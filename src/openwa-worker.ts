import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import type { Chat, Client, Contact, Message, ReactionEvent } from "@open-wa/wa-automate";

type WorkerConfiguration = {
  sessionId: string;
  sessionDataPath: string;
  chromePath?: string;
};

type InvokeMessage = { type: "invoke"; id: number; method: string; args: unknown[] };
type ShutdownMessage = { type: "shutdown" };
type AnyRecord = Record<string, any>;

const configuration = workerData as WorkerConfiguration;
const channel = parentPort;
const runtimeRequire = createRequire(import.meta.url);
let client: Client | null = null;
let connected = false;

if (!channel) throw new Error("Canal IPC do OpenWA indisponivel.");

function serializable(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}

function post(message: Record<string, unknown>): void {
  channel!.postMessage(serializable(message));
}

function serializedId(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const record = value as AnyRecord;
  return String(record._serialized || record.id?._serialized || record.id || record.remote || "");
}

function timestampOf(value: AnyRecord | null | undefined): number {
  return Number(value?.t || value?.timestamp || value?.id?.t || 0) || 0;
}

function labelFor(type: string): string {
  return ({
    image: "[Imagem]", video: "[Video]", audio: "[Audio]", ptt: "[Audio]",
    document: "[Documento]", sticker: "[Figurinha]", location: "[Localizacao]",
    contact: "[Contato]", vcard: "[Contato]", poll_creation: "[Enquete]",
  } as Record<string, string>)[type.toLowerCase()] || "";
}

function ackStatus(ack: unknown): "erro" | "pendente" | "enviado" | "entregue" | "lido" | "reproduzido" {
  const value = Number(ack);
  if (value < 0) return "erro";
  if (value === 0) return "pendente";
  if (value === 1) return "enviado";
  if (value === 2) return "entregue";
  if (value === 3) return "lido";
  if (value >= 4) return "reproduzido";
  return "enviado";
}

function normalizeReactions(message: AnyRecord): AnyRecord[] {
  const groups = Array.isArray(message.reactions) ? message.reactions : [];
  return groups.flatMap((group: AnyRecord) => {
    const emoji = String(group.aggregateEmoji || group.emoji || "");
    const senders = Array.isArray(group.senders) ? group.senders : [];
    if (!senders.length && emoji) {
      return [{ emoji, count: Number(group.count || 1), fromMe: Boolean(group.hasReactionByMe), senders: [] }];
    }
    return emoji ? [{
      emoji,
      count: senders.length,
      fromMe: Boolean(group.hasReactionByMe),
      senders: senders.map((sender: AnyRecord) => String(sender.senderUserJid || sender.senderId || "")).filter(Boolean),
    }] : [];
  });
}

function chatIdFor(message: AnyRecord): string {
  const explicit = serializedId(message.chatId);
  if (explicit) return explicit;
  const from = serializedId(message.from);
  const to = serializedId(message.to);
  if (message.isGroupMsg || from.endsWith("@g.us") || to.endsWith("@g.us")) {
    return from.endsWith("@g.us") ? from : to;
  }
  return message.fromMe ? to : from;
}

function normalizeMessage(value: Message | AnyRecord): AnyRecord {
  const message = value as AnyRecord;
  const type = String(message.type || "chat").toLowerCase();
  const id = serializedId(message.id) || serializedId(message.mId) || `history-${chatIdFor(message)}-${timestampOf(message)}`;
  const sender = (message.sender || message.senderObj || {}) as AnyRecord;
  const quoted = (message.quotedMsg || message.quotedMsgObj || null) as AnyRecord | null;
  const rawText = String(message.text || message.caption || message.content || (type === "chat" ? message.body || "" : ""));
  const content = rawText || labelFor(type);
  const senderId = serializedId(message.author || message.senderId || sender.id || message.from);
  return {
    id,
    chatId: chatIdFor(message),
    isGroup: chatIdFor(message).endsWith("@g.us"),
    chatName: String(message.chat?.formattedTitle || message.chat?.name || ""),
    fromMe: Boolean(message.fromMe || message.self === "out"),
    timestamp: timestampOf(message),
    content: content.slice(0, 65_536),
    text: rawText.slice(0, 65_536),
    caption: String(message.caption || "").slice(0, 4096),
    type,
    senderId,
    senderName: String(sender.formattedName || sender.pushname || sender.name || message.notifyName || ""),
    mimetype: String(message.mimetype || message.mediaData?.mimetype || ""),
    filename: String(message.filename || ""),
    duration: Number(message.duration || message.mediaData?.duration || 0) || 0,
    ack: Number.isFinite(Number(message.ack)) ? Number(message.ack) : null,
    status: ackStatus(message.ack),
    isMedia: Boolean(message.isMedia || ["image", "video", "audio", "ptt", "document", "sticker"].includes(type)),
    mediaAvailable: Boolean(message.isMedia || message.deprecatedMms3Url || message.clientUrl || message.filehash),
    reactions: normalizeReactions(message),
    quoted: quoted ? {
      id: serializedId(quoted.id),
      content: String(quoted.text || quoted.caption || quoted.content || quoted.body || labelFor(String(quoted.type || "chat"))).slice(0, 512),
      senderName: String(quoted.sender?.formattedName || quoted.sender?.pushname || quoted.notifyName || ""),
      type: String(quoted.type || "chat"),
    } : null,
  };
}

function messagesFromChat(chat: AnyRecord): Message[] {
  const source = chat?.msgs;
  if (Array.isArray(source)) return source;
  if (Array.isArray(source?.models)) return source.models;
  if (Array.isArray(source?._models)) return source._models;
  return [];
}

function photoFrom(value: AnyRecord): string {
  const picture = value.profilePicThumbObj || value.profilePicThumb || value.contact?.profilePicThumbObj || value.contact?.profilePicThumb || {};
  return String(value.pic || picture.eurl || picture.imgFull || picture.img || "");
}

function normalizeContact(value: Contact | AnyRecord): AnyRecord {
  const contact = value as AnyRecord;
  const id = serializedId(contact.id);
  return {
    id,
    phone: id,
    jid: id,
    name: String(contact.formattedName || contact.name || contact.pushname || contact.shortName || id),
    formattedName: String(contact.formattedName || ""),
    verifiedName: String(contact.verifiedName || ""),
    pushname: String(contact.pushname || ""),
    photoUrl: photoFrom(contact),
    bio: String(contact.status?.status || contact.status?.text || contact.status || contact.about || ""),
    isBusiness: Boolean(contact.isBusiness || contact.isEnterprise),
    isMyContact: Boolean(contact.isMyContact),
    isBlocked: Boolean(contact.isBlocked),
  };
}

function normalizeChat(value: Chat | AnyRecord): AnyRecord {
  const chat = value as AnyRecord;
  const id = serializedId(chat.id);
  const recent = messagesFromChat(chat)
    .map(normalizeMessage)
    .filter((message) => message.timestamp > 0 && !String(message.type).includes("notification"))
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-25);
  const latest = recent[recent.length - 1];
  const contact = (chat.contact || {}) as AnyRecord;
  return {
    id,
    phone: id,
    jid: id,
    name: String(chat.formattedTitle || chat.name || contact.formattedName || contact.name || contact.pushname || id),
    formattedTitle: String(chat.formattedTitle || ""),
    pushname: String(contact.pushname || ""),
    isGroup: Boolean(chat.isGroup || id.endsWith("@g.us")),
    unreadCount: Number(chat.unreadCount || 0) || 0,
    timestamp: latest?.timestamp || timestampOf(chat),
    lastMessage: latest?.content || "",
    lastMessageType: latest?.type || "",
    photoUrl: photoFrom(chat),
    messages: recent,
  };
}

async function profilePicture(id: string): Promise<string> {
  if (!client || !id) return "";
  try {
    return String(await client.getProfilePicFromServer(id as never) || "");
  } catch {
    return "";
  }
}

async function chatCatalog(): Promise<AnyRecord[]> {
  if (!client) return [];
  const chats = await client.getAllChatsWithMessages(false);
  return chats
    .map(normalizeChat)
    .filter((chat) => chat.id && !chat.id.endsWith("@broadcast"))
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 500);
}

async function contactDetails(contactId: string): Promise<AnyRecord | null> {
  if (!client) return null;
  try {
    const contact = normalizeContact(await client.getContact(contactId as never));
    const [photoUrl, status] = await Promise.all([
      contact.photoUrl ? Promise.resolve(contact.photoUrl) : profilePicture(contactId),
      client.getStatus(contactId as never).catch(() => null),
    ]);
    contact.photoUrl = photoUrl;
    if (status?.status) contact.bio = status.status;
    return contact;
  } catch {
    return null;
  }
}

async function groupDetails(groupId: string): Promise<AnyRecord | null> {
  if (!client) return null;
  try {
    const [info, members, photoUrl] = await Promise.all([
      client.getGroupInfo(groupId as never).catch(() => ({})),
      client.getGroupMembers(groupId as never).catch(() => []),
      profilePicture(groupId),
    ]);
    const metadata = (info || {}) as AnyRecord;
    const participants = (Array.isArray(members) ? members : []).map((member) => normalizeContact(member));
    const participantMeta = Array.isArray(metadata.participants) ? metadata.participants : [];
    for (const participant of participants) {
      const match = participantMeta.find((item: AnyRecord) => serializedId(item.id || item.contact?.id) === participant.id);
      participant.isAdmin = Boolean(match?.isAdmin);
      participant.isSuperAdmin = Boolean(match?.isSuperAdmin);
    }
    return {
      id: groupId,
      subject: String(metadata.subject || metadata.formattedTitle || metadata.name || groupId),
      name: String(metadata.subject || metadata.formattedTitle || metadata.name || groupId),
      description: String(metadata.desc || metadata.description || ""),
      owner: serializedId(metadata.owner),
      createdAt: Number(metadata.creation || metadata.createdAt || 0) || null,
      participants,
      participantCount: participants.length,
      photoUrl,
    };
  } catch {
    return null;
  }
}

async function messageHistory(chatId: string, before: number | null, limit: number): Promise<AnyRecord> {
  if (!client) return { items: [], cursor: null, hasMore: false };
  let source = await client.getAllMessagesInChat(chatId as never, true, false);
  if (!before && source.length < limit) {
    for (let attempt = 0; attempt < 2 && source.length < limit; attempt += 1) {
      const loaded = await client.loadEarlierMessages(chatId as never).catch(() => []);
      if (!loaded.length) break;
      source = await client.getAllMessagesInChat(chatId as never, true, false);
    }
  }
  const normalized = source
    .map(normalizeMessage)
    .filter((message) => message.timestamp > 0 && (!before || message.timestamp < before))
    .sort((left, right) => left.timestamp - right.timestamp);
  const items = normalized.slice(-limit);
  return {
    items,
    cursor: items.at(0)?.timestamp || null,
    hasMore: normalized.length > items.length,
  };
}

function availableMethods(instance: Client): string[] {
  const current = instance as unknown as Record<string, unknown>;
  const methods = new Set<string>();
  let prototype = Object.getPrototypeOf(current) as object | null;
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (!name.startsWith("_") && typeof current[name] === "function") methods.add(name);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return [...methods].sort();
}

async function registerEvents(instance: Client): Promise<void> {
  await instance.onStateChanged((state) => {
    const next = String(state || "").toUpperCase();
    if (["CONNECTED", "READY", "TIMEOUT"].includes(next)) return;
    if (["UNPAIRED", "UNLAUNCHED", "DISCONNECTED", "CONFLICT"].includes(next) && connected) {
      connected = false;
      post({ type: "state", state: "disconnected" });
    }
  });
  await instance.onAnyMessage((payload) => post({ type: "event", eventName: "message", payload: normalizeMessage(payload) }));
  await instance.onAck((payload) => post({ type: "event", eventName: "ack", payload: normalizeMessage(payload) }));
  await instance.onReaction((payload: ReactionEvent) => post({
    type: "event",
    eventName: "reaction",
    payload: {
      type: payload.type,
      message: normalizeMessage(payload.message),
      reactions: payload.reactions,
      reactionByMe: payload.reactionByMe,
    },
  }));

  const dynamic = instance as unknown as Record<string, unknown>;
  const optional: Array<[string, string]> = [
    ["onAddedToGroup", "group-added"], ["onParticipantsChanged", "group-participants"],
    ["onIncomingCall", "incoming-call"], ["onPollVote", "poll-vote"],
  ];
  for (const [method, eventName] of optional) {
    const target = dynamic[method];
    if (typeof target !== "function") continue;
    await Reflect.apply(target, dynamic, [(payload: unknown) => post({ type: "event", eventName, payload })]).catch(() => undefined);
  }
}

channel.on("message", (message: InvokeMessage | ShutdownMessage) => {
  if (message?.type === "shutdown") {
    void (async () => {
      connected = false;
      await client?.kill("Worker do Norium encerrado.").catch(() => false);
      client = null;
      post({ type: "shutdown-complete" });
    })();
    return;
  }
  if (message?.type !== "invoke") return;
  void (async () => {
    try {
      if (!client || !connected) throw new Error("WhatsApp ainda nao esta conectado.");
      let result: unknown;
      if (message.method === "__methods") result = availableMethods(client);
      else if (message.method === "__noriumChatCatalog") result = await chatCatalog();
      else if (message.method === "__noriumContactCatalog") result = (await client.getAllContacts()).map(normalizeContact);
      else if (message.method === "__noriumContactDetails") result = await contactDetails(String(message.args?.[0] || ""));
      else if (message.method === "__noriumGroupDetails") result = await groupDetails(String(message.args?.[0] || ""));
      else if (message.method === "__noriumProfilePicture") result = await profilePicture(String(message.args?.[0] || ""));
      else if (message.method === "__noriumMessages") {
        const beforeValue = Number(message.args?.[1] || 0);
        const before = Number.isFinite(beforeValue) && beforeValue > 0 ? beforeValue : null;
        const limit = Math.max(1, Math.min(100, Number(message.args?.[2] || 50)));
        result = await messageHistory(String(message.args?.[0] || ""), before, limit);
      } else {
        if (!/^[a-zA-Z][a-zA-Z0-9]{1,80}$/.test(message.method) || message.method.startsWith("on")) {
          throw new Error("Metodo OpenWA nao permitido.");
        }
        const instance = client as unknown as Record<string, unknown>;
        const target = instance[message.method];
        if (typeof target !== "function") throw new Error("Metodo OpenWA desconhecido.");
        result = await Reflect.apply(target, instance, Array.isArray(message.args) ? message.args : []);
      }
      post({ type: "response", id: message.id, ok: true, result });
    } catch (error) {
      post({
        type: "response",
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 500) : "Falha no OpenWA.",
      });
    }
  })();
});

async function launch(): Promise<void> {
  post({ type: "state", state: "starting" });
  try {
    const openwa = runtimeRequire("@open-wa/wa-automate") as typeof import("@open-wa/wa-automate");
    openwa.ev.on(`qr.${configuration.sessionId}`, (value: unknown) => {
      if (typeof value === "string" && value) post({ type: "qr", value });
    });
    openwa.ev.on(`state-change.${configuration.sessionId}`, (value: unknown) => {
      const state = String(value || "").toUpperCase();
      if (["CONNECTED", "READY", "TIMEOUT"].includes(state) && client) connected = true;
      if (["UNPAIRED", "UNLAUNCHED", "DISCONNECTED"].includes(state) && connected) {
        connected = false;
        post({ type: "state", state: "disconnected" });
      }
    });

    const created = await openwa.create({
      sessionId: configuration.sessionId,
      sessionDataPath: configuration.sessionDataPath,
      headless: true,
      qrTimeout: 0,
      authTimeout: 0,
      waitForRipeSessionTimeout: 0,
      qrLogSkip: true,
      disableSpins: true,
      blockCrashLogs: true,
      logConsole: false,
      logConsoleErrors: false,
      killProcessOnBrowserClose: false,
      skipUpdateCheck: true,
      chromiumArgs: [
        "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
        "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      ],
      ...(configuration.chromePath ? { executablePath: configuration.chromePath } : {}),
    });
    client = created;
    const hostNumber = String(await created.getHostNumber()).trim();
    if (!hostNumber) throw new Error("OpenWA nao confirmou o numero autenticado.");
    await registerEvents(created);
    connected = true;
    post({ type: "state", state: "connected", hostNumber });
  } catch (error) {
    connected = false;
    client = null;
    post({
      type: "state",
      state: "error",
      error: error instanceof Error ? error.message.slice(0, 500) : "Falha ao iniciar OpenWA.",
    });
  }
}

void launch();
