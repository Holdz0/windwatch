import { registerAudioOutputElement } from './audio';
import { parseWatchUrl } from './watch';
import type { WatchSource, WatchAdapter, WatchStatus } from './watch';
import type { WatchBridge } from './watchBridge';
import type { VimeoUrl, PlayerEventMap } from '@vimeo/player';

interface PlayerCallbacks { status: (status: WatchStatus, error?: string) => void; ended: () => void; externalScan: (scanId: string) => void }
type YouTubePlayer = {
  playVideo(): void; pauseVideo(): void; seekTo(time: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number; getDuration(): number; getPlayerState(): number;
  getPlaybackRate(): number; setPlaybackRate(rate: number): void;
  setVolume(volume: number): void; unMute(): void; mute(): void; destroy(): void;
};
type YouTubeNamespace = { Player: new (target: HTMLElement, options: Record<string, unknown>) => YouTubePlayer };
let youtubeApi: Promise<YouTubeNamespace> | null = null;
function loadYouTube(): Promise<YouTubeNamespace> {
  const global = window as Window & { YT?: YouTubeNamespace; onYouTubeIframeAPIReady?: () => void };
  if (global.YT?.Player) return Promise.resolve(global.YT);
  if (youtubeApi) return youtubeApi;
  youtubeApi = new Promise((resolve, reject) => {
    const previous = global.onYouTubeIframeAPIReady;
    const timer = window.setTimeout(() => { youtubeApi = null; reject(new Error('YouTube oynatıcısı yüklenemedi. Bağlantınızı veya içerik engelleyicinizi kontrol edin.')); }, 15000);
    global.onYouTubeIframeAPIReady = () => { clearTimeout(timer); previous?.(); if (global.YT?.Player) resolve(global.YT); else reject(new Error('YouTube API kullanılamıyor.')); };
    if (!document.querySelector('script[data-windwatch-youtube]')) {
      const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.dataset.windwatchYoutube = 'true'; script.onerror = () => { clearTimeout(timer); youtubeApi = null; script.remove(); reject(new Error('YouTube oynatıcısı indirilemedi.')); }; document.head.appendChild(script);
    }
  });
  return youtubeApi;
}

export async function createWatchAdapter(source: WatchSource, target: HTMLElement, signal: AbortSignal, callbacks: PlayerCallbacks, bridge: WatchBridge): Promise<WatchAdapter> {
  const check = () => { if (signal.aborted) throw new DOMException('Oynatıcı kapatıldı.', 'AbortError'); };
  if (source.kind === 'external') {
    if (!bridge.connected && !await bridge.ping()) throw new Error('Kaynak sitede senkron izlemek için Video Yardımcısını kurup bu WindWatch adresine izin verin.');
    check();
    const scanId = crypto.randomUUID();
    callbacks.externalScan(scanId);
    const opened = await bridge.request('open', { url: source.url, scanId });
    check();
    if (!opened.ok) throw new Error(opened.error);
    callbacks.status('external');
    const command = async (command: string, value?: number) => {
      check();
      const result = await bridge.request('control', { scanId, command, value }, 3500);
      if (!result.ok) throw new Error(result.error);
      return result;
    };
    return { fineRate: true, sample: async () => {
      const result = await command('sample');
      if (!result.sample) throw new Error('Kaynak sayfadaki videonun başlaması bekleniyor.');
      return { ...result.sample, duration: result.sample.duration ?? Infinity };
    }, play: async () => { await command('play'); }, pause: async () => { await command('pause'); }, seek: async value => { await command('seek', value); }, rate: async value => { await command('rate', value); }, volume: async value => { await command('volume', value); }, destroy: () => { void bridge.request('stop', { scanId }); } };
  }
  if (source.kind === 'youtube') {
    const api = await loadYouTube(); check();
    const element = document.createElement('div'); target.appendChild(element);
    let ready = false;
    const player = new api.Player(element, {
      host: 'https://www.youtube-nocookie.com', videoId: source.mediaId,
      playerVars: { autoplay: 0, controls: 0, playsinline: 1, rel: 0, enablejsapi: 1, origin: window.location.origin, disablekb: 1 },
      events: {
        onReady: () => { if (!signal.aborted) { ready = true; callbacks.status('ready'); } },
        onStateChange: (event: { data: number }) => {
          if (signal.aborted) return;
          if (event.data === 0) { callbacks.status('ended'); callbacks.ended(); }
          else if (event.data === 3) callbacks.status('buffering');
          else if (event.data === 1 || event.data === 2) callbacks.status('ready');
        },
        onAutoplayBlocked: () => { if (!signal.aborted) callbacks.status('blocked'); },
        onError: (event: { data: number }) => {
          if (signal.aborted) return;
          callbacks.status('error', [101, 150].includes(event.data) ? 'Bu YouTube videosu başka sitelerde oynatılamıyor. Kaynak sitede izlemeyi deneyin.' : event.data === 153 ? 'YouTube kaynak adresini doğrulayamadı. Siteyi HTTPS üzerinden açın ve Referrer-Policy ayarını kontrol edin.' : 'YouTube videosu kullanılamıyor veya bu hesapta erişim gerektiriyor.');
        }
      }
    });
    return {
      sample: async () => { check(); if (!ready) throw new Error('YouTube yükleniyor.'); return { position: player.getCurrentTime(), duration: player.getDuration() || Infinity, paused: player.getPlayerState() !== 1, rate: player.getPlaybackRate() }; },
      play: async () => { check(); if (ready) player.playVideo(); }, pause: async () => { check(); if (ready) player.pauseVideo(); }, seek: async value => { check(); if (ready) player.seekTo(value, true); }, rate: async value => { check(); if (ready) player.setPlaybackRate(value); }, volume: async value => { check(); if (ready) { player.setVolume(value * 100); if (value > 0) player.unMute(); else player.mute(); } }, destroy: () => { player.destroy(); target.replaceChildren(); }
    };
  }
  if (source.kind === 'vimeo') {
    const { default: VimeoPlayer } = await import('@vimeo/player'); check();
    const player = new VimeoPlayer(target, { url: source.url as VimeoUrl, autoplay: false, controls: false, playsinline: true, responsive: true });
    const events: [keyof PlayerEventMap, (...args: unknown[]) => void][] = [
      ['loaded', () => { if (!signal.aborted) callbacks.status('ready'); }],
      ['bufferstart', () => { if (!signal.aborted) callbacks.status('buffering'); }],
      ['bufferend', () => { if (!signal.aborted) callbacks.status('ready'); }],
      ['ended', () => { if (!signal.aborted) { callbacks.status('ended'); callbacks.ended(); } }]
    ];
    events.forEach(([name, listener]) => player.on(name, listener));
    void player.ready().catch(() => { if (!signal.aborted) callbacks.status('error', 'Vimeo oynatıcısı açılmadı. Video özel olabilir veya gömme izni verilmemiş olabilir.'); });
    return { sample: async () => { check(); const [position, duration, paused, rate] = await Promise.all([player.getCurrentTime(), player.getDuration(), player.getPaused(), player.getPlaybackRate()]); return { position, duration, paused, rate }; }, play: async () => { check(); await player.play(); }, pause: async () => { check(); await player.pause(); }, seek: async value => { check(); await player.setCurrentTime(value); }, rate: async value => { check(); await player.setPlaybackRate(value); }, volume: async value => { check(); await player.setVolume(value); }, destroy: () => { events.forEach(([name, listener]) => player.off(name, listener)); void player.destroy(); } };
  }
  const video = document.createElement('video');
  video.playsInline = true; video.preload = 'metadata'; video.className = 'watch-video';
  video.setAttribute('aria-label', 'Birlikte izlenen video');
  target.appendChild(video);
  const releaseOutput = registerAudioOutputElement(video);
  let hls: import('hls.js').default | null = null;
  const status = (value: WatchStatus, error?: string) => { if (!signal.aborted) callbacks.status(value, error); };
  const options = { signal };
  video.addEventListener('loadedmetadata', () => status('ready'), options);
  video.addEventListener('playing', () => status('ready'), options);
  video.addEventListener('waiting', () => status('buffering'), options);
  video.addEventListener('ended', () => { status('ended'); callbacks.ended(); }, options);
  video.addEventListener('error', () => status('error', video.error?.code === 4 ? 'Bu video biçimi desteklenmiyor veya kaynak WindWatch üzerinden oynatmaya izin vermiyor. Kaynak sitede senkron izlemeyi deneyin.' : 'Video yüklenemedi. Linkin süresi dolmuş veya site erişim kısıtlaması uyguluyor olabilir.'), options);
  const destroy = () => { hls?.destroy(); releaseOutput(); video.pause(); video.removeAttribute('src'); video.load(); video.remove(); };
  try {
    if (source.kind === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
      const { default: Hls } = await import('hls.js'); check();
      if (!Hls.isSupported()) throw new Error('Bu tarayıcı HLS yayınlarını oynatamıyor.');
      hls = new Hls({ maxBufferLength: 20, backBufferLength: 15, capLevelToPlayerSize: true, enableWorker: true });
      let recovered = false;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || signal.aborted) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls?.recoverMediaError(); return; }
        status('error', data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'Yayın yüklenemedi. Kaynağın erişim/CORS izni veya bağlantının süresi nedeniyle olabilir. Kaynak sitede senkron izleyebilirsiniz.' : 'Yayın bu tarayıcıda çözülemedi. Şifreli veya desteklenmeyen bir video olabilir.');
        hls?.stopLoad();
      });
      hls.attachMedia(video); hls.loadSource(source.url);
    } else video.src = source.url;
    return {
      fineRate: true,
      sample: async () => { check(); if (video.readyState === 0) throw new Error('Video yükleniyor.'); return { position: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : Infinity, paused: video.paused, rate: video.playbackRate, buffered: video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0, live: !!hls?.liveSyncPosition || (source.kind === 'hls' && !Number.isFinite(video.duration)) }; },
      play: async () => { check(); await video.play(); }, pause: async () => { check(); video.pause(); }, seek: async position => {
        check();
        if (video.readyState > 0) {
          const max = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : video.seekable.length ? video.seekable.end(video.seekable.length - 1) : position;
          const min = video.seekable.length && !Number.isFinite(video.duration) ? video.seekable.start(0) : 0;
          video.currentTime = Math.max(min, Math.min(position, max));
        }
      }, rate: async value => { check(); video.playbackRate = value; }, volume: async value => { check(); video.volume = value; video.muted = value === 0; }, destroy,
      levels: () => [{ value: -1, label: 'Otomatik' }, ...(hls?.levels.map((level, value) => ({ value, label: `${level.height || '?'}p · ${Math.round(level.bitrate / 1000)} kbps` })) || [])], quality: value => { if (hls) hls.currentLevel = value; }
    };
  } catch (error) { destroy(); throw error; }
}

export function sourceSiteUrl(source: WatchSource): string {
  if (source.kind === 'youtube') return `https://www.youtube.com/watch?v=${source.mediaId}`;
  if (source.kind === 'vimeo') return `https://vimeo.com/${source.mediaId}${parseWatchUrl(source.url)?.searchParams.get('h') ? `/${parseWatchUrl(source.url)?.searchParams.get('h')}` : ''}`;
  return source.url;
}
