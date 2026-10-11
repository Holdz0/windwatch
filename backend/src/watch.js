const { randomUUID } = require('node:crypto');
const { validateSource, discoverSources } = require('./watchSources');

function positionAt(watch, now = Date.now()) {
  return Math.max(0, watch.position + (watch.paused ? 0 : Math.max(0, now - watch.updatedAt) / 1000 * watch.rate));
}
function snapshot(room) {
  const watch = room.watch;
  if (!watch) return { session: null, serverTime: Date.now() };
  const owner = room.users.get(watch.ownerClientId);
  const { ownerClientId, ...publicState } = watch;
  return { session: { ...publicState, ownerPeerId: owner?.peerId || '', ownerName: owner?.username || '', position: positionAt(watch), updatedAt: Date.now() }, serverTime: Date.now() };
}
function removeWatchMember(room, user) {
  if (!room.watch) return;
  delete room.watch.statuses[user.peerId];
  if (!room.users.size) { room.watch = null; return; }
  if (room.watch.ownerClientId === user.clientId) {
    room.watch.ownerClientId = room.hostClientId;
    room.watch.revision++;
  }
}
function installWatch(io, socket, currentMember) {
  let scan = null, scanAt = 0;
  let commandWindow = 0, commandCount = 0, statusAt = 0;
  let statusWindow = 0, statusCount = 0;
  const broadcast = room => io.to(room.roomId).emit('watch-state', snapshot(room));
  socket.on('watch-clock', ack => { if (typeof ack === 'function' && currentMember(socket)) ack({ serverTime: Date.now() }); });
  socket.on('watch-get', ack => { const member = currentMember(socket); if (typeof ack === 'function' && member) ack(snapshot(member.room)); });
  socket.on('watch-detect', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    const member = currentMember(socket);
    if (!member) return ack({ ok: false, error: 'Bu odada değilsiniz.' });
    if (Date.now() - scanAt < 1500) return ack({ ok: false, error: 'Yeni tespit için kısa bir süre bekleyin.' });
    scanAt = Date.now();
    scan?.abort();
    const controller = new AbortController();
    scan = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const result = await discoverSources(payload?.url, controller.signal);
      if (scan === controller && currentMember(socket)?.room === member.room) ack({ ok: true, ...result });
    } catch (error) {
      if (scan === controller) ack({ ok: false, error: controller.signal.aborted ? 'Site taraması zaman aşımına uğradı. Kaynak sekmesinde tespiti deneyin.' : error.message });
    } finally { clearTimeout(timeout); if (scan === controller) scan = null; }
  });
  socket.on('watch-command', (payload, ack) => {
    const respond = result => { if (typeof ack === 'function') ack(result); };
    const member = currentMember(socket);
    if (!member) return respond({ ok: false, error: 'Bu odada değilsiniz.' });
    if (Date.now() - commandWindow > 2000) { commandWindow = Date.now(); commandCount = 0; }
    if (++commandCount > 25) return respond({ ok: false, error: 'Çok sık oynatıcı komutu gönderildi.' });
    if (!payload || typeof payload !== 'object') return respond({ ok: false, error: 'Geçersiz oynatıcı komutu.' });
    const { room, user } = member;
    const host = room.hostClientId === user.clientId;
    let watch = room.watch;
    const owner = watch?.ownerClientId === user.clientId;
    const controls = !watch || host || owner || watch.everyoneControls;
    if (!controls) return respond({ ok: false, error: 'Oynatıcı kontrolü yayın yöneticisinde.' });
    if (payload.type !== 'load' && (!watch || payload.sessionId !== watch.id)) return respond({ ok: false, error: 'Video değişti. Güncel oynatıcıyı kullanın.', state: snapshot(room) });
    const now = Date.now();
    if (payload.type === 'load') {
      const source = validateSource(payload.source);
      if (!source) return respond({ ok: false, error: 'Desteklenen, geçerli bir video bağlantısı seçin.' });
      const position = typeof payload.position === 'number' && Number.isFinite(payload.position) && payload.position >= 0 ? Math.min(payload.position, 864000) : 0;
      watch = room.watch = { id: randomUUID(), revision: 1, source, ownerClientId: user.clientId, position, paused: false, rate: 1, updatedAt: now, everyoneControls: false, autoNext: true, statuses: {}, queue: watch?.queue || [] };
    } else if (payload.type === 'stop') room.watch = null;
    else if (payload.type === 'permission') {
      if ((!host && !owner) || typeof payload.everyoneControls !== 'boolean') return respond({ ok: false, error: 'Bu ayarı yalnızca yönetici değiştirebilir.' });
      watch.everyoneControls = payload.everyoneControls;
      if (typeof payload.autoNext === 'boolean') watch.autoNext = payload.autoNext;
    } else if (payload.type === 'take-control') {
      if (!host && !owner) return respond({ ok: false, error: 'Kontrolü yalnızca oda kurucusu devralabilir.' });
      watch.ownerClientId = user.clientId;
    } else if (payload.type === 'queue-add') {
      const source = validateSource(payload.source);
      if (!source || watch.queue.length >= 20) return respond({ ok: false, error: 'Kuyruk en fazla 20 geçerli video alabilir.' });
      watch.queue.push({ ...source, id: randomUUID(), addedBy: user.username });
    } else if (payload.type === 'queue-remove') {
      watch.queue = watch.queue.filter(source => source.id !== payload.itemId);
    } else if (payload.type === 'next') {
      if (!watch.queue.length) return respond({ ok: false, error: 'Kuyrukta video yok.' });
      const [source, ...queue] = watch.queue;
      const { id, addedBy, ...nextSource } = source;
      room.watch = { ...watch, id: randomUUID(), revision: 1, source: nextSource, position: 0, paused: false, rate: 1, updatedAt: now, statuses: {}, queue };
    } else if (['play', 'pause', 'seek', 'rate', 'heartbeat', 'ended'].includes(payload.type)) {
      if (payload.type === 'heartbeat' && !owner) return respond({ ok: false, error: 'Geçersiz oynatıcı bildirimi.' });
      if (payload.type === 'ended' && !owner && !host) return respond({ ok: false, error: 'Geçersiz bitiş bildirimi.' });
      const position = payload.position;
      if (position !== undefined && (typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position > 864000)) return respond({ ok: false, error: 'Geçersiz video zamanı.' });
      if (payload.type === 'rate' && ![0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(payload.rate)) return respond({ ok: false, error: 'Geçersiz oynatma hızı.' });
      if (payload.type === 'heartbeat' && Math.abs(positionAt(watch) - (position ?? positionAt(watch))) < 0.75) return respond({ ok: true });
      watch.position = position ?? positionAt(watch);
      watch.updatedAt = now;
      if (payload.type === 'play') watch.paused = false;
      if (['pause', 'ended'].includes(payload.type)) watch.paused = true;
      if (payload.type === 'rate') watch.rate = payload.rate;
    } else return respond({ ok: false, error: 'Geçersiz oynatıcı komutu.' });
    if (room.watch === watch && payload.type !== 'load') watch.revision++;
    const state = snapshot(room);
    io.to(room.roomId).emit('watch-state', state);
    respond({ ok: true, state });
  });
  socket.on('watch-status', payload => {
    const member = currentMember(socket);
    const watch = member?.room.watch;
    if (!watch || payload?.sessionId !== watch.id) return;
    if (!['loading', 'ready', 'buffering', 'blocked', 'error', 'ended', 'external'].includes(payload.status)) return;
    if (Date.now() - statusWindow > 2000) { statusWindow = Date.now(); statusCount = 0; }
    if (++statusCount > 25 || (Date.now() - statusAt < 500 && watch.statuses[member.user.peerId]?.status === payload.status)) return;
    statusAt = Date.now();
    watch.statuses[member.user.peerId] = { status: payload.status, updatedAt: Date.now() };
    // Playback status is separate from timeline revisions: a buffering report
    // must not seek/restart everybody's player.
    io.to(member.room.roomId).emit('watch-statuses', { sessionId: watch.id, statuses: watch.statuses });
  });
  socket.on('disconnect', () => { scan?.abort(); scan = null; });
  return broadcast;
}
module.exports = { installWatch, snapshot, removeWatchMember, positionAt };
