'use strict';

const MAX_FILE_SIZE = 6 * 1024 * 1024;
const FILE_CHUNK_SIZE = 48 * 1024;
const SAFE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

const ui = {
  homeView: document.querySelector('#homeView'),
  queueView: document.querySelector('#queueView'),
  chatView: document.querySelector('#chatView'),
  onlineCount: document.querySelector('#onlineCount'),
  adultCheck: document.querySelector('#adultCheck'),
  startButton: document.querySelector('#startButton'),
  startError: document.querySelector('#startError'),
  cancelSearchButton: document.querySelector('#cancelSearchButton'),
  nextButton: document.querySelector('#nextButton'),
  endButton: document.querySelector('#endButton'),
  partnerStatus: document.querySelector('#partnerStatus'),
  partnerStatusDot: document.querySelector('#partnerStatusDot'),
  messages: document.querySelector('#messages'),
  typingIndicator: document.querySelector('#typingIndicator'),
  messageInput: document.querySelector('#messageInput'),
  sendButton: document.querySelector('#sendButton'),
  fileInput: document.querySelector('#fileInput'),
  fileButton: document.querySelector('#fileButton'),
  privacyButton: document.querySelector('#privacyButton'),
  privacyDialog: document.querySelector('#privacyDialog'),
  toast: document.querySelector('#toast')
};

const state = {
  socket: null,
  socketPromise: null,
  gender: 'girl',
  preference: 'any',
  keyPair: null,
  roomKey: null,
  roomReady: false,
  matched: false,
  searching: false,
  pendingSecure: [],
  outgoingFiles: new Map(),
  incomingFiles: new Map(),
  objectUrls: new Set(),
  typingTimer: null,
  typingSent: false,
  toastTimer: null,
  sessionVersion: 0
};

function showView(name) {
  ui.homeView.classList.toggle('hidden', name !== 'home');
  ui.queueView.classList.toggle('hidden', name !== 'queue');
  ui.chatView.classList.toggle('hidden', name !== 'chat');
}

function toast(message) {
  clearTimeout(state.toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  state.toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2600);
}

function selectedValue(control) {
  return document.querySelector(`[data-control="${control}"] .segment.active`)?.dataset.value;
}

for (const group of document.querySelectorAll('.segmented')) {
  group.addEventListener('click', (event) => {
    const button = event.target.closest('.segment');
    if (!button) return;
    for (const item of group.querySelectorAll('.segment')) {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-checked', String(active));
    }
  });
}

function bytesToBase64(bytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < source.length; i += step) {
    binary += String.fromCharCode(...source.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uuidToBytes(uuid) {
  const hex = uuid.replaceAll('-', '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToUuid(bytes) {
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function makeKeyPair() {
  if (!window.crypto?.subtle) throw new Error('Web Crypto is not available in this browser.');
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );
  const rawPublicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return { keyPair, publicKey: bytesToBase64(rawPublicKey) };
}

async function deriveRoomKey(partnerPublicKey, keyPair) {
  const imported = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(partnerPublicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: imported },
    keyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptObject(value, roomKey = state.roomKey) {
  if (!roomKey) throw new Error('Secure session is not ready.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, roomKey, plain);
  return { iv: bytesToBase64(iv), data: bytesToBase64(cipher) };
}

async function decryptObject(envelope, roomKey = state.roomKey) {
  if (!roomKey) throw new Error('Secure session is not ready.');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
    roomKey,
    base64ToBytes(envelope.data)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

function ensureSocket() {
  if (state.socket?.readyState === WebSocket.OPEN) return Promise.resolve(state.socket);
  if (state.socketPromise) return state.socketPromise;

  state.socketPromise = new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl());
    socket.binaryType = 'arraybuffer';
    state.socket = socket;

    const timeout = setTimeout(() => {
      reject(new Error('Connection timed out.'));
      socket.close();
    }, 10_000);

    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      state.socketPromise = null;
      resolve(socket);
    }, { once: true });

    socket.addEventListener('message', handleSocketMessage);
    socket.addEventListener('close', () => {
      clearTimeout(timeout);
      state.socketPromise = null;
      state.socket = null;
      handleSocketClosed();
    });
    socket.addEventListener('error', () => {
      if (socket.readyState !== WebSocket.OPEN) {
        clearTimeout(timeout);
        state.socketPromise = null;
        reject(new Error('Could not connect to ChatMe.'));
      }
    });
  });

  return state.socketPromise;
}

function sendJson(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(payload));
}

async function startSearch() {
  ui.startError.textContent = '';
  if (!ui.adultCheck.checked) {
    ui.startError.textContent = 'Please confirm that you are 18 or older.';
    return;
  }

  ui.startButton.disabled = true;
  state.gender = selectedValue('gender') || 'girl';
  state.preference = selectedValue('preference') || 'any';

  try {
    await ensureSocket();
    invalidateSession();
    resetConversationUi();
    const sessionVersion = state.sessionVersion;
    const identity = await makeKeyPair();
    if (sessionVersion !== state.sessionVersion) return;
    state.keyPair = identity.keyPair;
    state.roomReady = false;
    state.matched = false;
    state.searching = true;
    showView('queue');
    sendJson({
      type: 'join',
      adult: true,
      gender: state.gender,
      preference: state.preference,
      publicKey: identity.publicKey
    });
  } catch (error) {
    ui.startError.textContent = error.message || 'Could not start the chat.';
    showView('home');
  } finally {
    ui.startButton.disabled = false;
  }
}

async function restartSearch() {
  invalidateSession();
  resetConversationUi();
  sendJson({ type: 'next' });
  const sessionVersion = state.sessionVersion;
  try {
    const identity = await makeKeyPair();
    if (sessionVersion !== state.sessionVersion) return;
    state.keyPair = identity.keyPair;
    state.roomReady = false;
    state.matched = false;
    state.searching = true;
    showView('queue');
    sendJson({
      type: 'join',
      adult: true,
      gender: state.gender,
      preference: state.preference,
      publicKey: identity.publicKey
    });
  } catch {
    if (sessionVersion !== state.sessionVersion) return;
    state.searching = false;
    toast('Could not create a new secure session.');
    showView('home');
  }
}

function cancelSearch() {
  state.searching = false;
  sendJson({ type: 'cancel_queue' });
  invalidateSession();
  resetConversationUi();
  showView('home');
}

function endChat() {
  sendJson({ type: 'end' });
  state.searching = false;
  state.matched = false;
  invalidateSession();
  resetConversationUi();
  showView('home');
}

function clearCryptoState() {
  state.keyPair = null;
  state.roomKey = null;
  state.roomReady = false;
  state.pendingSecure.length = 0;
  state.outgoingFiles.clear();
  state.incomingFiles.clear();
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls.clear();
}

function invalidateSession() {
  state.sessionVersion += 1;
  clearCryptoState();
}

function resetConversationUi() {
  ui.messages.querySelectorAll('.message-row, .system-message').forEach((node) => node.remove());
  ui.messageInput.disabled = false;
  ui.sendButton.disabled = false;
  ui.fileButton.disabled = false;
  state.typingSent = false;
  ui.typingIndicator.textContent = '';
  ui.messageInput.value = '';
  autoSizeInput();
  ui.partnerStatus.textContent = 'Connecting securely…';
  ui.partnerStatusDot.classList.remove('ready');
}

async function handleSocketMessage(event) {
  if (typeof event.data !== 'string') {
    await handleBinaryFrame(event.data);
    return;
  }

  let message;
  try { message = JSON.parse(event.data); } catch { return; }

  switch (message.type) {
    case 'online_count':
      ui.onlineCount.textContent = new Intl.NumberFormat().format(message.count || 0);
      break;
    case 'queued':
      state.searching = true;
      showView('queue');
      break;
    case 'matched':
      await handleMatched(message);
      break;
    case 'secure':
      await handleSecureEnvelope(message.payload);
      break;
    case 'partner_left':
      handlePartnerLeft(message.reason);
      break;
    case 'file_offer':
      await handleFileOffer(message);
      break;
    case 'file_response':
      await handleFileResponse(message);
      break;
    case 'file_complete':
      handleFileComplete(message.transferId);
      break;
    case 'file_cancelled':
      handleFileCancelled(message.transferId);
      break;
    case 'error':
      toast('The chat request was rejected. Please try again.');
      endChat();
      break;
    default:
      break;
  }
}

async function handleMatched(message) {
  const sessionVersion = state.sessionVersion;
  const keyPair = state.keyPair;
  if (!keyPair || !state.searching) return;

  try {
    const roomKey = await deriveRoomKey(message.partnerPublicKey, keyPair);
    if (sessionVersion !== state.sessionVersion || state.keyPair !== keyPair || !state.searching) return;
    state.roomKey = roomKey;
    state.roomReady = true;
    state.matched = true;
    state.searching = false;
    showView('chat');
    ui.partnerStatus.textContent = 'Secure connection ready';
    ui.partnerStatusDot.classList.add('ready');
    appendSystemMessage('You are connected. Say hello — neither person has a username here.');
    ui.messageInput.focus();

    const pending = state.pendingSecure.splice(0);
    for (const envelope of pending) await handleSecureEnvelope(envelope);
  } catch {
    if (sessionVersion !== state.sessionVersion) return;
    toast('Secure key exchange failed. Finding someone else…');
    await restartSearch();
  }
}

async function handleSecureEnvelope(envelope) {
  if (!state.roomKey) {
    if (state.searching && state.keyPair) state.pendingSecure.push(envelope);
    return;
  }

  const sessionVersion = state.sessionVersion;
  const roomKey = state.roomKey;
  try {
    const payload = await decryptObject(envelope, roomKey);
    if (sessionVersion !== state.sessionVersion || roomKey !== state.roomKey || !state.matched) return;
    if (payload.kind === 'message' && typeof payload.text === 'string') {
      appendMessage('them', payload.text.slice(0, 2000));
    } else if (payload.kind === 'typing') {
      ui.typingIndicator.textContent = payload.value ? 'Chat Partner is typing…' : '';
    }
  } catch {
    if (sessionVersion === state.sessionVersion && state.matched) toast('A secure message could not be decrypted.');
  }
}

function handlePartnerLeft(reason) {
  state.searching = false;
  state.matched = false;
  invalidateSession();
  resetConversationUi();
  ui.partnerStatus.textContent = 'Partner left the chat';
  ui.partnerStatusDot.classList.remove('ready');
  ui.typingIndicator.textContent = '';
  const message = reason === 'next'
    ? 'Chat Partner moved to another chat.'
    : reason === 'end'
      ? 'Chat Partner ended the chat.'
      : 'Chat Partner disconnected.';
  appendSystemMessage(message);
  ui.messageInput.disabled = true;
  ui.sendButton.disabled = true;
  ui.fileButton.disabled = true;
}

function handleSocketClosed() {
  ui.onlineCount.textContent = '—';
  if (state.searching || state.matched) {
    state.searching = false;
    state.matched = false;
    invalidateSession();
    resetConversationUi();
    showView('home');
    ui.startError.textContent = 'Connection lost. You can start a new chat.';
  }
}

async function sendMessage() {
  const text = ui.messageInput.value.trim();
  if (!text || !state.roomReady || !state.matched) return;
  const sessionVersion = state.sessionVersion;
  const roomKey = state.roomKey;
  ui.messageInput.value = '';
  autoSizeInput();
  appendMessage('me', text);
  try {
    const payload = await encryptObject({ kind: 'message', text }, roomKey);
    if (sessionVersion !== state.sessionVersion || roomKey !== state.roomKey || !state.matched) return;
    sendJson({ type: 'secure', payload });
    await setTyping(false);
  } catch {
    if (sessionVersion === state.sessionVersion && state.matched) toast('Message could not be encrypted.');
  }
}

function appendMessage(who, text) {
  const row = document.createElement('div');
  row.className = `message-row ${who}`;
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  const content = document.createElement('div');
  content.textContent = text;
  const time = document.createElement('div');
  time.className = 'message-time';
  time.textContent = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(new Date());
  bubble.append(content, time);
  row.appendChild(bubble);
  ui.messages.appendChild(row);
  scrollMessages();
}

function appendSystemMessage(text) {
  const node = document.createElement('div');
  node.className = 'system-message';
  node.textContent = text;
  ui.messages.appendChild(node);
  scrollMessages();
}

function scrollMessages() {
  requestAnimationFrame(() => { ui.messages.scrollTop = ui.messages.scrollHeight; });
}

async function setTyping(value) {
  if (!state.roomReady || !state.matched || state.typingSent === value) return;
  const sessionVersion = state.sessionVersion;
  const roomKey = state.roomKey;
  state.typingSent = value;
  try {
    const payload = await encryptObject({ kind: 'typing', value }, roomKey);
    if (sessionVersion !== state.sessionVersion || roomKey !== state.roomKey || !state.matched) return;
    sendJson({ type: 'secure', payload });
  } catch {
    // Typing indicators are non-essential.
  }
}

function autoSizeInput() {
  const explicitLines = ui.messageInput.value.split('\n');
  const estimatedRows = explicitLines.reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / 54)), 0);
  ui.messageInput.rows = Math.min(5, Math.max(1, estimatedRows));
}

function cleanFileName(name) {
  return String(name || 'file')
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .slice(0, 120) || 'file';
}

function humanFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildFileCard(side, transferId, meta, statusText) {
  const row = document.createElement('div');
  row.className = `message-row ${side}`;
  row.dataset.transferId = transferId;

  const card = document.createElement('div');
  card.className = 'file-card';
  const head = document.createElement('div');
  head.className = 'file-head';
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.textContent = '↗';
  const info = document.createElement('div');
  info.className = 'file-info';
  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = cleanFileName(meta.name);
  const size = document.createElement('div');
  size.className = 'file-size';
  size.textContent = humanFileSize(meta.size);
  info.append(name, size);
  head.append(icon, info);

  const status = document.createElement('div');
  status.className = 'file-status';
  status.textContent = statusText;
  card.append(head, status);
  row.appendChild(card);
  ui.messages.appendChild(row);
  scrollMessages();
  return { row, card, status };
}

function addFileProgress(card) {
  const progress = document.createElement('progress');
  progress.className = 'file-progress';
  progress.max = 100;
  progress.value = 0;
  progress.setAttribute('aria-label', 'File transfer progress');
  card.appendChild(progress);
  return progress;
}

async function offerFile(file) {
  if (!state.roomReady || !state.matched) return;
  if (!file || file.size < 1) return;
  if (file.size > MAX_FILE_SIZE) {
    toast('Files must be 6 MB or smaller.');
    return;
  }

  const sessionVersion = state.sessionVersion;
  const roomKey = state.roomKey;
  const transferId = crypto.randomUUID();
  const meta = {
    kind: 'file_meta',
    transferId,
    name: cleanFileName(file.name),
    mime: String(file.type || 'application/octet-stream').slice(0, 100),
    size: file.size
  };
  const card = buildFileCard('me', transferId, meta, 'Waiting for Chat Partner to accept…');
  const progress = addFileProgress(card.card);

  try {
    const encryptedMeta = await encryptObject(meta, roomKey);
    if (sessionVersion !== state.sessionVersion || roomKey !== state.roomKey || !state.matched) return;
    state.outgoingFiles.set(transferId, { file, meta, card, progress, sessionVersion, roomKey });
    sendJson({ type: 'file_offer', transferId, size: file.size, meta: encryptedMeta });
  } catch {
    if (sessionVersion === state.sessionVersion && state.matched) card.status.textContent = 'Could not encrypt file details.';
  }
}

async function handleFileOffer(message) {
  if (!state.roomKey || !state.matched || !Number.isSafeInteger(message.size) || message.size < 1 || message.size > MAX_FILE_SIZE) return;
  const sessionVersion = state.sessionVersion;
  const roomKey = state.roomKey;
  try {
    const meta = await decryptObject(message.meta, roomKey);
    if (sessionVersion !== state.sessionVersion || roomKey !== state.roomKey || !state.matched) return;
    if (meta.kind !== 'file_meta' || meta.transferId !== message.transferId || meta.size !== message.size) return;
    meta.name = cleanFileName(meta.name);
    meta.mime = String(meta.mime || 'application/octet-stream').slice(0, 100);

    const card = buildFileCard('them', message.transferId, meta, 'Chat Partner wants to send you this file.');
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const accept = document.createElement('button');
    accept.className = 'file-action accept';
    accept.type = 'button';
    accept.textContent = 'Accept';
    const decline = document.createElement('button');
    decline.className = 'file-action decline';
    decline.type = 'button';
    decline.textContent = 'Decline';
    actions.append(accept, decline);
    card.card.appendChild(actions);

    const transfer = {
      meta,
      size: message.size,
      card,
      progress: null,
      chunks: new Map(),
      receivedPlainBytes: 0,
      accepted: false,
      sessionVersion,
      roomKey
    };
    state.incomingFiles.set(message.transferId, transfer);

    accept.addEventListener('click', () => {
      if (sessionVersion !== state.sessionVersion || state.incomingFiles.get(message.transferId) !== transfer) return;
      transfer.accepted = true;
      actions.remove();
      card.status.textContent = 'Receiving encrypted file…';
      transfer.progress = addFileProgress(card.card);
      sendJson({ type: 'file_response', transferId: message.transferId, accept: true });
    });

    decline.addEventListener('click', () => {
      if (sessionVersion !== state.sessionVersion || state.incomingFiles.get(message.transferId) !== transfer) return;
      actions.remove();
      card.status.textContent = 'Declined.';
      state.incomingFiles.delete(message.transferId);
      sendJson({ type: 'file_response', transferId: message.transferId, accept: false });
    });
  } catch {
    if (sessionVersion === state.sessionVersion && state.matched) toast('File offer could not be decrypted.');
  }
}

async function handleFileResponse(message) {
  const transfer = state.outgoingFiles.get(message.transferId);
  if (!transfer || transfer.sessionVersion !== state.sessionVersion || transfer.roomKey !== state.roomKey) return;
  if (!message.accept) {
    transfer.card.status.textContent = 'Chat Partner declined the file.';
    state.outgoingFiles.delete(message.transferId);
    return;
  }
  transfer.card.status.textContent = 'Sending encrypted file…';
  await streamEncryptedFile(message.transferId, transfer);
}

async function waitForSocketBuffer(sessionVersion) {
  while (state.socket?.readyState === WebSocket.OPEN && state.socket.bufferedAmount > 512 * 1024) {
    if (sessionVersion !== state.sessionVersion) throw new Error('Chat ended.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function streamEncryptedFile(transferId, transfer) {
  const file = transfer.file;
  const totalChunks = Math.ceil(file.size / FILE_CHUNK_SIZE);
  const idBytes = uuidToBytes(transferId);
  const { sessionVersion, roomKey } = transfer;

  try {
    for (let seq = 0; seq < totalChunks; seq += 1) {
      if (
        sessionVersion !== state.sessionVersion ||
        roomKey !== state.roomKey ||
        state.outgoingFiles.get(transferId) !== transfer ||
        !state.matched ||
        state.socket?.readyState !== WebSocket.OPEN
      ) throw new Error('Chat ended.');

      const plain = await file.slice(seq * FILE_CHUNK_SIZE, Math.min(file.size, (seq + 1) * FILE_CHUNK_SIZE)).arrayBuffer();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = new Uint8Array(21);
      aad[0] = 1;
      aad.set(idBytes, 1);
      new DataView(aad.buffer).setUint32(17, seq);
      const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, roomKey, plain);

      if (sessionVersion !== state.sessionVersion || state.outgoingFiles.get(transferId) !== transfer) throw new Error('Chat ended.');
      const frame = new Uint8Array(33 + cipher.byteLength);
      frame.set(aad, 0);
      frame.set(iv, 21);
      frame.set(new Uint8Array(cipher), 33);
      await waitForSocketBuffer(sessionVersion);
      if (sessionVersion !== state.sessionVersion || state.socket?.readyState !== WebSocket.OPEN) throw new Error('Chat ended.');
      state.socket.send(frame.buffer);

      transfer.progress.value = Math.round(((seq + 1) / totalChunks) * 100);
    }
  } catch {
    if (sessionVersion === state.sessionVersion && state.outgoingFiles.get(transferId) === transfer) {
      transfer.card.status.textContent = 'Transfer stopped.';
      state.outgoingFiles.delete(transferId);
    }
  }
}

async function handleBinaryFrame(arrayBuffer) {
  if (!state.roomKey || !state.matched) return;
  const frame = new Uint8Array(arrayBuffer);
  if (frame.length < 49 || frame[0] !== 1) return;

  const transferId = bytesToUuid(frame.slice(1, 17));
  const transfer = state.incomingFiles.get(transferId);
  if (!transfer?.accepted || transfer.sessionVersion !== state.sessionVersion || transfer.roomKey !== state.roomKey) return;

  const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(17);
  if (transfer.chunks.has(seq)) return;

  const iv = frame.slice(21, 33);
  const cipher = frame.slice(33);
  const aad = frame.slice(0, 21);

  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, transfer.roomKey, cipher);
    if (
      transfer.sessionVersion !== state.sessionVersion ||
      state.incomingFiles.get(transferId) !== transfer ||
      transfer.roomKey !== state.roomKey
    ) return;
    transfer.chunks.set(seq, plain);
    transfer.receivedPlainBytes += plain.byteLength;
    if (transfer.progress) {
      transfer.progress.value = Math.min(100, Math.round((transfer.receivedPlainBytes / transfer.size) * 100));
    }
    if (transfer.completeSignal) finalizeIncomingFile(transferId, transfer);
  } catch {
    if (state.incomingFiles.get(transferId) === transfer) {
      transfer.card.status.textContent = 'File integrity check failed.';
      state.incomingFiles.delete(transferId);
    }
  }
}

function finalizeIncomingFile(transferId, incoming) {
  const expectedChunks = Math.ceil(incoming.size / FILE_CHUNK_SIZE);
  if (!incoming.completeSignal || incoming.chunks.size !== expectedChunks || incoming.receivedPlainBytes !== incoming.size) return;

  const parts = [];
  for (let seq = 0; seq < expectedChunks; seq += 1) {
    const part = incoming.chunks.get(seq);
    if (!part) return;
    parts.push(part);
  }

  const blob = new Blob(parts, { type: incoming.meta.mime });
  const objectUrl = URL.createObjectURL(blob);
  state.objectUrls.add(objectUrl);
  incoming.card.status.textContent = 'Received. Stored only in this browser tab.';

  if (SAFE_IMAGE_TYPES.has(incoming.meta.mime)) {
    const image = document.createElement('img');
    image.className = 'image-preview';
    image.src = objectUrl;
    image.alt = `Received image: ${incoming.meta.name}`;
    incoming.card.card.appendChild(image);
  }

  const link = document.createElement('a');
  link.className = 'file-download';
  link.href = objectUrl;
  link.download = incoming.meta.name;
  link.textContent = 'Download file';
  incoming.card.card.appendChild(link);
  state.incomingFiles.delete(transferId);
  scrollMessages();
}

function handleFileComplete(transferId) {
  const outgoing = state.outgoingFiles.get(transferId);
  if (outgoing) {
    outgoing.card.status.textContent = 'Sent securely.';
    state.outgoingFiles.delete(transferId);
  }

  const incoming = state.incomingFiles.get(transferId);
  if (!incoming) return;
  incoming.completeSignal = true;
  incoming.card.status.textContent = 'Finishing secure transfer…';
  finalizeIncomingFile(transferId, incoming);
}

function handleFileCancelled(transferId) {
  const outgoing = state.outgoingFiles.get(transferId);
  const incoming = state.incomingFiles.get(transferId);
  if (outgoing) outgoing.card.status.textContent = 'Transfer cancelled.';
  if (incoming) incoming.card.status.textContent = 'Transfer cancelled.';
  state.outgoingFiles.delete(transferId);
  state.incomingFiles.delete(transferId);
}

ui.startButton.addEventListener('click', startSearch);
ui.cancelSearchButton.addEventListener('click', cancelSearch);
ui.nextButton.addEventListener('click', restartSearch);
ui.endButton.addEventListener('click', endChat);
ui.sendButton.addEventListener('click', sendMessage);
ui.fileButton.addEventListener('click', () => {
  if (state.roomReady && state.matched) ui.fileInput.click();
});
ui.fileInput.addEventListener('change', async () => {
  const [file] = ui.fileInput.files;
  ui.fileInput.value = '';
  if (file) await offerFile(file);
});
ui.messageInput.addEventListener('input', () => {
  autoSizeInput();
  if (!state.matched) return;
  setTyping(true);
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => setTyping(false), 1000);
});
ui.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
ui.privacyButton.addEventListener('click', () => ui.privacyDialog.showModal());

window.addEventListener('pagehide', () => {
  state.searching = false;
  state.matched = false;
  invalidateSession();
  resetConversationUi();
  showView('home');
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.close(1000, 'pagehide');
});

ensureSocket().catch(() => {
  ui.onlineCount.textContent = '—';
});
