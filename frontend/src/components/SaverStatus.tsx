import { useEffect, useState } from 'react';
import type { SaverStats } from '../utils/saver';
import { formatBitrate } from '../utils/screenShare';

export default function SaverStatus({ readStats }: { readStats: () => Promise<SaverStats | null> }) {
  const [stats, setStats] = useState<SaverStats | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const sample = async () => {
      try {
        const current = await readStats();
        if (!stopped) setStats(current);
      } catch { /* Settings remain usable while a connection recovers. */ }
      if (!stopped) timer = setTimeout(() => { void sample(); }, 3000);
    };
    void sample();
    return () => { stopped = true; clearTimeout(timer); };
  }, [readStats]);

  return <div className="saver-status" aria-label="Tasarruf paylaşım durumu">
    <span className="saver-status-title">Gönderilen medya · {stats?.viewers ?? 0} izleyici</span>
    <strong>{stats?.viewers === 0 ? 'Henüz izleyici yok.' : stats?.mediaBitrate != null
      ? `${formatBitrate(stats.mediaBitrate / 1000)} · yaklaşık ${Math.round(stats.mediaBitrate * 3600 / 8_000_000)} MB/saat`
      : 'Veri kullanımı ölçülüyor…'}</strong>
    {!!stats?.height && <span>{stats.width} × {stats.height} · {Math.round(stats.fps)} fps</span>}
    <span>Ekran hedef sınırı: {formatBitrate((stats?.screenBitrateLimit ?? 500_000) / 1000)} / izleyici.</span>
    <span>Hareketsiz görüntüde daha az kare gönderilir. Kamera daha az veri kullanır. İndirme, dosyalar ve ağ ek yükü bu ölçüme dahil değildir.</span>
    {stats?.limitedBy === 'cpu' && <span>Cihaz akıcılığı korumak için görüntüyü uyarlıyor.</span>}
    {stats?.limitedBy === 'bandwidth' && <span>Bağlantıya uygun görüntü gönderiliyor.</span>}
  </div>;
}
