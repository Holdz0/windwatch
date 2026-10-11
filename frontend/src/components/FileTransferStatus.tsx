import type { TransferProgress } from '../utils/files';

function formatFileBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}
function remaining(seconds: number | null): string {
  if (seconds === null) return 'Kalan süre hesaplanıyor…';
  if (seconds < 60) return `Yaklaşık ${Math.ceil(seconds)} sn kaldı`;
  return `Yaklaşık ${Math.ceil(seconds / 60)} dk kaldı`;
}
export default function FileTransferStatus({ transfers, onCancel }: { transfers: TransferProgress[]; onCancel: (id: string) => void }) {
  if (!transfers.length) return null;
  return <div className="file-transfers">
    {transfers.map(transfer => {
      const percent = transfer.total ? Math.min(100, Math.floor(transfer.bytes / transfer.total * 100)) : transfer.status === 'complete' ? 100 : 0;
      return <div key={transfer.transferId} className="file-transfer" data-transfer-status={transfer.status}>
        <div className="file-transfer-title"><span>{transfer.direction === 'upload' ? 'Gönderim' : 'İndirme'}{transfer.peerName ? ` · ${transfer.peerName}` : ''} · %{percent}</span>
          {transfer.status === 'active' && <button type="button" onClick={() => onCancel(transfer.transferId)} aria-label="Dosya aktarımını iptal et">İptal</button>}</div>
        <progress max={100} value={percent} aria-label="Dosya aktarım ilerlemesi" />
        {transfer.status === 'active' && <span>{formatFileBytes(transfer.bytes)} / {formatFileBytes(transfer.total)} · {formatFileBytes(transfer.bytesPerSecond)}/sn<br />
          {percent === 100 ? 'Teslim onayı bekleniyor…' : remaining(transfer.remainingSeconds)}</span>}
        {transfer.status === 'complete' && <span>Aktarım tamamlandı.</span>}
        {transfer.status === 'cancelled' && <span>Aktarım iptal edildi.</span>}
        {transfer.status === 'error' && <span role="alert">{transfer.error || 'Aktarım başarısız.'}</span>}
      </div>;
    })}
  </div>;
}
