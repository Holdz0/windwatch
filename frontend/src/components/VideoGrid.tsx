import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  MicOff, VideoOff, Shield, Maximize, Minimize,
  Pin, Trash2, VolumeX, Volume1, Volume2, Tv, Activity
} from 'lucide-react';
import type { Participant } from './Room';
import {
  getSharedAudioContext,
  registerRemoteMediaElement,
  playRemoteMediaElement
} from '../utils/audio';
import { formatBitrate } from '../utils/screenShare';
import type { ScreenShareStats } from '../utils/screenShare';

interface VideoGridProps {
  participants: Participant[];
  hostSocketId: string | null;
  mySocketId: string;
  connectionStats: Record<string, { rtt: number; packetLoss: number }>;
  onKickUser?: (socketId: string) => void;
  onRemoteMute?: (socketId: string, trackKind: 'audio' | 'video') => void;
  hideThumbnails?: boolean;
  /** Live outbound telemetry for our own screen share */
  screenShareStats?: ScreenShareStats | null;
}

const LIMITATION_LABELS: Record<string, string> = {
  bandwidth: 'Bant genişliği sınırlı',
  cpu: 'İşlemci sınırlı',
  other: 'Sınırlı'
};

// Sub-component to manage individual participant streams and hooks.
//
// The callbacks take the socketId rather than closing over it, so VideoGrid can
// pass the same stable function identity to every card. With per-card arrow
// functions the memo below would never hit — and the stats timer re-renders
// this tree every 4 seconds, which on mobile is a real battery cost.
interface ParticipantCardProps {
  p: Participant;
  isMe: boolean;
  isHost: boolean;
  stats?: { rtt: number; packetLoss: number };
  localIsHost: boolean;
  isFullscreen: boolean;
  isPinned: boolean;
  onToggleFullscreen: (socketId: string) => void;
  onTogglePin: (socketId: string) => void;
  onKick: (socketId: string) => void;
  onRemoteMute: (socketId: string, trackKind: 'audio' | 'video') => void;
  screenShareStats?: ScreenShareStats | null;
}

const ParticipantCardComponent: React.FC<ParticipantCardProps> = ({
  p,
  isMe,
  isHost,
  stats,
  localIsHost,
  isFullscreen,
  isPinned,
  onToggleFullscreen,
  onTogglePin,
  onKick,
  onRemoteMute,
  screenShareStats
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Dedicated, always-hidden audio element. Remote audio is played ONLY through
  // this element — never through the video element, whose lifecycle is tangled
  // with display logic (avatar mode, PiP, fullscreen). This mirrors what major
  // conferencing apps do and removes a whole class of "video visible but silent"
  // failure modes.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);

  // WebRTC mutates the remote MediaStream object in place as tracks arrive or
  // vanish; React cannot see that. This revision counter bumps on addtrack /
  // removetrack so the binding effects re-run with the current track set —
  // Chromium does not reliably render tracks added to an element that is
  // already playing (long-standing bug), so re-binding is required.
  const [streamRevision, setStreamRevision] = useState(0);
  useEffect(() => {
    const stream = p.stream;
    if (!stream) return;
    const bump = () => setStreamRevision(v => v + 1);
    stream.addEventListener('addtrack', bump);
    stream.addEventListener('removetrack', bump);
    return () => {
      stream.removeEventListener('addtrack', bump);
      stream.removeEventListener('removetrack', bump);
    };
  }, [p.stream]);

  // Playback volume for this participant's stream (0..1), adjustable by the viewer.
  // The last non-zero value is kept so the speaker toggle can restore it.
  const [volume, setVolume] = useState(1);
  const lastVolumeRef = useRef(1);

  // isVideoMuted is synced over the server for remote users; a remote track's
  // `enabled` flag is always true locally, so it can't be used to detect mute
  // (it previously rendered a black rectangle instead of the avatar).
  const hasVideo = !!p.stream && p.stream.getVideoTracks().length > 0 && !p.isVideoMuted;
  const isScreen = p.isScreenSharing;
  // The media element must stay mounted even in avatar mode — remote audio only
  // plays through this element, so unmounting it would silence the participant.
  const showVideo = hasVideo || isScreen;

  // Render initials if camera is disabled
  const getInitials = (name: string) => {
    return name
      .trim()
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  // Bind the stream to the VIDEO element. The video element is permanently
  // muted — audio never depends on it — so its autoplay is always allowed.
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || !p.stream) return;

    if (videoEl.srcObject !== p.stream) {
      videoEl.srcObject = p.stream;
    } else if (streamRevision > 0) {
      // Same stream object but its track set changed: force a re-bind so
      // Chromium actually renders the newly added track.
      videoEl.srcObject = null;
      videoEl.srcObject = p.stream;
    }
    videoEl.play().catch(() => {});
  }, [p.stream, streamRevision, showVideo]);

  // Bind remote audio to the dedicated AUDIO element, with every recovery path:
  //  - rebuilt whenever the stream's track set changes (late-arriving tracks)
  //  - play() retried on track 'unmute' (fires when the first RTP data arrives)
  //  - play() retried if the element pauses for any external reason
  //  - registered with the gesture unlock (autoplay policy)
  //  - a watchdog nudges play() while a live track sits on a paused element
  useEffect(() => {
    const audioEl = audioRef.current;
    if (isMe || !audioEl || !p.stream) return;

    const audioTracks = p.stream.getAudioTracks();
    if (audioTracks.length === 0) {
      audioEl.srcObject = null;
      return;
    }

    audioEl.srcObject = new MediaStream(audioTracks);

    const unregister = registerRemoteMediaElement(audioEl);
    playRemoteMediaElement(audioEl);

    const retry = () => playRemoteMediaElement(audioEl);
    audioTracks.forEach(t => t.addEventListener('unmute', retry));
    audioEl.addEventListener('pause', retry);

    const watchdog = window.setInterval(() => {
      if (audioEl.paused && audioTracks.some(t => t.readyState === 'live')) {
        playRemoteMediaElement(audioEl);
      }
    }, 2000);

    return () => {
      window.clearInterval(watchdog);
      audioEl.removeEventListener('pause', retry);
      audioTracks.forEach(t => t.removeEventListener('unmute', retry));
      unregister();
      audioEl.srcObject = null;
    };
  }, [p.stream, streamRevision, isMe]);

  // Apply the viewer-selected volume to the audio element
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume, p.stream, streamRevision]);

  // Check for picture-in-picture API support
  useEffect(() => {
    if (document.pictureInPictureEnabled) {
      setPipSupported(true);
    }
  }, []);

  // Web Audio Analyser for speaking indicator
  useEffect(() => {
    // If muted or stream isn't established, we are not speaking
    if (p.isAudioMuted || !p.stream) {
      setIsSpeaking(false);
      return;
    }

    const audioTracks = p.stream.getAudioTracks();
    if (audioTracks.length === 0) {
      setIsSpeaking(false);
      return;
    }

    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyserTrack: MediaStreamTrack | null = null;
    let animFrameId: number;

    try {
      // Use the app-wide shared AudioContext — browsers cap concurrent contexts,
      // and one per participant would exhaust the limit in crowded rooms.
      const audioCtx = getSharedAudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;

      // Analyse a CLONE of the track: the audio element is the only consumer of
      // the live track, so metering can never interfere with audible playback.
      analyserTrack = audioTracks[0].clone();
      source = audioCtx.createMediaStreamSource(new MediaStream([analyserTrack]));
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      let speakingTicks = 0;

      const analyze = () => {
        if (!analyser) return;
        analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;

        // Threshold of average audio frequency power to trigger speaking state
        if (average > 18) {
          speakingTicks = Math.min(speakingTicks + 1, 8);
        } else {
          speakingTicks = Math.max(speakingTicks - 1, 0);
        }

        setIsSpeaking(speakingTicks > 3);
        animFrameId = requestAnimationFrame(analyze);
      };

      analyze();
    } catch (err) {
      console.warn("Failed to create voice analyser:", err);
    }

    return () => {
      if (animFrameId) cancelAnimationFrame(animFrameId);
      if (source) source.disconnect();
      if (analyser) analyser.disconnect();
      if (analyserTrack) analyserTrack.stop(); // stops the clone, not the live track
      // The shared AudioContext is intentionally left open for other consumers
    };
  }, [p.stream, p.isAudioMuted, streamRevision]);

  // Picture-in-picture triggers
  const handleTogglePiP = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement === videoRef.current) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (err) {
      console.error("PiP error:", err);
    }
  };

  return (
    <div 
      id={`video-card-${p.socketId}`} 
      className={`video-card ${isScreen ? 'screen-share' : ''} ${isSpeaking ? 'speaking-active' : ''} ${isPinned ? 'pinned' : ''}`}
      onDoubleClick={() => onTogglePin(p.socketId)}
    >
      {/* Top Left Menu Actions */}
      <div className="card-top-left-actions">
        <button 
          onClick={(e) => { e.stopPropagation(); onToggleFullscreen(p.socketId); }}
          className="fullscreen-btn"
          title={isFullscreen ? 'Tam Ekrandan Çık' : 'Tam Ekran Yap'}
        >
          {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
        </button>
        <button 
          onClick={(e) => { e.stopPropagation(); onTogglePin(p.socketId); }}
          className={`pin-btn ${isPinned ? 'active' : ''}`}
          title={isPinned ? 'Yayını Sabitlemeden Çıkar' : 'Yayını Ekrana Sabitle'}
        >
          <Pin size={14} />
        </button>
        {pipSupported && (hasVideo || isScreen) && (
          <button 
            onClick={handleTogglePiP}
            className="pip-btn"
            title="Pencere İçinde Oynat (PiP)"
          >
            <Tv size={14} />
          </button>
        )}
      </div>

      {/* Top-right stack: connection quality + mute badges.
          These share one container so they can never overlap each other. */}
      <div className="card-top-right-stack">
        {stats && !isMe && (
          <div className="connection-stats-badge" title={`RTT: ${stats.rtt}ms, Paket Kaybı: ${stats.packetLoss}%`}>
            <Activity size={12} className="stats-icon" />
            <span>{stats.rtt}ms</span>
          </div>
        )}

        <div className="stream-status-indicators">
          {p.isAudioMuted && (
            <div className="status-badge" title="Mikrofon Kapalı">
              <MicOff size={14} />
            </div>
          )}
          {p.isVideoMuted && !isScreen && (
            <div className="status-badge" title="Kamera Kapalı">
              <VideoOff size={14} />
            </div>
          )}
        </div>
      </div>

      {/* Live telemetry for our own screen share — what viewers actually receive */}
      {isMe && isScreen && screenShareStats && (
        <div
          className={`screen-stats-badge ${screenShareStats.limitation !== 'none' ? 'limited' : ''}`}
          title={
            screenShareStats.limitation !== 'none'
              ? `Kodlayıcı kısıtlaması: ${LIMITATION_LABELS[screenShareStats.limitation] || screenShareStats.limitation}`
              : 'Ekran paylaşımı sağlıklı gönderiliyor'
          }
        >
          <Activity size={12} className="stats-icon" />
          <span>
            {screenShareStats.width > 0 ? `${screenShareStats.width}×${screenShareStats.height}` : '—'}
            {' · '}
            {screenShareStats.fps} fps
            {' · '}
            {formatBitrate(screenShareStats.kbps)}
          </span>
          {screenShareStats.limitation !== 'none' && (
            <span className="screen-stats-warning">
              {LIMITATION_LABELS[screenShareStats.limitation] || screenShareStats.limitation}
            </span>
          )}
        </div>
      )}

      {/* Video element (permanently muted — remote audio plays through the
          dedicated audio element below) plus the Avatar placeholder */}
      {p.stream && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={p.isMirrored ? 'is-mirrored' : undefined}
          style={showVideo ? undefined : { display: 'none' }}
        />
      )}
      {!isMe && (
        <audio ref={audioRef} autoPlay style={{ display: 'none' }} />
      )}
      {(!p.stream || !showVideo) && (
        <div className="avatar-placeholder">
          {getInitials(p.username)}
        </div>
      )}

      {/* Viewer-side volume control for remote streams */}
      {!isMe && p.stream && (
        <div className="volume-control" onDoubleClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="volume-toggle-btn"
            onClick={(e) => {
              e.stopPropagation();
              if (volume === 0) {
                setVolume(lastVolumeRef.current || 1);
              } else {
                lastVolumeRef.current = volume;
                setVolume(0);
              }
            }}
            title={volume === 0 ? 'Sesi Aç' : 'Sesi Kapat'}
          >
            {volume === 0 ? <VolumeX size={14} /> : volume < 0.5 ? <Volume1 size={14} /> : <Volume2 size={14} />}
          </button>
          <input
            type="range"
            className="volume-slider"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setVolume(v);
              if (v > 0) lastVolumeRef.current = v;
            }}
            title={`Ses: ${Math.round(volume * 100)}%`}
          />
        </div>
      )}

      {/* Host / Moderator Quick Controls Overlays */}
      {localIsHost && !isMe && (
        <div className="moderator-card-controls">
          <button 
            className="mod-action-btn mute"
            onClick={(e) => { e.stopPropagation(); onRemoteMute(p.socketId, 'audio'); }}
            title="Kullanıcının Sesini Kapat"
          >
            <VolumeX size={14} />
          </button>
          <button 
            className="mod-action-btn camera-off"
            onClick={(e) => { e.stopPropagation(); onRemoteMute(p.socketId, 'video'); }}
            title="Kullanıcının Kamerasını Kapat"
          >
            <VideoOff size={14} />
          </button>
          <button 
            className="mod-action-btn kick danger"
            onClick={(e) => { e.stopPropagation(); onKick(p.socketId); }}
            title="Kullanıcıyı Odadan At"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {/* Name/Status Tag */}
      <div className="user-tag">
        {isHost && (
          <span className="user-tag-host" title="Oda Kurucusu / Host">
            <Shield size={10} style={{ display: 'inline', marginRight: '2px', verticalAlign: 'middle' }} /> Host
          </span>
        )}
        <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
          {p.username} {isScreen ? ' (Ekran Paylaşımı)' : ''}
        </span>
      </div>
    </div>
  );
};

// Memoised with a value-based comparison of the stats objects: the stats timer
// builds a fresh object every 4 seconds, so reference equality alone would
// re-render every card on every tick even when the numbers are identical.
// Everything else is compared by reference, which is correct — participant
// objects and streams are replaced (not mutated) when they genuinely change.
const ParticipantCard = React.memo(ParticipantCardComponent, (prev, next) => {
  if (
    prev.p !== next.p ||
    prev.isMe !== next.isMe ||
    prev.isHost !== next.isHost ||
    prev.localIsHost !== next.localIsHost ||
    prev.isFullscreen !== next.isFullscreen ||
    prev.isPinned !== next.isPinned ||
    prev.onToggleFullscreen !== next.onToggleFullscreen ||
    prev.onTogglePin !== next.onTogglePin ||
    prev.onKick !== next.onKick ||
    prev.onRemoteMute !== next.onRemoteMute
  ) {
    return false;
  }

  const a = prev.stats;
  const b = next.stats;
  if ((a === undefined) !== (b === undefined)) return false;
  if (a && b && (a.rtt !== b.rtt || a.packetLoss !== b.packetLoss)) return false;

  const sa = prev.screenShareStats;
  const sb = next.screenShareStats;
  if ((sa == null) !== (sb == null)) return false;
  if (sa && sb && (
    sa.width !== sb.width ||
    sa.height !== sb.height ||
    sa.fps !== sb.fps ||
    sa.kbps !== sb.kbps ||
    sa.limitation !== sb.limitation
  )) {
    return false;
  }

  return true; // props are equivalent — skip the re-render
});

const VideoGridComponent: React.FC<VideoGridProps> = ({
  participants, 
  hostSocketId, 
  mySocketId, 
  connectionStats,
  onKickUser,
  onRemoteMute,
  hideThumbnails = false,
  screenShareStats
}) => {
  const [fullscreenSocketId, setFullscreenSocketId] = useState<string | null>(null);
  const [pinnedSocketId, setPinnedSocketId] = useState<string | null>(null);

  // Synchronize fullscreen state with browser exit events (e.g. pressing ESC)
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setFullscreenSocketId(null);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // These are handed to every card, so their identity must be stable or the
  // memo on ParticipantCard can never hit.
  const handleToggleFullscreen = useCallback((socketId: string) => {
    const element = document.getElementById(`video-card-${socketId}`);
    if (!element) return;

    if (document.fullscreenElement) {
      document.exitFullscreen().then(() => {
        setFullscreenSocketId(null);
      }).catch(err => console.error('Fullscreen exit error:', err));
    } else {
      element.requestFullscreen().then(() => {
        setFullscreenSocketId(socketId);
      }).catch(err => console.error('Fullscreen request error:', err));
    }
  }, []);

  const handleTogglePin = useCallback((socketId: string) => {
    setPinnedSocketId(prev => (prev === socketId ? null : socketId));
  }, []);

  const handleKick = useCallback((socketId: string) => {
    onKickUser?.(socketId);
  }, [onKickUser]);

  const handleRemoteMute = useCallback((socketId: string, trackKind: 'audio' | 'video') => {
    onRemoteMute?.(socketId, trackKind);
  }, [onRemoteMute]);

  const getGridClass = () => {
    const count = participants.length;
    if (count <= 1) return 'video-grid count-1';
    if (count === 2) return 'video-grid count-2';
    return 'video-grid';
  };

  // Determine if a user is host
  const localIsHost = hostSocketId === mySocketId || participants.find(p => p.socketId === 'local')?.isHost;

  // 1. Prioritize displaying a Pinned User or Screen Sharing User in the focused layout
  const focusedUser = participants.find(p => p.socketId === pinnedSocketId) || participants.find(p => p.isScreenSharing);

  if (focusedUser) {
    const otherUsers = participants.filter(p => p.socketId !== focusedUser.socketId);
    
    return (
      <div className="screen-share-layout">
        <div className="focused-stream-container">
          <ParticipantCard
            p={focusedUser}
            isMe={focusedUser.socketId === 'local'}
            isHost={focusedUser.isHost || (hostSocketId && focusedUser.socketId === hostSocketId) || (focusedUser.socketId === 'local' && hostSocketId === mySocketId)}
            stats={connectionStats[focusedUser.socketId]}
            localIsHost={!!localIsHost}
            isFullscreen={fullscreenSocketId === focusedUser.socketId}
            isPinned={pinnedSocketId === focusedUser.socketId}
            onToggleFullscreen={handleToggleFullscreen}
            onTogglePin={handleTogglePin}
            onKick={handleKick}
            onRemoteMute={handleRemoteMute}
            screenShareStats={focusedUser.socketId === 'local' ? screenShareStats : undefined}
          />
        </div>
        {otherUsers.length > 0 && !hideThumbnails && (
          <div className="thumbnails-strip-container">
            {otherUsers.map(p => (
              <ParticipantCard
                key={p.socketId}
                p={p}
                isMe={p.socketId === 'local'}
                isHost={p.isHost || (hostSocketId && p.socketId === hostSocketId) || (p.socketId === 'local' && hostSocketId === mySocketId)}
                stats={connectionStats[p.socketId]}
                localIsHost={!!localIsHost}
                isFullscreen={fullscreenSocketId === p.socketId}
                isPinned={pinnedSocketId === p.socketId}
                onToggleFullscreen={handleToggleFullscreen}
                onTogglePin={handleTogglePin}
                onKick={handleKick}
                onRemoteMute={handleRemoteMute}
                screenShareStats={p.socketId === 'local' ? screenShareStats : undefined}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Default Grid Layout (No pinned user or active screen share)
  return (
    <div className={getGridClass()}>
      {participants.map(p => (
        <ParticipantCard
          key={p.socketId}
          p={p}
          isMe={p.socketId === 'local'}
          isHost={p.isHost || (hostSocketId && p.socketId === hostSocketId) || (p.socketId === 'local' && hostSocketId === mySocketId)}
          stats={connectionStats[p.socketId]}
          localIsHost={!!localIsHost}
          isFullscreen={fullscreenSocketId === p.socketId}
          isPinned={pinnedSocketId === p.socketId}
          onToggleFullscreen={handleToggleFullscreen}
          onTogglePin={handleTogglePin}
          onKick={handleKick}
          onRemoteMute={handleRemoteMute}
          screenShareStats={p.socketId === 'local' ? screenShareStats : undefined}
        />
      ))}
    </div>
  );
};

const VideoGrid = React.memo(VideoGridComponent);

export default VideoGrid;
