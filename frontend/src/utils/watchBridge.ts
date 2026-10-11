import type { PlayerSample, WatchCandidate } from './watch';

export interface HelperUpdate {
  scanId: string;
  candidates: WatchCandidate[];
  pageUrl: string;
  title: string;
  sample?: PlayerSample;
  detected?: boolean;
  encrypted?: boolean;
  closed?: boolean;
  action?: 'play' | 'pause' | 'seek' | 'rate' | 'ended';
}
interface HelperReply { ok: boolean; error?: string; sample?: PlayerSample; scanId?: string }

// The helper checks a user-configured WindWatch origin before serving any of
// these requests. Each request is correlated and expires; unrelated messages
// from third-party iframes cannot control this instance.
export class WatchBridge {
  private pending = new Map<string, { resolve: (reply: HelperReply) => void; timer: number }>();
  private listeners = new Set<(update: HelperUpdate) => void>();
  private disposed = false;
  private available = false;
  private receive = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin || event.data?.channel !== 'windwatch-helper:reply') return;
    const data = event.data;
    if (data.event === 'update' && typeof data.update?.scanId === 'string') {
      this.listeners.forEach(listener => listener(data.update));
    } else if (typeof data.id === 'string') {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(data.id);
      pending.resolve(data.result || { ok: false, error: 'Uzantı yanıt vermedi.' });
    }
  };
  constructor() { window.addEventListener('message', this.receive); }
  async request(action: string, payload: Record<string, unknown> = {}, timeout = 6000): Promise<HelperReply> {
    if (this.disposed) return { ok: false, error: 'Video yardımcısı kapatıldı.' };
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = window.setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: action === 'ping' ? 'Video yardımcısı bağlı değil.' : 'Video yardımcısı yanıt vermedi. Uzantının bu WindWatch adresine izin verdiğini kontrol edin.' }); }, timeout);
      this.pending.set(id, { resolve, timer });
      window.postMessage({ channel: 'windwatch-helper:request', id, action, ...payload }, window.location.origin);
    });
  }
  async ping(): Promise<boolean> { this.available = (await this.request('ping', {}, 1000)).ok; return this.available; }
  get connected() { return this.available; }
  subscribe(listener: (update: HelperUpdate) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose(): void {
    this.disposed = true; window.removeEventListener('message', this.receive);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, error: 'Video yardımcısı kapatıldı.' }); }
    this.pending.clear(); this.listeners.clear();
  }
}
