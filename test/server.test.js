'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { createChatMeServer } = require('../server');

function onceJson(ws, type, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeout);
    function onMessage(data, isBinary) {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}


function onceBinary(ws, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for binary frame'));
    }, timeout);
    function onMessage(data, isBinary) {
      if (!isBinary) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(Buffer.from(data));
    }
    ws.on('message', onMessage);
  });
}

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: url.replace('ws://', 'http://').replace('/ws', '') });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function publicKey(seed) {
  const bytes = Buffer.alloc(65, seed);
  bytes[0] = 4;
  return bytes.toString('base64');
}

test('health endpoint and mutually compatible matchmaking work', async (t) => {
  const app = createChatMeServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());

  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

  const a = await openWs(`ws://127.0.0.1:${address.port}/ws`);
  const b = await openWs(`ws://127.0.0.1:${address.port}/ws`);
  t.after(() => { a.close(); b.close(); });

  const queued = onceJson(a, 'queued');
  a.send(JSON.stringify({ type: 'join', adult: true, gender: 'girl', preference: 'boy', publicKey: publicKey(1) }));
  await queued;

  const matchA = onceJson(a, 'matched');
  const matchB = onceJson(b, 'matched');
  b.send(JSON.stringify({ type: 'join', adult: true, gender: 'boy', preference: 'girl', publicKey: publicKey(2) }));
  const [aMatched, bMatched] = await Promise.all([matchA, matchB]);
  assert.equal(aMatched.partnerPublicKey, publicKey(2));
  assert.equal(bMatched.partnerPublicKey, publicKey(1));

  const relayed = onceJson(b, 'secure');
  a.send(JSON.stringify({ type: 'secure', payload: { iv: 'dGVzdGl2', data: 'Y2lwaGVydGV4dA==' } }));
  assert.deepEqual((await relayed).payload, { iv: 'dGVzdGl2', data: 'Y2lwaGVydGV4dA==' });
});

test('18+ is required before queueing', async (t) => {
  const app = createChatMeServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());

  const address = app.server.address();
  const ws = await openWs(`ws://127.0.0.1:${address.port}/ws`);
  t.after(() => ws.close());

  const error = onceJson(ws, 'error');
  ws.send(JSON.stringify({ type: 'join', adult: false, gender: 'girl', preference: 'any', publicKey: publicKey(3) }));
  assert.equal((await error).code, 'invalid_join');
});


test('incompatible preferences stay queued until a compatible person arrives', async (t) => {
  const app = createChatMeServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());

  const { port } = app.server.address();
  const url = `ws://127.0.0.1:${port}/ws`;
  const a = await openWs(url);
  const b = await openWs(url);
  const c = await openWs(url);
  t.after(() => { a.close(); b.close(); c.close(); });

  const queuedA = onceJson(a, 'queued');
  a.send(JSON.stringify({ type: 'join', adult: true, gender: 'girl', preference: 'boy', publicKey: publicKey(4) }));
  await queuedA;

  const queuedB = onceJson(b, 'queued');
  b.send(JSON.stringify({ type: 'join', adult: true, gender: 'girl', preference: 'girl', publicKey: publicKey(5) }));
  await queuedB;

  const matchedA = onceJson(a, 'matched');
  const matchedC = onceJson(c, 'matched');
  c.send(JSON.stringify({ type: 'join', adult: true, gender: 'boy', preference: 'girl', publicKey: publicKey(6) }));

  const [aMatch, cMatch] = await Promise.all([matchedA, matchedC]);
  assert.equal(aMatch.partnerPublicKey, publicKey(6));
  assert.equal(cMatch.partnerPublicKey, publicKey(4));
});

test('Next separates a pair and lets the requester enter a fresh match', async (t) => {
  const app = createChatMeServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());

  const { port } = app.server.address();
  const url = `ws://127.0.0.1:${port}/ws`;
  const a = await openWs(url);
  const b = await openWs(url);
  const c = await openWs(url);
  t.after(() => { a.close(); b.close(); c.close(); });

  const queuedA = onceJson(a, 'queued');
  a.send(JSON.stringify({ type: 'join', adult: true, gender: 'girl', preference: 'boy', publicKey: publicKey(7) }));
  await queuedA;
  const matchA = onceJson(a, 'matched');
  const matchB = onceJson(b, 'matched');
  b.send(JSON.stringify({ type: 'join', adult: true, gender: 'boy', preference: 'girl', publicKey: publicKey(8) }));
  await Promise.all([matchA, matchB]);

  const leftB = onceJson(b, 'partner_left');
  const idleA = onceJson(a, 'idle');
  a.send(JSON.stringify({ type: 'next' }));
  assert.equal((await leftB).reason, 'next');
  await idleA;

  const queuedAgain = onceJson(a, 'queued');
  a.send(JSON.stringify({ type: 'join', adult: true, gender: 'girl', preference: 'boy', publicKey: publicKey(9) }));
  await queuedAgain;

  const rematchA = onceJson(a, 'matched');
  const rematchC = onceJson(c, 'matched');
  c.send(JSON.stringify({ type: 'join', adult: true, gender: 'boy', preference: 'girl', publicKey: publicKey(10) }));
  const [aMatch, cMatch] = await Promise.all([rematchA, rematchC]);
  assert.equal(aMatch.partnerPublicKey, publicKey(10));
  assert.equal(cMatch.partnerPublicKey, publicKey(9));
});

test('accepted files are relayed as binary chunks and completed without server-side file buffering', async (t) => {
  const app = createChatMeServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());

  const { port } = app.server.address();
  const url = `ws://127.0.0.1:${port}/ws`;
  const a = await openWs(url);
  const b = await openWs(url);
  t.after(() => { a.close(); b.close(); });

  const queuedA = onceJson(a, 'queued');
  a.send(JSON.stringify({ type: 'join', adult: true, gender: 'girl', preference: 'boy', publicKey: publicKey(11) }));
  await queuedA;
  const matchA = onceJson(a, 'matched');
  const matchB = onceJson(b, 'matched');
  b.send(JSON.stringify({ type: 'join', adult: true, gender: 'boy', preference: 'girl', publicKey: publicKey(12) }));
  await Promise.all([matchA, matchB]);

  const transferId = crypto.randomUUID();
  const offerB = onceJson(b, 'file_offer');
  a.send(JSON.stringify({
    type: 'file_offer',
    transferId,
    size: 3,
    meta: { iv: 'dGVzdGl2', data: 'ZW5jcnlwdGVkLW1ldGE=' }
  }));
  assert.equal((await offerB).transferId, transferId);

  const acceptedA = onceJson(a, 'file_response');
  b.send(JSON.stringify({ type: 'file_response', transferId, accept: true }));
  assert.equal((await acceptedA).accept, true);

  const frame = Buffer.alloc(33 + 3 + 16);
  frame[0] = 1;
  uuidToBytes(transferId).copy(frame, 1);
  frame.writeUInt32BE(0, 17);
  crypto.randomBytes(12).copy(frame, 21);
  crypto.randomBytes(19).copy(frame, 33);

  const binaryB = onceBinary(b);
  const completeA = onceJson(a, 'file_complete');
  const completeB = onceJson(b, 'file_complete');
  a.send(frame);

  assert.deepEqual(await binaryB, frame);
  assert.equal((await completeA).transferId, transferId);
  assert.equal((await completeB).transferId, transferId);
});
