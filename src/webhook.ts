import { createHmac, randomUUID } from "node:crypto";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

type WebhookEnvelope = {
  id: string;
  event: string;
  sessionId: string;
  occurredAt: string;
  data: unknown;
  attempts: number;
  userId: string;
};

type SessionContext = { userId: string; sessionId: string };

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function serializedId(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return value == null ? "" : String(value);
  const record = value as Record<string, unknown>;
  return serializedId(record._serialized || record.id || record.user || "");
}

function safePayload(event: string, data: unknown): unknown {
  if (!["message", "any-message"].includes(event) || typeof data !== "object" || data === null) return data;
  const message = data as Record<string, unknown>;
  const sender = typeof message.sender === "object" && message.sender !== null
    ? message.sender as Record<string, unknown>
    : {};
  const chat = typeof message.chat === "object" && message.chat !== null
    ? message.chat as Record<string, unknown>
    : {};
  const messageId = serializedId(message.id || message.messageId);
  const chatId = serializedId(message.chatId || chat.id || message.from);
  const senderId = serializedId(message.senderId || sender.id || message.author);
  return {
    phone: chatId,
    chatId,
    from: chatId,
    fromMe: Boolean(message.fromMe),
    senderName: sender.pushname || sender.formattedName || message.notifyName,
    chatName: chat.name || chat.formattedTitle,
    isGroup: Boolean(message.isGroupMsg) || chatId.endsWith("@g.us"),
    senderId,
    messageId,
    id: messageId,
    timestamp: message.timestamp,
    type: message.type,
    body: message.body,
    text: message.body,
    caption: message.caption,
    mimetype: message.mimetype,
    filename: message.filename,
    duration: message.duration,
  };
}

export class WebhookDispatcher {
  async enqueue(context: SessionContext, event: string, data: unknown): Promise<void> {
    if (!config.noriumWebhookUrl) return;
    const envelope: WebhookEnvelope = {
      id: randomUUID(),
      event,
      sessionId: context.sessionId,
      userId: context.userId,
      occurredAt: new Date().toISOString(),
      data: safePayload(event, data),
      attempts: 0,
    };
    const path = join(config.outboxPath, `${Date.now()}-${envelope.id}.json`);
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    void this.deliverFile(path);
  }

  async drain(): Promise<void> {
    const files = (await readdir(config.outboxPath)).filter((name) => name.endsWith(".json")).sort().slice(0, 500);
    for (const file of files) await this.deliverFile(join(config.outboxPath, file));
  }

  private async deliverFile(path: string): Promise<void> {
    let envelope: WebhookEnvelope;
    try {
      envelope = JSON.parse(await readFile(path, "utf8")) as WebhookEnvelope;
    } catch {
      await unlink(path).catch(() => undefined);
      return;
    }

    for (let attempt = envelope.attempts; attempt < 6; attempt += 1) {
      const bodyPayload = {
        event: envelope.event,
        eventId: envelope.id,
        sessionId: envelope.sessionId,
        userId: envelope.userId,
        occurredAt: envelope.occurredAt,
        data: envelope.data,
      };
      const body = JSON.stringify(bodyPayload);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac("sha256", config.webhookHmacSecret)
        .update(`${timestamp}.${body}`, "utf8")
        .digest("hex");
      try {
        const response = await fetch(config.noriumWebhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Norium-WhatsApp-API/1.0",
            "x-norium-event-id": envelope.id,
            "x-norium-timestamp": timestamp,
            "x-norium-signature": `sha256=${signature}`,
            ...(config.noriumWebhookSecret ? { "x-whatsapp-webhook-secret": config.noriumWebhookSecret } : {}),
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          await unlink(path).catch(() => undefined);
          return;
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) return;
      } catch {
        // Mantem no outbox para uma proxima tentativa.
      }
      envelope.attempts = attempt + 1;
      await writeFile(path, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
      await sleep(Math.min(30_000, 750 * 2 ** attempt));
    }
  }
}
