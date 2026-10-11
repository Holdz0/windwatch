(() => {
  if (globalThis.__windwatchDetectorInstalled) return;
  globalThis.__windwatchDetectorInstalled = true;
  let scanId = '', selected = null, cleanup = () => {};
  const controlled = new Map();
  function videos(root = document) {
    const list = [...root.querySelectorAll('video')];
    // Open shadow roots are inspectable; closed roots remain browser-private.
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) list.push(...videos(element.shadowRoot));
    return list;
  }
  function rank(video) {
    const area = video.getBoundingClientRect();
    return (!video.paused && !video.ended ? 1000 : 0) + (video.currentTime > 0 ? 300 : 0) + (video.duration > 120 ? 200 : 0) + Math.min(area.width * area.height / 1000, 200);
  }
  function sample(video) { return { position: video.currentTime || 0, duration: Number.isFinite(video.duration) ? video.duration : null, paused: video.paused, rate: video.playbackRate, live: !Number.isFinite(video.duration) && video.readyState > 0 }; }
  function report(action, framesChanged = false, reuseSelection = false) {
    if (!scanId) return;
    if (!reuseSelection || !selected?.isConnected) {
      const found = videos().sort((a, b) => rank(b) - rank(a));
      selected = found[0] || null;
    }
    const payload = { type: 'windwatch:detected', scanId, title: document.title, detected: !!selected, framesChanged };
    if (selected) {
      payload.sample = sample(selected); payload.rank = rank(selected);
      const value = selected.currentSrc || selected.src || selected.querySelector('source')?.src;
      if (value && /^https?:/i.test(value)) {
        const kind = /\.m3u8(?:$|\?)/i.test(value) ? 'hls' : 'video';
        payload.candidate = { url: value, kind, title: document.title, method: !selected.paused ? 'Oynatılan video' : 'Sayfadaki video', playing: !selected.paused, position: selected.currentTime, score: !selected.paused ? 120 : 85 };
      }
      if (action === 'encrypted' || selected.mediaKeys) payload.encrypted = true;
      if (action && action !== 'encrypted') {
        const expected = controlled.get(action);
        const matches = expected && Date.now() < expected.expires &&
          (action === 'seek' ? Math.abs(selected.currentTime - expected.value) < .6 :
            action === 'rate' ? Math.abs(selected.playbackRate - expected.value) < .01 :
              action === 'play' ? !selected.paused : selected.paused);
        const consistent = action === 'play' ? !selected.paused : action === 'pause' ? selected.paused : action === 'ended' ? selected.ended : true;
        if (!matches && consistent) payload.action = action;
      }
    }
    chrome.runtime.sendMessage(payload).catch(() => {});
  }
  function start(id) {
    cleanup(); scanId = id;
    let timer, lastReport = 0, pendingAction;
    const update = action => {
      if (['play', 'pause', 'ended'].includes(action)) { lastReport = Date.now(); report(action); return; }
      if (action) pendingAction = action;
      clearTimeout(timer);
      timer = setTimeout(() => { lastReport = Date.now(); report(pendingAction); pendingAction = undefined; }, 180);
    };
    // "playing" also fires after a seek or buffering. Only "play" indicates
    // a transition from paused to playing; treating readiness as a user play
    // command would undo a room pause that arrived during a seek.
    const events = { play: 'play', playing: undefined, pause: 'pause', seeked: 'seek', ratechange: 'rate', loadedmetadata: undefined, encrypted: 'encrypted', ended: 'ended' };
    const handlers = Object.entries(events).map(([name, action]) => { const handler = event => { if (event.target instanceof HTMLVideoElement) update(action); }; document.addEventListener(name, handler, true); return [name, handler]; });
    const observer = new MutationObserver(mutations => {
      if (mutations.some(mutation => [...mutation.addedNodes].some(node => node instanceof Element && (node.matches('video, source, iframe') || node.querySelector('video, source, iframe')))) || mutations.some(mutation => mutation.type === 'attributes')) {
        update();
        if (mutations.some(mutation => [...mutation.addedNodes].some(node => node instanceof Element && (node.matches('iframe') || node.querySelector('iframe'))))) report(undefined, true);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    // The detector is active only in the selected source tab. Polling covers
    // shadow-root players and updates playback samples without global capture.
    let ticks = 0;
    const interval = setInterval(() => { if (Date.now() - lastReport > 1500) report(undefined, false, ++ticks % 5 !== 0); }, 2000);
    cleanup = () => { observer.disconnect(); clearTimeout(timer); clearInterval(interval); handlers.forEach(([name, handler]) => document.removeEventListener(name, handler, true)); selected = null; scanId = ''; controlled.clear(); };
    report();
  }
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === 'windwatch:scan') { start(message.scanId); reply({ ok: true }); return; }
    if (message?.type === 'windwatch:stop') { cleanup(); reply({ ok: true }); return; }
    if (message?.type !== 'windwatch:control' || message.scanId !== scanId) return;
    (async () => {
      if (!selected || !selected.isConnected) report();
      if (!selected) return { ok: false, error: 'Sayfada henüz bir video bulunamadı. Videoyu kaynak sitede başlatıp tekrar tespit edin.' };
      const video = selected;
      const value = Number(message.value);
      if (message.command === 'play') controlled.delete('pause');
      if (message.command === 'pause') controlled.delete('play');
      if (['play', 'pause', 'seek', 'rate'].includes(message.command)) controlled.set(message.command, { value, expires: Date.now() + 2000 });
      if (message.command === 'play') await video.play();
      else if (message.command === 'pause') video.pause();
      else if (message.command === 'seek' && Number.isFinite(value) && value >= 0) video.currentTime = value;
      else if (message.command === 'rate' && Number.isFinite(value) && value >= 0.25 && value <= 4) video.playbackRate = value;
      else if (message.command === 'volume' && Number.isFinite(value)) { video.muted = value === 0; video.volume = Math.max(0, Math.min(1, value)); }
      return { ok: true, sample: sample(video) };
    })().then(reply, error => reply({ ok: false, error: error.name === 'NotAllowedError' ? 'Kaynak sekmesinde videoyu bir kez başlatın.' : error.message }));
    return true;
  });
})();
