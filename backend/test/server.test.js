const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../src/server');
const { getRoom } = require('../src/rooms');
const { randomUUID } = require('node:crypto');

let runtime;
let url;
const clients = [];
before(async () => {
  runtime = createServer();
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${runtime.server.address().port}`;
});
after(async () => {
  clients.forEach(client => client.disconnect());
  await new Promise(resolve => runtime.io.close(resolve));
});

function event(socket, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error(`Missing ${name}`)); }, 3000);
    function handler(data) {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off(name, handler);
      resolve(data);
    }
    socket.on(name, handler);
  });
}
async function room(password = null) {
  const response = await fetch(`${url}/create-room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(response.status, 201);
  return (await response.json()).roomId;
}
async function client(roomId, username, credential = {}) {
  const socket = connect(url, { transports: ['websocket'], reconnection: false });
  clients.push(socket);
  await event(socket, 'connect');
  const identity = { roomId, username, clientId: randomUUID(), peerId: randomUUID(), ...credential };
  const joined = event(socket, 'room-users', data => data.roomUsers.some(user => user.peerId === identity.peerId));
  socket.emit('join-room', identity);
  const users = await joined;
  return { socket, identity, users };
}

test('room creation rejects non-string and oversized passwords', async () => {
  for (const password of [{ bypass: true }, 'a'.repeat(101)]) {
    const response = await fetch(`${url}/create-room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    assert.equal(response.status, 400);
  }
});

test('simultaneous screen requests allow exactly one sharer', async () => {
  const id = await room();
  const a = await client(id, 'A');
  const b = await client(id, 'B');
  const answers = await Promise.all([a, b].map(member => member.socket.timeout(1000).emitWithAck('toggle-screen-share', { isSharing: true })));
  assert.equal(answers.filter(answer => answer.ok).length, 1);
  const winner = answers[0].ok ? a : b;
  const loser = winner === a ? b : a;
  await winner.socket.timeout(1000).emitWithAck('toggle-screen-share', { isSharing: false });
  assert.equal((await loser.socket.timeout(1000).emitWithAck('toggle-screen-share', { isSharing: true })).ok, true);
});

test('signalling forwards only within a room and identifies the real sender', async () => {
  const id = await room();
  const a = await client(id, 'A');
  const b = await client(id, 'B');
  const outsider = await client(await room(), 'Outside');
  const signal = { sessionId: randomUUID(), description: { type: 'offer', sdp: 'test-offer' } };
  const received = event(b.socket, 'rtc-signal');
  a.socket.emit('rtc-signal', { targetPeerId: b.identity.peerId, signal });
  assert.deepEqual(await received, { peerId: a.identity.peerId, signal });
  let unauthorized = 0;
  b.socket.on('rtc-signal', () => unauthorized++);
  outsider.socket.emit('rtc-signal', { targetPeerId: b.identity.peerId, signal });
  outsider.socket.emit('send-message', { roomId: outsider.identity.roomId, text: 'barrier' });
  await event(outsider.socket, 'receive-message', message => message.text === 'barrier');
  assert.equal(unauthorized, 0);
});

test('rejoining a locked room retains host rights and media state', async () => {
  const id = await room('secret');
  const host = await client(id, 'Host', { password: 'secret' });
  const locked = event(host.socket, 'room-locked-status', state => state.isLocked);
  host.socket.emit('toggle-lock-room');
  await locked;
  host.socket.disconnect();
  const replacement = await client(id, 'Host', { ...host.identity, media: { isAudioMuted: false, isVideoMuted: false, isScreenSharing: true } });
  const user = replacement.users.roomUsers[0];
  assert.equal(user.isHost, true);
  assert.equal(user.isAudioMuted, false);
  assert.equal(user.isVideoMuted, false);
  assert.equal(user.isScreenSharing, true);
  assert.equal(user.isReconnecting, false);
  assert.equal(replacement.users.hostSocketId, replacement.socket.id);
  assert.equal(JSON.stringify(replacement.users).includes(host.identity.clientId), false);
});

test('malformed socket payloads do not crash the server', async () => {
  const member = await client(await room(), 'Valid');
  const warning = event(member.socket, 'warning-msg');
  member.socket.emit('join-room', null);
  assert.equal(await warning, 'Geçersiz istek.');
  assert.equal((await fetch(`${url}/health`)).status, 200);
});

test('host removal promotes a connected participant and explicit leave removes membership', async () => {
  const id = await room();
  const host = await client(id, 'Host');
  const viewer = await client(id, 'Viewer');
  const promoted = event(viewer.socket, 'room-users', data => data.hostSocketId === viewer.socket.id);
  host.socket.emit('leave-room');
  await promoted;
  assert.equal(getRoom(id).users.size, 1);
});

test('watch timeline is authoritative, controls are scoped, stale commands fail, late joins receive current playback', async () => {
  const id = await room();
  const host = await client(id, 'Watch host');
  const viewer = await client(id, 'Watch viewer');
  const other = await client(await room(), 'Other room');
  const send = (socket, payload) => socket.timeout(1500).emitWithAck('watch-command', payload);
  const loaded = await send(host.socket, { type: 'load', source: { kind: 'video', url: 'https://example.org/movie.mp4', title: 'Film' }, position: 10 });
  assert.equal(loaded.ok, true);
  const sessionId = loaded.state.session.id;
  assert.equal(loaded.state.session.ownerPeerId, host.identity.peerId);
  assert.equal(JSON.stringify(loaded).includes(host.identity.clientId), false);
  assert.equal((await send(viewer.socket, { type: 'pause', sessionId })).ok, false);
  assert.equal((await send(other.socket, { type: 'pause', sessionId })).ok, false);
  assert.equal((await send(host.socket, { type: 'seek', sessionId, position: NaN })).ok, false);
  assert.equal((await send(host.socket, { type: 'rate', sessionId, rate: 50 })).ok, false);
  assert.equal((await send(host.socket, { type: 'pause', sessionId: 'stale' })).ok, false);
  assert.equal((await send(host.socket, { type: 'permission', sessionId, everyoneControls: true })).ok, true);
  const paused = await send(viewer.socket, { type: 'pause', sessionId, position: 42 });
  assert.equal(paused.state.session.position, 42);
  assert.equal(paused.state.session.paused, true);
  const late = await client(id, 'Late watcher');
  const state = await late.socket.timeout(1500).emitWithAck('watch-get');
  assert.equal(state.session.position, 42);
  assert.equal(state.session.paused, true);
  assert.equal((await send(host.socket, { type: 'rate', sessionId, rate: 1.5, position: 42 })).ok, true);
  assert.equal((await send(host.socket, { type: 'play', sessionId, position: 42 })).ok, true);
  const advancing = await late.socket.timeout(1500).emitWithAck('watch-get');
  assert.equal(advancing.session.rate, 1.5);
  assert.equal(advancing.session.paused, false);
  assert.ok(advancing.session.position >= 42);
  host.socket.emit('leave-room');
  await event(viewer.socket, 'watch-state', value => value.session?.ownerPeerId === viewer.identity.peerId);
  assert.equal((await send(viewer.socket, { type: 'pause', sessionId })).ok, true);
});

test('watch queue, readiness and source changes survive reconnect without leaking credentials', async () => {
  const id = await room();
  const host = await client(id, 'Queue host');
  const loaded = await host.socket.timeout(1500).emitWithAck('watch-command', { type: 'load', source: { kind: 'youtube', url: 'https://youtu.be/abcdefghijk' } });
  const sessionId = loaded.state.session.id;
  const queued = await host.socket.timeout(1500).emitWithAck('watch-command', { type: 'queue-add', sessionId, source: { kind: 'hls', url: 'https://example.org/playlist.m3u8' } });
  assert.equal(queued.state.session.queue.length, 1);
  const statuses = event(host.socket, 'watch-statuses');
  host.socket.emit('watch-status', { sessionId, status: 'ready' });
  assert.equal((await statuses).statuses[host.identity.peerId].status, 'ready');
  host.socket.disconnect();
  const replacement = await client(id, 'Queue host', host.identity);
  const current = await replacement.socket.timeout(1500).emitWithAck('watch-get');
  assert.equal(current.session.ownerPeerId, replacement.identity.peerId);
  assert.equal(current.session.queue.length, 1);
  const next = await replacement.socket.timeout(1500).emitWithAck('watch-command', { type: 'next', sessionId });
  assert.equal(next.state.session.source.kind, 'hls');
  assert.notEqual(next.state.session.id, sessionId);
  assert.equal(next.state.session.queue.length, 0);
  assert.equal((await replacement.socket.timeout(1500).emitWithAck('watch-command', { type: 'pause', sessionId })).ok, false);
  const stopped = await replacement.socket.timeout(1500).emitWithAck('watch-command', { type: 'stop', sessionId: next.state.session.id });
  assert.equal(stopped.state.session, null);
});
