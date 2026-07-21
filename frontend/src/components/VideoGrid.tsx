import React, { useState, useEffect, useRef } from 'react';
import {
  MicOff, VideoOff, Shield, Maximize, Minimize,
  Pin, Trash2, VolumeX, Volume1, Volume2, Tv, Activity
} from 'lucide-react';
import type { Participant } from './Room';
import { getSharedAudioContext } from '../utils/audio';
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

// Sub-component to manage individual participant streams and hooks
interface ParticipantCardProps {
  p: Participant;
  isMe: boolean;
  isHost: boolean;
  stats?: { rtt: number; packetLoss: number };
  localIsHost: boolean;
  isFullscreen: boolean;
  isPinned: boolean;
  onToggleFullscreen: () => void;
  onTogglePin: () => void;
  onKick: () => void;
  onRemoteMute: (trackKind: 'audio' | 'video') => void;
  screenShareStats?: ScreenShareStats | null;
}

const ParticipantCard: React.FC<ParticipantCardProps> = ({
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
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);

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

  // Bind WebRTC stream to video element and make sure playback actually starts.
  // Browsers can reject unmuted autoplay; when that happens the element stays
  // paused and the participant is silent — retry on the next user gesture.
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || !p.stream) return;

    if (videoEl.srcObject !== p.stream) {
      videoEl.srcObject = p.stream;
    }

    let retryListener: (() => void) | null = null;
    videoEl.play().catch(() => {
      retryListener = () => {
        videoEl.play().catch(() => {});
      };
      document.addEventListener('click', retryListener, { once: true });
    });

    return () => {
      if (retryListener) document.removeEventListener('click', retryListener);
    };
  }, [p.stream, showVideo]);

  // Apply the viewer-selected volume to the media element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
  }, [volume, p.stream]);

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
    let animFrameId: number;

    try {
      // Use the app-wide shared AudioContext — browsers cap concurrent contexts,
      // and one per participant would exhaust the limit in crowded rooms.
      const audioCtx = getSharedAudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;

      // Extract only the audio track from the media stream to analyze
      source = audioCtx.createMediaStreamSource(new MediaStream([audioTracks[0]]));
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
      // The shared AudioContext is intentionally left open for other consumers
    };
  }, [p.stream, p.isAudioMuted]);

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
      onDoubleClick={onTogglePin}
    >
      {/* Top Left Menu Actions */}
      <div className="card-top-left-actions">
        <button 
          onClick={(e) => { e.stopPropagation(); onToggleFullscreen(); }}
          className="fullscreen-btn"
          title={isFullscreen ? 'Tam Ekrandan Çık' : 'Tam Ekran Yap'}
        >
          {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
        </button>
        <button 
          onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
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

      {/* Network connection strength indicators */}
      {stats && !isMe && (
        <div className="connection-stats-badge" title={`RTT: ${stats.rtt}ms, Paket Kaybı: ${stats.packetLoss}%`}>
          <Activity size={12} className="stats-icon" />
          <span>{stats.rtt}ms</span>
        </div>
      )}

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

      {/* Audio/Video Mute status badges */}
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

      {/* Media element (always mounted while a stream exists — it carries the audio)
          plus the Avatar placeholder when video is off */}
      {p.stream && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isMe} // Mute self to prevent hearing echo
          style={showVideo ? undefined : { display: 'none' }}
        />
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
            onClick={(e) => { e.stopPropagation(); onRemoteMute('audio'); }}
            title="Kullanıcının Sesini Kapat"
          >
            <VolumeX size={14} />
          </button>
          <button 
            className="mod-action-btn camera-off"
            onClick={(e) => { e.stopPropagation(); onRemoteMute('video'); }}
            title="Kullanıcının Kamerasını Kapat"
          >
            <VideoOff size={14} />
          </button>
          <button 
            className="mod-action-btn kick danger"
            onClick={(e) => { e.stopPropagation(); onKick(); }}
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

const VideoGrid: React.FC<VideoGridProps> = ({ 
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

  const handleToggleFullscreen = (socketId: string) => {
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
  };

  const handleTogglePin = (socketId: string) => {
    setPinnedSocketId(prev => (prev === socketId ? null : socketId));
  };

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
            onToggleFullscreen={() => handleToggleFullscreen(focusedUser.socketId)}
            onTogglePin={() => handleTogglePin(focusedUser.socketId)}
            onKick={() => onKickUser?.(focusedUser.socketId)}
            onRemoteMute={(trackKind) => onRemoteMute?.(focusedUser.socketId, trackKind)}
            screenShareStats={screenShareStats}
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
                onToggleFullscreen={() => handleToggleFullscreen(p.socketId)}
                onTogglePin={() => handleTogglePin(p.socketId)}
                onKick={() => onKickUser?.(p.socketId)}
                onRemoteMute={(trackKind) => onRemoteMute?.(p.socketId, trackKind)}
                screenShareStats={screenShareStats}
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
          onToggleFullscreen={() => handleToggleFullscreen(p.socketId)}
          onTogglePin={() => handleTogglePin(p.socketId)}
          onKick={() => onKickUser?.(p.socketId)}
          onRemoteMute={(trackKind) => onRemoteMute?.(p.socketId, trackKind)}
          screenShareStats={screenShareStats}
        />
      ))}
    </div>
  );
};

export default VideoGrid;
