import { useCallback, useEffect, useState } from 'react';

export interface MediaPreferences { microphone: string; camera: string; speaker: string }
export type DevicePreference = keyof MediaPreferences;
const KEY = 'windwatch:mediaDevices';

export function loadMediaPreferences(): MediaPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { microphone: typeof saved.microphone === 'string' ? saved.microphone : '',
      camera: typeof saved.camera === 'string' ? saved.camera : '', speaker: typeof saved.speaker === 'string' ? saved.speaker : '' };
  } catch { return { microphone: '', camera: '', speaker: '' }; }
}

export function saveMediaPreferences(preferences: MediaPreferences): void {
  try { localStorage.setItem(KEY, JSON.stringify(preferences)); } catch { /* Storage may be disabled. */ }
}

export function microphoneConstraints(deviceId = ''): MediaStreamConstraints {
  return { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } };
}

export function deviceError(error: unknown): string {
  const name = (error as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Cihaz izni verilmedi. Tarayıcının site izinlerini kontrol edin.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Seçilen cihaz bulunamadı. Başka bir cihaz veya sistem varsayılanını seçin.';
  if (name === 'NotReadableError') return 'Cihaz açılamadı. Başka bir uygulamada kullanılıyor olabilir.';
  return 'Cihaz kullanılamadı. Bağlantısını ve tarayıcı izinlerini kontrol edin.';
}

export function useMediaDevices() {
  const [preferences, setPreferences] = useState(loadMediaPreferences);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceRevision, setDeviceRevision] = useState(0);
  const refresh = useCallback(async () => {
    const found = await navigator.mediaDevices?.enumerateDevices();
    return found || [];
  }, []);
  useEffect(() => {
    let stopped = false;
    let generation = 0;
    const detect = async (changed = false) => {
      const current = ++generation;
      try {
        const found = await refresh();
        if (!stopped && current === generation) { setDevices(found); if (changed) setDeviceRevision(value => value + 1); }
      } catch { /* Enumeration may be denied until permission is granted. */ }
    };
    const changed = () => { void detect(true); };
    const permitted = () => { void detect(); };
    void detect();
    navigator.mediaDevices?.addEventListener('devicechange', changed);
    window.addEventListener('windwatch:devices-permitted', permitted);
    return () => { stopped = true; navigator.mediaDevices?.removeEventListener('devicechange', changed);
      window.removeEventListener('windwatch:devices-permitted', permitted); };
  }, [refresh]);
  const choose = useCallback((kind: DevicePreference, id: string) => {
    setPreferences(previous => { const next = { ...previous, [kind]: id }; saveMediaPreferences(next); return next; });
  }, []);
  return { preferences, devices, deviceRevision, choose };
}

export function refreshDeviceLabels(): void { window.dispatchEvent(new Event('windwatch:devices-permitted')); }

/** A short PCM test tone played through an HTMLAudioElement so it follows the
 * exact same output-device API as participant playback. No microphone loopback. */
export function speakerTestUrl(): string {
  const rate = 24000, count = rate;
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => Array.from(value).forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const envelope = Math.min(1, i / 1200, (count - i) / 2400);
    view.setInt16(44 + i * 2, Math.sin(i / rate * 2 * Math.PI * (i < count / 2 ? 440 : 660)) * envelope * 6000, true);
  }
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}
