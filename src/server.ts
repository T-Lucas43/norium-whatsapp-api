import { createHash } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import QRCode from "qrcode";
import { z, ZodError } from "zod";
import { Client, createClient, type OpenWAClient } from "@open-wa/wa-automate";
import { PuppeteerDriver } from "@open-wa/driver-puppeteer";
import { config } from "./config.js";
import { requireDestructiveConfirmation, requireRole } from "./security.js";
import { WebhookDispatcher } from "./webhook.js";
import { BlobPersistence } from "./persistence.js";

const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.x-api-key",
      "req.headers.cookie",
      "res.headers.set-cookie",
      "*.sessionData",
      "*.qr",
    ],
    censor: "[REDACTED]",
  },
});

const app = express();
const dispatcher = new WebhookDispatcher();
const persistence = new BlobPersistence();
let client: Client | null = null;
let openwa: OpenWAClient | null = null;
let launchPromise: Promise<void> | null = null;
let latestQr: string | null = null;
let sessionState: "starting" | "qr" | "connected" | "disconnected" | "error" = "starting";
let lastError: string | null = null;
let connectedAt: string | null = null;

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
  allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-API-Key", "X-Confirm-Destructive"],
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

function normalizeChatId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 5) throw new Error("Destino do WhatsApp invalido.");
  return `${digits}@c.us`;
}

function readyClient(): Client {
  if (!client || sessionState !== "connected") {
    const error = new Error("WhatsApp ainda nao esta conectado.") as Error & { status?: number };
    error.status = 503;
    throw error;
  }
  return client;
}

function idempotencyKey(request: Request): string | null {
  const key = (request.header("idempotency-key") || "").trim();
  return key && key.length <= 180 ? key : null;
}

const idempotency = new Map<string, { expiresAt: number; payload: unknown }>();
async function idempotent<T>(request: Request, operation: () => Promise<T>): Promise<T> {
  const key = idempotencyKey(request);
  if (!key) return operation();
  const hash = createHash("sha256").update(`${request.path}:${key}`).digest("hex");
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
  response.json({ status: "ok", service: "norium-whatsapp-api", session: sessionState, uptime: Math.round(process.uptime()) });
});

app.get("/ready", (_request, response) => {
  response.status(sessionState === "connected" ? 200 : 503).json({ ready: sessionState === "connected", session: sessionState });
});

app.get("/v1/session/status", requireRole("norium"), async (_request, response) => {
  let hostNumber: string | null = null;
  if (client && sessionState === "connected") {
    hostNumber = String(await (client as unknown as { getHostNumber(): Promise<string> }).getHostNumber().catch(() => "")) || null;
  }
  response.json({ sessionId: config.sessionId, state: sessionState, connected: sessionState === "connected", connectedAt, hostNumber, lastError });
});

app.get("/v1/session/qr", requireRole("norium"), (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ state: sessionState, qr: sessionState === "qr" ? latestQr : null });
});

app.post("/v1/session/reconnect", requireRole("admin"), async (_request, response) => {
  if (!launchPromise) launchPromise = launchWhatsApp();
  response.status(202).json({ accepted: true, state: sessionState });
});

app.post("/v1/session/logout", requireRole("admin"), requireDestructiveConfirmation, async (_request, response) => {
  if (client) {
    await (client as unknown as { evaluate: (fn: () => unknown, arg: undefined) => Promise<unknown> })
      .evaluate(() => (globalThis as unknown as { WAPI?: { logout?: () => unknown } }).WAPI?.logout?.(), undefined)
      .catch(() => undefined);
  }
  if (openwa) await openwa.stop("logout").catch(() => undefined);
  client = null;
  openwa = null;
  sessionState = "disconnected";
  latestQr = null;
  response.json({ loggedOut: true });
});

app.post("/v1/messages/text", requireRole("norium"), sendLimiter, async (request, response) => {
  const body = textPayload.parse(request.body);
  const result = await idempotent(request, () => (readyClient() as any).sendText(normalizeChatId(body.to), body.text));
  response.json({ sent: Boolean(result), messageId: result });
});

app.post("/v1/messages/media", requireRole("norium"), sendLimiter, async (request, response) => {
  const body = mediaPayload.parse(request.body);
  if (!body.data.startsWith("data:") && !body.data.startsWith("./") && !body.data.startsWith("../")) {
    response.status(422).json({ error: "invalid_media", message: "Use Data URL ou caminho relativo; URLs remotas exigem a API administrativa." });
    return;
  }
  const result = await idempotent(request, () => (readyClient() as any).sendFile(
    normalizeChatId(body.to), body.data, body.filename, body.caption,
  ));
  response.json({ sent: Boolean(result), messageId: result });
});

app.get("/v1/chats", requireRole("norium"), async (_request, response) => response.json(await readyClient().getAllChats()));
app.get("/v1/contacts", requireRole("norium"), async (_request, response) => response.json(await readyClient().getAllContacts()));
app.get("/v1/groups", requireRole("norium"), async (_request, response) => {
  const chats = await readyClient().getAllChats();
  response.json(chats.filter((chat: any) => Boolean(chat.isGroup || String(chat.id || "").endsWith("@g.us"))));
});
app.get("/v1/contacts/:id/profile-picture", requireRole("norium"), async (request, response) => {
  const contactId = normalizeChatId(String(request.params.id || ""));
  const value = await (readyClient() as any).getProfilePic(contactId);
  response.json({ value: value || null });
});
app.get("/v1/groups/:id", requireRole("norium"), async (request, response) => {
  const groupId = normalizeChatId(String(request.params.id || ""));
  response.json(await (readyClient() as any).getGroupInfo(groupId));
});

app.get("/v1/openwa/methods", requireRole("admin"), (_request, response) => {
  const current = readyClient() as unknown as Record<string, unknown>;
  const methods = new Set<string>();
  let prototype = Object.getPrototypeOf(current) as object | null;
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (!name.startsWith("_") && typeof current[name] === "function") methods.add(name);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  response.json({ methods: [...methods].sort() });
});

const destructiveMethods = new Set(["logout", "kill", "deleteChat", "deleteMessage", "clearChat", "leaveGroup", "deleteAllStatus"]);
app.post("/v1/openwa/:method", requireRole("admin"), async (request, response, next) => {
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
    const instance = readyClient() as unknown as Record<string, unknown>;
    const target = instance[method];
    if (typeof target !== "function") {
      response.status(404).json({ error: "unknown_method" });
      return;
    }
    const { args } = rawPayload.parse(request.body);
    const result = await Reflect.apply(target, instance, args);
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

async function registerEvents(openwaClient: Client): Promise<void> {
  const dynamic = openwaClient as unknown as Record<string, unknown>;
  const listeners: Array<[string, string]> = [
    ["onMessage", "message"], ["onAnyMessage", "any-message"], ["onAck", "ack"],
    ["onStateChanged", "state"], ["onAddedToGroup", "group-added"],
    ["onParticipantsChanged", "group-participants"], ["onIncomingCall", "incoming-call"],
    ["onButton", "button"], ["onPollVote", "poll-vote"], ["onReaction", "reaction"],
  ];
  for (const [method, eventName] of listeners) {
    const target = dynamic[method];
    if (typeof target !== "function") continue;
    try {
      await Reflect.apply(target, dynamic, [(payload: unknown) => void dispatcher.enqueue(eventName, payload)]);
    } catch (error) {
      logger.warn({ err: error, method }, "Listener OpenWA indisponivel");
    }
  }
}

async function launchWhatsApp(): Promise<void> {
  sessionState = "starting";
  lastError = null;
  try {
    const core = await createClient({
      sessionId: config.sessionId,
      driver: new PuppeteerDriver(),
      sessionDataPath: config.sessionDataPath,
      headless: true,
      authTimeoutMs: 0,
      qrTimeoutMs: 0,
      logConsole: false,
      logConsoleErrors: false,
      blockCrashLogs: true,
      safeMode: true,
      deleteSessionDataOnLogout: false,
      killClientOnLogout: false,
      ...(config.chromePath ? { executablePath: config.chromePath } : {}),
    });
    core.events.on("launch.auth.qr.generated", (payload) => {
      const rawQr = payload.details?.qr || "";
      if (!rawQr) return;
      void QRCode.toDataURL(rawQr, { errorCorrectionLevel: "M", margin: 2, width: 360 })
        .then((dataUrl) => {
          latestQr = dataUrl;
          sessionState = "qr";
        })
        .catch((error) => {
          lastError = "Falha ao renderizar o QR Code.";
          logger.warn({ err: error }, "QR Code do OpenWA nao foi renderizado");
        });
    });
    core.events.on("session.state.changed", (payload) => {
      if (payload.details?.next === "DISCONNECTED" || payload.details?.next === "STOPPED") {
        sessionState = "disconnected";
      }
    });
    const created = new Client({ client: core, transport: core.getTransport() });
    openwa = core;
    await created.start();
    await created.loaded();
    client = created;
    latestQr = null;
    sessionState = "connected";
    connectedAt = new Date().toISOString();
    await registerEvents(created);
    await dispatcher.enqueue("session-ready", { connectedAt });
  } catch (error) {
    sessionState = "error";
    lastError = error instanceof Error ? error.message.slice(0, 500) : "Falha ao iniciar OpenWA.";
    logger.error({ err: error }, "OpenWA nao iniciou");
  } finally {
    launchPromise = null;
  }
}

let persistenceTimer: NodeJS.Timeout | null = null;

async function bootstrapWhatsApp(): Promise<void> {
  await persistence.restore().catch((error) => logger.warn({ err: error }, "Persistencia anterior indisponivel"));
  persistenceTimer = setInterval(
    () => void persistence.save().catch((error) => logger.warn({ err: error }, "Falha ao sincronizar persistencia")),
    config.persistenceIntervalMs,
  );
  persistenceTimer.unref();
  launchPromise = launchWhatsApp();
}

const server = app.listen(config.port, "0.0.0.0", () => {
  logger.info({ port: config.port, sessionId: config.sessionId }, "Norium WhatsApp API pronta");
  void dispatcher.drain();
  void bootstrapWhatsApp();
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Encerrando API WhatsApp");
  server.close();
  if (openwa) await openwa.stop(signal).catch(() => undefined);
  if (persistenceTimer) clearInterval(persistenceTimer);
  await persistence.save().catch(() => undefined);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
