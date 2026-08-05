import React, { useEffect, useRef, useState } from 'react';
import {
  Mic, MicOff, Video, VideoOff,
  Monitor, MessageSquare, LogOut, Settings2, SlidersHorizontal, SwitchCamera
} from 'lucide-react';
import {
  SCREEN_SHARE_PRESETS,
  CUSTOM_RESOLUTION_OPTIONS,
  CUSTOM_FRAMERATE_OPTIONS,
  CUSTOM_BITRATE_BOUNDS,
  formatBitrate
} from '../utils/screenShare';
import type { BuiltInScreenShareQuality, ScreenShareQuality, CustomScreenShareSettings } from '../utils/screenShare';

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
  allowDesktopAudio: boolean;
  onToggleDesktopAudio: (enabled: boolean) => void;
  screenCustomSettings: CustomScreenShareSettings;
  onChangeCustomScreenSettings: (partial: Partial<CustomScreenShareSettings>) => void;
  /** Shown only on devices that actually have a second camera, while it is on */
  canSwitchCamera: boolean;
  isSwitchingCamera: boolean;
  facingMode: 'user' | 'environment';
  onSwitchCamera: () => void;
}

const QUALITY_ORDER: BuiltInScreenShareQuality[] = ['detail', 'balanced', 'motion'];

// How long to wait after the user stops moving a slider before actually
// re-negotiating the share — dragging fires many change events per second,
// and each one triggers a getUserMedia constraint update + RTP param push.
const CUSTOM_SETTING_DEBOUNCE_MS = 300;

// Debounces a callback by a fixed delay, cancelling any pending call on unmount.
function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delayMs: number) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  return (...args: A) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => fnRef.current(...args), delayMs);
  };
}

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
  screenShareBlockedBy,
  allowDesktopAudio,
  onToggleDesktopAudio,
  screenCustomSettings,
  onChangeCustomScreenSettings,
  canSwitchCamera,
  isSwitchingCamera,
  facingMode,
  onSwitchCamera
}) => {
  const [isQualityMenuOpen, setIsQualityMenuOpen] = useState(false);
  const qualityMenuRef = useRef<HTMLDivElement | null>(null);

  // Local mirror of the custom settings for instant slider/select feedback —
  // the actual apply (which re-negotiates the live share) is debounced below,
  // but the UI itself must never feel laggy while dragging.
  const [localMaxHeight, setLocalMaxHeight] = useState(screenCustomSettings.maxHeight);
  const [localFrameRate, setLocalFrameRate] = useState(screenCustomSettings.frameRate);
  const [localMaxBitrate, setLocalMaxBitrate] = useState(screenCustomSettings.maxBitrate);
  useEffect(() => {
    setLocalMaxHeight(screenCustomSettings.maxHeight);
    setLocalFrameRate(screenCustomSettings.frameRate);
    setLocalMaxBitrate(screenCustomSettings.maxBitrate);
  }, [screenCustomSettings]);

  // Only the bitrate slider needs debouncing — it fires continuously while
  // dragging. Resolution/fps are discrete <select> choices, applied instantly.
  const debouncedApplyBitrate = useDebouncedCallback(
    (maxBitrate: number) => onChangeCustomScreenSettings({ maxBitrate }),
    CUSTOM_SETTING_DEBOUNCE_MS
  );

  // Close the popover on an outside click or Escape
  useEffect(() => {
    if (!isQualityMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (qualityMenuRef.current && !qualityMenuRef.current.contains(e.target as Node)) {
        setIsQualityMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsQualityMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
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

      {/* Front/rear camera switch — only rendered when the device has a second
          camera and it is currently on, so it never appears as a dead control */}
      {canSwitchCamera && (
        <button
          type="button"
          onClick={onSwitchCamera}
          disabled={isSwitchingCamera}
          className={`ctrl-btn ctrl-flip ${isSwitchingCamera ? 'is-disabled' : ''}`}
          title={facingMode === 'user' ? 'Arka Kameraya Geç' : 'Ön Kameraya Geç'}
          aria-label={facingMode === 'user' ? 'Arka kameraya geç' : 'Ön kameraya geç'}
        >
          <SwitchCamera size={20} />
        </button>
      )}

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

            {/* Custom (manual) profile */}
            <button
              type="button"
              className={`quality-option ${screenQuality === 'custom' ? 'selected' : ''}`}
              onClick={() => onChangeScreenQuality('custom')}
            >
              <span className="quality-option-label">
                <SlidersHorizontal size={13} style={{ marginRight: '5px', verticalAlign: '-2px' }} />
                Özel
              </span>
              <span className="quality-option-hint">Çözünürlük, kare hızı ve bitrate elle ayarlanır.</span>
              <span className="quality-option-specs">
                {localMaxHeight}p · {localFrameRate} fps · {formatBitrate(localMaxBitrate / 1000)}
              </span>
            </button>

            {screenQuality === 'custom' && (
              <div className="custom-screen-settings">
                <label className="custom-setting-row">
                  <span className="custom-setting-label">Çözünürlük</span>
                  <select
                    className="custom-setting-select"
                    value={localMaxHeight}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setLocalMaxHeight(v);
                      onChangeCustomScreenSettings({ maxHeight: v });
                    }}
                  >
                    {CUSTOM_RESOLUTION_OPTIONS.map(opt => (
                      <option key={opt.height} value={opt.height}>{opt.label}</option>
                    ))}
                  </select>
                </label>

                <label className="custom-setting-row">
                  <span className="custom-setting-label">Kare Hızı</span>
                  <select
                    className="custom-setting-select"
                    value={localFrameRate}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setLocalFrameRate(v);
                      onChangeCustomScreenSettings({ frameRate: v });
                    }}
                  >
                    {CUSTOM_FRAMERATE_OPTIONS.map(fps => (
                      <option key={fps} value={fps}>{fps} fps</option>
                    ))}
                  </select>
                </label>

                <div className="custom-setting-row custom-setting-row-bitrate">
                  <span className="custom-setting-label">
                    Bitrate <span className="custom-setting-value">{formatBitrate(localMaxBitrate / 1000)}</span>
                  </span>
                  <input
                    type="range"
                    className="custom-setting-slider"
                    min={CUSTOM_BITRATE_BOUNDS.min}
                    max={CUSTOM_BITRATE_BOUNDS.max}
                    step={CUSTOM_BITRATE_BOUNDS.step}
                    value={localMaxBitrate}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setLocalMaxBitrate(v);
                      debouncedApplyBitrate(v);
                    }}
                  />
                </div>
              </div>
            )}

            <div className="quality-menu-section">
              <label className="quality-toggle">
                <input
                  type="checkbox"
                  checked={allowDesktopAudio}
                  onChange={(e) => onToggleDesktopAudio(e.target.checked)}
                />
                <span className="quality-toggle-text">
                  <span className="quality-option-label">Masaüstü sesini paylaş</span>
                  <span className="quality-option-hint">
                    Steam, Discord ve oyun sesleri de paylaşılır. Tüm ekran paylaşımında
                    konuşan katılımcılar kendi seslerini yankı olarak duyabilir.
                  </span>
                </span>
              </label>
            </div>

            <div className="quality-menu-footer">
              Paylaşım sürerken de değiştirilebilir. Sekme paylaşımında o sekmenin sesi
              her zaman gönderilir.
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

// Memoised: the room re-renders on stats/participant updates, and this
// subtree is comparatively expensive to rebuild for no visual change.
export default React.memo(Controls);
