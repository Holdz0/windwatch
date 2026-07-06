import React, { useState, useEffect } from 'react';
import { MicOff, VideoOff, Shield, Maximize, Minimize } from 'lucide-react';
import type { Participant } from './Room';

interface VideoGridProps {
  participants: Participant[];
  hostSocketId: string | null;
  mySocketId: string;
}

const VideoGrid: React.FC<VideoGridProps> = ({ participants, hostSocketId, mySocketId }) => {
  const [fullscreenSocketId, setFullscreenSocketId] = useState<string | null>(null);

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

  // Get initials for avatar display
  const getInitials = (name: string) => {
    return name
      .trim()
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const getGridClass = () => {
    const count = participants.length;
    if (count <= 1) return 'video-grid count-1';
    if (count === 2) return 'video-grid count-2';
    return 'video-grid';
  };

  const renderUserCard = (p: Participant) => {
    const isMe = p.socketId === 'local';
    const isHost = p.isHost || (hostSocketId && p.socketId === hostSocketId) || (isMe && hostSocketId === mySocketId);
    const hasVideo = p.stream && p.stream.getVideoTracks().length > 0 && p.stream.getVideoTracks()[0].enabled;
    const isScreen = p.isScreenSharing;
    const isFullscreen = fullscreenSocketId === p.socketId;

    return (
      <div 
        key={p.socketId} 
        id={`video-card-${p.socketId}`} 
        className={`video-card ${isScreen ? 'screen-share' : ''}`}
      >
        {/* Fullscreen control action */}
        <div className="card-top-left-actions">
          <button 
            onClick={() => handleToggleFullscreen(p.socketId)}
            className="fullscreen-btn"
            title={isFullscreen ? 'Tam Ekrandan Çık' : 'Tam Ekran Yap'}
          >
            {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
          </button>
        </div>

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

        {/* Video element or Avatar placeholder */}
        {p.stream && (hasVideo || isScreen) ? (
          <video
            ref={(el) => {
              if (el && p.stream && el.srcObject !== p.stream) {
                el.srcObject = p.stream;
              }
            }}
            autoPlay
            playsInline
            muted={isMe} // Mute self to prevent hearing echo
          />
        ) : (
          <div className="avatar-placeholder">
            {getInitials(p.username)}
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

  // Find if there is an active screen sharing session
  const screenShareUser = participants.find(p => p.isScreenSharing);
  
  if (screenShareUser) {
    const otherUsers = participants.filter(p => p.socketId !== screenShareUser.socketId);
    
    return (
      <div className="screen-share-layout">
        <div className="focused-stream-container">
          {renderUserCard(screenShareUser)}
        </div>
        {otherUsers.length > 0 && (
          <div className="thumbnails-strip-container">
            {otherUsers.map(renderUserCard)}
          </div>
        )}
      </div>
    );
  }

  // Default Grid Layout (No screen share active)
  return (
    <div className={getGridClass()}>
      {participants.map(renderUserCard)}
    </div>
  );
};

export default VideoGrid;
