import { createHash } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import { z, ZodError } from "zod";
import { config } from "./config.js";
import { requireDestructiveConfirmation, requireRole, requireSessionContext, requestSessionContext } from "./security.js";
import { WebhookDispatcher } from "./webhook.js";
import { BlobPersistence } from "./persistence.js";
import { WhatsAppSessionManager } from "./session-manager.js";

const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-api-key']",
      "req.headers['x-norium-session-signature']",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "*.sessionData",
      "*.qr",
    ],
    censor: "[REDACTED]",
  },
});

const app = express();
const dispatcher = new WebhookDispatcher();
const persistence = new BlobPersistence();
const sessions = new WhatsAppSessionManager(dispatcher, persistence, logger);

app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);
app.use((pinoHttp as unknown as (options: { logger: typeof logger }) => express.Handler)({ logger }));
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Origin nao permitida."));
  },
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: [
    "Authorization", "Content-Type", "Idempotency-Key", "X-API-Key", "X-Confirm-Destructive",
    "X-Norium-User-Id", "X-Norium-Session-Id", "X-Norium-Session-Signature",
  ],
  maxAge: 600,
}));
app.use(express.json({ limit: `${config.maxBodyMb}mb`, type: ["application/json", "application/*+json"] }));
app.use(rateLimit({
  windowMs: 60_000,
  limit: config.rateLimitPerMinute,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: (request) => request.path === "/health",
}));

const sendLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.sendRateLimitPerMinute,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const textPayload = z.object({
  to: z.string().min(5).max(80),
  text: z.string().min(1).max(65_536),
});
const mediaPayload = z.object({
  to: z.string().min(5).max(80),
  data: z.string().min(16),
  filename: z.string().min(1).max(240),
  caption: z.string().max(4096).default(""),
  viewOnce: z.boolean().default(false),
});
const rawPayload = z.object({ args: z.array(z.unknown()).max(32).default([]) });
const historyQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const groupPayload = z.object({
  name: z.string().trim().min(1).max(100),
  participants: z.array(z.string().min(5).max(80)).min(1).max(256),
});
const forwardPayload = z.object({
  to: z.string().min(5).max(80),
  messageIds: z.array(z.string().min(3).max(200)).min(1).max(100),
});
const deleteMessagePayload = z.object({
  chatId: z.string().min(5).max(80),
  onlyLocal: z.boolean().default(true),
});

function normalizeChatId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 5) throw new Error("Destino do WhatsApp invalido.");
  return `${digits}@c.us`;
}

function messageIdOf(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const candidate of [record.id, record.messageId, record.msgId]) {
    if (typeof candidate === "string" || typeof candidate === "number") return String(candidate);
    if (candidate && typeof candidate === "object") {
      const serialized = (candidate as Record<string, unknown>)._serialized;
      if (typeof serialized === "string") return serialized;
    }
  }
  return null;
}

function idempotencyKey(request: Request): string | null {
  const key = (request.header("idempotency-key") || "").trim();
  return key && key.length <= 180 ? key : null;
}

const idempotency = new Map<string, { expiresAt: number; payload: unknown }>();
async function idempotent<T>(request: Request, operation: () => Promise<T>): Promise<T> {
  const key = idempotencyKey(request);
  if (!key) return operation();
  const sessionId = requestSessionContext(request).sessionId;
  const hash = createHash("sha256").update(`${sessionId}:${request.path}:${key}`).digest("hex");
  const cached = idempotency.get(hash);
  if (cached && cached.expiresAt > Date.now()) return cached.payload as T;
  const payload = await operation();
  idempotency.set(hash, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, payload });
  if (idempotency.size > 5_000) {
    for (const [itemKey, item] of idempotency) if (item.expiresAt <= Date.now()) idempotency.delete(itemKey);
  }
  return payload;
}

app.get("/", (_request, response) => {
  response.type("html").send(`<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Norium WhatsApp API</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: #07090c; color: #f8fafc; }
      main { width: min(560px, 100%); padding: 32px; border: 1px solid #26303a; border-radius: 24px; background: #0d1117; box-shadow: 0 24px 80px #0008; }
      .status { display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 999px; background: #0d2a1e; color: #6ee7a8; font-weight: 800; font-size: 13px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 16px #22c55e; }
      h1 { margin: 22px 0 10px; font-size: clamp(28px, 7vw, 42px); letter-spacing: -0.04em; }
      p { margin: 0; color: #a8b3c2; line-height: 1.7; }
      code { color: #67e8f9; }
    </style>
  </head>
  <body>
    <main>
      <span class="status"><span class="dot"></span>API online</span>
      <h1>Norium WhatsApp API</h1>
      <p>Serviço privado ativo. A autenticação e o QR Code são acessados com segurança dentro do Norium. Monitoramento técnico disponível em <code>/health</code>.</p>
    </main>
  </body>
</html>`);
});

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "norium-whatsapp-api",
    sessions: sessions.health(),
    uptime: Math.round(process.uptime()),
  });
});

app.get("/ready", (_request, response) => {
  response.json({ ready: true, service: "norium-whatsapp-api" });
});

app.get("/v1/session/status", requireRole("norium"), requireSessionContext, async (request, response) => {
  response.json(sessions.status(requestSessionContext(request), false));
});

app.get("/v1/session/qr", requireRole("norium"), requireSessionContext, (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json(sessions.qr(requestSessionContext(request)));
});

app.post("/v1/session/reconnect", requireRole("norium"), requireSessionContext, async (request, response) => {
  const status = await sessions.reconnect(requestSessionContext(request));
  response.status(202).json({ accepted: true, ...status });
});

app.post("/v1/session/logout", requireRole("norium"), requireSessionContext, requireDestructiveConfirmation, async (request, response) => {
  await sessions.logout(requestSessionContext(request));
  response.json({ loggedOut: true });
});

app.post("/v1/messages/text", requireRole("norium"), requireSessionContext, sendLimiter, async (request, response) => {
  const body = textPayload.parse(request.body);
  const context = requestSessionContext(request);
  const result = await idempotent(request, () => sessions.invoke(context, "sendText", [normalizeChatId(body.to), body.text], 30_000));
  response.json({ sent: Boolean(result), messageId: messageIdOf(result) });
});

app.post("/v1/messages/media", requireRole("norium"), requireSessionContext, sendLimiter, async (request, response) => {
  const body = mediaPayload.parse(request.body);
  if (!body.data.startsWith("data:") && !body.data.startsWith("./") && !body.data.startsWith("../")) {
    response.status(422).json({ error: "invalid_media", message: "Use Data URL ou caminho relativo; URLs remotas exigem a API administrativa." });
    return;
  }
  const context = requestSessionContext(request);
  const result = await idempotent(request, () => sessions.invoke(context, "sendFile", [
    normalizeChatId(body.to), body.data, body.filename, body.caption,
  ], 90_000));
  response.json({ sent: Boolean(result), messageId: messageIdOf(result) });
});

app.get("/v1/messages/:id/media", requireRole("norium"), requireSessionContext, async (request, response) => {
  const result = await sessions.invoke<unknown>(requestSessionContext(request), "decryptMedia", [String(request.params.id || "")], 60_000);
  const data = typeof result === "string"
    ? result
    : result && typeof result === "object" && typeof (result as Record<string, unknown>).data === "string"
      ? String((result as Record<string, unknown>).data)
      : null;
  if (!data || !data.startsWith("data:")) {
    response.status(404).json({ error: "media_unavailable", message: "Midia indisponivel no WhatsApp." });
    return;
  }
  response.json({ data });
});

app.get("/v1/chats", requireRole("norium"), requireSessionContext, async (request, response) => response.json(await sessions.invoke(requestSessionContext(request), "__noriumChatCatalog", [], 20_000)));
app.get("/v1/chats/:id/messages", requireRole("norium"), requireSessionContext, async (request, response) => {
  const query = historyQuery.parse(request.query);
  const chatId = normalizeChatId(String(request.params.id || ""));
  response.json(await sessions.invoke(
    requestSessionContext(request),
    "__noriumMessages",
    [chatId, query.before || null, query.limit],
    20_000,
  ));
});
app.post("/v1/chats/:id/read", requireRole("norium"), requireSessionContext, async (request, response) => {
  const chatId = normalizeChatId(String(request.params.id || ""));
  const marked = await sessions.invoke(requestSessionContext(request), "sendSeen", [chatId], 20_000);
  response.json({ marked: Boolean(marked) });
});
app.delete("/v1/chats/:id", requireRole("norium"), requireSessionContext, requireDestructiveConfirmation, async (request, response) => {
  const chatId = normalizeChatId(String(request.params.id || ""));
  const deleted = await sessions.invoke(requestSessionContext(request), "deleteChat", [chatId], 30_000);
  response.json({ deleted: Boolean(deleted) });
});
app.get("/v1/contacts", requireRole("norium"), requireSessionContext, async (request, response) => response.json(await sessions.invoke(requestSessionContext(request), "__noriumContactCatalog", [], 20_000)));
app.get("/v1/groups", requireRole("norium"), requireSessionContext, async (request, response) => {
  const chats = await sessions.invoke<any[]>(requestSessionContext(request), "__noriumChatCatalog", [], 20_000);
  response.json(chats.filter((chat: any) => Boolean(chat.isGroup || String(chat.id || "").endsWith("@g.us"))));
});
app.get("/v1/contacts/:id/profile-picture", requireRole("norium"), requireSessionContext, async (request, response) => {
  const contactId = normalizeChatId(String(request.params.id || ""));
  const value = await sessions.invoke(requestSessionContext(request), "getProfilePic", [contactId]);
  response.json({ value: value || null });
});
app.get("/v1/groups/:id", requireRole("norium"), requireSessionContext, async (request, response) => {
  const groupId = normalizeChatId(String(request.params.id || ""));
  response.json(await sessions.invoke(requestSessionContext(request), "getGroupInfo", [groupId]));
});
app.post("/v1/groups", requireRole("norium"), requireSessionContext, async (request, response) => {
  const body = groupPayload.parse(request.body);
  const result = await sessions.invoke(requestSessionContext(request), "createGroup", [
    body.name,
    body.participants.map(normalizeChatId),
  ], 45_000);
  response.status(201).json(result);
});
app.post("/v1/messages/forward", requireRole("norium"), requireSessionContext, sendLimiter, async (request, response) => {
  const body = forwardPayload.parse(request.body);
  const forwarded = await sessions.invoke(requestSessionContext(request), "forwardMessages", [
    normalizeChatId(body.to),
    body.messageIds,
    false,
  ], 45_000);
  response.json({ forwarded: Boolean(forwarded) });
});
app.delete("/v1/messages/:id", requireRole("norium"), requireSessionContext, requireDestructiveConfirmation, async (request, response) => {
  const body = deleteMessagePayload.parse(request.body);
  const deleted = await sessions.invoke(requestSessionContext(request), "deleteMessage", [
    normalizeChatId(body.chatId),
    String(request.params.id || ""),
    body.onlyLocal,
  ], 30_000);
  response.json({ deleted: Boolean(deleted) });
});

app.get("/v1/openwa/methods", requireRole("admin"), requireSessionContext, async (request, response) => {
  response.json({ methods: await sessions.invoke<string[]>(requestSessionContext(request), "__methods", [], 15_000) });
});

const destructiveMethods = new Set(["logout", "kill", "deleteChat", "deleteMessage", "clearChat", "leaveGroup", "deleteAllStatus"]);
app.post("/v1/openwa/:method", requireRole("admin"), requireSessionContext, async (request, response, next) => {
  try {
    const method = String(request.params.method || "");
    if (!/^[a-zA-Z][a-zA-Z0-9]{1,80}$/.test(method) || method.startsWith("on") || method === "middleware") {
      response.status(404).json({ error: "unknown_method" });
      return;
    }
    if (destructiveMethods.has(method) && (request.header("x-confirm-destructive") || "").toLowerCase() !== "true") {
      response.status(428).json({ error: "confirmation_required", message: "Confirme a operacao destrutiva no cabecalho." });
      return;
    }
    const { args } = rawPayload.parse(request.body);
    const result = await sessions.invoke(requestSessionContext(request), method, args, 120_000);
    response.json({ method, result });
  } catch (error) {
    next(error);
  }
});

app.use((_request, response) => response.status(404).json({ error: "not_found" }));
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    response.status(422).json({ error: "validation_error", issues: error.issues.map((item) => ({ path: item.path.join("."), message: item.message })) });
    return;
  }
  const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : 500;
  logger.error({ err: error }, "Falha na requisicao da API WhatsApp");
  response.status(Number.isFinite(status) ? status : 500).json({
    error: status === 503 ? "session_unavailable" : "internal_error",
    message: error instanceof Error ? error.message : "Falha interna.",
  });
});

let persistenceTimer: NodeJS.Timeout | null = null;

async function bootstrapWhatsApp(): Promise<void> {
  await persistence.restore().catch((error) => logger.warn({ err: error }, "Persistencia anterior indisponivel"));
  persistenceTimer = setInterval(
    () => void persistence.save().catch((error) => logger.warn({ err: error }, "Falha ao sincronizar persistencia")),
    config.persistenceIntervalMs,
  );
  persistenceTimer.unref();
}

await bootstrapWhatsApp();
void dispatcher.drain();

const server = app.listen(config.port, "0.0.0.0", () => {
  logger.info({ port: config.port, maxActiveSessions: config.maxActiveSessions }, "Norium WhatsApp API pronta");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Encerrando API WhatsApp");
  server.close();
  await sessions.shutdown();
  if (persistenceTimer) clearInterval(persistenceTimer);
  await persistence.save().catch(() => undefined);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
