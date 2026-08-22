import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import type { Client } from "@open-wa/client";
import type { OpenWAClient } from "@open-wa/core";

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

type OpenWAEvent<T = Record<string, unknown>> = {
  details?: T;
  error?: { message?: string };
};

const configuration = workerData as WorkerConfiguration;
const channel = parentPort;
const runtimeRequire = createRequire(import.meta.url);
let client: Client | null = null;
let core: OpenWAClient | null = null;
let verifiedConnected = false;
let qrPoller: NodeJS.Timeout | null = null;
let lastPolledQr: string | null = null;

const QR_SNAPSHOT_SCRIPT = `(() => {
  const webEntry = Array.from(document.querySelectorAll('a, button, [role="button"]'))
    .find((element) => String(element.textContent || '').toLowerCase().includes('whatsapp web'));
  if (webEntry && !webEntry.hasAttribute('data-norium-opened')) {
    webEntry.setAttribute('data-norium-opened', 'true');
    webEntry.click();
    return null;
  }
  const directRef = Array.from(document.querySelectorAll('[data-ref]'))
    .map((element) => element.getAttribute('data-ref'))
    .find((value) => typeof value === 'string' && value.length > 20);
  if (directRef) return directRef;
  const canvases = Array.from(document.querySelectorAll('canvas'));
  const qrCanvas = canvases.find((canvas) => {
    const label = String(canvas.getAttribute('aria-label') || '').toLowerCase();
    return label.includes('qr') || label.includes('scan');
  }) || canvases.find((canvas) => canvas.width >= 180 && canvas.height >= 180 && Math.abs(canvas.width - canvas.height) <= 24);
  if (!qrCanvas) return null;
  const dataRef = qrCanvas.closest('[data-ref]')?.getAttribute('data-ref')
    || qrCanvas.parentElement?.getAttribute('data-ref');
  if (dataRef) return dataRef;
  try { return qrCanvas.toDataURL('image/png'); } catch { return null; }
})()`;

if (!channel) throw new Error("Canal IPC do OpenWA indisponivel.");

function serializable(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}

function post(message: Record<string, unknown>): void {
  channel!.postMessage(serializable(message));
}

function stopQrPoller(): void {
  if (qrPoller) clearInterval(qrPoller);
  qrPoller = null;
}

function startQrPoller(openwa: OpenWAClient): void {
  stopQrPoller();
  qrPoller = setInterval(() => {
    void openwa.evaluateScript<string | null>(QR_SNAPSHOT_SCRIPT)
      .then((value) => {
        if (typeof value !== "string" || !value || value === lastPolledQr) return;
        lastPolledQr = value;
        post({ type: "qr", value });
      })
      .catch(() => undefined);
  }, 1_500);
  qrPoller.unref();
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
      // Alguns eventos ainda nao estao implementados no runtime v5 alpha.
    }
  }
}

channel.on("message", (message: InvokeMessage) => {
  if (message?.type !== "invoke") return;
  void (async () => {
    try {
      if (!client || !verifiedConnected) throw new Error("WhatsApp ainda nao esta conectado.");
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
    // The alpha ESM build resolves browser assets from a file:// stack path.
    // Its CJS export uses a filesystem path and works consistently on Windows/Linux.
    const { Client: OpenWAClientFacade } = runtimeRequire("@open-wa/client") as typeof import("@open-wa/client");
    const { createClient } = runtimeRequire("@open-wa/core") as typeof import("@open-wa/core");
    const { PuppeteerDriver } = runtimeRequire("@open-wa/driver-puppeteer") as typeof import("@open-wa/driver-puppeteer");

    const createdCore = await createClient({
      sessionId: configuration.sessionId,
      sessionDataPath: configuration.sessionDataPath,
      driver: new PuppeteerDriver(),
      headless: true,
      qrTimeoutMs: 0,
      authTimeoutMs: 0,
      blockCrashLogs: true,
      logConsole: false,
      logConsoleErrors: false,
      ...(configuration.chromePath ? { executablePath: configuration.chromePath } : {}),
    });
    core = createdCore;

    createdCore.events.on("launch.auth.qr.generated", (event: OpenWAEvent<{ qr?: string }>) => {
      const value = event.details?.qr;
      if (typeof value === "string" && value) post({ type: "qr", value });
    });
    createdCore.events.on("launch.auth.qr.scanned", () => {
      stopQrPoller();
      post({ type: "state", state: "starting" });
    });
    createdCore.events.on("session.state.changed", (event: OpenWAEvent<{ next?: string }>) => {
      const next = String(event.details?.next || "").toUpperCase();
      if (verifiedConnected && (next === "DISCONNECTED" || next === "STOPPED")) {
        verifiedConnected = false;
        post({ type: "state", state: "disconnected" });
      }
    });
    createdCore.events.on("session.connection.disconnected", () => {
      if (!verifiedConnected) return;
      verifiedConnected = false;
      post({ type: "state", state: "disconnected" });
    });
    createdCore.events.on("session.logout", () => {
      verifiedConnected = false;
      post({ type: "state", state: "disconnected" });
    });

    const createdClient = new OpenWAClientFacade({
      client: createdCore,
      transport: createdCore.getTransport(),
    });
    startQrPoller(createdCore);
    await createdClient.start();
    await createdClient.loaded();

    if (createdClient.getState() !== "READY") {
      throw new Error(`OpenWA finalizou sem prontidao confirmada (${createdClient.getState()}).`);
    }
    const hostNumber = String(await createdClient.getHostNumber()).trim();
    if (!hostNumber) throw new Error("OpenWA nao confirmou o numero autenticado.");

    client = createdClient;
    await registerEvents(createdClient);
    verifiedConnected = true;
    stopQrPoller();
    post({ type: "state", state: "connected", hostNumber });
  } catch (error) {
    stopQrPoller();
    verifiedConnected = false;
    client = null;
    await core?.stop("bootstrap_failed").catch(() => undefined);
    core = null;
    post({
      type: "state",
      state: "error",
      error: error instanceof Error ? error.message.slice(0, 500) : "Falha ao iniciar OpenWA.",
    });
  }
}

void launch();
