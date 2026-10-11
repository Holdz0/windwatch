import { useEffect, useRef, useState } from 'react';
import { X, Volume2 } from 'lucide-react';
import { buildCameraConstraints } from '../utils/device';
import { deviceError, microphoneConstraints, refreshDeviceLabels, speakerTestUrl } from '../utils/mediaDevices';
import type { DevicePreference, MediaPreferences } from '../utils/mediaDevices';

function MicrophoneMeter({ track }: { track?: MediaStreamTrack }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!track) { setLevel(0); return; }
    const context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser(); analyser.fftSize = 256; source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    void context.resume().catch(() => {});
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
      setLevel(Math.min(100, Math.round(rms * 350)));
    }, 100);
    return () => { clearInterval(timer); source.disconnect(); analyser.disconnect(); void context.close().catch(() => {}); };
  }, [track]);
  return <div className="microphone-meter"><span>Mikrofon seviyesi</span>
    <progress aria-label="Mikrofon seviyesi" max={100} value={level} />
    <span>{track ? 'Konuşarak kontrol edin. Sesiniz kendinize çalınmaz.' : 'Testi başlatın veya görüşmede mikrofonunuzu açın.'}</span></div>;
}

interface Props {
  preferences: MediaPreferences;
  devices: MediaDeviceInfo[];
  onChange: (kind: DevicePreference, id: string) => Promise<void> | void;
  liveStream?: MediaStream | null;
  audioBusy?: boolean;
  videoBusy?: boolean;
  onClose?: () => void;
}
type OutputDevices = MediaDevices & { selectAudioOutput?: (options: { deviceId?: string }) => Promise<MediaDeviceInfo> };

export default function DeviceSettings({ preferences, devices, onChange, liveStream, audioBusy, videoBusy, onClose }: Props) {
  const [cameraTest, setCameraTest] = useState(false), [microphoneTest, setMicrophoneTest] = useState(false);
  const [previewCamera, setPreviewCamera] = useState<MediaStreamTrack>(), [previewMicrophone, setPreviewMicrophone] = useState<MediaStreamTrack>();
  const [error, setError] = useState(''), [changing, setChanging] = useState(false), [testingSpeaker, setTestingSpeaker] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null), speakerRef = useRef<HTMLAudioElement | null>(null);
  const outputPicker = (navigator.mediaDevices as OutputDevices | undefined)?.selectAudioOutput?.bind(navigator.mediaDevices);
  const mounted = useRef(true);
  const liveCamera = liveStream?.getVideoTracks()[0], liveMicrophone = liveStream?.getAudioTracks()[0];
  const camera = liveCamera || previewCamera, microphone = liveMicrophone || previewMicrophone;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; speakerRef.current?.pause(); if (speakerRef.current?.src) URL.revokeObjectURL(speakerRef.current.src); };
  }, []);
  useEffect(() => {
    if (!cameraTest || liveCamera) return;
    let stopped = false;
    let stream: MediaStream | undefined;
    const constraints = buildCameraConstraints('user', false);
    if (preferences.camera) (constraints.video as MediaTrackConstraints).deviceId = { exact: preferences.camera };
    void navigator.mediaDevices?.getUserMedia(constraints).then(found => {
      stream = found;
      if (stopped) found.getTracks().forEach(track => track.stop());
      else { setPreviewCamera(found.getVideoTracks()[0]); refreshDeviceLabels(); }
    }).catch(failure => { if (!stopped) { setError(deviceError(failure)); setCameraTest(false); } });
    return () => { stopped = true; stream?.getTracks().forEach(track => track.stop()); setPreviewCamera(undefined); };
  }, [cameraTest, liveCamera, preferences.camera]);
  useEffect(() => {
    if (!microphoneTest || liveMicrophone) return;
    let stopped = false;
    let stream: MediaStream | undefined;
    void navigator.mediaDevices?.getUserMedia(microphoneConstraints(preferences.microphone)).then(found => {
      stream = found;
      if (stopped) found.getTracks().forEach(track => track.stop());
      else { setPreviewMicrophone(found.getAudioTracks()[0]); refreshDeviceLabels(); }
    }).catch(failure => { if (!stopped) { setError(deviceError(failure)); setMicrophoneTest(false); } });
    return () => { stopped = true; stream?.getTracks().forEach(track => track.stop()); setPreviewMicrophone(undefined); };
  }, [microphoneTest, liveMicrophone, preferences.microphone]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = camera ? new MediaStream([camera]) : null;
    if (camera) void video.play().catch(() => {});
    return () => { video.srcObject = null; };
  }, [camera]);
  const change = async (kind: DevicePreference, id: string) => {
    setChanging(true); setError('');
    try { await onChange(kind, id); }
    catch (failure) { if (mounted.current) setError(deviceError(failure)); }
    finally { if (mounted.current) setChanging(false); }
  };
  const testSpeaker = async () => {
    speakerRef.current?.pause();
    if (speakerRef.current?.src) URL.revokeObjectURL(speakerRef.current.src);
    const audio = new Audio(speakerTestUrl()); speakerRef.current = audio;
    setError(''); setTestingSpeaker(true);
    audio.onended = () => { if (mounted.current) setTestingSpeaker(false); URL.revokeObjectURL(audio.src); };
    try {
      if (audio.setSinkId) await audio.setSinkId(preferences.speaker);
      if (!mounted.current || speakerRef.current !== audio) return;
      await audio.play();
    } catch (failure) { if (mounted.current) { setError(deviceError(failure)); setTestingSpeaker(false); } }
  };
  const selectSpeaker = async () => {
    if (!outputPicker) return;
    try {
      const device = await outputPicker({ deviceId: preferences.speaker });
      if (mounted.current) { await change('speaker', device.deviceId); refreshDeviceLabels(); }
    } catch (failure) { if (mounted.current) setError(deviceError(failure)); }
  };
  const names: Record<DevicePreference, string> = { microphone: 'Mikrofon', camera: 'Kamera', speaker: 'Hoparlör / kulaklık' };
  const kinds = { microphone: 'audioinput', camera: 'videoinput', speaker: 'audiooutput' };
  const mediaSupported = !!navigator.mediaDevices?.getUserMedia;
  return <section className="device-settings" aria-label="Ses ve görüntü cihazları">
    <div className="device-settings-heading"><strong>Ses ve görüntü cihazları</strong>
      {onClose && <button type="button" className="device-close" aria-label="Cihaz ayarlarını kapat" onClick={onClose} autoFocus><X size={20} /></button>}</div>
    {!mediaSupported && <p>Kamera ve mikrofon için HTTPS ve desteklenen bir tarayıcı gerekiyor.</p>}
    {error && <p className="device-error" role="alert">{error}</p>}
    {(Object.keys(names) as DevicePreference[]).map(kind => {
      const available = devices.filter(device => device.kind === kinds[kind] && device.deviceId);
      return <label className="device-select" key={kind}>{names[kind]}
        <select aria-label={names[kind]} value={preferences[kind]} onChange={event => { void change(kind, event.target.value); }}
          disabled={changing || (kind === 'microphone' && audioBusy) || (kind === 'camera' && videoBusy) || (kind === 'speaker' && !HTMLMediaElement.prototype.setSinkId)}>
          <option value="">Sistem varsayılanı</option>
          {preferences[kind] && !available.some(device => device.deviceId === preferences[kind]) && <option value={preferences[kind]}>Önceki seçim (izin veya bağlantı gerekiyor)</option>}
          {available.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${names[kind]} ${index + 1}`}</option>)}
        </select></label>;
    })}
    <div className="device-preview"><video ref={videoRef} muted playsInline aria-label="Kamera önizlemesi" style={{ display: camera ? undefined : 'none' }} />
      {!camera && <span>Kamera önizlemesi</span>}</div>
    <div className="device-test-actions">
      {!liveCamera && <button type="button" disabled={!mediaSupported} onClick={() => { setError(''); setCameraTest(value => !value); }}>{cameraTest ? 'Kamera testini durdur' : 'Kamerayı test et'}</button>}
      {!liveMicrophone && <button type="button" disabled={!mediaSupported} onClick={() => { setError(''); setMicrophoneTest(value => !value); }}>{microphoneTest ? 'Mikrofon testini durdur' : 'Mikrofonu test et'}</button>}
      <button type="button" disabled={testingSpeaker} onClick={() => { void testSpeaker(); }}><Volume2 size={15} />{testingSpeaker ? 'Test sesi çalıyor…' : 'Hoparlörü test et'}</button>
      {!!outputPicker && <button type="button" onClick={() => { void selectSpeaker(); }}>Çıkış cihazına izin ver</button>}
    </div>
    <MicrophoneMeter track={microphone} />
    <p className="device-note">{liveCamera || liveMicrophone
      ? 'Açık cihazlar görüşmede kullanılmaya devam eder. Test düğmeleriyle başlatılan önizlemeler diğer katılımcılara gönderilmez.'
      : 'Test görüntüsü ve mikrofon testi yalnızca bu cihazda kullanılır.'} Seçimleriniz sonraki görüşmeler için hatırlanır.</p>
    {!HTMLMediaElement.prototype.setSinkId && <p className="device-note">Bu tarayıcıda ses çıkışı işletim sisteminin seçtiği cihazdan yapılır.</p>}
  </section>;
}
