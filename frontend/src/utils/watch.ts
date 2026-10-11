export type WatchKind = 'video' | 'hls' | 'youtube' | 'vimeo' | 'external';
export interface WatchSource {
  kind: WatchKind;
  url: string;
  title: string;
  mediaId?: string;
  pageUrl?: string;
}
export interface WatchCandidate extends WatchSource {
  method: string;
  score: number;
  playing?: boolean;
  position?: number;
}
export type WatchStatus = 'loading' | 'ready' | 'buffering' | 'blocked' | 'error' | 'ended' | 'external';
export interface WatchSession {
  id: string;
  revision: number;
  source: WatchSource;
  ownerPeerId: string;
  ownerName: string;
  position: number;
  paused: boolean;
  rate: number;
  updatedAt: number;
  everyoneControls: boolean;
  autoNext: boolean;
  statuses: Record<string, { status: WatchStatus; updatedAt: number }>;
  queue: (WatchSource & { id: string; addedBy: string })[];
}
export interface WatchState { session: WatchSession | null; serverTime: number }
export interface PlayerSample { position: number; duration: number; paused: boolean; rate: number; buffered?: number; live?: boolean }
export interface WatchAdapter {
  sample(): Promise<PlayerSample>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(position: number): Promise<void>;
  rate(rate: number): Promise<void>;
  volume(volume: number): Promise<void>;
  destroy(): void;
  fineRate?: boolean;
  levels?: () => { value: number; label: string }[];
  quality?: (value: number) => void;
}
export interface WatchCommand { type: string; sessionId?: string; source?: WatchSource; position?: number; rate?: number; everyoneControls?: boolean; autoNext?: boolean; itemId?: string }

export function parseWatchUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return value.length <= 4096 && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}
export function sourceFromUrl(value: string): WatchCandidate | null {
  const url = parseWatchUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let kind: WatchKind | null = null, mediaId: string | undefined;
  if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'youtu.be'].includes(host)) {
    mediaId = (host === 'youtu.be' ? url.pathname.split('/')[1] : url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1]) || undefined;
    if (/^[\w-]{11}$/.test(mediaId || '')) kind = 'youtube';
  } else if (['vimeo.com', 'player.vimeo.com'].includes(host)) {
    mediaId = url.pathname.match(/(?:^|\/)(\d+)(?:\/|$)/)?.[1];
    if (mediaId) kind = 'vimeo';
  } else if (/\.m3u8$/i.test(url.pathname)) kind = 'hls';
  else if (/\.(?:mp4|webm|ogv|m4v|mov)$/i.test(url.pathname)) kind = 'video';
  let title = mediaId || url.pathname.split('/').pop() || host;
  try { title = decodeURIComponent(title); } catch { /* A malformed escape should not stop detection. */ }
  return kind ? { kind, url: url.href, title, ...(mediaId ? { mediaId } : {}), method: 'Doğrudan bağlantı', score: 100 } : null;
}
export function startPosition(url: string): number {
  const parsed = parseWatchUrl(url);
  const value = parsed?.searchParams.get('t') || parsed?.searchParams.get('start') || parsed?.hash.match(/t=([^&]+)/)?.[1] || '';
  if (/^\d+(?:\.\d+)?s?$/.test(value)) return Math.min(parseFloat(value), 864000);
  const time = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return time ? Math.min(Number(time[1] || 0) * 3600 + Number(time[2] || 0) * 60 + Number(time[3] || 0), 864000) : 0;
}
export function expectedPosition(session: WatchSession, clockOffset: number, now = Date.now()): number {
  return Math.max(0, session.position + (session.paused ? 0 : Math.max(0, now + clockOffset - session.updatedAt) / 1000 * session.rate));
}
export function clockTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'Canlı';
  const value = Math.floor(Math.max(0, seconds));
  return value >= 3600 ? `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
export const WATCH_STATUS_LABELS: Record<WatchStatus, string> = { loading: 'Yükleniyor', ready: 'Hazır', buffering: 'Video yükleniyor', blocked: 'Başlatması bekleniyor', error: 'Kaynak açılamadı', ended: 'Video bitti', external: 'Kaynak sekmesi bekleniyor' };
