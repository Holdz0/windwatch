import React, { useEffect, useRef, useState } from 'react';
import {
  Mic, MicOff, Video, VideoOff,
  Monitor, MessageSquare, LogOut, Settings2
} from 'lucide-react';
import { SCREEN_SHARE_PRESETS } from '../utils/screenShare';
import type { ScreenShareQuality } from '../utils/screenShare';

interface ControlsProps {
  isAudioMuted: boolean;
  isVideoMuted: boolean;
  isScreenSharing: boolean;
  isChatOpen: boolean;
  toggleAudio: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => void;
  toggleChat: () => void;
  onLeave: () => void;
  screenQuality: ScreenShareQuality;
  onChangeScreenQuality: (quality: ScreenShareQuality) => void;
  /** Username of another member currently sharing, if any */
  screenShareBlockedBy?: string;
}

const QUALITY_ORDER: ScreenShareQuality[] = ['detail', 'balanced', 'motion'];

const Controls: React.FC<ControlsProps> = ({
  isAudioMuted,
  isVideoMuted,
  isScreenSharing,
  isChatOpen,
  toggleAudio,
  toggleVideo,
  toggleScreenShare,
  toggleChat,
  onLeave,
  screenQuality,
  onChangeScreenQuality,
  screenShareBlockedBy
}) => {
  const [isQualityMenuOpen, setIsQualityMenuOpen] = useState(false);
  const qualityMenuRef = useRef<HTMLDivElement | null>(null);

  // Close the popover on an outside click
  useEffect(() => {
    if (!isQualityMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (qualityMenuRef.current && !qualityMenuRef.current.contains(e.target as Node)) {
        setIsQualityMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isQualityMenuOpen]);

  const isShareBlocked = !isScreenSharing && !!screenShareBlockedBy;

  return (
    <div className="controls-container">
      {/* Mic Button */}
      <button
        onClick={toggleAudio}
        className={`ctrl-btn ctrl-mic ${isAudioMuted ? 'danger' : 'active'}`}
        title={isAudioMuted ? 'Sesi Aç' : 'Sesi Kapat'}
      >
        {isAudioMuted ? <MicOff size={20} /> : <Mic size={20} />}
      </button>

      {/* Video/Camera Button */}
      <button
        onClick={toggleVideo}
        className={`ctrl-btn ctrl-video ${isVideoMuted ? 'danger' : 'active'}`}
        title={isVideoMuted ? 'Kamerayı Aç' : 'Kamerayı Kapat'}
      >
        {isVideoMuted ? <VideoOff size={20} /> : <Video size={20} />}
      </button>

      {/* Screen Share Button */}
      <button
        onClick={toggleScreenShare}
        disabled={isShareBlocked}
        className={`ctrl-btn ctrl-screen ${isScreenSharing ? 'active' : ''} ${isShareBlocked ? 'is-disabled' : ''}`}
        title={
          isShareBlocked
            ? `${screenShareBlockedBy} şu anda ekranını paylaşıyor`
            : isScreenSharing
              ? 'Paylaşımı Durdur'
              : 'Ekranını Paylaş'
        }
      >
        <Monitor size={20} />
      </button>

      {/* Screen Share Quality Selector */}
      <div className="quality-menu-wrapper" ref={qualityMenuRef}>
        <button
          type="button"
          onClick={() => setIsQualityMenuOpen(prev => !prev)}
          className={`ctrl-btn ctrl-quality ${isQualityMenuOpen ? 'active' : ''}`}
          title="Ekran Paylaşımı Kalitesi"
        >
          <Settings2 size={20} />
        </button>

        {isQualityMenuOpen && (
          <div className="quality-menu">
            <div className="quality-menu-title">Ekran Paylaşımı Kalitesi</div>
            {QUALITY_ORDER.map(q => {
              const preset = SCREEN_SHARE_PRESETS[q];
              return (
                <button
                  key={q}
                  type="button"
                  className={`quality-option ${screenQuality === q ? 'selected' : ''}`}
                  onClick={() => {
                    onChangeScreenQuality(q);
                    setIsQualityMenuOpen(false);
                  }}
                >
                  <span className="quality-option-label">{preset.label}</span>
                  <span className="quality-option-hint">{preset.hint}</span>
                  <span className="quality-option-specs">
                    {preset.maxHeight}p · {preset.frameRate} fps · {preset.maxBitrate / 1_000_000} Mbps
                  </span>
                </button>
              );
            })}
            <div className="quality-menu-footer">
              Paylaşım sürerken de değiştirilebilir.
            </div>
          </div>
        )}
      </div>

      {/* Chat Pane Toggle Button */}
      <button
        onClick={toggleChat}
        className={`ctrl-btn ctrl-chat ${isChatOpen ? 'active' : ''}`}
        title={isChatOpen ? 'Sohbeti Gizle' : 'Sohbeti Göster'}
      >
        <MessageSquare size={20} />
      </button>

      {/* Leave Room Button */}
      <button
        onClick={onLeave}
        className="ctrl-btn ctrl-leave danger"
        title="Odadan Ayrıl"
        style={{ marginLeft: '12px' }}
      >
        <LogOut size={20} />
      </button>
    </div>
  );
};

export default Controls;
