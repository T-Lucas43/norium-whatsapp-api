import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import QRCode from "qrcode";
import { config } from "./config.js";
import type { SessionContext } from "./security.js";
import type { WebhookDispatcher } from "./webhook.js";
import type { BlobPersistence } from "./persistence.js";

export type SessionState = "starting" | "qr" | "connected" | "disconnected" | "error";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type SessionRuntime = SessionContext & {
  worker: Worker | null;
  launchPromise: Promise<void> | null;
  latestQr: string | null;
  state: SessionState;
  lastError: string | null;
  connectedAt: string | null;
  hostNumber: string | null;
  requestSequence: number;
  requests: Map<number, PendingRequest>;
  lastUsedAt: number;
  nextLaunchAt: number;
};

export type SessionStatus = {
  sessionId: string;
  state: SessionState;
  connected: boolean;
  connectedAt: string | null;
  hostNumber: string | null;
  lastError: string | null;
};

type Logger = {
  info: (payload: unknown, message?: string) => void;
  warn: (payload: unknown, message?: string) => void;
  error: (payload: unknown, message?: string) => void;
};

export class WhatsAppSessionManager {
  private readonly sessions = new Map<string, SessionRuntime>();

  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly persistence: BlobPersistence,
    private readonly logger: Logger,
  ) {}

  status(context: SessionContext, start = true): SessionStatus {
    const runtime = this.ensure(context, start || this.shouldResume(context));
    return this.publicStatus(runtime);
  }

  qr(context: SessionContext): { state: SessionState; qr: string | null } {
    const runtime = this.ensure(context, false);
    return { state: runtime.state, qr: runtime.state === "qr" ? runtime.latestQr : null };
  }

  health(): { total: number; connected: number; starting: number; qr: number; error: number } {
    const states = [...this.sessions.values()].map((runtime) => runtime.state);
    return {
      total: states.length,
      connected: states.filter((state) => state === "connected").length,
      starting: states.filter((state) => state === "starting").length,
      qr: states.filter((state) => state === "qr").length,
      error: states.filter((state) => state === "error").length,
    };
  }

  async invoke<T>(context: SessionContext, method: string, args: unknown[] = [], timeoutMs = 60_000): Promise<T> {
    const runtime = this.ensure(context, true);
    runtime.lastUsedAt = Date.now();
    if (!runtime.worker || runtime.state !== "connected") {
      const error = new Error("WhatsApp ainda nao esta conectado.") as Error & { status?: number };
      error.status = 503;
      throw error;
    }
    const target = runtime.worker;
    const id = ++runtime.requestSequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.requests.delete(id);
        reject(new Error(`Operacao ${method} excedeu o tempo limite.`));
      }, timeoutMs);
      timer.unref();
      runtime.requests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      target.postMessage({ type: "invoke", id, method, args });
    });
  }

  async reconnect(context: SessionContext): Promise<SessionStatus> {
    await unlink(this.disabledMarker(context)).catch(() => undefined);
    const runtime = this.ensure(context, false);
    runtime.nextLaunchAt = 0;
    if (runtime.worker && ["starting", "qr", "connected"].includes(runtime.state)) {
      return this.publicStatus(runtime);
    }
    if (!runtime.launchPromise) runtime.launchPromise = this.launch(runtime);
    return this.publicStatus(runtime);
  }

  async logout(context: SessionContext): Promise<void> {
    const runtime = this.ensure(context, false);
    if (runtime.worker && runtime.state === "connected") {
      await this.invoke(context, "logout", [false], 20_000).catch(() => undefined);
    }
    await this.stop(runtime, "Sessao encerrada.");
    runtime.state = "disconnected";
    runtime.latestQr = null;
    runtime.connectedAt = null;
    runtime.hostNumber = null;
    runtime.lastError = null;
    const marker = this.disabledMarker(context);
    await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
    await writeFile(marker, new Date().toISOString(), { mode: 0o600 });
    await this.persistence.save().catch((error) => this.logger.warn({ err: error }, "Falha ao persistir logout"));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((runtime) => this.stop(runtime, "API encerrada.")));
  }

  private ensure(context: SessionContext, start: boolean): SessionRuntime {
    const existing = this.sessions.get(context.sessionId);
    if (existing) {
      if (existing.userId !== context.userId) {
        const error = new Error("Sessao pertence a outro usuario.") as Error & { status?: number };
        error.status = 403;
        throw error;
      }
      existing.lastUsedAt = Date.now();
      if (start && !existing.worker && !existing.launchPromise && Date.now() >= existing.nextLaunchAt) {
        existing.launchPromise = this.launch(existing);
      }
      return existing;
    }

    if (this.sessions.size >= config.maxActiveSessions) {
      const disposable = [...this.sessions.values()]
        .filter((runtime) => !runtime.worker && runtime.state === "disconnected")
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (disposable) this.sessions.delete(disposable.sessionId);
    }
    if (this.sessions.size >= config.maxActiveSessions) {
      const error = new Error("Limite seguro de sessoes simultaneas atingido.") as Error & { status?: number };
      error.status = 503;
      throw error;
    }

    const runtime: SessionRuntime = {
      ...context,
      worker: null,
      launchPromise: null,
      latestQr: null,
      state: start ? "starting" : "disconnected",
      lastError: null,
      connectedAt: null,
      hostNumber: null,
      requestSequence: 0,
      requests: new Map(),
      lastUsedAt: Date.now(),
      nextLaunchAt: 0,
    };
    this.sessions.set(context.sessionId, runtime);
    if (start) runtime.launchPromise = this.launch(runtime);
    return runtime;
  }

  private publicStatus(runtime: SessionRuntime): SessionStatus {
    return {
      sessionId: runtime.sessionId,
      state: runtime.state,
      connected: runtime.state === "connected",
      connectedAt: runtime.connectedAt,
      hostNumber: runtime.hostNumber,
      lastError: runtime.lastError,
    };
  }

  private sessionRoot(context: SessionContext): string {
    return context.sessionId === config.legacySessionId
      ? config.sessionDataPath
      : join(config.sessionDataPath, context.sessionId);
  }

  private disabledMarker(context: SessionContext): string {
    return context.sessionId === config.legacySessionId
      ? join(config.sessionDataPath, `.norium-disabled-${context.sessionId}`)
      : join(this.sessionRoot(context), ".norium-disabled");
  }

  private shouldResume(context: SessionContext): boolean {
    if (existsSync(this.disabledMarker(context))) return false;
    return existsSync(join(this.sessionRoot(context), `_IGNORE_${context.sessionId}`));
  }

  private rejectRequests(runtime: SessionRuntime, message: string): void {
    for (const pending of runtime.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    runtime.requests.clear();
  }

  private async stop(runtime: SessionRuntime, reason: string): Promise<void> {
    const target = runtime.worker;
    runtime.worker = null;
    this.rejectRequests(runtime, reason);
    if (target) await target.terminate().catch(() => undefined);
  }

  private async launch(runtime: SessionRuntime): Promise<void> {
    await this.stop(runtime, "Processo do WhatsApp reiniciado.");
    runtime.state = "starting";
    runtime.lastError = null;
    runtime.latestQr = null;
    runtime.hostNumber = null;
    try {
      const worker = new Worker(new URL("./openwa-worker.js", import.meta.url), {
        workerData: {
          sessionId: runtime.sessionId,
          sessionDataPath: this.sessionRoot(runtime),
          chromePath: config.chromePath,
        },
      });
      runtime.worker = worker;

      worker.on("message", (message: Record<string, unknown>) => {
        if (runtime.worker !== worker) return;
        if (message.type === "response") {
          const id = Number(message.id);
          const pending = runtime.requests.get(id);
          if (!pending) return;
          runtime.requests.delete(id);
          clearTimeout(pending.timer);
          if (message.ok === true) pending.resolve(message.result);
          else pending.reject(new Error(String(message.error || "Falha no processo do WhatsApp.")));
          return;
        }
        if (message.type === "qr" && typeof message.value === "string") {
          const value = message.value;
          if (value.startsWith("data:image/")) {
            runtime.latestQr = value;
            runtime.state = "qr";
          } else {
            void QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 2, width: 360 })
              .then((dataUrl) => {
                if (runtime.worker !== worker) return;
                runtime.latestQr = dataUrl;
                runtime.state = "qr";
              })
              .catch((error) => this.logger.warn({ err: error, sessionId: runtime.sessionId }, "QR Code nao foi renderizado"));
          }
          return;
        }
        if (message.type === "state") {
          const state = String(message.state || "error");
          if (state === "starting") {
            runtime.state = "starting";
            runtime.latestQr = null;
          } else if (state === "connected") {
            runtime.state = "connected";
            runtime.latestQr = null;
            runtime.lastError = null;
            runtime.connectedAt = new Date().toISOString();
            runtime.hostNumber = String(message.hostNumber || "") || null;
            runtime.nextLaunchAt = 0;
            void unlink(this.disabledMarker(runtime)).catch(() => undefined);
            void this.persistence.save().catch((error) => this.logger.warn({ err: error }, "Falha ao persistir sessao conectada"));
            void this.dispatcher.enqueue(runtime, "session-ready", { connectedAt: runtime.connectedAt });
          } else if (state === "disconnected") {
            runtime.state = "disconnected";
            runtime.latestQr = null;
            runtime.nextLaunchAt = Date.now() + 5_000;
            void this.stop(runtime, "Conexao do WhatsApp interrompida.");
          } else {
            runtime.state = "error";
            runtime.latestQr = null;
            runtime.lastError = String(message.error || "Falha ao iniciar OpenWA.").slice(0, 500);
            runtime.nextLaunchAt = Date.now() + 10_000;
            this.logger.error({ sessionId: runtime.sessionId, workerError: runtime.lastError }, "OpenWA nao iniciou");
            void this.stop(runtime, runtime.lastError);
          }
          return;
        }
        if (message.type === "event" && typeof message.eventName === "string") {
          void this.dispatcher.enqueue(runtime, message.eventName, message.payload);
        }
      });

      worker.on("error", (error) => {
        if (runtime.worker !== worker) return;
        runtime.state = "error";
        runtime.latestQr = null;
        runtime.lastError = error.message.slice(0, 500);
        runtime.nextLaunchAt = Date.now() + 10_000;
        this.rejectRequests(runtime, "Processo do WhatsApp falhou.");
        this.logger.error({ err: error, sessionId: runtime.sessionId }, "Worker OpenWA falhou");
      });
      worker.on("exit", (code) => {
        if (runtime.worker !== worker) return;
        runtime.worker = null;
        this.rejectRequests(runtime, "Processo do WhatsApp foi encerrado.");
        if (code !== 0 && runtime.state !== "disconnected") {
          runtime.state = "error";
          runtime.latestQr = null;
          runtime.lastError = `Processo OpenWA encerrado com codigo ${code}.`;
          runtime.nextLaunchAt = Date.now() + 10_000;
        }
      });
    } catch (error) {
      runtime.state = "error";
      runtime.lastError = error instanceof Error ? error.message.slice(0, 500) : "Falha ao iniciar OpenWA.";
      runtime.nextLaunchAt = Date.now() + 10_000;
      this.logger.error({ err: error, sessionId: runtime.sessionId }, "OpenWA nao iniciou");
    } finally {
      runtime.launchPromise = null;
    }
  }
}
