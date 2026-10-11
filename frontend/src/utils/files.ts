import { MAX_SHARE_FILE_SIZE } from '../types';
import type { SharedFileMeta } from '../types';

interface Download {
  meta: SharedFileMeta;
  chunks: ArrayBuffer[];
  received: number;
  started: boolean;
  resolve: (blob: Blob) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const CHUNK_SIZE = 16 * 1024;
const HIGH_WATER = 256 * 1024;

// Chunks and backpressure keep large file transfers from blocking video or
// allocating the whole file at the sender. Only a requested file is accepted.
export class FileTransfers {
  private channels = new Map<string, RTCDataChannel>();
  private downloads = new Map<string, Download>();
  private localFiles: Map<string, File>;

  constructor(localFiles: Map<string, File>) { this.localFiles = localFiles; }

  attach(peerId: string, channel: RTCDataChannel): void {
    if (this.channels.has(peerId)) this.finish(peerId, new Error('Dosya bağlantısı yeniden kuruldu. Tekrar deneyin.'));
    this.channels.set(peerId, channel);
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = HIGH_WATER / 2;
    let sending = false;
    channel.onmessage = event => {
      if (this.channels.get(peerId) !== channel) return;
      if (typeof event.data === 'string') {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'request' && typeof data.id === 'string') {
          const file = this.localFiles.get(data.id);
          if (!file || sending) { channel.send(JSON.stringify({ type: 'error', id: data.id })); return; }
          sending = true;
          void this.sendFile(channel, data.id, file).catch(() => {
            if (channel.readyState === 'open') channel.send(JSON.stringify({ type: 'error', id: data.id }));
          }).finally(() => { sending = false; });
          return;
        }
        const download = this.downloads.get(peerId);
        if (!download || data.id !== download.meta.id) return;
        if (data.type === 'begin') {
          if (download.started || data.size !== download.meta.size || data.size > MAX_SHARE_FILE_SIZE)
            this.finish(peerId, new Error('Dosya bilgileri eşleşmiyor.'));
          else { download.started = true; this.touch(peerId, download); }
        } else if (data.type === 'end') {
          if (!download.started || download.received !== download.meta.size)
            this.finish(peerId, new Error('Dosya aktarımı eksik kaldı.'));
          else this.finish(peerId);
        } else if (data.type === 'error') this.finish(peerId, new Error('Dosya artık paylaşılmıyor veya gönderen meşgul.'));
      } else if (event.data instanceof ArrayBuffer) {
        const download = this.downloads.get(peerId);
        if (!download?.started) return;
        if (event.data.byteLength > CHUNK_SIZE || download.received + event.data.byteLength > download.meta.size) {
          this.finish(peerId, new Error('Geçersiz dosya parçası.'));
          return;
        }
        download.chunks.push(event.data);
        download.received += event.data.byteLength;
        this.touch(peerId, download);
      }
    };
    channel.onclose = () => {
      if (this.channels.get(peerId) !== channel) return;
      this.channels.delete(peerId);
      this.finish(peerId, new Error('Dosya bağlantısı kapandı.'));
    };
    channel.onerror = () => { if (this.channels.get(peerId) === channel) this.finish(peerId, new Error('Dosya aktarımı başarısız.')); };
  }

  private async sendFile(channel: RTCDataChannel, id: string, file: File): Promise<void> {
    channel.send(JSON.stringify({ type: 'begin', id, size: file.size }));
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      if (channel.readyState !== 'open') throw new Error('Channel closed');
      if (channel.bufferedAmount > HIGH_WATER) await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          channel.removeEventListener('bufferedamountlow', ready);
          channel.removeEventListener('close', closed);
          if (error) reject(error); else resolve();
        };
        const ready = () => finish();
        const closed = () => finish(new Error('Channel closed'));
        const timer = setTimeout(() => finish(new Error('Transfer stalled')), 15000);
        channel.addEventListener('bufferedamountlow', ready, { once: true });
        channel.addEventListener('close', closed, { once: true });
      });
      const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      if (channel.readyState !== 'open') throw new Error('Channel closed');
      channel.send(chunk);
    }
    channel.send(JSON.stringify({ type: 'end', id }));
  }

  download(peerId: string, meta: SharedFileMeta): Promise<Blob> {
    const channel = this.channels.get(peerId);
    if (!channel || channel.readyState !== 'open') return Promise.reject(new Error('Bağlantı henüz hazır değil. Biraz sonra tekrar deneyin.'));
    if (this.downloads.has(peerId)) return Promise.reject(new Error('Bu kullanıcıdan bir dosya zaten indiriliyor.'));
    return new Promise((resolve, reject) => {
      const download: Download = { meta, chunks: [], received: 0, started: false, resolve, reject };
      this.downloads.set(peerId, download);
      this.touch(peerId, download);
      try { channel.send(JSON.stringify({ type: 'request', id: meta.id })); }
      catch { this.finish(peerId, new Error('Dosya istenemedi.')); }
    });
  }

  private touch(peerId: string, download: Download): void {
    clearTimeout(download.timer);
    download.timer = setTimeout(() => this.finish(peerId, new Error('Dosya indirme zaman aşımına uğradı.')), 60000);
  }

  private finish(peerId: string, error?: Error): void {
    const download = this.downloads.get(peerId);
    if (!download) return;
    this.downloads.delete(peerId);
    clearTimeout(download.timer);
    if (error) download.reject(error);
    else download.resolve(new Blob(download.chunks, { type: download.meta.type || 'application/octet-stream' }));
  }

  dispose(): void {
    for (const peerId of this.downloads.keys()) this.finish(peerId, new Error('Odadan ayrıldınız.'));
    this.channels.clear();
  }
}
