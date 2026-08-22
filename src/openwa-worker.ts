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

const CURRENT_WA_COMPATIBILITY_SCRIPT = `(() => {
  if (!window.WAPI) return false;

  const getSocket = () => window.Store?.State?.Socket
    || window.Store?.State?.default
    || (() => { try { return window.require?.('WAWebSocketModel')?.Socket; } catch { return null; } })();
  const readState = () => {
    const socket = getSocket();
    const socketState = socket?.state || socket?.stream;
    if (typeof socketState === 'string' && socketState) return socketState;
    const authenticated = Boolean(
      window.WA_AUTHENTICATED
      || document.querySelector('#pane-side')
      || document.querySelector('[data-testid="chat-list-search"]')
      || (window.Store?.Chat && !document.querySelector('[data-ref]'))
    );
    return authenticated ? 'CONNECTED' : 'UNPAIRED';
  };

  window.__NORIUM_STATE_CALLBACKS__ = window.__NORIUM_STATE_CALLBACKS__ || new Set();
  window.WAPI.onStateChanged = function (callback) {
    window.__NORIUM_STATE_CALLBACKS__.add(callback);
    const socket = getSocket();
    if (socket?.on && !socket.__NORIUM_STATE_BRIDGE__) {
      const emit = (payload) => {
        const next = payload?.state || payload?.stream || readState();
        window.__NORIUM_STATE_CALLBACKS__.forEach((listener) => {
          try { listener(next); } catch {}
        });
      };
      socket.on('change:state', emit);
      socket.on('change:stream', emit);
      socket.__NORIUM_STATE_BRIDGE__ = true;
    }
    if (!window.__NORIUM_STATE_TIMER__) {
      let previous = readState();
      window.__NORIUM_STATE_TIMER__ = setInterval(() => {
        const next = readState();
        if (next === previous) return;
        previous = next;
        window.__NORIUM_STATE_CALLBACKS__.forEach((listener) => {
          try { listener(next); } catch {}
        });
      }, 1000);
    }
    return true;
  };
  window.WAPI.getState = readState;
  window.WAPI.getConnectionState = readState;
  window.WAPI.getHostNumber = function () {
    const value = window.Store?.Me?.me?.user
      || window.Store?.Me?.wid?.user
      || window.Store?.Me?.attributes?.wid?.user
      || localStorage.getItem('last-wid-md')
      || '';
    return String(value).replace(/["']/g, '').split('@')[0].split(':')[0];
  };
  return true;
})()`;

const CHAT_CATALOG_SCRIPT = `(() => {
  const modelsOf = (collection) => {
    if (Array.isArray(collection?.models)) return collection.models;
    if (Array.isArray(collection?._models)) return collection._models;
    return [];
  };
  const serializedId = (value) => String(value?._serialized || value?.id?._serialized || value || '');
  const timestampOf = (value) => Number(value?.t || value?.timestamp || value?.id?.t || 0) || 0;
  const labelFor = (type) => ({
    image: '[Imagem]', video: '[Video]', audio: '[Audio]', ptt: '[Audio]',
    document: '[Documento]', sticker: '[Figurinha]', location: '[Localizacao]',
    contact: '[Contato]', vcard: '[Contato]'
  }[String(type || '').toLowerCase()] || '[Mensagem]');
  const chats = modelsOf(window.Store?.Chat).map((chat) => {
    const id = serializedId(chat?.id);
    const contact = chat?.contact || {};
    const allMessages = modelsOf(chat?.msgs);
    const messages = allMessages.slice(-20).map((message) => {
      const type = String(message?.type || 'chat');
      const content = String(message?.body || message?.caption || labelFor(type));
      return {
        id: serializedId(message?.id) || ('history-' + id + '-' + timestampOf(message)),
        fromMe: Boolean(message?.id?.fromMe || message?.fromMe),
        timestamp: timestampOf(message),
        content: content.slice(0, 65536),
        type,
        senderName: String(message?.senderObj?.formattedName || message?.senderObj?.pushname || '')
      };
    }).filter((message) => message.timestamp > 0);
    const latest = messages[messages.length - 1];
    const photo = contact?.profilePicThumb || {};
    return {
      id,
      phone: id,
      jid: id,
      name: String(chat?.formattedTitle || chat?.name || contact?.formattedName || contact?.name || contact?.pushname || id),
      formattedTitle: String(chat?.formattedTitle || ''),
      pushname: String(contact?.pushname || ''),
      isGroup: Boolean(chat?.isGroup || id.endsWith('@g.us')),
      unreadCount: Number(chat?.unreadCount || 0) || 0,
      timestamp: latest?.timestamp || timestampOf(chat),
      lastMessage: latest?.content || '',
      photoUrl: String(photo?.eurl || photo?.imgFull || photo?.img || ''),
      messages
    };
  }).filter((chat) => chat.id && !chat.id.endsWith('@broadcast'));
  chats.sort((left, right) => right.timestamp - left.timestamp);
  return chats.slice(0, 250);
})()`;

const CONTACT_CATALOG_SCRIPT = `(() => {
  const models = Array.isArray(window.Store?.Contact?.models)
    ? window.Store.Contact.models
    : (Array.isArray(window.Store?.Contact?._models) ? window.Store.Contact._models : []);
  return models.slice(0, 2000).map((contact) => {
    const id = String(contact?.id?._serialized || contact?.id || '');
    const photo = contact?.profilePicThumb || {};
    return {
      id,
      phone: id,
      jid: id,
      name: String(contact?.formattedName || contact?.name || contact?.pushname || id),
      formattedName: String(contact?.formattedName || ''),
      verifiedName: String(contact?.verifiedName || ''),
      pushname: String(contact?.pushname || ''),
      photoUrl: String(photo?.eurl || photo?.imgFull || photo?.img || '')
    };
  }).filter((contact) => contact.id);
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

async function installCurrentWACompatibility(openwa: OpenWAClient): Promise<void> {
  const installed = await openwa.evaluateScript<boolean>(CURRENT_WA_COMPATIBILITY_SCRIPT);
  if (!installed) throw new Error("Runtime do WhatsApp nao estava disponivel para compatibilidade.");
}

function keepCompatibilityAfterOpenWAReinjection(openwa: OpenWAClient): void {
  const transport = openwa.getTransport() as unknown as Record<string, unknown>;
  for (const methodName of ["performRuntimeInjection", "applyLivePatchArtifacts", "applyDeferredInitPatchArtifact"]) {
    const original = transport[methodName];
    if (typeof original !== "function") continue;
    transport[methodName] = async (...args: unknown[]) => {
      const result = await Reflect.apply(original, transport, args);
      await installCurrentWACompatibility(openwa);
      return result;
    };
  }
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
      if (message.method === "__noriumChatCatalog") {
        if (!core) throw new Error("Runtime do WhatsApp indisponivel.");
        const result = await core.evaluateScript<unknown[]>(CHAT_CATALOG_SCRIPT);
        post({ type: "response", id: message.id, ok: true, result });
        return;
      }
      if (message.method === "__noriumContactCatalog") {
        if (!core) throw new Error("Runtime do WhatsApp indisponivel.");
        const result = await core.evaluateScript<unknown[]>(CONTACT_CATALOG_SCRIPT);
        post({ type: "response", id: message.id, ok: true, result });
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
    keepCompatibilityAfterOpenWAReinjection(createdCore);

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
