'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_FILE_SIZE = 6 * 1024 * 1024;
const FILE_CHUNK_SIZE = 48 * 1024;
const MAX_TEXT_FRAME = 16 * 1024;
const MAX_BINARY_FRAME = FILE_CHUNK_SIZE + 64;
const TRANSFER_TTL_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const MAX_MESSAGES_PER_WINDOW = 35;
const MAX_BINARY_FRAMES_PER_WINDOW = 300;
const MAX_PENDING_TRANSFERS_PER_CLIENT = 3;
const RATE_WINDOW_MS = 10 * 1000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-DNS-Prefetch-Control': 'off',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Connection state can change between the readiness check and send.
  }
}

function uuidBytesToString(bytes) {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validPublicKey(value) {
  if (typeof value !== 'string' || value.length < 80 || value.length > 100) return false;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 65 && decoded[0] === 4;
  } catch {
    return false;
  }
}

function validSecureEnvelope(value, maxDataLength = 12_000) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.iv === 'string' &&
    value.iv.length <= 40 &&
    typeof value.data === 'string' &&
    value.data.length <= maxDataLength
  );
}

function createChatMeServer(options = {}) {
  const publicDir = options.publicDir || PUBLIC_DIR;
  const clients = new Set();
  const queue = new Set();
  const transfers = new Map();

  function applyHeaders(res, extra = {}) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
  }

  function serveStatic(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/health') {
      applyHeaders(res, { 'Content-Type': 'application/json; charset=utf-8' });
      res.writeHead(200);
      res.end('{"ok":true}');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      applyHeaders(res, { Allow: 'GET, HEAD' });
      res.writeHead(405);
      res.end();
      return;
    }

    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const normalized = path.posix.normalize(requested).replace(/^\/+/, '');
    const filePath = path.join(publicDir, normalized);
    const relative = path.relative(publicDir, filePath);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      applyHeaders(res);
      res.writeHead(403);
      res.end();
      return;
    }

    fs.stat(filePath, (statError, stat) => {
      if (statError || !stat.isFile()) {
        applyHeaders(res, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      applyHeaders(res, { 'Content-Type': contentType });
      res.writeHead(200);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    });
  }

  const server = http.createServer(serveStatic);
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_error, socket) => socket.destroy());

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BINARY_FRAME,
    perMessageDeflate: false,
    clientTracking: false
  });

  function broadcastOnlineCount() {
    const payload = JSON.stringify({ type: 'online_count', count: clients.size });
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      try { client.ws.send(payload); } catch { /* Socket closed during broadcast. */ }
    }
  }

  function clearMatchingMetadata(client) {
    client.gender = null;
    client.preference = null;
    client.publicKey = null;
  }

  function removeFromQueue(client) {
    queue.delete(client);
    if (client.state === 'queued') client.state = 'idle';
  }

  function cleanupTransfersFor(client) {
    for (const [id, transfer] of transfers) {
      if (transfer.sender === client || transfer.recipient === client) {
        const other = transfer.sender === client ? transfer.recipient : transfer.sender;
        sendJson(other.ws, { type: 'file_cancelled', transferId: id });
        transfers.delete(id);
      }
    }
  }

  function separatePair(client, reason = 'left') {
    const partner = client.partner;
    if (!partner) {
      clearMatchingMetadata(client);
      return;
    }

    client.partner = null;
    if (client.state === 'chatting') client.state = 'idle';
    cleanupTransfersFor(client);

    if (partner.partner === client) {
      partner.partner = null;
      if (partner.state === 'chatting') partner.state = 'idle';
      clearMatchingMetadata(partner);
      sendJson(partner.ws, { type: 'partner_left', reason });
    }
    clearMatchingMetadata(client);
  }

  function preferenceAccepts(client, candidate) {
    return client.preference === 'any' || client.preference === candidate.gender;
  }

  function mutuallyCompatible(a, b) {
    return preferenceAccepts(a, b) && preferenceAccepts(b, a);
  }

  function matchOrQueue(client) {
    removeFromQueue(client);

    const compatible = [];
    for (const candidate of queue) {
      if (
        candidate !== client &&
        candidate.ws.readyState === WebSocket.OPEN &&
        candidate.state === 'queued' &&
        mutuallyCompatible(client, candidate)
      ) {
        compatible.push(candidate);
      }
    }

    if (compatible.length === 0) {
      client.state = 'queued';
      queue.add(client);
      sendJson(client.ws, { type: 'queued' });
      return;
    }

    const partner = compatible[crypto.randomInt(compatible.length)];
    queue.delete(partner);

    const clientPublicKey = client.publicKey;
    const partnerPublicKey = partner.publicKey;

    client.state = 'chatting';
    partner.state = 'chatting';
    client.partner = partner;
    partner.partner = client;

    sendJson(client.ws, {
      type: 'matched',
      partnerPublicKey
    });
    sendJson(partner.ws, {
      type: 'matched',
      partnerPublicKey: clientPublicKey
    });

    // Matching choices and public keys are no longer needed after pairing.
    clearMatchingMetadata(client);
    clearMatchingMetadata(partner);
  }

  function rateAllowed(client, binary = false) {
    const now = Date.now();
    if (now - client.rateWindowStart >= RATE_WINDOW_MS) {
      client.rateWindowStart = now;
      client.rateCount = 0;
      client.binaryRateCount = 0;
    }

    if (binary) {
      client.binaryRateCount += 1;
      return client.binaryRateCount <= MAX_BINARY_FRAMES_PER_WINDOW;
    }

    client.rateCount += 1;
    return client.rateCount <= MAX_MESSAGES_PER_WINDOW;
  }

  function handleJoin(client, message) {
    const genders = new Set(['girl', 'boy', 'other']);
    const preferences = new Set(['girl', 'boy', 'any']);

    if (
      client.partner ||
      message.adult !== true ||
      !genders.has(message.gender) ||
      !preferences.has(message.preference) ||
      !validPublicKey(message.publicKey)
    ) {
      sendJson(client.ws, { type: 'error', code: 'invalid_join' });
      return;
    }

    client.gender = message.gender;
    client.preference = message.preference;
    client.publicKey = message.publicKey;
    client.state = 'idle';
    matchOrQueue(client);
  }

  function handleSecure(client, message) {
    if (!client.partner || client.state !== 'chatting') return;
    if (!validSecureEnvelope(message.payload)) return;
    sendJson(client.partner.ws, { type: 'secure', payload: message.payload });
  }

  function pendingTransferCount(client) {
    let count = 0;
    for (const transfer of transfers.values()) {
      if (transfer.sender === client || transfer.recipient === client) count += 1;
    }
    return count;
  }

  function handleFileOffer(client, message) {
    if (!client.partner || client.state !== 'chatting') return;
    if (pendingTransferCount(client) >= MAX_PENDING_TRANSFERS_PER_CLIENT) return;
    if (!isUuid(message.transferId)) return;
    if (!Number.isSafeInteger(message.size) || message.size < 1 || message.size > MAX_FILE_SIZE) return;
    if (!validSecureEnvelope(message.meta, 4_000)) return;
    if (transfers.has(message.transferId)) return;

    const transfer = {
      sender: client,
      recipient: client.partner,
      size: message.size,
      accepted: false,
      createdAt: Date.now(),
      expectedChunks: Math.ceil(message.size / FILE_CHUNK_SIZE),
      seenSeq: new Set(),
      cipherBytes: 0
    };
    transfers.set(message.transferId, transfer);

    sendJson(client.partner.ws, {
      type: 'file_offer',
      transferId: message.transferId,
      size: message.size,
      meta: message.meta
    });
  }

  function handleFileResponse(client, message) {
    const transfer = transfers.get(message.transferId);
    if (!transfer || transfer.recipient !== client || typeof message.accept !== 'boolean') return;

    if (!message.accept) {
      sendJson(transfer.sender.ws, {
        type: 'file_response',
        transferId: message.transferId,
        accept: false
      });
      transfers.delete(message.transferId);
      return;
    }

    transfer.accepted = true;
    sendJson(transfer.sender.ws, {
      type: 'file_response',
      transferId: message.transferId,
      accept: true
    });
  }

  function failTransfer(id, transfer) {
    sendJson(transfer.sender.ws, { type: 'file_cancelled', transferId: id });
    sendJson(transfer.recipient.ws, { type: 'file_cancelled', transferId: id });
    transfers.delete(id);
  }

  function handleBinary(client, buffer) {
    if (!client.partner || client.state !== 'chatting') return;
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (buffer.length < 49 || buffer.length > MAX_BINARY_FRAME) return;
    if (buffer[0] !== 1) return;

    const transferId = uuidBytesToString(buffer.subarray(1, 17));
    const transfer = transfers.get(transferId);
    if (!transfer || transfer.sender !== client || !transfer.accepted || transfer.recipient !== client.partner) return;

    const seq = buffer.readUInt32BE(17);
    if (seq >= transfer.expectedChunks || transfer.seenSeq.has(seq)) {
      failTransfer(transferId, transfer);
      return;
    }

    const cipherLength = buffer.length - 33;
    if (cipherLength < 17 || cipherLength > FILE_CHUNK_SIZE + 16) {
      failTransfer(transferId, transfer);
      return;
    }

    transfer.seenSeq.add(seq);
    transfer.cipherBytes += cipherLength;

    const maximumCipherBytes = transfer.size + transfer.expectedChunks * 16;
    if (transfer.cipherBytes > maximumCipherBytes) {
      failTransfer(transferId, transfer);
      return;
    }

    if (transfer.recipient.ws.readyState === WebSocket.OPEN) {
      try { transfer.recipient.ws.send(buffer, { binary: true }); } catch { return; }
    }

    if (transfer.seenSeq.size === transfer.expectedChunks) {
      if (transfer.cipherBytes !== maximumCipherBytes) {
        failTransfer(transferId, transfer);
        return;
      }
      sendJson(transfer.sender.ws, { type: 'file_complete', transferId });
      sendJson(transfer.recipient.ws, { type: 'file_complete', transferId });
      transfers.delete(transferId);
    }
  }

  function handleText(client, raw) {
    if (raw.length > MAX_TEXT_FRAME || !rateAllowed(client)) return;

    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    switch (message.type) {
      case 'join':
        handleJoin(client, message);
        break;
      case 'cancel_queue':
        removeFromQueue(client);
        clearMatchingMetadata(client);
        sendJson(client.ws, { type: 'idle' });
        break;
      case 'secure':
        handleSecure(client, message);
        break;
      case 'file_offer':
        handleFileOffer(client, message);
        break;
      case 'file_response':
        handleFileResponse(client, message);
        break;
      case 'next':
        removeFromQueue(client);
        separatePair(client, 'next');
        sendJson(client.ws, { type: 'idle' });
        break;
      case 'end':
        removeFromQueue(client);
        separatePair(client, 'end');
        clearMatchingMetadata(client);
        sendJson(client.ws, { type: 'idle' });
        break;
      default:
        break;
    }
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host) {
      try {
        if (new URL(origin).host !== host) {
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    const client = {
      ws,
      state: 'idle',
      gender: null,
      preference: null,
      publicKey: null,
      partner: null,
      isAlive: true,
      rateWindowStart: Date.now(),
      rateCount: 0,
      binaryRateCount: 0
    };
    clients.add(client);
    broadcastOnlineCount();

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (rateAllowed(client, true)) handleBinary(client, data);
        return;
      }
      handleText(client, data);
    });

    ws.on('close', () => {
      removeFromQueue(client);
      separatePair(client, 'disconnected');
      cleanupTransfersFor(client);
      clients.delete(client);
      broadcastOnlineCount();
    });

    ws.on('error', () => {
      // Intentionally no request, user, message, or IP logging.
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      if (client.ws.readyState === WebSocket.OPEN) client.ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const transferCleanup = setInterval(() => {
    const cutoff = Date.now() - TRANSFER_TTL_MS;
    for (const [id, transfer] of transfers) {
      if (transfer.createdAt < cutoff) failTransfer(id, transfer);
    }
  }, 30_000);
  transferCleanup.unref();

  async function close() {
    clearInterval(heartbeat);
    clearInterval(transferCleanup);
    for (const client of clients) client.ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }

  return {
    server,
    wss,
    close,
    constants: { MAX_FILE_SIZE, FILE_CHUNK_SIZE }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8000;
  const { server } = createChatMeServer();
  server.listen(port, '0.0.0.0');
}

module.exports = { createChatMeServer };
