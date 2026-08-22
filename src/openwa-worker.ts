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

type ShutdownMessage = {
  type: "shutdown";
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
let disconnectTimer: NodeJS.Timeout | null = null;
let bootstrapRetryTimer: NodeJS.Timeout | null = null;
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
    contact: '[Contato]', vcard: '[Contato]', poll_creation: '[Enquete]'
  }[String(type || '').toLowerCase()] || '[Mensagem]');
  const ackStatus = (ack) => {
    const value = Number(ack);
    if (value < 0) return 'erro';
    if (value === 0) return 'pendente';
    if (value === 1) return 'enviado';
    if (value === 2) return 'entregue';
    if (value === 3) return 'lido';
    if (value >= 4) return 'reproduzido';
    return 'enviado';
  };
  const reactionsOf = (message) => {
    const groups = Array.isArray(message?.reactions) ? message.reactions : [];
    return groups.map((group) => {
      const emoji = String(group?.aggregateEmoji || group?.emoji || '');
      const senders = Array.isArray(group?.senders) ? group.senders : [];
      return {
        emoji,
        count: Number(group?.count || senders.length || 1),
        fromMe: Boolean(group?.hasReactionByMe),
        senders: senders.map((sender) => String(sender?.senderUserJid || sender?.senderId || '')).filter(Boolean)
      };
    }).filter((reaction) => reaction.emoji);
  };
  const normalizeMessage = (message, chatId) => {
    const type = String(message?.type || 'chat').toLowerCase();
    const timestamp = timestampOf(message);
    const sender = message?.senderObj || message?.sender || {};
    const quoted = message?.quotedMsg || message?.quotedMsgObj || null;
    const rawText = String(message?.text || message?.caption || message?.content || (type === 'chat' ? message?.body || '' : ''));
    const senderId = serializedId(message?.author || message?.senderId || sender?.id || message?.from);
    const ack = Number.isFinite(Number(message?.ack)) ? Number(message.ack) : null;
    return {
      id: serializedId(message?.id) || ('history-' + chatId + '-' + timestamp),
      chatId,
      isGroup: chatId.endsWith('@g.us'),
      fromMe: Boolean(message?.id?.fromMe || message?.fromMe || message?.self === 'out'),
      timestamp,
      content: String(rawText || labelFor(type)).slice(0, 65536),
      text: rawText.slice(0, 65536),
      caption: String(message?.caption || '').slice(0, 4096),
      type,
      senderId,
      senderName: String(sender?.formattedName || sender?.pushname || sender?.name || message?.notifyName || ''),
      mimetype: String(message?.mimetype || message?.mediaData?.mimetype || ''),
      filename: String(message?.filename || ''),
      duration: Number(message?.duration || message?.mediaData?.duration || 0) || 0,
      ack,
      status: ackStatus(ack),
      isMedia: Boolean(message?.isMedia || ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(type)),
      mediaAvailable: Boolean(message?.isMedia || message?.deprecatedMms3Url || message?.clientUrl || message?.filehash),
      reactions: reactionsOf(message),
      quoted: quoted ? {
        id: serializedId(quoted?.id),
        content: String(quoted?.text || quoted?.caption || quoted?.content || quoted?.body || labelFor(quoted?.type)).slice(0, 512),
        senderName: String(quoted?.sender?.formattedName || quoted?.sender?.pushname || quoted?.notifyName || ''),
        type: String(quoted?.type || 'chat')
      } : null
    };
  };
  const chats = modelsOf(window.Store?.Chat).map((chat) => {
    const id = serializedId(chat?.id);
    const contact = chat?.contact || {};
    const allMessages = modelsOf(chat?.msgs);
    const messages = allMessages.slice(-25).map((message) => normalizeMessage(message, id))
      .filter((message) => message.timestamp > 0 && !message.type.includes('notification'));
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
      lastMessageType: latest?.type || '',
      photoUrl: String(photo?.eurl || photo?.imgFull || photo?.img || ''),
      messages
    };
  }).filter((chat) => chat.id && !chat.id.endsWith('@broadcast'));
  chats.sort((left, right) => right.timestamp - left.timestamp);
  return chats.slice(0, 500);
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
      photoUrl: String(photo?.eurl || photo?.imgFull || photo?.img || ''),
      bio: String(contact?.status?.status || contact?.status?.text || contact?.status || contact?.about || ''),
      isBusiness: Boolean(contact?.isBusiness || contact?.isEnterprise),
      isMyContact: Boolean(contact?.isMyContact),
      isBlocked: Boolean(contact?.isBlocked)
    };
  }).filter((contact) => contact.id);
})()`;

function contactDetailsScript(contactId: string): string {
  return `(() => {
    const contactId = ${JSON.stringify(contactId)};
    const contact = window.Store?.Contact?.get?.(contactId)
      || (window.Store?.Contact?.models || window.Store?.Contact?._models || [])
        .find((item) => String(item?.id?._serialized || item?.id || '') === contactId);
    if (!contact) return null;
    const id = String(contact?.id?._serialized || contact?.id || contactId);
    const photo = contact?.profilePicThumb || {};
    return {
      id,
      phone: id,
      name: String(contact?.formattedName || contact?.name || contact?.pushname || id),
      formattedName: String(contact?.formattedName || ''),
      pushname: String(contact?.pushname || ''),
      verifiedName: String(contact?.verifiedName || ''),
      photoUrl: String(photo?.eurl || photo?.imgFull || photo?.img || ''),
      bio: String(contact?.status?.status || contact?.status?.text || contact?.status || contact?.about || ''),
      isBusiness: Boolean(contact?.isBusiness || contact?.isEnterprise),
      isMyContact: Boolean(contact?.isMyContact),
      isBlocked: Boolean(contact?.isBlocked)
    };
  })()`;
}

function groupDetailsScript(groupId: string): string {
  return `(() => {
    const groupId = ${JSON.stringify(groupId)};
    const serializedId = (value) => String(value?._serialized || value?.id?._serialized || value || '');
    const modelsOf = (collection) => Array.isArray(collection?.models)
      ? collection.models
      : (Array.isArray(collection?._models) ? collection._models : []);
    const chat = window.Store?.Chat?.get?.(groupId)
      || modelsOf(window.Store?.Chat).find((item) => serializedId(item?.id) === groupId);
    if (!chat) return null;
    const metadata = chat?.groupMetadata || {};
    const photo = chat?.contact?.profilePicThumb || {};
    const participants = modelsOf(metadata?.participants).map((participant) => {
      const id = serializedId(participant?.id || participant?.contact?.id);
      const contact = participant?.contact || window.Store?.Contact?.get?.(id) || {};
      const participantPhoto = contact?.profilePicThumbObj || contact?.profilePicThumb || {};
      return {
        id,
        phone: id,
        name: String(contact?.formattedName || contact?.name || contact?.pushname || id),
        photoUrl: String(participantPhoto?.eurl || participantPhoto?.imgFull || participantPhoto?.img || ''),
        isAdmin: Boolean(participant?.isAdmin),
        isSuperAdmin: Boolean(participant?.isSuperAdmin)
      };
    }).filter((participant) => participant.id);
    return {
      id: groupId,
      subject: String(metadata?.subject || chat?.formattedTitle || chat?.name || groupId),
      name: String(metadata?.subject || chat?.formattedTitle || chat?.name || groupId),
      description: String(metadata?.desc || metadata?.description || ''),
      owner: serializedId(metadata?.owner),
      createdAt: Number(metadata?.creation || metadata?.createdAt || 0) || null,
      participants,
      participantCount: participants.length,
      photoUrl: String(photo?.eurl || photo?.imgFull || photo?.img || '')
    };
  })()`;
}

function profilePictureScript(contactId: string): string {
  return `(() => {
    const contactId = ${JSON.stringify(contactId)};
    const contact = window.Store?.Contact?.get?.(contactId)
      || (window.Store?.Contact?.models || window.Store?.Contact?._models || [])
        .find((item) => String(item?.id?._serialized || item?.id || '') === contactId);
    const chat = window.Store?.Chat?.get?.(contactId);
    const photo = contact?.profilePicThumbObj || contact?.profilePicThumb
      || chat?.contact?.profilePicThumbObj || chat?.contact?.profilePicThumb || {};
    return String(photo?.eurl || photo?.imgFull || photo?.img || '');
  })()`;
}

function messageCatalogScript(chatId: string, before: number | null, limit: number): string {
  return `(() => {
    const chatId = ${JSON.stringify(chatId)};
    const before = ${before === null ? "null" : String(before)};
    const limit = ${limit};
    const chat = window.Store?.Chat?.get?.(chatId)
      || (window.Store?.Chat?.models || window.Store?.Chat?._models || []).find((item) => String(item?.id?._serialized || item?.id || '') === chatId);
    const models = Array.isArray(chat?.msgs?.models) ? chat.msgs.models : (Array.isArray(chat?.msgs?._models) ? chat.msgs._models : []);
    const timestampOf = (value) => Number(value?.t || value?.timestamp || value?.id?.t || 0) || 0;
    const serializedId = (value) => String(value?._serialized || value?.id?._serialized || value || '');
    const labelFor = (type) => ({ image: '[Imagem]', video: '[Video]', audio: '[Audio]', ptt: '[Audio]', document: '[Documento]', sticker: '[Figurinha]', location: '[Localizacao]', contact: '[Contato]', vcard: '[Contato]', poll_creation: '[Enquete]' }[String(type || '').toLowerCase()] || '[Mensagem]');
    const ackStatus = (ack) => {
      const value = Number(ack);
      if (value < 0) return 'erro';
      if (value === 0) return 'pendente';
      if (value === 1) return 'enviado';
      if (value === 2) return 'entregue';
      if (value === 3) return 'lido';
      if (value >= 4) return 'reproduzido';
      return 'enviado';
    };
    const reactionsOf = (message) => {
      const groups = Array.isArray(message?.reactions) ? message.reactions : [];
      return groups.map((group) => {
        const emoji = String(group?.aggregateEmoji || group?.emoji || '');
        const senders = Array.isArray(group?.senders) ? group.senders : [];
        return { emoji, count: Number(group?.count || senders.length || 1), fromMe: Boolean(group?.hasReactionByMe), senders: senders.map((sender) => String(sender?.senderUserJid || sender?.senderId || '')).filter(Boolean) };
      }).filter((reaction) => reaction.emoji);
    };
    const eligible = models.filter((message) => !before || timestampOf(message) < before);
    const selected = eligible.slice(-limit);
    const items = selected.map((message) => {
      const type = String(message?.type || 'chat').toLowerCase();
      const sender = message?.senderObj || message?.sender || {};
      const quoted = message?.quotedMsg || message?.quotedMsgObj || null;
      const rawText = String(message?.text || message?.caption || message?.content || (type === 'chat' ? message?.body || '' : ''));
      const ack = Number.isFinite(Number(message?.ack)) ? Number(message.ack) : null;
      return {
        id: serializedId(message?.id) || ('history-' + chatId + '-' + timestampOf(message)),
        chatId,
        isGroup: chatId.endsWith('@g.us'),
        fromMe: Boolean(message?.id?.fromMe || message?.fromMe || message?.self === 'out'),
        timestamp: timestampOf(message),
        content: String(rawText || labelFor(type)).slice(0, 65536),
        text: rawText.slice(0, 65536),
        caption: String(message?.caption || '').slice(0, 4096),
        type,
        senderId: serializedId(message?.author || message?.senderId || sender?.id || message?.from),
        senderName: String(sender?.formattedName || sender?.pushname || sender?.name || message?.notifyName || ''),
        mimetype: String(message?.mimetype || message?.mediaData?.mimetype || ''),
        filename: String(message?.filename || ''),
        duration: Number(message?.duration || message?.mediaData?.duration || 0) || 0,
        ack,
        status: ackStatus(ack),
        isMedia: Boolean(message?.isMedia || ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(type)),
        mediaAvailable: Boolean(message?.isMedia || message?.deprecatedMms3Url || message?.clientUrl || message?.filehash),
        reactions: reactionsOf(message),
        quoted: quoted ? {
          id: serializedId(quoted?.id),
          content: String(quoted?.text || quoted?.caption || quoted?.content || quoted?.body || labelFor(quoted?.type)).slice(0, 512),
          senderName: String(quoted?.sender?.formattedName || quoted?.sender?.pushname || quoted?.notifyName || ''),
          type: String(quoted?.type || 'chat')
        } : null
      };
    }).filter((message) => message.timestamp > 0 && !message.type.includes('notification'));
    return { items, cursor: items.length ? items[0].timestamp : null, hasMore: eligible.length > selected.length };
  })()`;
}

function mediaMessageScript(messageId: string, chatId: string | null): string {
  return `(async () => {
    const messageId = ${JSON.stringify(messageId)};
    const chatId = ${JSON.stringify(chatId)};
    const modelsOf = (collection) => Array.isArray(collection?.models)
      ? collection.models
      : (Array.isArray(collection?._models) ? collection._models : []);
    const serializedId = (value) => String(value?._serialized || value?.id?._serialized || value || '');
    const findIn = (collection) => modelsOf(collection).find((item) => serializedId(item?.id) === messageId);
    const chats = modelsOf(window.Store?.Chat);
    const targetChat = chatId
      ? (window.Store?.Chat?.get?.(chatId) || chats.find((item) => serializedId(item?.id) === chatId))
      : null;
    const findMessage = () => window.Store?.Msg?.get?.(messageId)
      || findIn(window.Store?.Msg)
      || findIn(targetChat?.msgs)
      || chats.map((chat) => findIn(chat?.msgs)).find(Boolean)
      || null;

    let message = findMessage();
    if (!message && targetChat && typeof targetChat.loadEarlierMsgs === 'function') {
      for (let attempt = 0; attempt < 8 && !message; attempt += 1) {
        const loaded = await targetChat.loadEarlierMsgs();
        message = findMessage();
        if (!loaded || (Array.isArray(loaded) && loaded.length === 0)) break;
      }
    }
    if (!message) return null;

    const read = (source, key) => source?.[key]
      ?? source?.['__x_' + key]
      ?? source?.attributes?.[key]
      ?? undefined;
    const mediaData = read(message, 'mediaData') || {};
    const type = String(read(message, 'type') || read(mediaData, 'type') || 'document').toLowerCase();
    const mimeFallback = ({ image: 'image/jpeg', video: 'video/mp4', audio: 'audio/ogg', ptt: 'audio/ogg', document: 'application/octet-stream', sticker: 'image/webp' })[type]
      || 'application/octet-stream';
    const directPath = String(read(message, 'directPath') || read(mediaData, 'directPath') || '');
    let clientUrl = String(
      read(message, 'clientUrl')
      || read(message, 'deprecatedMms3Url')
      || read(mediaData, 'clientUrl')
      || read(mediaData, 'deprecatedMms3Url')
      || ''
    );
    if (!clientUrl && directPath) clientUrl = directPath.startsWith('http') ? directPath : 'https://mmg.whatsapp.net' + directPath;
    const mediaKey = read(message, 'mediaKey') || read(mediaData, 'mediaKey');
    const filehash = read(message, 'filehash') || read(mediaData, 'filehash') || read(message, 'uploadhash') || read(mediaData, 'uploadhash');
    const size = Number(read(message, 'size') || read(mediaData, 'size') || read(mediaData, 'fileSize') || 0) || undefined;
    return {
      id: messageId,
      type,
      mimetype: String(read(message, 'mimetype') || read(mediaData, 'mimetype') || mimeFallback),
      mediaKey,
      filehash,
      uploadhash: read(message, 'uploadhash') || read(mediaData, 'uploadhash'),
      size,
      clientUrl,
      deprecatedMms3Url: clientUrl,
      directPath
    };
  })()`;
}

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

function clearDisconnectTimer(): void {
  if (disconnectTimer) clearTimeout(disconnectTimer);
  disconnectTimer = null;
}

function scheduleDisconnected(): void {
  clearDisconnectTimer();
  disconnectTimer = setTimeout(() => {
    disconnectTimer = null;
    if (!verifiedConnected) post({ type: "state", state: "disconnected" });
  }, 12_000);
  disconnectTimer.unref();
}

async function confirmReconnected(): Promise<void> {
  if (verifiedConnected || !client) return;
  try {
    const hostNumber = String(await client.getHostNumber()).trim();
    if (!hostNumber) return;
    clearDisconnectTimer();
    verifiedConnected = true;
    post({ type: "state", state: "connected", hostNumber });
  } catch {
    scheduleDisconnected();
  }
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
    ["onAnyMessage", "message"], ["onAck", "ack"],
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

channel.on("message", (message: InvokeMessage | ShutdownMessage) => {
  if (message?.type === "shutdown") {
    void (async () => {
      stopQrPoller();
      clearDisconnectTimer();
      if (bootstrapRetryTimer) clearTimeout(bootstrapRetryTimer);
      bootstrapRetryTimer = null;
      verifiedConnected = false;
      try {
        await core?.stop("Worker do Norium encerrado.");
      } catch {
        // O processo pai ainda encerra o worker caso o navegador nao responda.
      } finally {
        post({ type: "shutdown-complete" });
      }
    })();
    return;
  }
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
      if (message.method === "__noriumContactDetails") {
        if (!core) throw new Error("Runtime do WhatsApp indisponivel.");
        const result = await core.evaluateScript<Record<string, unknown> | null>(contactDetailsScript(String(message.args?.[0] || "")));
        post({ type: "response", id: message.id, ok: true, result });
        return;
      }
      if (message.method === "__noriumGroupDetails") {
        if (!core) throw new Error("Runtime do WhatsApp indisponivel.");
        const result = await core.evaluateScript<Record<string, unknown> | null>(groupDetailsScript(String(message.args?.[0] || "")));
        post({ type: "response", id: message.id, ok: true, result });
        return;
      }
      if (message.method === "__noriumProfilePicture") {
        if (!core) throw new Error("Runtime do WhatsApp indisponivel.");
        const result = await core.evaluateScript<string>(profilePictureScript(String(message.args?.[0] || "")));
        post({ type: "response", id: message.id, ok: true, result });
        return;
      }
      if (message.method === "__noriumMessages") {
        if (!core) throw new Error("Runtime do WhatsApp indisponivel.");
        const chatId = String(message.args?.[0] || "");
        const beforeValue = Number(message.args?.[1] || 0);
        const before = Number.isFinite(beforeValue) && beforeValue > 0 ? beforeValue : null;
        const limit = Math.max(1, Math.min(100, Number(message.args?.[2] || 50)));
        const result = await core.evaluateScript<Record<string, unknown>>(messageCatalogScript(chatId, before, limit));
        post({ type: "response", id: message.id, ok: true, result });
        return;
      }
      if (message.method === "__noriumMedia") {
        if (!core) throw new Error("Runtime do WhatsApp indisponivel.");
        const messageId = String(message.args?.[0] || "");
        const chatId = typeof message.args?.[1] === "string" ? String(message.args[1]) : null;
        const mediaMessage = await core.evaluateScript<Record<string, unknown> | null>(mediaMessageScript(messageId, chatId));
        if (!mediaMessage) throw new Error("Midia nao encontrada no historico carregado do WhatsApp.");
        const result = await client.decryptMedia(mediaMessage as never);
        post({ type: "response", id: message.id, ok: true, result });
        return;
      }
      if (message.method === "sendFile") {
        const [to, data, filename, caption] = message.args || [];
        const result = await client.sendImage(String(to) as never, String(data) as never, String(filename || "arquivo"), String(caption || ""));
        post({ type: "response", id: message.id, ok: true, result });
        return;
      }
      if (message.method === "sendImageAsSticker") {
        const [to, data] = message.args || [];
        const result = await client.sendSticker(String(to) as never, String(data) as never, { author: "Norium", pack: "Norium" });
        post({ type: "response", id: message.id, ok: true, result });
        return;
      }
      if (message.method === "react") {
        if (!core) throw new Error("Runtime do WhatsApp indisponivel.");
        const messageId = String(message.args?.[0] || "");
        const emoji = String(message.args?.[1] || "");
        const result = await core.evaluateScript<boolean>(`(() => {
          const messageId = ${JSON.stringify(messageId)};
          const emoji = ${JSON.stringify(emoji)};
          if (typeof window.WAPI?.react === 'function') return window.WAPI.react(messageId, emoji);
          const message = window.Store?.Msg?.get?.(messageId);
          if (!message) return false;
          const reaction = window.Store?.ReactionCommands || window.Store?.Reactions;
          const target = reaction?.sendReactionToMessage || reaction?.sendReaction;
          return typeof target === 'function' ? target.call(reaction, message, emoji) : false;
        })()`);
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
  if (bootstrapRetryTimer) clearTimeout(bootstrapRetryTimer);
  bootstrapRetryTimer = null;
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
      if (next === "READY" || next === "CONNECTED") {
        void confirmReconnected();
        return;
      }
      if (verifiedConnected && (next === "DISCONNECTED" || next === "STOPPED")) {
        verifiedConnected = false;
        scheduleDisconnected();
      }
    });
    createdCore.events.on("session.connection.disconnected", () => {
      if (!verifiedConnected) return;
      verifiedConnected = false;
      scheduleDisconnected();
    });
    createdCore.events.on("session.logout", () => {
      clearDisconnectTimer();
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

    const authenticatedState = String(createdClient.getState() || "").toUpperCase();
    if (!["READY", "CONNECTED"].includes(authenticatedState)) {
      throw new Error(`OpenWA finalizou sem prontidao confirmada (${authenticatedState || "desconhecido"}).`);
    }
    const hostNumber = String(await createdClient.getHostNumber()).trim();
    if (!hostNumber) throw new Error("OpenWA nao confirmou o numero autenticado.");

    client = createdClient;
    await registerEvents(createdClient);
    verifiedConnected = true;
    clearDisconnectTimer();
    stopQrPoller();
    clearDisconnectTimer();
    post({ type: "state", state: "connected", hostNumber });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Falha ao iniciar OpenWA.";
    stopQrPoller();
    verifiedConnected = false;
    client = null;
    await core?.stop("bootstrap_failed").catch(() => undefined);
    core = null;
    if (errorMessage.includes("QR scan took too long")) {
      post({ type: "state", state: "starting" });
      bootstrapRetryTimer = setTimeout(() => {
        bootstrapRetryTimer = null;
        void launch();
      }, 1_500);
      return;
    }
    post({
      type: "state",
      state: "error",
      error: errorMessage.slice(0, 500),
    });
  }
}

void launch();
