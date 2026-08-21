import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function secret(name: string): string {
  const value = (process.env[name] || "").trim();
  if (process.env.NODE_ENV === "production" && value.length < 32) {
    throw new Error(`${name} precisa ter ao menos 32 caracteres em producao.`);
  }
  return value;
}

const sessionDataPath = resolve(process.env.SESSION_DATA_PATH || "./data/sessions");
const persistenceRoot = resolve(process.env.PERSISTENCE_ROOT || "./data");
mkdirSync(sessionDataPath, { recursive: true, mode: 0o700 });

export const config = {
  environment: process.env.NODE_ENV || "development",
  port: integerEnv("PORT", 8080, 1, 65535),
  sessionId: (process.env.SESSION_ID || "norium").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80),
  sessionDataPath,
  persistenceRoot,
  persistenceBlobUrl: (process.env.PERSISTENCE_BLOB_URL || "").trim(),
  persistenceIntervalMs: integerEnv("PERSISTENCE_INTERVAL_SECONDS", 30, 10, 300) * 1000,
  chromePath: (process.env.CHROME_PATH || "").trim(),
  noriumApiKey: secret("NORIUM_API_KEY"),
  adminApiKey: secret("ADMIN_API_KEY"),
  webhookHmacSecret: secret("WEBHOOK_HMAC_SECRET"),
  noriumWebhookUrl: (process.env.NORIUM_WEBHOOK_URL || "").trim(),
  noriumWebhookSecret: (process.env.NORIUM_WEBHOOK_SECRET || "").trim(),
  trustProxy: integerEnv("TRUST_PROXY", 1, 0, 3),
  rateLimitPerMinute: integerEnv("RATE_LIMIT_PER_MINUTE", 120, 10, 2000),
  sendRateLimitPerMinute: integerEnv("SEND_RATE_LIMIT_PER_MINUTE", 30, 1, 600),
  maxBodyMb: integerEnv("MAX_BODY_MB", 25, 1, 48),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL || "info",
  outboxPath: resolve(process.env.OUTBOX_PATH || "./data/outbox"),
};

if (config.environment === "production" && config.noriumWebhookUrl) {
  const url = new URL(config.noriumWebhookUrl);
  if (url.protocol !== "https:") throw new Error("NORIUM_WEBHOOK_URL deve usar HTTPS em producao.");
}
if (config.environment === "production" && config.persistenceBlobUrl) {
  const url = new URL(config.persistenceBlobUrl);
  if (url.protocol !== "https:") throw new Error("PERSISTENCE_BLOB_URL deve usar HTTPS em producao.");
}

mkdirSync(config.outboxPath, { recursive: true, mode: 0o700 });
