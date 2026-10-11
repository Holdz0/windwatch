import { MAX_SHARE_FILE_SIZE } from '../types';
import type { SharedFileMeta } from '../types';
import { randomId } from './session';

export const DEFAULT_FILE_RATE = 128 * 1024;
export const FILE_RATE_OPTIONS = [
  { value: 64 * 1024, label: '64 KB/sn' }, { value: DEFAULT_FILE_RATE, label: '128 KB/sn (önerilen)' },
  { value: 256 * 1024, label: '256 KB/sn' }, { value: 1024 * 1024, label: '1 MB/sn' }, { value: 0, label: 'Sınırsız' }
];
export function loadFileRate(): number {
  try { const value = Number(localStorage.getItem('windwatch:fileRate')); return localStorage.getItem('windwatch:fileRate') !== null && FILE_RATE_OPTIONS.some(option => option.value === value) ? value : DEFAULT_FILE_RATE; }
  catch { return DEFAULT_FILE_RATE; }
}
export interface TransferProgress {
  transferId: string; fileId: string; peerId: string; direction: 'upload' | 'download';
  bytes: number; total: number; bytesPerSecond: number; remainingSeconds: number | null;
  status: 'active' | 'complete' | 'cancelled' | 'error'; error?: string;
  peerName?: string;
}
export interface DownloadOptions { onProgress?: (progress: TransferProgress) => void }
interface Transfer {
  transferId: string; meta: SharedFileMeta; controller: AbortController;
  bytes: number; startedAt: number; lastReport: number; timer?: ReturnType<typeof setTimeout>;
}
interface Download extends Transfer {
  chunks: ArrayBuffer[]; started: boolean;
  resolve: (blob: Blob) => void; reject: (error: Error) => void;
  onProgress?: (progress: TransferProgress) => void;
}
interface Upload extends Transfer { rate: number; nextPeerAt: number }
const CHUNK_SIZE = 16 * 1024, HIGH_WATER = 64 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const cancelled = () => new DOMException('Dosya aktarımı iptal edildi.', 'AbortError');
const rateLimit = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? value === 0 ? 0 : Math.min(16 * 1024 * 1024, Math.max(16 * 1024, Math.round(value))) : DEFAULT_FILE_RATE;

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, Math.max(0, milliseconds));
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Every chunk carries its transfer ID: cancellation/retry cannot misattribute
 * already buffered data. Only requested, ordered chunks are accepted. */
export class FileTransfers {
  private channels = new Map<string, RTCDataChannel>();
  private downloads = new Map<string, Download>();
  private uploads = new Map<string, Upload>();
  private nextUploadAt = 0;
  private rate = DEFAULT_FILE_RATE;
  private localFiles: Map<string, File>;
  private onProgress?: (progress: TransferProgress) => void;
  constructor(localFiles: Map<string, File>, onProgress?: (progress: TransferProgress) => void) {
    this.localFiles = localFiles; this.onProgress = onProgress;
  }

  setRateLimit(value: number): void {
    this.rate = rateLimit(value); this.nextUploadAt = performance.now();
    for (const [peerId, download] of this.downloads) this.send(peerId, { type: 'rate', id: download.meta.id, transferId: download.transferId, rate: this.rate });
  }

  private send(peerId: string, data: object): boolean {
    const channel = this.channels.get(peerId);
    try { if (channel?.readyState === 'open') { channel.send(JSON.stringify(data)); return true; } } catch { /* Connection closed. */ }
    return false;
  }

  attach(peerId: string, channel: RTCDataChannel): void {
    this.finishDownload(peerId, new Error('Dosya bağlantısı yeniden kuruldu. Tekrar deneyin.'));
    this.finishUpload(peerId, new Error('Dosya bağlantısı yeniden kuruldu.'));
    this.channels.set(peerId, channel); channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = HIGH_WATER / 2;
    channel.onmessage = event => {
      if (this.channels.get(peerId) !== channel) return;
      if (typeof event.data === 'string') {
        if (event.data.length > 2048) return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (!data || typeof data.id !== 'string' || typeof data.transferId !== 'string' || !data.transferId || data.transferId.length > 64) return;
        if (data.type === 'request') {
          const file = this.localFiles.get(data.id);
          if (!file || this.uploads.has(peerId)) { this.send(peerId, { type: 'error', id: data.id, transferId: data.transferId }); return; }
          const upload: Upload = { transferId: data.transferId, meta: { id: data.id, name: file.name, size: file.size, type: file.type },
            controller: new AbortController(), bytes: 0, startedAt: performance.now(), lastReport: 0,
            rate: rateLimit(data.rate), nextPeerAt: performance.now() };
          this.uploads.set(peerId, upload); this.report(peerId, upload, 'upload');
          void this.sendFile(peerId, channel, upload, file).catch(error => {
            if (this.uploads.get(peerId) !== upload) return;
            this.send(peerId, { type: 'error', id: data.id, transferId: upload.transferId }); this.finishUpload(peerId, error);
          });
          return;
        }
        const upload = this.uploads.get(peerId), download = this.downloads.get(peerId);
        const matches = (transfer?: Transfer) => !!transfer && transfer.transferId === data.transferId && transfer.meta.id === data.id;
        if (data.type === 'rate' && matches(upload)) { upload!.rate = rateLimit(data.rate); upload!.nextPeerAt = performance.now(); }
        else if (data.type === 'complete' && matches(upload) && upload!.bytes === upload!.meta.size) this.finishUpload(peerId);
        else if (data.type === 'cancel') {
          if (matches(upload)) this.finishUpload(peerId, cancelled());
          if (matches(download)) this.finishDownload(peerId, cancelled());
        } else if (matches(download)) {
          if (data.type === 'begin') {
            if (download!.started || data.size !== download!.meta.size || data.size > MAX_SHARE_FILE_SIZE) this.failDownload(peerId, new Error('Dosya bilgileri eşleşmiyor.'));
            else { download!.started = true; this.touch(peerId, download!); }
          } else if (data.type === 'end') {
            if (!download!.started || download!.bytes !== download!.meta.size) this.failDownload(peerId, new Error('Dosya aktarımı eksik kaldı.'));
            else { this.send(peerId, { type: 'complete', id: data.id, transferId: data.transferId }); this.finishDownload(peerId); }
          } else if (data.type === 'error') this.finishDownload(peerId, new Error('Dosya artık paylaşılmıyor veya gönderen meşgul.'));
        }
      } else if (event.data instanceof ArrayBuffer) {
        const download = this.downloads.get(peerId);
        if (!download?.started) return;
        const buffer: ArrayBuffer = event.data;
        try {
          const length = new DataView(buffer).getUint16(0);
          if (!length || length > 64 || buffer.byteLength < 2 + length || buffer.byteLength > CHUNK_SIZE + 66) throw new Error('Invalid chunk');
          const id = decoder.decode(new Uint8Array(buffer, 2, length));
          if (id !== download.transferId) return;
          const chunk = buffer.slice(2 + length);
          if (!chunk.byteLength || download.bytes + chunk.byteLength > download.meta.size) throw new Error('Invalid size');
          download.chunks.push(chunk); download.bytes += chunk.byteLength;
          this.touch(peerId, download); this.report(peerId, download, 'download');
        } catch { this.failDownload(peerId, new Error('Geçersiz dosya parçası.')); }
      }
    };
    const closed = () => {
      if (this.channels.get(peerId) !== channel) return;
      this.channels.delete(peerId);
      this.finishDownload(peerId, new Error('Dosya bağlantısı kapandı.')); this.finishUpload(peerId, new Error('Dosya bağlantısı kapandı.'));
    };
    channel.onclose = closed; channel.onerror = closed;
  }

  private async drain(channel: RTCDataChannel, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw cancelled();
    if (channel.bufferedAmount <= HIGH_WATER) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); channel.removeEventListener('bufferedamountlow', ready); channel.removeEventListener('close', closed);
        channel.removeEventListener('error', closed); signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const ready = () => finish(), closed = () => finish(new Error('Dosya bağlantısı kapandı.')), abort = () => finish(cancelled());
      const timer = setTimeout(() => finish(new Error('Dosya aktarımı durdu.')), 15000);
      channel.addEventListener('bufferedamountlow', ready); channel.addEventListener('close', closed);
      channel.addEventListener('error', closed); signal.addEventListener('abort', abort, { once: true });
      if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) ready();
    });
  }

  private async sendFile(peerId: string, channel: RTCDataChannel, upload: Upload, file: File): Promise<void> {
    const identity = encoder.encode(upload.transferId), signal = upload.controller.signal;
    this.send(peerId, { type: 'begin', id: upload.meta.id, transferId: upload.transferId, size: file.size });
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      await this.drain(channel, signal);
      const size = Math.min(CHUNK_SIZE, file.size - offset), now = performance.now();
      const due = Math.max(now, this.rate ? this.nextUploadAt : now, upload.rate ? upload.nextPeerAt : now);
      if (this.rate) this.nextUploadAt = due + size / this.rate * 1000;
      if (upload.rate) upload.nextPeerAt = due + size / upload.rate * 1000;
      if (due > now) await pause(due - now, signal);
      const chunk = await file.slice(offset, offset + size).arrayBuffer();
      if (signal.aborted) throw cancelled();
      if (channel.readyState !== 'open' || this.channels.get(peerId) !== channel) throw new Error('Dosya bağlantısı kapandı.');
      const packet = new Uint8Array(2 + identity.length + chunk.byteLength);
      new DataView(packet.buffer).setUint16(0, identity.length); packet.set(identity, 2); packet.set(new Uint8Array(chunk), 2 + identity.length);
      channel.send(packet); upload.bytes += chunk.byteLength; this.report(peerId, upload, 'upload');
    }
    if (!this.send(peerId, { type: 'end', id: upload.meta.id, transferId: upload.transferId })) throw new Error('Dosya bağlantısı kapandı.');
    if (this.uploads.get(peerId) === upload) upload.timer = setTimeout(() => this.finishUpload(peerId, new Error('Dosya teslim onayı alınamadı.')), 60000);
  }

  download(peerId: string, meta: SharedFileMeta, options: DownloadOptions = {}): Promise<Blob> {
    if (this.channels.get(peerId)?.readyState !== 'open') return Promise.reject(new Error('Bağlantı henüz hazır değil. Biraz sonra tekrar deneyin.'));
    if (this.downloads.has(peerId)) return Promise.reject(new Error('Bu kullanıcıdan bir dosya zaten indiriliyor.'));
    return new Promise((resolve, reject) => {
      const download: Download = { transferId: randomId(), meta, controller: new AbortController(), chunks: [], bytes: 0, started: false,
        startedAt: performance.now(), lastReport: 0, resolve, reject, onProgress: options.onProgress };
      this.downloads.set(peerId, download); this.touch(peerId, download); this.report(peerId, download, 'download');
      if (!this.send(peerId, { type: 'request', id: meta.id, transferId: download.transferId, rate: this.rate })) this.finishDownload(peerId, new Error('Dosya istenemedi.'));
    });
  }

  cancel(transferId: string): void {
    for (const [peerId, transfer] of [...this.downloads, ...this.uploads]) if (transfer.transferId === transferId) {
      this.send(peerId, { type: 'cancel', id: transfer.meta.id, transferId });
      if (this.downloads.get(peerId) === transfer) this.finishDownload(peerId, cancelled());
      else this.finishUpload(peerId, cancelled());
    }
  }

  private report(peerId: string, transfer: Transfer, direction: 'upload' | 'download', error?: Error, complete = false): void {
    const now = performance.now();
    if (!error && !complete && transfer.lastReport && now - transfer.lastReport < 250 && transfer.bytes !== transfer.meta.size) return;
    transfer.lastReport = now;
    const seconds = (now - transfer.startedAt) / 1000, speed = seconds >= 0.25 ? transfer.bytes / seconds : 0;
    const progress: TransferProgress = { transferId: transfer.transferId, fileId: transfer.meta.id, peerId, direction,
      bytes: transfer.bytes, total: transfer.meta.size, bytesPerSecond: speed,
      remainingSeconds: speed > 0 ? Math.max(0, (transfer.meta.size - transfer.bytes) / speed) : null,
      status: error ? error.name === 'AbortError' ? 'cancelled' : 'error' : complete ? 'complete' : 'active', error: error?.message };
    this.onProgress?.(progress); if (direction === 'download') (transfer as Download).onProgress?.(progress);
  }

  private touch(peerId: string, download: Download): void {
    clearTimeout(download.timer); download.timer = setTimeout(() => this.failDownload(peerId, new Error('Dosya indirme zaman aşımına uğradı.')), 60000);
  }
  private failDownload(peerId: string, error: Error): void {
    const download = this.downloads.get(peerId);
    if (download) this.send(peerId, { type: 'cancel', id: download.meta.id, transferId: download.transferId });
    this.finishDownload(peerId, error);
  }
  private finishDownload(peerId: string, error?: Error): void {
    const download = this.downloads.get(peerId); if (!download) return;
    this.downloads.delete(peerId); clearTimeout(download.timer); download.controller.abort();
    this.report(peerId, download, 'download', error, !error);
    if (error) { download.chunks.length = 0; download.reject(error); }
    else download.resolve(new Blob(download.chunks, { type: download.meta.type || 'application/octet-stream' }));
  }
  private finishUpload(peerId: string, error?: Error): void {
    const upload = this.uploads.get(peerId); if (!upload) return;
    this.uploads.delete(peerId); clearTimeout(upload.timer); upload.controller.abort(); this.report(peerId, upload, 'upload', error, !error);
  }
  dispose(): void {
    for (const peerId of this.downloads.keys()) this.finishDownload(peerId, new Error('Odadan ayrıldınız.'));
    for (const peerId of this.uploads.keys()) this.finishUpload(peerId, new Error('Odadan ayrıldınız.'));
    this.channels.clear();
  }
}
