import { parentPort, workerData } from "node:worker_threads";
import type { Client } from "@open-wa/wa-automate";

type WorkerConfiguration = {
  sessionId: string;
  sessionDataPath: string;
  chromePath?: string;
};

type InvokeMessage = {
  type: "invoke";
  id: number;
  method: string;
  args: unknown[];
};

const configuration = workerData as WorkerConfiguration;
const channel = parentPort;
let client: Client | null = null;

if (!channel) throw new Error("Canal IPC do OpenWA indisponivel.");

function serializable(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}

function post(message: Record<string, unknown>): void {
  channel!.postMessage(serializable(message));
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
  const dynamic = instance as unknown as Record<string, unknown>;
  const listeners: Array<[string, string]> = [
    ["onMessage", "message"], ["onAnyMessage", "any-message"], ["onAck", "ack"],
    ["onAddedToGroup", "group-added"], ["onParticipantsChanged", "group-participants"],
    ["onIncomingCall", "incoming-call"], ["onButton", "button"],
    ["onPollVote", "poll-vote"], ["onReaction", "reaction"],
  ];
  for (const [method, eventName] of listeners) {
    const target = dynamic[method];
    if (typeof target !== "function") continue;
    try {
      await Reflect.apply(target, dynamic, [(payload: unknown) => post({ type: "event", eventName, payload })]);
    } catch {
      // Nem todos os eventos existem em todas as revisoes do WhatsApp Web.
    }
  }
}

channel.on("message", (message: InvokeMessage) => {
  if (message?.type !== "invoke") return;
  void (async () => {
    try {
      if (!client) throw new Error("WhatsApp ainda nao esta conectado.");
      if (message.method === "__methods") {
        post({ type: "response", id: message.id, ok: true, result: availableMethods(client) });
        return;
      }
      if (!/^[a-zA-Z][a-zA-Z0-9]{1,80}$/.test(message.method) || message.method.startsWith("on")) {
        throw new Error("Metodo OpenWA nao permitido.");
      }
      const instance = client as unknown as Record<string, unknown>;
      const target = instance[message.method];
      if (typeof target !== "function") throw new Error("Metodo OpenWA desconhecido.");
      const result = await Reflect.apply(target, instance, Array.isArray(message.args) ? message.args : []);
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
    const { create, ev } = await import("@open-wa/wa-automate");
    ev.on(`qr.${configuration.sessionId}`, (value: unknown) => {
      if (typeof value === "string" && value) post({ type: "qr", value });
    });

    const created = await create({
      sessionId: configuration.sessionId,
      sessionDataPath: configuration.sessionDataPath,
      headless: true,
      authTimeout: 0,
      qrTimeout: 0,
      qrLogSkip: true,
      disableSpins: true,
      logConsole: false,
      logConsoleErrors: false,
      blockCrashLogs: true,
      multiDevice: true,
      skipUpdateCheck: true,
      killProcessOnTimeout: false,
      killProcessOnBrowserClose: false,
      ...(configuration.chromePath ? { executablePath: configuration.chromePath } : {}),
    });

    client = created;
    await created.onStateChanged((state) => {
      const next = String(state).toUpperCase();
      if (next === "DISCONNECTED" || next === "CONFLICT" || next === "UNPAIRED") {
        post({ type: "state", state: "disconnected" });
      }
    });
    await registerEvents(created);
    post({ type: "state", state: "connected" });
  } catch (error) {
    post({
      type: "state",
      state: "error",
      error: error instanceof Error ? error.message.slice(0, 500) : "Falha ao iniciar OpenWA.",
    });
  }
}

void launch();
