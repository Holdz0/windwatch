import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { Film, Play, Pause, RefreshCw, Search, ExternalLink, Volume2, VolumeX, Maximize, Minimize, SkipBack, SkipForward, X, ListPlus, ChevronDown, ChevronUp, ListVideo, Link, ShieldCheck } from 'lucide-react';
import type { Participant } from '../types';
import { WatchBridge } from '../utils/watchBridge';
import type { HelperUpdate } from '../utils/watchBridge';
import { createWatchAdapter, sourceSiteUrl } from '../utils/watchPlayers';
import { clockTime, expectedPosition, parseWatchUrl, sourceFromUrl, startPosition, WATCH_STATUS_LABELS } from '../utils/watch';
import type { PlayerSample, WatchAdapter, WatchCandidate, WatchCommand, WatchSession, WatchSource, WatchState, WatchStatus } from '../utils/watch';

interface Props { socket: Socket | null; participants: Participant[]; open: boolean; connected: boolean; onClose: () => void; onActive: (active: boolean) => void }
const EMPTY_SAMPLE: PlayerSample = { position: 0, duration: 0, paused: true, rate: 1 };
function savedVolume() { try { const value = Number(localStorage.getItem('windwatch:watchVolume') ?? '0.7'); return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.7; } catch { return 0.7; } }

export default function WatchParty({ socket, participants, open, connected, onClose, onActive }: Props) {
  const [watch, setWatch] = useState<WatchSession | null>(null);
  const active = !!watch;
  const [draft, setDraft] = useState('');
  const [candidates, setCandidates] = useState<WatchCandidate[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectInfo, setDetectInfo] = useState('');
  const [error, setError] = useState('');
  const [playerError, setPlayerError] = useState('');
  const [bridge, setBridge] = useState<WatchBridge | null>(null);
  const [helper, setHelper] = useState(false);
  const [helperDetected, setHelperDetected] = useState(false);
  const [helperEncrypted, setHelperEncrypted] = useState(false);
  const [status, setStatus] = useState<WatchStatus>('loading');
  const [sample, setSample] = useState(EMPTY_SAMPLE);
  const [scrubPosition, setScrubPosition] = useState<number | null>(null);
  const [volume, setVolume] = useState(savedVolume);
  const [retry, setRetry] = useState(0);
  const [showSources, setShowSources] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [queueMode, setQueueMode] = useState(false);
  const [autoStart, setAutoStart] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [levels, setLevels] = useState<{ value: number; label: string }[]>([]);
  const [quality, setQuality] = useState(-1);
  const [permissionsPending, setPermissionsPending] = useState<{ everyoneControls: boolean; autoNext: boolean } | null>(null);
  const [drift, setDrift] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<WatchAdapter | null>(null);
  const watchRef = useRef(watch); watchRef.current = watch;
  const sampleRef = useRef(sample); sampleRef.current = sample;
  const volumeRef = useRef(volume); volumeRef.current = volume;
  const statusRef = useRef(status); statusRef.current = status;
  const contextRef = useRef({ participants, connected }); contextRef.current = { participants, connected };
  const commandRef = useRef<(command: WatchCommand) => Promise<boolean>>(async () => false);
  const chooseRef = useRef<(source: WatchSource, position?: number) => Promise<void>>(async () => {});
  const offsetRef = useRef(0);
  const bestRttRef = useRef(Infinity);
  const scanRef = useRef('');
  const scanModeRef = useRef<'page' | 'helper'>('page');
  const externalScanRef = useRef('');
  const externalReadyRef = useRef(false);
  const outputVersionRef = useRef(0);
  const generationRef = useRef(0);
  const detectedUrlRef = useRef('');
  const autoChosenRef = useRef('');
  const autoConfigRef = useRef({ autoStart, queueMode }); autoConfigRef.current = { autoStart, queueMode };
  const blockedRef = useRef(false);
  const statusSentRef = useRef('');
  const heartbeatRef = useRef(0);
  const endedRef = useRef('');
  const seekTimerRef = useRef<number | undefined>(undefined);
  const seekTargetRef = useRef<{ position: number; expires: number } | null>(null);

  const setPlayerStatus = useCallback((next: WatchStatus, message = '') => {
    if (next === 'ready' && blockedRef.current) return;
    statusRef.current = next; setStatus(next);
    if (message) setPlayerError(message);
    if (next === 'blocked') blockedRef.current = true;
    const session = watchRef.current;
    if (session && statusSentRef.current !== `${session.id}:${next}`) {
      statusSentRef.current = `${session.id}:${next}`;
      socket?.emit('watch-status', { sessionId: session.id, status: next });
    }
  }, [socket]);

  useEffect(() => {
    const instance = new WatchBridge(); setBridge(instance);
    return () => { void instance.request('stop'); instance.dispose(); };
  }, []);
  useEffect(() => { if (bridge && !active && !open && bridge.connected) void bridge.request('stop'); }, [bridge, active, open]);
  useEffect(() => {
    if (!bridge || (!open && !active)) return;
    let stopped = false;
    void bridge.ping().then(value => { if (!stopped) setHelper(value); });
    return () => { stopped = true; };
  }, [bridge, open, active]);

  useEffect(() => {
    if (!socket) return;
    let disposed = false;
    const receive = (state: WatchState) => {
      if (disposed || !state || typeof state.serverTime !== 'number') return;
      if (bestRttRef.current === Infinity) offsetRef.current = state.serverTime - Date.now();
      setWatch(previous => previous && previous.id === state.session?.id && previous.revision > state.session.revision ? previous : state.session);
    };
    const statuses = (payload: { sessionId: string; statuses: WatchSession['statuses'] }) => setWatch(previous => previous?.id === payload.sessionId ? { ...previous, statuses: payload.statuses } : previous);
    const fetchState = () => { void socket.timeout(5000).emitWithAck('watch-get').then(receive).catch(() => {}); };
    socket.on('watch-state', receive); socket.on('watch-statuses', statuses); socket.on('connect', fetchState);
    if (socket.connected) fetchState();
    return () => { disposed = true; socket.off('watch-state', receive); socket.off('watch-statuses', statuses); socket.off('connect', fetchState); };
  }, [socket]);

  useEffect(() => { onActive(active); }, [active, onActive]);
  useEffect(() => {
    if (!socket || !connected || (!open && !active)) return;
    let stopped = false;
    const measure = async () => {
      for (let attempt = 0; attempt < 3 && !stopped; attempt++) {
        const start = Date.now();
        try {
          const result = await socket.timeout(3000).emitWithAck('watch-clock');
          const end = Date.now(), rtt = end - start;
          if (!stopped && typeof result.serverTime === 'number' && rtt <= bestRttRef.current + 10) { bestRttRef.current = rtt; offsetRef.current = result.serverTime - (start + end) / 2; }
        } catch { /* A reconnect can interrupt a sample. */ }
      }
    };
    void measure();
    const timer = window.setInterval(() => { bestRttRef.current = Infinity; void measure(); }, 60000);
    return () => { stopped = true; clearInterval(timer); };
  }, [socket, connected, open, active]);

  const me = participants.find(person => person.socketId === 'local');
  const owner = !!watch && watch.ownerPeerId === me?.peerId;
  const manager = owner || !!me?.isHost;
  const canControl = !!watch && (manager || watch.everyoneControls);
  const command = useCallback(async (payload: WatchCommand): Promise<boolean> => {
    if (!socket?.connected) { setError('Oda bağlantısı yeniden kurulunca tekrar deneyin.'); return false; }
    const session = watchRef.current;
    try {
      const reply = await socket.timeout(5000).emitWithAck('watch-command', { sessionId: session?.id, ...payload });
      if (!reply.ok) { setError(reply.error || 'Oynatıcı komutu uygulanamadı.'); return false; }
      setError(''); return true;
    } catch { setError('Oynatıcı yanıtı alınamadı. Oda bağlantısını kontrol edip tekrar deneyin.'); return false; }
  }, [socket]);
  commandRef.current = command;

  const choose = async (source: WatchSource, position = startPosition(source.url)) => {
    const queued = autoConfigRef.current.queueMode && !!watchRef.current;
    const selected = { ...source, ...(detectedUrlRef.current && detectedUrlRef.current !== source.url ? { pageUrl: detectedUrlRef.current } : {}) };
    if (await command({ type: queued ? 'queue-add' : 'load', source: selected, position })) {
      if (queued) { setDetectInfo('Video ortak kuyruğa eklendi.'); setShowQueue(true); }
      else {
        setShowSources(false); setDetectInfo('Video bulundu ve odaya açıldı.'); onClose();
        if (source.kind !== 'external' && scanModeRef.current === 'helper' && bridge) {
          const scanId = scanRef.current;
          void bridge.request('control', { scanId, command: 'pause' }).then(reply => {
            if (reply.ok) void bridge.request('suspend', { scanId });
          });
        }
      }
    }
  };
  chooseRef.current = choose;

  useEffect(() => {
    if (!bridge) return;
    return bridge.subscribe((update: HelperUpdate) => {
      const editing = update.scanId === scanRef.current;
      const external = update.scanId === externalScanRef.current && watchRef.current?.source.kind === 'external';
      if (!editing && !external) return;
      if (update.closed) {
        if (external) { externalReadyRef.current = false; outputVersionRef.current++; setPlayerStatus('external', 'Kaynak sekmesi kapandı. Kaynak sekmesini yeniden açın.'); }
        if (editing) setDetectInfo('Kaynak sekmesi kapandı. Yeniden açarak tespit edebilirsiniz.');
        setHelperDetected(false); return;
      }
      if (editing) {
        setHelperDetected(!!update.detected); setHelperEncrypted(!!update.encrypted);
        setCandidates(update.candidates || []);
        if (update.detected) setDetectInfo(update.encrypted ? 'Kaynak sitede korumalı bir video bulundu. Kaynak sitede senkron izlemeyi kullanın.' : 'Kaynak sekmesindeki video tespit edildi.');
        if (autoConfigRef.current.autoStart && !autoConfigRef.current.queueMode && update.detected && update.sample && !update.sample.paused && autoChosenRef.current !== update.scanId) {
          const best = (update.candidates || []).find(candidate => candidate.playing && candidate.score >= 110);
          autoChosenRef.current = update.scanId;
          const source: WatchSource = best && !update.encrypted ? best : { kind: 'external', url: update.pageUrl, title: update.title || 'Kaynak sitedeki video' };
          void chooseRef.current(source, update.sample.position || 0);
        }
      }
      if (external && update.detected && update.sample) {
        if (statusRef.current === 'external' || statusRef.current === 'loading') setPlayerStatus('ready');
        const current = watchRef.current;
        const local = contextRef.current.participants.find(person => person.socketId === 'local');
        if (update.action === 'ended' && externalReadyRef.current && current && current.ownerPeerId === local?.peerId && endedRef.current !== current.id) {
          endedRef.current = current.id;
          void commandRef.current(current.autoNext && current.queue.length ? { type: 'next' } : { type: 'ended', position: update.sample.position });
        } else if (update.action && update.action !== 'ended' && externalReadyRef.current && current && (current.ownerPeerId === local?.peerId || local?.isHost || current.everyoneControls)) {
          void commandRef.current({ type: update.action, position: update.sample.position, ...(update.action === 'rate' ? { rate: update.sample.rate } : {}) });
        }
      }
    });
  }, [bridge, setPlayerStatus]);

  const sessionId = watch?.id;
  useEffect(() => {
    if (!sessionId || !bridge || !playerRef.current) return;
    const session = watchRef.current;
    if (!session) return;
    const controller = new AbortController();
    let disposed = false, working = false, timer: number;
    let adapter: WatchAdapter | null = null;
    let lastAppliedRevision = -1, attempts = 0;
    let appliedVolume: number | null = null, rejectedRate: number | null = null, outputVersion = -1;
    externalReadyRef.current = false;
    playerRef.current.closest('.watch-workspace')?.scrollTo({ top: 0 });
    playerRef.current.closest('.watch-panel')?.scrollTo({ top: 0 });
    setPlayerError(''); setSample(EMPTY_SAMPLE); setDrift(null); setLevels([]); setQuality(-1);
    clearTimeout(seekTimerRef.current); seekTargetRef.current = null; setScrubPosition(null);
    setPermissionsPending(null);
    blockedRef.current = false; statusSentRef.current = ''; endedRef.current = ''; heartbeatRef.current = 0;
    setPlayerStatus('loading');
    const sync = async (force = false) => {
      let current = watchRef.current;
      if (disposed || working || !adapter || !current || current.id !== sessionId || statusRef.current === 'error') return;
      working = true;
      try {
        const currentSample = await adapter.sample();
        if (disposed || watchRef.current?.id !== sessionId) return;
        current = watchRef.current;
        if (!current) return;
        const appliedRevision = current.revision;
        const superseded = () => disposed || watchRef.current?.id !== sessionId || watchRef.current?.revision !== appliedRevision;
        if (appliedVolume !== volumeRef.current || outputVersion !== outputVersionRef.current) {
          const requested = volumeRef.current;
          const requestedVersion = outputVersionRef.current;
          await adapter.volume(requested).then(() => { appliedVolume = requested; outputVersion = requestedVersion; }).catch(() => {});
        }
        if (superseded()) return;
        sampleRef.current = currentSample; setSample(currentSample);
        const target = seekTargetRef.current;
        if (target && (Math.abs(currentSample.position - target.position) < 1.25 || Date.now() > target.expires)) {
          seekTargetRef.current = null; setScrubPosition(null);
        }
        setLevels(adapter.levels?.() || []);
        const local = contextRef.current.participants.find(person => person.socketId === 'local');
        const isOwner = local?.peerId === current.ownerPeerId;
        const expected = expectedPosition(current, offsetRef.current);
        const bounded = Number.isFinite(currentSample.duration) && currentSample.duration > 0 ? Math.min(expected, currentSample.duration) : expected;
        const difference = bounded - currentSample.position;
        setDrift(difference);
        const revisionChanged = lastAppliedRevision !== current.revision;
        // When the owner's video is buffering, publish its actual position
        // instead of repeatedly seeking it forward past unseen content.
        const ownerBuffering = isOwner && statusRef.current === 'buffering' && !revisionChanged;
        if (!ownerBuffering && !currentSample.live && (force || (current.paused && Math.abs(difference) > 0.15) || Math.abs(difference) > 1.25 || (revisionChanged && Math.abs(difference) > 0.5))) await adapter.seek(bounded);
        if (superseded()) return;
        const targetRate = !current.paused && adapter.fineRate && !currentSample.live && Math.abs(difference) >= 0.2 && Math.abs(difference) <= 1.25 && !force ? current.rate * (difference > 0 ? 1.035 : 0.965) : current.rate;
        // Some providers restrict speed changes. Playback and pause must still
        // work when a provider declines a requested playback rate.
        if (Math.abs(currentSample.rate - targetRate) > 0.01 && rejectedRate !== targetRate) {
          await adapter.rate(targetRate).then(() => { rejectedRate = null; }).catch(() => {
            rejectedRate = targetRate; setError('Kaynak site seçilen oynatma hızını desteklemiyor. Başka bir hız seçin.');
          });
        }
        if (superseded()) return;
        if (current.paused && !currentSample.paused) await adapter.pause();
        else if (!current.paused && currentSample.paused && !blockedRef.current && statusRef.current !== 'ended') await adapter.play();
        if (superseded()) return;
        lastAppliedRevision = current.revision;
        if (session.source.kind === 'external' && (currentSample.live || Number.isFinite(currentSample.duration))) externalReadyRef.current = true;
        if (isOwner && !current.paused && !blockedRef.current && contextRef.current.connected && Date.now() - heartbeatRef.current > 5000) {
          heartbeatRef.current = Date.now();
          if (Math.abs(difference) > 0.75 && !revisionChanged) void commandRef.current({ type: 'heartbeat', position: currentSample.position });
        }
        if (statusRef.current === 'external') setPlayerStatus('ready');
        attempts = 0;
      } catch (failure) {
        if (disposed) return;
        const name = (failure as { name?: string })?.name;
        if (name === 'NotAllowedError' || /bir kez başlatın/i.test((failure as Error).message)) setPlayerStatus('blocked');
        else if (session.source.kind === 'external' && ++attempts >= 2) setPlayerStatus('external', (failure as Error).message);
      } finally { working = false; }
    };
    const ended = () => {
      const current = watchRef.current;
      const local = contextRef.current.participants.find(person => person.socketId === 'local');
      if (!current || endedRef.current === current.id || current.ownerPeerId !== local?.peerId) return;
      endedRef.current = current.id;
      void commandRef.current(current.autoNext && current.queue.length ? { type: 'next' } : { type: 'ended', position: sampleRef.current.duration > 0 && Number.isFinite(sampleRef.current.duration) ? sampleRef.current.duration : sampleRef.current.position });
    };
    void createWatchAdapter(session.source, playerRef.current, controller.signal, { status: (value, message) => { if (!disposed) setPlayerStatus(value, message); }, ended, externalScan: id => { externalScanRef.current = id; } }, bridge).then(async result => {
      if (disposed) { result.destroy(); return; }
      adapter = result; adapterRef.current = result;
      if (!disposed) await sync(true);
    }).catch(failure => { if (!disposed) setPlayerStatus('error', (failure as Error).message); });
    timer = window.setInterval(() => { void sync(); }, 800);
    const foreground = () => { if (!document.hidden) void sync(true); };
    document.addEventListener('visibilitychange', foreground);
    return () => {
      disposed = true; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', foreground);
      adapter?.destroy(); adapterRef.current = null;
    };
  }, [sessionId, retry, bridge, setPlayerStatus]);

  useEffect(() => {
    void adapterRef.current?.volume(volume).catch(() => {});
    try { localStorage.setItem('windwatch:watchVolume', String(volume)); } catch { /* storage unavailable */ }
  }, [volume]);
  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', change); return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  useEffect(() => () => { generationRef.current++; clearTimeout(seekTimerRef.current); }, []);

  const detect = async (inSourceTab = false) => {
    const url = parseWatchUrl(draft);
    if (!url) { setError('Geçerli bir HTTP/HTTPS video veya sayfa bağlantısı girin.'); return; }
    const generation = ++generationRef.current;
    detectedUrlRef.current = url.href; autoChosenRef.current = ''; setError(''); setDetecting(true); setCandidates([]);
    setHelperDetected(false); setHelperEncrypted(false); setDetectInfo('Bağlantıdaki videolar aranıyor…');
    const scanId = crypto.randomUUID(); scanRef.current = scanId;
    scanModeRef.current = inSourceTab ? 'helper' : 'page';
    const direct = !inSourceTab && sourceFromUrl(url.href);
    if (direct) {
      setCandidates([direct]); setDetecting(false); setDetectInfo('Video bağlantısı tespit edildi.');
      if (autoConfigRef.current.autoStart) await choose(direct);
      return;
    }
    if (!socket?.connected) { setDetecting(false); setError('Tespit için oda bağlantısını bekleyin.'); return; }
    try {
      const scanInTab = async () => {
        if (!bridge) return false;
        const available = await bridge.ping(); if (generation !== generationRef.current) return;
        setHelper(available);
        if (!available) { setDetectInfo('Dinamik video tespiti için Video Yardımcısını bağlayın. Kurulum adımları aşağıda.'); return false; }
        scanModeRef.current = 'helper';
        const reply = await bridge.request('rescan', { url: url.href, scanId });
        if (generation !== generationRef.current) return;
        if (!reply.ok) { setError(reply.error || 'Kaynak sekmesi açılamadı.'); return false; }
        setDetectInfo('Kaynak sekmesi açıldı. Video başladığında otomatik tespit edilecek; gerekirse kaynak sekmesinde oynatın.');
        return true;
      };
      if (inSourceTab) { await scanInTab(); return; }
      const reply = await socket.timeout(15000).emitWithAck('watch-detect', { url: url.href });
      if (generation !== generationRef.current) return;
      if (!reply.ok) { setDetectInfo(reply.error || 'Video bulunamadı.'); if (helper) await scanInTab(); return; }
      const found = reply.candidates as WatchCandidate[];
      setCandidates(found);
      setDetectInfo(found.length ? `${found.length} video kaynağı bulundu.` : 'İlk taramada video bulunamadı. Sayfa videoyu sonradan yüklüyor olabilir. Kaynak sekmesinde tespit edin; video başlayınca otomatik bulunur.');
      if (found.length === 1 && found[0].score >= 70 && autoConfigRef.current.autoStart) await choose(found[0]);
      else if (!found.length && helper) await scanInTab();
    } catch { if (generation === generationRef.current) setDetectInfo('Tespit yanıtı alınamadı. Tekrar tespit edin veya kaynak sekmesini kullanın.'); }
    finally { if (generation === generationRef.current) setDetecting(false); }
  };

  const openSource = async (rescan = false) => {
    if (!bridge || !watch) return;
    const url = watch.source.pageUrl || sourceSiteUrl(watch.source);
    if (watch.source.kind !== 'external') { await command({ type: 'load', source: { kind: 'external', url, title: watch.source.title }, position: sampleRef.current.position }); return; }
    const scanId = externalScanRef.current;
    externalReadyRef.current = false; outputVersionRef.current++;
    const reply = await bridge.request(rescan ? 'rescan' : 'open', { url, scanId, focus: !rescan });
    if (!reply.ok) setError(reply.error || 'Kaynak sekmesi açılamadı.');
    else { setPlayerError(''); setPlayerStatus('external'); }
  };
  const resumeLocal = async () => {
    const adapter = adapterRef.current, current = watchRef.current;
    if (!adapter || !current) { setRetry(value => value + 1); return; }
    try {
      blockedRef.current = false; await adapter.play();
      if (current.paused) await adapter.pause();
      else await adapter.seek(expectedPosition(current, offsetRef.current));
      setPlayerError(''); setPlayerStatus('ready');
    } catch (failure) { setPlayerStatus('blocked', (failure as Error).message || 'Kaynak sekmesinde videoyu bir kez başlatın.'); }
  };
  const seek = (position: number) => {
    const current = watchRef.current;
    if (!current) return;
    const bounded = Math.max(0, Number.isFinite(sample.duration) && sample.duration > 0 ? Math.min(position, sample.duration) : position);
    setScrubPosition(bounded); seekTargetRef.current = { position: bounded, expires: Date.now() + 5000 };
    clearTimeout(seekTimerRef.current);
    seekTimerRef.current = window.setTimeout(() => {
      if (watchRef.current?.id !== current.id) return;
      void command({ type: 'seek', position: bounded }).then(ok => {
        if (!ok) { seekTargetRef.current = null; setScrubPosition(null); }
      });
    }, 180);
  };
  const togglePlayback = async () => {
    const current = watchRef.current;
    if (!current) return;
    const actual = await adapterRef.current?.sample().catch(() => null);
    if (watchRef.current?.id !== current.id) return;
    await command({ type: current.paused ? 'play' : 'pause', ...(actual ? { position: actual.position } : {}) });
  };
  const changePermission = async (patch: { everyoneControls?: boolean; autoNext?: boolean }) => {
    const current = watchRef.current;
    if (!current || permissionsPending) return;
    const requested = { everyoneControls: current.everyoneControls, autoNext: current.autoNext, ...patch };
    setPermissionsPending(requested);
    await command({ type: 'permission', ...requested });
    setPermissionsPending(null);
  };
  const toggleFullscreen = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await stageRef.current?.requestFullscreen(); } catch { setError('Bu tarayıcı tam ekranı açamadı.'); } };

  if (!open && !watch) return null;
  const editor = !watch || open || showSources;
  return <section className={`watch-panel${!watch ? ' watch-empty' : ''}`} aria-label="Birlikte izleme">
    <div className="watch-heading"><div><Film size={20} /><strong>Birlikte izle</strong><span className="watch-heading-note">{watch ? `${watch.ownerName} yönetiyor` : 'Aynı video, aynı an'}</span></div><div>
      {watch && <button type="button" className="watch-icon-btn" aria-label="Video bağlantıları" title="Video bağlantıları" onClick={() => setShowSources(value => !value)}><Link size={17} /></button>}
      {watch && <button type="button" className="watch-icon-btn" aria-label="Video kuyruğu" title="Video kuyruğu" onClick={() => setShowQueue(value => !value)}><ListVideo size={18} /><span>{watch.queue.length}</span></button>}
      {watch && canControl && <button type="button" className="watch-icon-btn" aria-label="Birlikte izlemeyi bitir" title="Birlikte izlemeyi bitir" onClick={() => { void command({ type: 'stop' }); onClose(); }}><X size={18} /></button>}
      {!watch && <button type="button" className="watch-icon-btn" aria-label="Video panelini kapat" onClick={onClose}><X size={18} /></button>}
    </div></div>
    {error && <div className="watch-alert" role="alert">{error}<button type="button" aria-label="Video uyarısını kapat" onClick={() => setError('')}><X size={14} /></button></div>}
    {editor && <div className="watch-source-editor">
      <p>Video veya sayfa bağlantısını yapıştırın. Video bulunduğunda herkes kendi bağlantısından izler; oynatma ve ileri sarma odada eşitlenir.</p>
      <form className="watch-link-form" onSubmit={event => { event.preventDefault(); void detect(); }}>
        <label className="sr-only" htmlFor="watch-url">Video veya sayfa bağlantısı</label><input id="watch-url" type="url" value={draft} onChange={event => setDraft(event.target.value)} placeholder="YouTube, Vimeo, video dosyası veya video içeren sayfa…" maxLength={4096} required />
        <button type="submit" disabled={!connected || detecting}><Search size={16} />{detecting ? 'Tespit ediliyor…' : 'Videoyu tespit et'}</button>
      </form>
      <div className="watch-detect-actions"><button type="button" disabled={!connected || detecting || !draft} onClick={() => { void detect(scanModeRef.current === 'helper'); }}><RefreshCw size={15} />Tekrar tespit et</button><button type="button" disabled={!connected || detecting || !draft} onClick={() => { void detect(true); }}><ExternalLink size={15} />Kaynak sekmesinde tespit et</button>
        {helper && scanRef.current && <button type="button" onClick={() => { void bridge?.request('focus', { scanId: scanRef.current }).then(reply => { if (!reply.ok) setError(reply.error || 'Kaynak sekmesi bulunamadı.'); }); }}><ExternalLink size={15} />Kaynak sekmesine git</button>}
      </div>
      <div className="watch-detect-options"><label><input type="checkbox" checked={autoStart} onChange={event => setAutoStart(event.target.checked)} />Tespit edilince otomatik başlat</label>{watch && canControl && <label><input type="checkbox" checked={queueMode} onChange={event => setQueueMode(event.target.checked)} />Kuyruğa ekle</label>}<span className={`watch-helper-badge${helper ? ' connected' : ''}`}>{helper ? 'Video yardımcısı bağlı' : 'YouTube, Vimeo, MP4/WebM ve HLS desteklenir'}</span></div>
      {detectInfo && <p className="watch-detection-info" role="status">{detectInfo}</p>}
      {!!candidates.length && <div className="watch-candidates">{candidates.map(candidate => <div key={candidate.url}><div><strong>{candidate.title || 'Video'}</strong><small>{candidate.method} · {parseWatchUrl(candidate.url)?.hostname}</small><span title={candidate.url}>{candidate.url}</span></div><button type="button" disabled={!!watch && !canControl} onClick={() => { void choose(candidate, candidate.position || startPosition(candidate.url)); }}>{queueMode ? <ListPlus size={15} /> : <Play size={15} />}{queueMode ? 'Kuyruğa ekle' : 'Birlikte izle'}</button></div>)}</div>}
      {helperDetected && <button type="button" className="watch-external-choice" disabled={!!watch && !canControl} onClick={() => { void choose({ kind: 'external', url: detectedUrlRef.current, title: candidates[0]?.title || 'Kaynak sitedeki video' }); }}><ExternalLink size={16} />Kaynak sitede senkron izle{helperEncrypted ? ' · Korumalı oynatıcı' : ''}</button>}
      <details className="watch-helper-help"><summary>Dinamik sitelerde video nasıl tespit edilir?</summary><p>Bazı siteler videoyu sayfa açıldıktan sonra yükler. Video Yardımcısı seçtiğiniz sekmedeki oynatıcıyı ve yayın bağlantılarını tespit eder. Her sitenin videosu başka yerde açılamayabilir; bu durumda “Kaynak sitede senkron izle” kullanılabilir.</p><a href="/windwatch-video-helper.zip" download>Chrome / Edge Video Yardımcısını indir</a><ol><li>ZIP dosyasını bir klasöre çıkarın. Tarayıcının uzantılar sayfasında geliştirici modunu açıp “Paketlenmemiş öğe yükle” ile klasörü seçin.</li><li>WindWatch sekmesindeyken uzantı menüsünden bu adrese izin verin ve sayfayı yenileyin.</li><li>Linki girip “Kaynak sekmesinde tespit et” düğmesine basın. Gerekirse kaynak sekmesinde videoyu başlatın; “Tekrar tespit et” aynı sekmeyi yeniden tarar.</li></ol><p>Kaynak sitede izleme için her katılımcının yardımcıyı kurması ve siteye kendi erişiminin olması gerekir.</p></details>
    </div>}
    {watch && <>
      <div className="watch-stage" ref={stageRef}>
        <div className="watch-player" ref={playerRef} />
        {watch.source.kind === 'external' && <div className="watch-external-stage"><ExternalLink size={38} /><h3>Kaynak sitede senkron izleme</h3><p>{watch.source.title}</p><span>Video kendi kaynak sekmenizde oynar. Oynatma kontrolleri bu odadan eşitlenir.</span><div><button type="button" onClick={() => { void openSource(); }}>Kaynak sekmesini aç</button><button type="button" onClick={() => { void openSource(true); }}><RefreshCw size={15} />Tekrar tespit et</button></div></div>}
        {watch.source.kind !== 'external' && status === 'loading' && <div className="watch-player-message">Oynatıcı yükleniyor…</div>}
        {status === 'blocked' && <div className="watch-player-message"><button type="button" onClick={() => { void resumeLocal(); }}><Play size={18} />Bu cihazda izlemeyi başlat</button><span>Tarayıcı sesli oynatmayı başlatmanız için bir tıklama bekliyor.</span></div>}
        {(status === 'error' || (status === 'external' && playerError)) && <div className={`watch-player-message ${watch.source.kind === 'external' ? 'watch-external-error' : ''}`}><p>{playerError || 'Video açılamadı.'}</p><div><button type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} />Oynatıcıyı yeniden dene</button>{helper && canControl && watch.source.kind !== 'external' && <button type="button" onClick={() => { void openSource(); }}>Kaynak sitede senkron izle</button>}</div></div>}
        <div className="watch-playback-controls">
          <div className="watch-timeline"><span>{clockTime(scrubPosition ?? sample.position)}</span><input type="range" min="0" max={Number.isFinite(sample.duration) ? sample.duration || 1 : 1} step="0.1" value={Math.min(scrubPosition ?? sample.position, Number.isFinite(sample.duration) ? sample.duration || 1 : 1)} aria-label="Video zamanı" disabled={!canControl || !Number.isFinite(sample.duration) || sample.duration <= 0 || sample.live} onInput={event => seek(Number(event.currentTarget.value))} /><span>{sample.live ? 'Canlı' : clockTime(sample.duration)}</span></div>
          <div className="watch-playback-row"><div><button type="button" className="watch-icon-btn" disabled={!canControl} aria-label={watch.paused ? 'Videoyu oynat' : 'Videoyu duraklat'} title={watch.paused ? 'Oynat' : 'Duraklat'} onClick={() => { void togglePlayback(); }}>{watch.paused ? <Play size={21} /> : <Pause size={21} />}</button><button type="button" className="watch-icon-btn" disabled={!canControl || sample.live} aria-label="Videoda 10 saniye geri" onClick={() => seek(sample.position - 10)}><SkipBack size={17} /></button><button type="button" className="watch-icon-btn" disabled={!canControl || sample.live} aria-label="Videoda 10 saniye ileri" onClick={() => seek(sample.position + 10)}><SkipForward size={17} /></button><button type="button" className="watch-icon-btn" aria-label={volume > 0 ? 'Video sesini kapat' : 'Video sesini aç'} onClick={() => setVolume(volume > 0 ? 0 : 0.7)}>{volume > 0 ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><input className="watch-volume" type="range" min="0" max="1" step="0.05" value={volume} aria-label="Video ses seviyesi" onChange={event => setVolume(Number(event.target.value))} /></div><div><select aria-label="Video oynatma hızı" value={watch.rate} disabled={!canControl || sample.live} onChange={event => { void command({ type: 'rate', rate: Number(event.target.value) }); }}>{[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select>{levels.length > 1 && <select aria-label="Video görüntü kalitesi" value={quality} onChange={event => { const value = Number(event.target.value); setQuality(value); adapterRef.current?.quality?.(value); }}>{levels.map(level => <option key={level.value} value={level.value}>{level.label}</option>)}</select>}<button type="button" className="watch-icon-btn" aria-label="Videoyu tekrar senkronize et" title="Tekrar senkronize et" onClick={() => { void adapterRef.current?.seek(expectedPosition(watch, offsetRef.current)).catch(() => {}); }}><RefreshCw size={16} /></button><button type="button" className="watch-icon-btn" aria-label={fullscreen ? 'Video tam ekrandan çık' : 'Video tam ekran'} onClick={() => { void toggleFullscreen(); }}>{fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}</button></div></div>
        </div>
      </div>
      <div className="watch-info"><div><strong title={watch.source.title}>{watch.source.title}</strong><span>{WATCH_STATUS_LABELS[status]}{drift !== null && status === 'ready' ? ` · ${Math.abs(drift) < 0.25 ? 'Senkron' : `Fark ${Math.abs(drift).toFixed(1)} sn`}` : ''}</span></div><a href={watch.source.pageUrl || sourceSiteUrl(watch.source)} target="_blank" rel="noopener noreferrer" title="Video kaynağını aç"><ExternalLink size={16} /></a></div>
      <div className="watch-members" aria-label="İzleyici durumları">{participants.map(person => <span key={person.peerId} className={`watch-member ${watch.statuses[person.peerId]?.status || 'loading'}`} title={WATCH_STATUS_LABELS[watch.statuses[person.peerId]?.status || 'loading']}><i />{person.username}<small>{WATCH_STATUS_LABELS[watch.statuses[person.peerId]?.status || 'loading']}</small></span>)}</div>
      <div className="watch-management">{manager && <><label><input type="checkbox" checked={permissionsPending?.everyoneControls ?? watch.everyoneControls} disabled={!!permissionsPending} onChange={event => { void changePermission({ everyoneControls: event.target.checked }); }} /><ShieldCheck size={14} />Herkes oynatıcıyı kontrol edebilir</label><label><input type="checkbox" checked={permissionsPending?.autoNext ?? watch.autoNext} disabled={!!permissionsPending} onChange={event => { void changePermission({ autoNext: event.target.checked }); }} />Kuyruğu otomatik ilerlet</label></>}{me?.isHost && !owner && <button type="button" onClick={() => { void command({ type: 'take-control' }); }}>Kontrolü devral</button>}{!canControl && <span>Oynatma kontrolü {watch.ownerName} adlı katılımcıda. Ses seviyesi ve görüntü kalitesi bu cihaz için değişir.</span>}</div>
      {showQueue && <div className="watch-queue"><div><strong><ListVideo size={16} />Video kuyruğu · {watch.queue.length}/20</strong><button type="button" className="watch-icon-btn" onClick={() => setShowQueue(false)} aria-label="Video kuyruğunu kapat"><ChevronUp size={17} /></button></div>{!watch.queue.length && <p>Linki tespit ederken “Kuyruğa ekle” seçeneğini işaretleyin.</p>}{watch.queue.map((source, index) => <div key={source.id}><span>{index + 1}. {source.title}<small>{source.addedBy} ekledi</small></span>{canControl && <button type="button" className="watch-icon-btn" aria-label={`${source.title} videosunu kuyruktan çıkar`} onClick={() => { void command({ type: 'queue-remove', itemId: source.id }); }}><X size={15} /></button>}</div>)}{!!watch.queue.length && canControl && <button type="button" onClick={() => { void command({ type: 'next' }); }}><SkipForward size={15} />Sıradaki videoya geç</button>}</div>}
      {!editor && canControl && <button type="button" className="watch-add-link" onClick={() => setShowSources(true)}><ChevronDown size={15} />Başka video ekle veya değiştir</button>}
    </>}
  </section>;
}
