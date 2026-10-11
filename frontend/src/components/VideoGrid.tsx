import { useState, useEffect, useRef } from 'react';
import type { MouseEvent } from 'react';
import { MicOff, VideoOff, Shield, Maximize, Minimize, Pin, Trash2, VolumeX, Volume1, Volume2, Tv, WifiOff } from 'lucide-react';
import type { Participant } from '../types';
import { getSharedAudioContext } from '../utils/audio';
import RemoteAudio from './RemoteAudio';

interface VideoGridProps {
  participants: Participant[];
  hostSocketId: string | null;
  mySocketId: string;
  onKickUser?: (socketId: string) => void;
  onRemoteMute?: (socketId: string, trackKind: 'audio' | 'video') => void;
  hideThumbnails?: boolean;
}

function ParticipantCard({ p, screen, focused, hidden, localIsHost, volume, onVolume, onPin, pinned, onKickUser, onRemoteMute }: {
  screen: boolean;
  p: Participant; focused: boolean; hidden: boolean; localIsHost: boolean; volume: number;
  onVolume: (volume: number) => void; onPin: () => void; pinned: boolean;
  onKickUser?: (socketId: string) => void;
  onRemoteMute?: (socketId: string, kind: 'audio' | 'video') => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [speaking, setSpeaking] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [revision, setRevision] = useState(0);
  const lastVolume = useRef(1);
  const isMe = p.socketId === 'local';
  const isScreen = screen;
  const stream = isScreen ? p.screenStream : p.stream;
  const showVideo = !!stream?.getVideoTracks().length && (isScreen || !p.isVideoMuted);

  useEffect(() => {
    if (!stream) return;
    const changed = () => setRevision(value => value + 1);
    stream.addEventListener('addtrack', changed);
    stream.addEventListener('removetrack', changed);
    return () => { stream.removeEventListener('addtrack', changed); stream.removeEventListener('removetrack', changed); };
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tracks = stream?.getVideoTracks() || [];
    video.srcObject = tracks.length ? new MediaStream(tracks) : null;
    const play = () => { void video.play().catch(() => {}); };
    tracks.forEach(track => track.addEventListener('unmute', play));
    if (tracks.length) play();
    return () => {
      tracks.forEach(track => track.removeEventListener('unmute', play));
      video.pause();
      video.srcObject = null;
    };
  }, [stream, revision]);

  // Meter microphone only. Screen music does not count as someone speaking.
  // Sample at 7 Hz and change React state only when the speaking state changes.
  useEffect(() => {
    const track = p.stream?.getAudioTracks()[0];
    if (!track || p.isAudioMuted || hidden || screen) { setSpeaking(false); return; }
    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    let last = false;
    let quiet = 0;
    try {
      const context = getSharedAudioContext();
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source = context.createMediaStreamSource(new MediaStream([track]));
      source.connect(analyser);
    } catch { return; }
    const samples = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      if (document.hidden) return;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      quiet = rms > 0.02 ? 0 : quiet + 1;
      const active = quiet < 3;
      if (active !== last) { last = active; setSpeaking(active); }
    }, 150);
    return () => { clearInterval(timer); source.disconnect(); analyser.disconnect(); };
  }, [p.stream, p.isAudioMuted, hidden, screen]);

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === cardRef.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  const toggleFullscreen = async (event: MouseEvent) => {
    event.stopPropagation();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (cardRef.current?.requestFullscreen) await cardRef.current.requestFullscreen();
      else if (videoRef.current && 'webkitEnterFullscreen' in videoRef.current)
        (videoRef.current as HTMLVideoElement & { webkitEnterFullscreen: () => void }).webkitEnterFullscreen();
    } catch { /* Fullscreen can be denied by the browser. */ }
  };
  const togglePiP = async (event: MouseEvent) => {
    event.stopPropagation();
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement === videoRef.current) await document.exitPictureInPicture();
      else await videoRef.current.requestPictureInPicture();
    } catch { /* Unsupported surface or no decoded video yet. */ }
  };
  const disconnected = p.isReconnecting || p.connectionState === 'disconnected' || p.connectionState === 'failed';
  const connecting = !isMe && p.connectionState !== 'connected' && !disconnected;
  const initials = p.username.trim().split(/\s+/).map(word => word[0]).join('').toUpperCase().slice(0, 2);

  return <div ref={cardRef} data-peer-id={p.peerId} data-media-role={screen ? 'screen' : 'participant'}
    data-connection-state={screen ? undefined : p.connectionState || (isMe ? 'local' : 'connecting')}
    className={`video-card ${isScreen ? 'screen-share' : ''} ${speaking ? 'speaking-active' : ''} ${focused ? 'focused-card' : ''} ${pinned ? 'pinned' : ''} ${hidden ? 'thumbnail-hidden' : ''}`}
    onDoubleClick={onPin}>
    <div className="card-top-left-actions">
      <button type="button" onClick={toggleFullscreen} className="fullscreen-btn" title={fullscreen ? 'Tam ekrandan çık' : 'Tam ekran'} aria-label={fullscreen ? 'Tam ekrandan çık' : 'Tam ekran'}>
        {fullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
      </button>
      <button type="button" onClick={event => { event.stopPropagation(); onPin(); }} className={`pin-btn ${pinned ? 'active' : ''}`} title="Yayını sabitle" aria-label="Yayını sabitle" aria-pressed={pinned}><Pin size={14} /></button>
      {document.pictureInPictureEnabled && showVideo && <button type="button" onClick={togglePiP} className="pip-btn" title="Pencere içinde oynat" aria-label="Pencere içinde oynat"><Tv size={14} /></button>}
    </div>
    <div className="card-top-right-stack"><div className="stream-status-indicators">
      {disconnected && <div className="status-badge reconnecting-badge" title="Yeniden bağlanıyor"><WifiOff size={14} /></div>}
      {p.isAudioMuted && <div className="status-badge" title="Mikrofon kapalı"><MicOff size={14} /></div>}
      {isScreen && !p.hasScreenAudio && <div className="status-badge" title="Ekran sesi paylaşılmıyor"><VolumeX size={14} /></div>}
      {p.isVideoMuted && !isScreen && <div className="status-badge" title="Kamera kapalı"><VideoOff size={14} /></div>}
    </div></div>
    <video ref={videoRef} autoPlay playsInline muted className={!isScreen && p.isMirrored ? 'is-mirrored' : undefined} style={{ display: showVideo ? undefined : 'none' }} />
    {!showVideo && <div className="avatar-placeholder">{initials}</div>}
    {connecting && <div className="media-connection-label" role="status">Medya bağlantısı kuruluyor…</div>}
    {!isMe && <div className="volume-control" onDoubleClick={event => event.stopPropagation()}>
      <button type="button" className="volume-toggle-btn" title={volume === 0 ? 'Katılımcı sesini aç' : 'Katılımcı sesini kapat'} aria-label={volume === 0 ? 'Katılımcı sesini aç' : 'Katılımcı sesini kapat'} onClick={event => {
        event.stopPropagation();
        if (volume === 0) onVolume(lastVolume.current); else { lastVolume.current = volume; onVolume(0); }
      }}>{volume === 0 ? <VolumeX size={14} /> : volume < 0.5 ? <Volume1 size={14} /> : <Volume2 size={14} />}</button>
      <input type="range" className="volume-slider" min={0} max={1} step={0.05} value={volume} aria-label={`${p.username} ses seviyesi`}
        onClick={event => event.stopPropagation()} onChange={event => { const value = Number(event.target.value); onVolume(value); if (value > 0) lastVolume.current = value; }} />
    </div>}
    {localIsHost && !isMe && <div className="moderator-card-controls">
      <button type="button" className="mod-action-btn mute" onClick={event => { event.stopPropagation(); onRemoteMute?.(p.socketId, 'audio'); }} title="Kullanıcının mikrofonunu kapat" aria-label="Kullanıcının mikrofonunu kapat"><VolumeX size={14} /></button>
      <button type="button" className="mod-action-btn camera-off" onClick={event => { event.stopPropagation(); onRemoteMute?.(p.socketId, 'video'); }} title="Kullanıcının kamerasını kapat" aria-label="Kullanıcının kamerasını kapat"><VideoOff size={14} /></button>
      <button type="button" className="mod-action-btn kick danger" onClick={event => { event.stopPropagation(); onKickUser?.(p.socketId); }} title="Kullanıcıyı odadan çıkar" aria-label="Kullanıcıyı odadan çıkar"><Trash2 size={14} /></button>
    </div>}
    <div className="user-tag">
      {p.isHost && <span className="user-tag-host"><Shield size={10} /> Kurucu</span>}
      <span>{p.username}{isScreen ? ' (Ekran paylaşımı)' : ''}{disconnected ? ' · yeniden bağlanıyor…' : ''}</span>
    </div>
  </div>;
}

export default function VideoGrid({ participants, hostSocketId, mySocketId, onKickUser, onRemoteMute, hideThumbnails = false }: VideoGridProps) {
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const cards = participants.flatMap(p => [
    { id: p.peerId, p, screen: false },
    ...(p.isScreenSharing ? [{ id: `${p.peerId}:screen`, p, screen: true }] : [])
  ]);
  const focused = cards.find(card => card.id === pinnedId) || cards.find(card => card.screen);
  const localIsHost = hostSocketId === mySocketId || !!participants.find(p => p.socketId === 'local')?.isHost;
  useEffect(() => {
    setVolumes(previous => {
      const entries = Object.entries(previous).filter(([id]) => participants.some(p => p.peerId === id));
      return entries.length === Object.keys(previous).length ? previous : Object.fromEntries(entries);
    });
    if (pinnedId && !participants.some(p => p.peerId === pinnedId || (p.isScreenSharing && `${p.peerId}:screen` === pinnedId))) setPinnedId(null);
  }, [participants, pinnedId]);
  return <>
    <RemoteAudio participants={participants} volumes={volumes} />
    <div className={`video-grid ${focused ? 'focused-grid' : participants.length <= 2 ? `count-${participants.length}` : ''} ${hideThumbnails ? 'hide-thumbnails' : ''}`}>
      {cards.map(({ id, p, screen }) => <ParticipantCard key={id} p={p} screen={screen} focused={focused?.id === id}
        hidden={!!focused && hideThumbnails && focused.id !== id} localIsHost={localIsHost}
        volume={volumes[p.peerId] ?? 1} onVolume={value => setVolumes(previous => ({ ...previous, [p.peerId]: value }))}
        onPin={() => setPinnedId(previous => previous === id ? null : id)} pinned={id === pinnedId}
        onKickUser={onKickUser} onRemoteMute={onRemoteMute} />)}
    </div>
  </>;
}
