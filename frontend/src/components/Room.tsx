import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { Copy, Users, Lock, Unlock, KeyRound, Volume2 } from 'lucide-react';
import VideoGrid from './VideoGrid';
import Chat from './Chat';
import Controls from './Controls';
import type { Participant, ChatMessage, SharedFileMeta } from '../types';
import { FILE_MESSAGE_PREFIX, MAX_SHARE_FILE_SIZE } from '../types';
import { primeAudioUnlock, resetAudioUnlock, unlockAudioPlayback } from '../utils/audio';
import { startWakeLock, stopWakeLock } from '../utils/wakeLock';
import { startCallMediaSession, updateCallMediaSession } from '../utils/mediaSession';
import { buildCameraConstraints, isMobileDevice } from '../utils/device';
import type { FacingMode } from '../utils/device';
import { getClientId, randomId } from '../utils/session';
import { BACKEND_URL, buildIceServers } from '../utils/config';
import { RtcMesh } from '../utils/rtc';
import type { RtcSignal } from '../utils/rtc';
import { FileTransfers } from '../utils/files';
import {
  DEFAULT_SCREEN_QUALITY, DEFAULT_CUSTOM_SETTINGS, SCREEN_SHARE_PRESETS,
  buildDisplayMediaConstraints, resolveScreenSharePreset, normalizeCustomSettings,
  protectDisplayAudio, SYSTEM_AUDIO_BLOCKED_HINT
} from '../utils/screenShare';
import type { ScreenShareQuality, CustomScreenShareSettings } from '../utils/screenShare';

interface RoomProps {
  roomId: string;
  username: string;
  initialPassword: string | null;
  onLeave: (reason?: string) => void;
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
}

function mediaError(error: unknown, device: string): string {
  const name = (error as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return `${device} izni verilmedi. Tarayıcının site izinlerini kontrol edin.`;
  if (name === 'NotFoundError') return `${device} bulunamadı. Cihaz bağlantısını kontrol edin.`;
  if (name === 'NotReadableError' || name === 'AbortError') return `${device} açılamadı. Cihaz başka bir uygulamada kullanılıyor olabilir.`;
  return `${device} başlatılamadı. Cihazınızı ve tarayıcı izinlerini kontrol edin.`;
}

function savedQuality(): ScreenShareQuality {
  try {
    const saved = localStorage.getItem('windwatch:screenQuality');
    if (saved === 'custom' || (saved && Object.hasOwn(SCREEN_SHARE_PRESETS, saved))) return saved as ScreenShareQuality;
  } catch { /* storage unavailable */ }
  return DEFAULT_SCREEN_QUALITY;
}

function savedCustom(): CustomScreenShareSettings {
  try { return normalizeCustomSettings(JSON.parse(localStorage.getItem('windwatch:screenCustom') || '{}')); }
  catch { return DEFAULT_CUSTOM_SETTINGS; }
}

const Room: React.FC<RoomProps> = ({ roomId, username, initialPassword, onLeave }) => {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isAudioMuted, setIsAudioMuted] = useState(true);
  const [isVideoMuted, setIsVideoMuted] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(window.innerWidth > 640);
  const [audioBusy, setAudioBusy] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);
  const [screenBusy, setScreenBusy] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [facingMode, setFacingMode] = useState<FacingMode>('user');
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false);
  const [screenQuality, setScreenQuality] = useState<ScreenShareQuality>(savedQuality);
  const [screenCustomSettings, setScreenCustomSettings] = useState<CustomScreenShareSettings>(savedCustom);
  const [warningToast, setWarningToast] = useState<string | null>(null);
  const [showCopiedToast, setShowCopiedToast] = useState(false);
  const [hostSocketId, setHostSocketId] = useState<string | null>(null);
  const [isPasswordPromptOpen, setIsPasswordPromptOpen] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isRoomLocked, setIsRoomLocked] = useState(false);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 640);
  const [isShortLandscape, setIsShortLandscape] = useState(false);
  const [isChromeHidden, setIsChromeHidden] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const meshRef = useRef<RtcMesh | null>(null);
  const filesRef = useRef<FileTransfers | null>(null);
  const localFilesRef = useRef(new Map<string, File>());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const passwordRef = useRef(initialPassword);
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  const facingModeRef = useRef<FacingMode>('user');
  const screenQualityRef = useRef(screenQuality);
  const screenCustomSettingsRef = useRef(screenCustomSettings);
  const isAudioMutedRef = useRef(true);
  const isVideoMutedRef = useRef(true);
  const sessionRef = useRef(0);
  const operationsRef = useRef({ audio: 0, video: 0, screen: 0 });
  const busyRef = useRef({ audio: false, video: false, screen: false });
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chromeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pipWindowRef = useRef<Window | null>(null);
  const joinRoomRef = useRef<(() => void) | null>(null);
  const invalidateSession = () => { sessionRef.current++; };

  const showWarning = (message: string) => {
    setWarningToast(message);
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    warningTimerRef.current = setTimeout(() => setWarningToast(null), 8000);
  };

  const updateLocalParticipant = () => {
    const stream = localStreamRef.current;
    const screenStream = screenStreamRef.current;
    setParticipants(previous => previous.map(p => p.socketId === 'local' ? {
      ...p, stream: stream ? new MediaStream(stream.getTracks()) : undefined,
      screenStream: screenStream ? new MediaStream(screenStream.getTracks()) : undefined,
      isAudioMuted: isAudioMutedRef.current, isVideoMuted: isVideoMutedRef.current,
      isScreenSharing: !!screenStream, hasScreenAudio: !!screenStream?.getAudioTracks().length,
      isMirrored: facingModeRef.current === 'user'
    } : p));
  };

  const syncMedia = () => meshRef.current?.setTracks({
    microphone: localStreamRef.current?.getAudioTracks()[0] || null,
    camera: localStreamRef.current?.getVideoTracks()[0] || null,
    screenVideo: screenStreamRef.current?.getVideoTracks()[0] || null,
    screenAudio: screenStreamRef.current?.getAudioTracks()[0] || null
  }, screenStreamRef.current ? resolveScreenSharePreset(screenQualityRef.current, screenCustomSettingsRef.current) : null);

  const muteLocalAudio = () => {
    operationsRef.current.audio++;
    const stream = localStreamRef.current;
    stream?.getAudioTracks().forEach(track => { track.onended = null; track.stop(); stream.removeTrack(track); });
    isAudioMutedRef.current = true;
    setIsAudioMuted(true);
    updateLocalParticipant();
    void syncMedia();
    socketRef.current?.emit('media-state', { isAudioMuted: true });
  };

  const muteLocalVideo = () => {
    operationsRef.current.video++;
    const stream = localStreamRef.current;
    stream?.getVideoTracks().forEach(track => { track.onended = null; track.stop(); stream.removeTrack(track); });
    isVideoMutedRef.current = true;
    setIsVideoMuted(true);
    updateLocalParticipant();
    void syncMedia();
    socketRef.current?.emit('media-state', { isVideoMuted: true });
  };

  const releaseScreenCapture = () => {
    const stream = screenStreamRef.current;
    screenStreamRef.current = null;
    stopStream(stream);
  };

  const stopScreenSharing = () => {
    operationsRef.current.screen++;
    releaseScreenCapture();
    setIsScreenSharing(false);
    updateLocalParticipant();
    void syncMedia();
    if (socketRef.current?.connected) socketRef.current.emit('toggle-screen-share', { isSharing: false });
  };

  useEffect(() => {
    const session = ++sessionRef.current;
    const peerId = randomId();
    const localStream = new MediaStream();
    localStreamRef.current = localStream;
    isAudioMutedRef.current = true;
    isVideoMutedRef.current = true;
    const socket = io(BACKEND_URL, { autoConnect: false });
    socketRef.current = socket;
    const localFiles = localFilesRef.current;
    const operations = operationsRef.current;
    const files = new FileTransfers(localFiles);
    filesRef.current = files;
    const remoteMedia = new Map<string, { stream: MediaStream; screenStream: MediaStream; connectionState?: RTCPeerConnectionState }>();
    const current = () => sessionRef.current === session;
    const mesh = new RtcMesh({
      peerId, iceServers: buildIceServers(),
      sendSignal: (targetPeerId, signal) => { if (socket.connected) socket.emit('rtc-signal', { targetPeerId, signal }); },
      onStreams: (id, stream, screenStream) => {
        // addTrack() called by our transport does not dispatch an addtrack
        // event. Publish snapshots so playback effects also bind late tracks.
        const media = { ...remoteMedia.get(id), stream: new MediaStream(stream.getTracks()),
          screenStream: new MediaStream(screenStream.getTracks()) };
        remoteMedia.set(id, media);
        if (current()) setParticipants(previous => previous.map(p => p.peerId === id ? { ...p, ...media } : p));
      },
      onState: (id, connectionState) => {
        const media = remoteMedia.get(id);
        if (media) media.connectionState = connectionState;
        if (current()) setParticipants(previous => previous.map(p => p.peerId === id ? { ...p, connectionState } : p));
      },
      onDataChannel: (id, channel) => files.attach(id, channel),
      onError: error => console.warn('[WindWatch bağlantı]', error)
    });
    meshRef.current = mesh;
    setParticipants([{ socketId: 'local', peerId, username: `${username} (Siz)`, isHost: false,
      stream: localStream, isAudioMuted: true, isVideoMuted: true, isMirrored: true }]);
    const joinRoom = () => socket.emit('join-room', { roomId, peerId, clientId: getClientId(), username,
      password: passwordRef.current, media: { isAudioMuted: isAudioMutedRef.current,
        isVideoMuted: isVideoMutedRef.current, isScreenSharing: !!screenStreamRef.current,
        hasScreenAudio: !!screenStreamRef.current?.getAudioTracks().length } });
    joinRoomRef.current = joinRoom;
    socket.on('connect', joinRoom);
    socket.on('disconnect', () => {
      if (!current()) return;
      setConnectionStatus('reconnecting');
      mesh.setOnline(false);
    });
    socket.on('connect_error', () => { if (current()) setConnectionStatus('reconnecting'); });
    socket.on('room-users', ({ roomUsers, hostSocketId: hostId }: { roomUsers: Participant[]; hostSocketId: string | null }) => {
      if (!current()) return;
      const me = roomUsers.find(p => p.peerId === peerId);
      if (!me) return;
      setHostSocketId(hostId);
      setConnectionStatus('connected');
      setIsPasswordPromptOpen(false);
      setPasswordError(null);
      if (screenStreamRef.current && !me.isScreenSharing) stopScreenSharing();
      const others = roomUsers.filter(p => p.peerId !== peerId);
      for (const id of remoteMedia.keys()) if (!others.some(p => p.peerId === id)) remoteMedia.delete(id);
      setParticipants(previous => {
        const local = previous.find(p => p.socketId === 'local');
        return [ ...(local ? [{ ...local, isHost: me.isHost }] : []), ...others.map(p => ({ ...p, ...remoteMedia.get(p.peerId) })) ];
      });
      mesh.sync(others);
      mesh.setOnline(true);
    });
    socket.on('rtc-signal', ({ peerId: id, signal }: { peerId: string; signal: RtcSignal }) => { void mesh.handleSignal(id, signal); });
    socket.on('receive-message', (message: ChatMessage) => {
      if (current()) setChatMessages(previous => [...previous, message].slice(-200));
    });
    socket.on('room-history', (history: ChatMessage[]) => { if (current()) setChatMessages(history); });
    socket.on('password-required', () => {
      if (!current()) return;
      if (passwordRef.current) setPasswordError('Şifre yanlış. Lütfen tekrar deneyin.');
      setIsPasswordPromptOpen(true);
    });
    socket.on('room-locked-status', ({ isLocked }: { isLocked: boolean }) => { if (current()) setIsRoomLocked(isLocked); });
    socket.on('mute-user-request', ({ trackKind }: { trackKind: 'audio' | 'video' }) => {
      if (!current()) return;
      if (trackKind === 'audio') muteLocalAudio(); else muteLocalVideo();
      showWarning(`Oda kurucusu ${trackKind === 'audio' ? 'mikrofonunuzu' : 'kameranızı'} kapattı.`);
    });
    for (const event of ['kicked', 'error-msg']) socket.on(event, (reason: string) => { if (current()) onLeaveRef.current(reason); });
    socket.on('session-replaced', () => { if (current()) onLeaveRef.current('Bu oda başka bir sekmede açıldı.'); });
    socket.on('warning-msg', (message: string) => { if (current()) showWarning(message); });
    const resume = () => {
      if (document.hidden || !current()) return;
      if (!socket.connected) socket.connect(); else mesh.resume();
      unlockAudioPlayback();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    socket.connect();
    primeAudioUnlock();
    startWakeLock();
    return () => {
      invalidateSession();
      operations.audio++;
      operations.video++;
      operations.screen++;
      stopStream(localStream);
      releaseScreenCapture();
      localStreamRef.current = null;
      joinRoomRef.current = null;
      meshRef.current = null;
      filesRef.current = null;
      socketRef.current = null;
      mesh.dispose();
      files.dispose();
      localFiles.clear();
      socket.disconnect();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      resetAudioUnlock();
      stopWakeLock();
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
      pipWindowRef.current?.close();
    };
  }, [roomId, username]);

  useEffect(() => {
    let cancelled = false;
    const detect = async () => {
      try {
        const devices = await navigator.mediaDevices?.enumerateDevices();
        if (!cancelled) setHasMultipleCameras((devices?.filter(d => d.kind === 'videoinput').length || 0) > 1);
      } catch { /* enumeration may require permission */ }
    };
    void detect();
    navigator.mediaDevices?.addEventListener('devicechange', detect);
    return () => { cancelled = true; navigator.mediaDevices?.removeEventListener('devicechange', detect); };
  }, [isVideoMuted]);

  useEffect(() => {
    const resize = () => {
      setIsMobile(window.innerWidth <= 640);
      setIsShortLandscape(window.innerWidth > window.innerHeight && window.innerHeight <= 550);
    };
    resize();
    window.addEventListener('resize', resize);
    const audio = (event: Event) => setAudioBlocked((event as CustomEvent<boolean>).detail);
    window.addEventListener('windwatch:audio-blocked', audio);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('windwatch:audio-blocked', audio);
    };
  }, []);

  const toggleAudio = async () => {
    if (!isAudioMutedRef.current) { muteLocalAudio(); return; }
    if (busyRef.current.audio || !localStreamRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) { showWarning('Mikrofon için HTTPS bağlantısı ve desteklenen bir tarayıcı gerekiyor.'); return; }
    const session = sessionRef.current;
    const operation = ++operationsRef.current.audio;
    busyRef.current.audio = true;
    setAudioBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (session !== sessionRef.current || operation !== operationsRef.current.audio || !localStreamRef.current) { stopStream(stream); return; }
      const track = stream.getAudioTracks()[0];
      if (!track) { stopStream(stream); throw new Error('No microphone track'); }
      localStreamRef.current.addTrack(track);
      track.onended = muteLocalAudio;
      isAudioMutedRef.current = false;
      setIsAudioMuted(false);
      updateLocalParticipant();
      await syncMedia();
      socketRef.current?.emit('media-state', { isAudioMuted: false });
    } catch (error) {
      if (session === sessionRef.current) showWarning(mediaError(error, 'Mikrofon'));
    } finally {
      busyRef.current.audio = false;
      if (session === sessionRef.current) setAudioBusy(false);
    }
  };

  const openCamera = async (switching = false) => {
    if (busyRef.current.video || !localStreamRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) { showWarning('Kamera için HTTPS bağlantısı ve desteklenen bir tarayıcı gerekiyor.'); return; }
    const session = sessionRef.current;
    const operation = ++operationsRef.current.video;
    const previous = facingModeRef.current;
    const target: FacingMode = switching ? (previous === 'user' ? 'environment' : 'user') : previous;
    const local = localStreamRef.current;
    const previousDeviceId = local.getVideoTracks()[0]?.getSettings().deviceId;
    busyRef.current.video = true;
    setVideoBusy(true);
    if (switching) {
      local.getVideoTracks().forEach(track => { track.onended = null; track.stop(); local.removeTrack(track); });
    }
    const attach = async (mode: FacingMode, strict: boolean) => {
      const constraints = buildCameraConstraints(mode, strict);
      if (switching && !isMobileDevice()) {
        const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
        const currentIndex = cameras.findIndex(device => device.deviceId === previousDeviceId);
        const deviceId = strict ? cameras[(currentIndex + 1) % cameras.length]?.deviceId : previousDeviceId;
        if (deviceId) (constraints.video as MediaTrackConstraints).deviceId = { exact: deviceId };
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (session !== sessionRef.current || operation !== operationsRef.current.video) { stopStream(stream); return; }
      const track = stream.getVideoTracks()[0];
      if (!track) { stopStream(stream); throw new Error('No camera track'); }
      local.addTrack(track);
      track.onended = muteLocalVideo;
      facingModeRef.current = (track.getSettings().facingMode as FacingMode) || mode;
      setFacingMode(facingModeRef.current);
      isVideoMutedRef.current = false;
      setIsVideoMuted(false);
      updateLocalParticipant();
      await syncMedia();
      socketRef.current?.emit('media-state', { isVideoMuted: false });
    };
    try { await attach(target, switching); }
    catch (error) {
      if (session !== sessionRef.current || operation !== operationsRef.current.video) return;
      if (switching) {
        try { await attach(previous, false); } catch { muteLocalVideo(); }
        showWarning('Kamera değiştirilemedi.');
      } else showWarning(mediaError(error, 'Kamera'));
    } finally {
      busyRef.current.video = false;
      if (session === sessionRef.current) setVideoBusy(false);
    }
  };
  const toggleVideo = () => { if (!isVideoMutedRef.current) muteLocalVideo(); else void openCamera(); };
  const switchCamera = () => { void openCamera(true); };

  const toggleScreenShare = async () => {
    if (screenStreamRef.current) { stopScreenSharing(); return; }
    if (busyRef.current.screen || !localStreamRef.current) return;
    if (!socketRef.current?.connected || connectionStatus !== 'connected') { showWarning('Ekran paylaşmak için oda bağlantısının kurulmasını bekleyin.'); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { showWarning('Bu tarayıcı ekran paylaşımını desteklemiyor. Masaüstünde güncel Chrome veya Edge kullanın.'); return; }
    const session = sessionRef.current;
    const operation = ++operationsRef.current.screen;
    const socket = socketRef.current;
    busyRef.current.screen = true;
    setScreenBusy(true);
    let stream: MediaStream | null = null;
    let reserved = false;
    try {
      // Keep the picker directly inside the click gesture. A retry after awaiting
      // a failed request loses transient activation and cannot open another picker.
      const preset = resolveScreenSharePreset(screenQualityRef.current, screenCustomSettingsRef.current);
      stream = await navigator.mediaDevices.getDisplayMedia(buildDisplayMediaConstraints(preset));
      if (session !== sessionRef.current || operation !== operationsRef.current.screen) { stopStream(stream); return; }
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') { stopStream(stream); return; }
      track.onended = () => {
        if (screenStreamRef.current === stream) stopScreenSharing();
        else { ++operationsRef.current.screen; stopStream(stream); }
      };
      const blocked = await protectDisplayAudio(stream);
      const ack = await new Promise<{ ok: boolean; sharerName?: string }>((resolve, reject) => {
        socket.timeout(5000).emit('toggle-screen-share', { isSharing: true, hasAudio: !!stream?.getAudioTracks().length }, (error: Error | null, response: { ok: boolean; sharerName?: string }) => {
          if (error) reject(new Error('Paylaşım onayı alınamadı. Bağlantınızı kontrol edip tekrar deneyin.'));
          else resolve(response || { ok: false });
        });
      });
      reserved = ack.ok;
      if (session !== sessionRef.current || operation !== operationsRef.current.screen || track.readyState !== 'live') {
        stopStream(stream);
        if (reserved && socket.connected) socket.emit('toggle-screen-share', { isSharing: false });
        return;
      }
      if (!ack.ok) { stopStream(stream); showWarning(ack.sharerName ? `${ack.sharerName} ekranını paylaşıyor.` : 'Ekran paylaşımı başlatılamadı.'); return; }
      screenStreamRef.current = stream;
      track.contentHint = preset.contentHint;
      const audio = stream.getAudioTracks()[0];
      if (audio) audio.onended = () => {
        if (screenStreamRef.current !== stream) return;
        stream?.removeTrack(audio);
        updateLocalParticipant();
        void syncMedia();
        socketRef.current?.emit('media-state', { hasScreenAudio: false });
      };
      setIsScreenSharing(true);
      updateLocalParticipant();
      await syncMedia();
      if (blocked) showWarning(SYSTEM_AUDIO_BLOCKED_HINT);
      else if (!audio) showWarning('Görüntü paylaşılıyor. Ses için paylaşım penceresinde “Sesi paylaş” seçeneğini işaretleyin; ses desteği tarayıcıya ve seçilen kaynağa bağlıdır.');
    } catch (error) {
      stopStream(stream);
      if (session !== sessionRef.current) return;
      // A lost acknowledgement may still have reserved the server's slot.
      if (socket.connected) socket.emit('toggle-screen-share', { isSharing: false });
      const name = (error as { name?: string })?.name;
      if (name !== 'NotAllowedError' && name !== 'AbortError') showWarning((error as Error)?.message || 'Ekran paylaşımı başlatılamadı.');
    } finally {
      busyRef.current.screen = false;
      if (session === sessionRef.current) setScreenBusy(false);
    }
  };

  const qualityQueueRef = useRef(Promise.resolve());
  const changeScreenQuality = (quality: ScreenShareQuality) => {
    screenQualityRef.current = quality;
    setScreenQuality(quality);
    try { localStorage.setItem('windwatch:screenQuality', quality); } catch { /* storage unavailable */ }
    qualityQueueRef.current = qualityQueueRef.current.then(async () => {
      const stream = screenStreamRef.current;
      const track = stream?.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') return;
      const preset = resolveScreenSharePreset(screenQualityRef.current, screenCustomSettingsRef.current);
      track.contentHint = preset.contentHint;
      try {
        await track.applyConstraints({ width: { max: preset.maxWidth }, height: { max: preset.maxHeight }, frameRate: { ideal: preset.frameRate, max: preset.frameRate } });
      } catch { /* Encoder settings remain effective if capture resizing is unavailable. */ }
      if (screenStreamRef.current === stream) await syncMedia();
    }).catch(error => console.warn('Paylaşım kalitesi güncellenemedi:', error));
  };

  const applyCustomScreenSettings = (partial: Partial<CustomScreenShareSettings>) => {
    const settings = normalizeCustomSettings({ ...screenCustomSettingsRef.current, ...partial });
    screenCustomSettingsRef.current = settings;
    setScreenCustomSettings(settings);
    try { localStorage.setItem('windwatch:screenCustom', JSON.stringify(settings)); } catch { /* storage unavailable */ }
    if (screenQualityRef.current === 'custom') changeScreenQuality('custom');
  };

  const mediaHandlersRef = useRef({ toggleAudio, toggleVideo });
  mediaHandlersRef.current = { toggleAudio, toggleVideo };
  useEffect(() => startCallMediaSession({
    onToggleMicrophone: () => { void mediaHandlersRef.current.toggleAudio(); },
    onToggleCamera: () => mediaHandlersRef.current.toggleVideo(),
    onHangUp: () => { socketRef.current?.emit('leave-room'); onLeaveRef.current(); }
  }), []);
  useEffect(() => updateCallMediaSession({ roomTitle: 'WindWatch görüşmesi', participantCount: participants.length,
    isMicrophoneActive: !isAudioMuted, isCameraActive: !isVideoMuted }), [participants.length, isAudioMuted, isVideoMuted]);

  const copyRoomLink = async () => {
    const url = `${window.location.origin}/room/${encodeURIComponent(roomId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setShowCopiedToast(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setShowCopiedToast(false), 2500);
    } catch { showWarning(`Davet bağlantısı: ${url}`); }
  };

  const toggleChatPiP = async () => {
    if (pipWindow) { pipWindow.close(); return; }
    const api = (window as Window & { documentPictureInPicture?: { requestWindow: (options: { width: number; height: number }) => Promise<Window> } }).documentPictureInPicture;
    if (!api) { showWarning('Ayrı sohbet penceresi için güncel Chrome veya Edge kullanın.'); return; }
    const session = sessionRef.current;
    try {
      const pip = await api.requestWindow({ width: 380, height: 550 });
      if (session !== sessionRef.current) { pip.close(); return; }
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const style = pip.document.createElement('style');
          style.textContent = Array.from(sheet.cssRules).map(rule => rule.cssText).join('\n');
          pip.document.head.appendChild(style);
        } catch {
          if (sheet.href) { const link = pip.document.createElement('link'); link.rel = 'stylesheet'; link.href = sheet.href; pip.document.head.appendChild(link); }
        }
      }
      pip.document.body.className = 'pip-body';
      pip.document.body.style.cssText = 'background:#080808;margin:0;overflow:hidden';
      pip.addEventListener('pagehide', () => { pipWindowRef.current = null; if (session === sessionRef.current) setPipWindow(null); }, { once: true });
      pipWindowRef.current = pip;
      setPipWindow(pip);
    } catch { showWarning('Sohbet penceresi açılamadı.'); }
  };

  const handleSendMessage = useCallback((text: string) => {
    if (!socketRef.current?.connected) { showWarning('Bağlantı kurulunca mesajı tekrar gönderin.'); return false; }
    if (!text.trim()) return false;
    socketRef.current.emit('send-message', { roomId, text });
    return true;
  }, [roomId]);

  const handleShareFile = (file: File) => {
    if (!socketRef.current?.connected) { showWarning('Dosya paylaşmak için bağlantının kurulmasını bekleyin.'); return; }
    if (file.size > MAX_SHARE_FILE_SIZE) { showWarning('En fazla 100 MB dosya paylaşılabilir.'); return; }
    const total = Array.from(localFilesRef.current.values()).reduce((sum, item) => sum + item.size, 0);
    if (total + file.size > 250 * 1024 * 1024) { showWarning('Bu oturumda en fazla 250 MB dosya paylaşılabilir.'); return; }
    const id = randomId();
    localFilesRef.current.set(id, file);
    const meta: SharedFileMeta = { id, name: file.name, size: file.size, type: file.type, peerId: participants.find(p => p.socketId === 'local')?.peerId };
    handleSendMessage(`${FILE_MESSAGE_PREFIX}${JSON.stringify(meta)}`);
  };

  const handleDownloadFile = async (senderSocketId: string, meta: SharedFileMeta) => {
    const sender = participants.find(p => p.peerId === meta.peerId) || participants.find(p => p.socketId === senderSocketId);
    if (!sender || !filesRef.current) throw new Error('Dosyayı paylaşan kullanıcı odada değil.');
    const blob = await filesRef.current.download(sender.peerId, meta);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = meta.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const toggleLockRoom = () => socketRef.current?.emit('toggle-lock-room');
  const closeChat = useCallback(() => setIsChatOpen(false), []);
  const toggleChat = useCallback(() => setIsChatOpen(value => !value), []);
  const handleKickUser = useCallback((targetSocketId: string) => socketRef.current?.emit('kick-user', { targetSocketId }), []);
  const handleRemoteMute = useCallback((targetSocketId: string, trackKind: 'audio' | 'video') => socketRef.current?.emit('mute-user-request', { targetSocketId, trackKind }), []);
  const handlePasswordSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!passwordInput) return;
    passwordRef.current = passwordInput;
    setPasswordError(null);
    joinRoomRef.current?.();
  };
  const leaveRoom = useCallback(() => { socketRef.current?.emit('leave-room'); onLeaveRef.current(); }, []);

  const hasActiveScreenShare = participants.some(p => p.isScreenSharing);
  const showMobileScreenShareChat = isMobile && hasActiveScreenShare && isChatOpen && !pipWindow;
  const isImmersiveStage = isShortLandscape && hasActiveScreenShare && !pipWindow;
  useEffect(() => {
    if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
    setIsChromeHidden(false);
    if (isImmersiveStage) chromeTimerRef.current = setTimeout(() => setIsChromeHidden(true), 3000);
    return () => { if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current); };
  }, [isImmersiveStage]);
  const handleStageTap = (event: React.MouseEvent) => {
    if (!isImmersiveStage || (event.target as HTMLElement).closest('button, input, .chat-panel')) return;
    if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
    setIsChromeHidden(previous => {
      if (previous) chromeTimerRef.current = setTimeout(() => setIsChromeHidden(true), 3500);
      return !previous;
    });
  };
  const remoteSharer = participants.find(p => p.isScreenSharing && p.socketId !== 'local');
  const localIsHost = participants.find(p => p.socketId === 'local')?.isHost;
  const localPeerId = participants.find(p => p.socketId === 'local')?.peerId || '';

  return (
    <div className={`room-container${isImmersiveStage ? ' immersive-stage' : ''}${isImmersiveStage && isChromeHidden ? ' chrome-hidden' : ''}`}>
      {/* Toast notifications — stacked so they never overlap or leave a gap */}
      <div className="toast-stack" aria-live="polite">
        {showCopiedToast && (
          <div className="toast-notification">Davet linki panoya kopyalandı!</div>
        )}
        {warningToast && (
          <div className="toast-notification warning">{warningToast}</div>
        )}
      </div>

      {/* Password Prompt Overlay */}
      {isPasswordPromptOpen && (
        <div className="password-prompt-overlay">
          <div className="password-prompt-card">
            <KeyRound size={32} className="password-icon" />
            <h3>Şifreli Oda</h3>
            <p>Bu odaya girmek için kurucusu tarafından belirlenen şifreyi yazın.</p>
            {passwordError && <div className="error-alert">{passwordError}</div>}
            <form onSubmit={handlePasswordSubmit}>
              <input
                type="password"
                className="form-input"
                placeholder="Oda Şifresi"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                autoFocus
                required
              />
              <div className="password-prompt-buttons">
                <button type="button" className="btn btn-secondary" onClick={leaveRoom}>Geri Dön</button>
                <button type="submit" className="btn btn-primary">Giriş Yap</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="main-screen">
        {/* Header */}
        <header className="room-header">
          <div className="room-title" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span className={`live-badge ${connectionStatus !== 'connected' ? 'connection-pending' : ''}`} role="status">
              {connectionStatus === 'connected' ? 'Bağlı' : connectionStatus === 'connecting' ? 'Bağlanıyor…' : 'Yeniden bağlanıyor…'}
            </span>
            {isRoomLocked && (
              <span className="lock-badge" title="Oda kilitli, yeni katılımcı giremez">
                <Lock size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} /> Kilitli
              </span>
            )}
            {localIsHost && (
              <button
                onClick={toggleLockRoom}
                className={`lock-room-btn ${isRoomLocked ? 'locked' : ''}`}
                title={isRoomLocked ? 'Odayı Girişlere Aç' : 'Odayı Girişlere Kilitle'}
              >
                {isRoomLocked ? <Unlock size={14} /> : <Lock size={14} />}
                <span>{isRoomLocked ? 'Kilidi Aç' : 'Odayı Kilitle'}</span>
              </button>
            )}
            <button type="button" className="room-id-tag" onClick={() => { void copyRoomLink(); }} title="Davet bağlantısını kopyala">
              <span className="room-id-label">Oda ID: </span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{roomId}</span> <Copy size={14} style={{ marginLeft: '4px', verticalAlign: 'middle' }} />
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-text-secondary)', fontSize: '0.9rem' }}>
            <Users size={16} />
            <span>{participants.length} <span className="participant-label">Katılımcı</span></span>
          </div>
        </header>

        {/* Video stream feeds workspace */}
        <div
          className={`video-workspace ${showMobileScreenShareChat ? 'mobile-ss-chat-active' : ''}`}
          onClick={handleStageTap}
        >
          <VideoGrid
            participants={participants}
            hostSocketId={hostSocketId}
            mySocketId={socketRef.current?.id || ''}
            onKickUser={handleKickUser}
            onRemoteMute={handleRemoteMute}
            hideThumbnails={showMobileScreenShareChat}
          />
          {showMobileScreenShareChat && (
            <div className="mobile-chat-container">
              <Chat
                messages={chatMessages}
                onSendMessage={handleSendMessage}
                onShareFile={handleShareFile}
                onDownloadFile={handleDownloadFile}
                myId={localPeerId}
                onClose={closeChat}
                isPiP={false}
              />
            </div>
          )}
        </div>

        {audioBlocked && <button type="button" className="audio-unlock-banner" onClick={unlockAudioPlayback}>
          <Volume2 size={18} /> Katılımcıların sesini duymak için tıklayın
        </button>}

        {/* Controls menu */}
        <Controls
          isAudioMuted={isAudioMuted}
          isVideoMuted={isVideoMuted}
          isScreenSharing={isScreenSharing}
          isChatOpen={isChatOpen}
          toggleAudio={toggleAudio}
          toggleVideo={toggleVideo}
          toggleScreenShare={toggleScreenShare}
          toggleChat={toggleChat}
          onLeave={leaveRoom}
          screenQuality={screenQuality}
          onChangeScreenQuality={changeScreenQuality}
          screenShareBlockedBy={remoteSharer?.username}
          screenCustomSettings={screenCustomSettings}
          onChangeCustomScreenSettings={applyCustomScreenSettings}
          canSwitchCamera={hasMultipleCameras && !isVideoMuted}
          isSwitchingCamera={videoBusy}
          facingMode={facingMode}
          onSwitchCamera={switchCamera}
          audioBusy={audioBusy}
          videoBusy={videoBusy}
          screenBusy={screenBusy}
          isConnected={connectionStatus === 'connected'}
        />
      </div>

      {/* Slide-out Chat Pane or popped out Document PiP */}
      {isChatOpen && !showMobileScreenShareChat && (
        pipWindow ? (
          createPortal(
            <Chat
              messages={chatMessages}
              onSendMessage={handleSendMessage}
              onShareFile={handleShareFile}
              onDownloadFile={handleDownloadFile}
              myId={localPeerId}
              onClose={() => { pipWindow.close(); setPipWindow(null); }}
              isPiP={true}
            />,
            pipWindow.document.body
          )
        ) : (
          <>
            <div className="chat-backdrop" onClick={closeChat} />
            <Chat
              messages={chatMessages}
              onSendMessage={handleSendMessage}
              onShareFile={handleShareFile}
              onDownloadFile={handleDownloadFile}
              myId={localPeerId}
              onClose={closeChat}
              onDetach={toggleChatPiP}
              isPiP={false}
              // Bottom sheet on a phone held upright. In the short-landscape
              // immersive layout the side overlay is the better fit — there is
              // barely any vertical room for a sheet to travel.
              isBottomSheet={isMobile && !isShortLandscape}
            />
          </>
        )
      )}
    </div>
  );
};

export default Room;
