import React from 'react';
import { 
  Mic, MicOff, Video, VideoOff, 
  Monitor, MessageSquare, LogOut 
} from 'lucide-react';

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
  onLeave
}) => {
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
        className={`ctrl-btn ctrl-screen ${isScreenSharing ? 'active' : ''}`}
        title={isScreenSharing ? 'Paylaşımı Durdur' : 'Ekranını Paylaş'}
      >
        <Monitor size={20} />
      </button>

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
