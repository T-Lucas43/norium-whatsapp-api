import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import QRCode from "qrcode";
import { z, ZodError } from "zod";
import { config } from "./config.js";
import { requireDestructiveConfirmation, requireRole } from "./security.js";
import { WebhookDispatcher } from "./webhook.js";
import { BlobPersistence } from "./persistence.js";

const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-api-key']",
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
let openwaWorker: Worker | null = null;
let launchPromise: Promise<void> | null = null;
let latestQr: string | null = null;
let sessionState: "starting" | "qr" | "connected" | "disconnected" | "error" = "starting";
let lastError: string | null = null;
let connectedAt: string | null = null;
let workerRequestSequence = 0;
const workerRequests = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();

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

function assertConnected(): void {
  if (!openwaWorker || sessionState !== "connected") {
    const error = new Error("WhatsApp ainda nao esta conectado.") as Error & { status?: number };
    error.status = 503;
    throw error;
  }
}

function rejectWorkerRequests(message: string): void {
  for (const pending of workerRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  workerRequests.clear();
}

async function invokeOpenWA<T>(method: string, args: unknown[] = [], timeoutMs = 60_000): Promise<T> {
  assertConnected();
  const target = openwaWorker;
  if (!target) throw new Error("Processo do WhatsApp indisponivel.");
  const id = ++workerRequestSequence;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      workerRequests.delete(id);
      reject(new Error(`Operacao ${method} excedeu o tempo limite.`));
    }, timeoutMs);
    timer.unref();
    workerRequests.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    target.postMessage({ type: "invoke", id, method, args });
  });
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
  const error = (lastError || "").toLowerCase();
  const sessionIssue = sessionState !== "error"
    ? null
    : error.includes("sandbox") || error.includes("zygote")
      ? "chromium_sandbox"
      : error.includes("browser") || error.includes("executable")
        ? "chromium_launch"
        : error.includes("err_") || error.includes("network") || error.includes("navigation")
          ? "whatsapp_network"
          : error.includes("tos") || error.includes("blocked")
            ? "whatsapp_restricted"
            : error.includes("session") || error.includes("auth")
              ? "session_bootstrap"
              : "openwa_start_failed";
  response.json({
    status: "ok",
    service: "norium-whatsapp-api",
    session: sessionState,
    ...(sessionIssue ? { sessionIssue } : {}),
    uptime: Math.round(process.uptime()),
  });
});

app.get("/ready", (_request, response) => {
  response.status(sessionState === "connected" ? 200 : 503).json({ ready: sessionState === "connected", session: sessionState });
});

app.get("/v1/session/status", requireRole("norium"), async (_request, response) => {
  let hostNumber: string | null = null;
  if (openwaWorker && sessionState === "connected") {
    hostNumber = String(await invokeOpenWA<string>("getHostNumber", [], 10_000).catch(() => "")) || null;
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
  if (openwaWorker && sessionState === "connected") {
    await invokeOpenWA("logout", [false], 20_000).catch(() => undefined);
  }
  await stopOpenWAWorker();
  sessionState = "disconnected";
  latestQr = null;
  response.json({ loggedOut: true });
});

app.post("/v1/messages/text", requireRole("norium"), sendLimiter, async (request, response) => {
  const body = textPayload.parse(request.body);
  const result = await idempotent(request, () => invokeOpenWA("sendText", [normalizeChatId(body.to), body.text], 30_000));
  response.json({ sent: Boolean(result), messageId: result });
});

app.post("/v1/messages/media", requireRole("norium"), sendLimiter, async (request, response) => {
  const body = mediaPayload.parse(request.body);
  if (!body.data.startsWith("data:") && !body.data.startsWith("./") && !body.data.startsWith("../")) {
    response.status(422).json({ error: "invalid_media", message: "Use Data URL ou caminho relativo; URLs remotas exigem a API administrativa." });
    return;
  }
  const result = await idempotent(request, () => invokeOpenWA("sendFile", [
    normalizeChatId(body.to), body.data, body.filename, body.caption,
  ], 90_000));
  response.json({ sent: Boolean(result), messageId: result });
});

app.get("/v1/chats", requireRole("norium"), async (_request, response) => response.json(await invokeOpenWA("getAllChats")));
app.get("/v1/contacts", requireRole("norium"), async (_request, response) => response.json(await invokeOpenWA("getAllContacts")));
app.get("/v1/groups", requireRole("norium"), async (_request, response) => {
  const chats = await invokeOpenWA<any[]>("getAllChats");
  response.json(chats.filter((chat: any) => Boolean(chat.isGroup || String(chat.id || "").endsWith("@g.us"))));
});
app.get("/v1/contacts/:id/profile-picture", requireRole("norium"), async (request, response) => {
  const contactId = normalizeChatId(String(request.params.id || ""));
  const value = await invokeOpenWA("getProfilePic", [contactId]);
  response.json({ value: value || null });
});
app.get("/v1/groups/:id", requireRole("norium"), async (request, response) => {
  const groupId = normalizeChatId(String(request.params.id || ""));
  response.json(await invokeOpenWA("getGroupInfo", [groupId]));
});

app.get("/v1/openwa/methods", requireRole("admin"), async (_request, response) => {
  response.json({ methods: await invokeOpenWA<string[]>("__methods", [], 15_000) });
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
    const { args } = rawPayload.parse(request.body);
    const result = await invokeOpenWA(method, args, 120_000);
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

async function stopOpenWAWorker(): Promise<void> {
  const target = openwaWorker;
  openwaWorker = null;
  rejectWorkerRequests("Processo do WhatsApp reiniciado.");
  if (target) await target.terminate().catch(() => undefined);
}

async function launchWhatsApp(): Promise<void> {
  await stopOpenWAWorker();
  sessionState = "starting";
  lastError = null;
  latestQr = null;
  try {
    // OpenWA 4 performs synchronous bootstrap work. Keeping it in a worker
    // prevents Chromium/session failures from blocking health checks or the API.
    const worker = new Worker(new URL("./openwa-worker.js", import.meta.url), {
      workerData: {
        sessionId: config.sessionId,
        sessionDataPath: config.sessionDataPath,
        chromePath: config.chromePath,
      },
    });
    openwaWorker = worker;

    worker.on("message", (message: Record<string, unknown>) => {
      if (message.type === "response") {
        const id = Number(message.id);
        const pending = workerRequests.get(id);
        if (!pending) return;
        workerRequests.delete(id);
        clearTimeout(pending.timer);
        if (message.ok === true) pending.resolve(message.result);
        else pending.reject(new Error(String(message.error || "Falha no processo do WhatsApp.")));
        return;
      }
      if (message.type === "qr" && typeof message.value === "string") {
        const value = message.value;
        if (value.startsWith("data:image/")) {
          latestQr = value;
          sessionState = "qr";
        } else {
          void QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 2, width: 360 })
            .then((dataUrl) => {
              latestQr = dataUrl;
              sessionState = "qr";
            })
            .catch((error) => logger.warn({ err: error }, "QR Code do OpenWA nao foi renderizado"));
        }
        return;
      }
      if (message.type === "state") {
        const state = String(message.state || "error");
        if (state === "connected") {
          sessionState = "connected";
          latestQr = null;
          lastError = null;
          connectedAt = new Date().toISOString();
          void dispatcher.enqueue("session-ready", { connectedAt });
        } else if (state === "disconnected") {
          sessionState = "disconnected";
          latestQr = null;
        } else if (state === "error") {
          sessionState = "error";
          latestQr = null;
          lastError = String(message.error || "Falha ao iniciar OpenWA.").slice(0, 500);
          logger.error({ workerError: lastError }, "OpenWA nao iniciou");
        }
        return;
      }
      if (message.type === "event" && typeof message.eventName === "string") {
        void dispatcher.enqueue(message.eventName, message.payload);
      }
    });

    worker.on("error", (error) => {
      if (openwaWorker !== worker) return;
      sessionState = "error";
      latestQr = null;
      lastError = error.message.slice(0, 500);
      rejectWorkerRequests("Processo do WhatsApp falhou.");
      logger.error({ err: error }, "Worker OpenWA falhou");
    });
    worker.on("exit", (code) => {
      if (openwaWorker !== worker) return;
      openwaWorker = null;
      rejectWorkerRequests("Processo do WhatsApp foi encerrado.");
      if (code !== 0) {
        sessionState = "error";
        latestQr = null;
        lastError = `Processo OpenWA encerrado com codigo ${code}.`;
      }
    });
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
  await stopOpenWAWorker();
  if (persistenceTimer) clearInterval(persistenceTimer);
  await persistence.save().catch(() => undefined);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
