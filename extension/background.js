const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://localhost:5178'];
let work = Promise.resolve();
function serial(fn) { const next = work.catch(() => {}).then(fn); work = next; return next; }
async function jobs() { return (await chrome.storage.session.get('jobs')).jobs || {}; }
async function saveJobs(value) { await chrome.storage.session.set({ jobs: value }); }
function safeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 4096 ? url.href : null; } catch { return null; }
}
function sourceKind(url, mime = '') {
  const parsed = new URL(url);
  if (/\.m3u8$/i.test(parsed.pathname) || /mpegurl/i.test(mime)) return 'hls';
  if (/\.(?:mp4|webm|ogv|m4v|mov)$/i.test(parsed.pathname) || /^video\/(?:mp4|webm|ogg|quicktime)/i.test(mime)) return 'video';
  return null;
}
async function push(job, update = {}) {
  try { await chrome.tabs.sendMessage(job.appTabId, { type: 'windwatch:update', update: { scanId: job.scanId, pageUrl: job.url, title: job.title || '', candidates: Object.values(job.candidates || {}).sort((a, b) => b.score - a.score).slice(0, 15), ...update } }); } catch { /* The app may have closed. Its job is cleared by onRemoved. */ }
}
async function inject(job) {
  if (job.suspended) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: job.sourceTabId, allFrames: true }, files: ['detector.js'] });
    await chrome.tabs.sendMessage(job.sourceTabId, { type: 'windwatch:scan', scanId: job.scanId });
  } catch { /* A navigation or an inaccessible frame can temporarily fail. Rescan remains available. */ }
}
async function stopDetector(job, pause = false) {
  if (pause && !job.suspended) {
    try { await chrome.tabs.sendMessage(job.sourceTabId, { type: 'windwatch:control', scanId: job.scanId, command: 'pause' }, { frameId: job.frameId ?? 0 }); } catch { /* already closed or not detected */ }
  }
  try { await chrome.tabs.sendMessage(job.sourceTabId, { type: 'windwatch:stop' }); } catch { /* already closed */ }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'windwatch:app') {
    (async () => {
      const origin = new URL(sender.url).origin;
      const settings = await chrome.storage.local.get('origins');
      if (!(settings.origins || DEFAULT_ORIGINS).includes(origin) || sender.frameId !== 0) return { ok: false, error: 'Uzantı menüsünden bu WindWatch adresine izin verin.' };
      const appTabId = sender.tab?.id;
      if (!appTabId) return { ok: false, error: 'WindWatch sekmesi bulunamadı.' };
      if (message.action === 'ping') return { ok: true };
      return serial(async () => {
        const all = await jobs();
        let job = all[appTabId];
        if (message.action === 'stop') {
          if (message.scanId && job?.scanId !== message.scanId) return { ok: true };
          if (job) await stopDetector(job, true);
          delete all[appTabId]; await saveJobs(all); return { ok: true };
        }
        if (['open', 'rescan'].includes(message.action)) {
          const url = safeUrl(message.url);
          if (!url) return { ok: false, error: 'Geçerli bir kaynak bağlantısı girin.' };
          if (job?.sourceTabId) {
            try { await chrome.tabs.get(job.sourceTabId); } catch { job = null; }
          }
          if (!job || job.url !== url) {
            if (job) await stopDetector(job, true);
            const tab = await chrome.tabs.create({ url, active: message.focus === true });
            job = { appTabId, sourceTabId: tab.id, url, candidates: {}, title: '', encrypted: false };
          } else if (message.focus) await chrome.tabs.update(job.sourceTabId, { active: true });
          job.scanId = typeof message.scanId === 'string' ? message.scanId.slice(0, 100) : crypto.randomUUID();
          job.suspended = false;
          if (message.action === 'rescan') { job.candidates = {}; job.encrypted = false; job.detected = false; job.sample = null; job.rank = 0; delete job.frameId; }
          all[appTabId] = job; await saveJobs(all);
          // Do not await inject inside the storage transaction: a newly opened
          // page may not have its document yet. onUpdated injects after load.
          void inject(job);
          return { ok: true, scanId: job.scanId };
        }
        if (!job || message.scanId !== job.scanId) return { ok: false, error: 'Kaynak sekmesi henüz açık değil. Kaynak sekmesini açın.' };
        if (message.action === 'suspend') {
          job.suspended = true; all[appTabId] = job; await saveJobs(all);
          await stopDetector(job); return { ok: true };
        }
        if (message.action === 'focus') { await chrome.tabs.update(job.sourceTabId, { active: true }); return { ok: true }; }
        if (message.action === 'control') {
          if (!['sample', 'play', 'pause', 'seek', 'rate', 'volume'].includes(message.command)) return { ok: false, error: 'Geçersiz oynatıcı komutu.' };
          try {
            return await chrome.tabs.sendMessage(job.sourceTabId, { type: 'windwatch:control', command: message.command, value: message.value, scanId: job.scanId }, { frameId: job.frameId ?? 0 });
          } catch { return { ok: false, error: 'Kaynak oynatıcı yanıt vermedi. Tekrar tespit edin.' }; }
        }
        return { ok: false, error: 'Bilinmeyen video yardımcısı isteği.' };
      });
    })().then(reply, error => reply({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'windwatch:detected') {
    serial(async () => {
      const all = await jobs();
      const job = Object.values(all).find(item => item.sourceTabId === sender.tab?.id && item.scanId === message.scanId);
      if (!job || job.suspended) return;
      const candidate = message.candidate;
      if (candidate && safeUrl(candidate.url) && ['video', 'hls'].includes(candidate.kind)) {
        const existing = job.candidates[candidate.url];
        if (!existing || candidate.score > existing.score) job.candidates[candidate.url] = { ...candidate, title: String(candidate.title || '').slice(0, 160) };
        if (Object.keys(job.candidates).length > 30) job.candidates = Object.fromEntries(Object.values(job.candidates).sort((a, b) => b.score - a.score).slice(0, 30).map(item => [item.url, item]));
      }
      // Prefer the actual long-form, playing video over thumbnails, adverts
      // and a paused video in another iframe.
      if (message.detected && (!job.sample || message.rank >= (job.rank || 0) || sender.frameId === job.frameId)) {
        job.frameId = sender.frameId; job.sample = message.sample; job.rank = message.rank;
        job.title = String(message.title || job.title).slice(0, 160); job.detected = true;
      }
      if (message.encrypted) job.encrypted = true;
      if (message.framesChanged) void inject(job);
      await saveJobs(all);
      const selected = sender.frameId === job.frameId;
      await push(job, { sample: job.sample, detected: job.detected, encrypted: job.encrypted, ...(selected && message.action ? { action: message.action } : {}) });
    }).then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }
});
chrome.webRequest.onHeadersReceived.addListener(details => {
  const mime = details.responseHeaders?.find(header => header.name.toLowerCase() === 'content-type')?.value || '';
  const url = safeUrl(details.url);
  if (!url) return;
  const kind = sourceKind(url, mime);
  if (!kind) return;
  void serial(async () => {
    const all = await jobs();
    const job = Object.values(all).find(item => item.sourceTabId === details.tabId);
    if (!job || job.suspended || job.encrypted) return;
    if (!job.candidates[url] || job.candidates[url].score < 80) job.candidates[url] = { kind, url, title: job.title || 'Tespit edilen video', score: kind === 'hls' ? 80 : 55, method: kind === 'hls' ? 'Yayın manifesti' : 'Video ağ isteği' };
    if (Object.keys(job.candidates).length > 30) return;
    await saveJobs(all); await push(job, { detected: job.detected, sample: job.sample });
  });
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'complete') return;
  void jobs().then(all => { const job = Object.values(all).find(item => item.sourceTabId === tabId); if (job) void inject(job); });
});
chrome.tabs.onRemoved.addListener(tabId => {
  void serial(async () => {
    const all = await jobs();
    for (const [key, job] of Object.entries(all)) {
      if (job.sourceTabId === tabId) { await push(job, { closed: true }); delete all[key]; }
      else if (job.appTabId === tabId) { await stopDetector(job, true); delete all[key]; }
    }
    await saveJobs(all);
  });
});
