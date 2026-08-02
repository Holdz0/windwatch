import React, { useState, useEffect, useRef } from 'react';
import { Send, X, Paperclip, FileText, Download, Check, ExternalLink } from 'lucide-react';
import type { ChatMessage, SharedFileMeta } from './Room';
import { parseFileMessage } from './Room';

interface ChatProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  onShareFile: (file: File) => void;
  onDownloadFile: (senderSocketId: string, file: SharedFileMeta) => Promise<void>;
  myId: string;
  onClose: () => void;
  onDetach?: () => void;
  isPiP?: boolean;
  /** Render as a draggable bottom sheet (mobile portrait) instead of a side panel */
  isBottomSheet?: boolean;
}

// Resting position of the sheet when half-open, as a fraction of its height.
const SHEET_HALF_OFFSET = 0.45;
// Drag past this fraction of the sheet height (downwards) and it dismisses.
const SHEET_DISMISS_THRESHOLD = 0.65;

const Chat: React.FC<ChatProps> = ({ 
  messages, 
  onSendMessage, 
  onShareFile, 
  onDownloadFile, 
  myId, 
  onClose,
  onDetach,
  isPiP = false,
  isBottomSheet = false
}) => {
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // --- Bottom sheet drag ---------------------------------------------------
  // Only the handle starts a drag, so the message list keeps its own natural
  // scrolling — mixing the two is what makes hand-rolled sheets feel broken.
  const sheetRef = useRef<HTMLDivElement | null>(null);
  // Resting offset in px from the fully-open position (0 = full height)
  const [sheetOffset, setSheetOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startOffset: number } | null>(null);

  // The slide-in is driven through the same inline transform + CSS transition
  // that the drag uses, rather than a keyframe animation. A keyframe would be a
  // second owner of `transform` and would win over the inline value while it
  // ran — so dragging during the entry did nothing, and if the animation was
  // ever interrupted the sheet was left stranded off-screen.
  const [hasEntered, setHasEntered] = useState(false);
  useEffect(() => {
    if (!isBottomSheet) {
      setHasEntered(false);
      return;
    }
    // One frame at the off-screen position, then transition to resting.
    // A timeout backs up the rAF because rAF does not fire while the tab is
    // hidden — without it, opening the chat and immediately switching apps
    // would leave the sheet parked off-screen for the rest of the session.
    const raf = requestAnimationFrame(() => setHasEntered(true));
    const timer = window.setTimeout(() => setHasEntered(true), 80);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [isBottomSheet]);

  const handleDragStart = (e: React.PointerEvent) => {
    if (!isBottomSheet) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startOffset: sheetOffset };
    setIsDragging(true);
  };

  const handleDragMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const delta = e.clientY - dragRef.current.startY;
    // Never drag above the fully-open position
    setSheetOffset(Math.max(0, dragRef.current.startOffset + delta));
  };

  const handleDragEnd = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setIsDragging(false);

    const height = sheetRef.current?.offsetHeight ?? 0;
    if (!height) return;

    if (sheetOffset > height * SHEET_DISMISS_THRESHOLD) {
      onClose();
      setSheetOffset(0); // reset so it reopens fully next time
      return;
    }
    // Snap to whichever resting point is nearer
    const halfPx = height * SHEET_HALF_OFFSET;
    setSheetOffset(sheetOffset > halfPx / 2 ? halfPx : 0);
  };

  // Track downloading states: fileId -> boolean
  const [downloadingFiles, setDownloadingFiles] = useState<Record<string, boolean>>({});

  // Auto-scroll to bottom of chat when new message arrives
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    onSendMessage(inputText);
    setInputText('');
  };

  const handlePaperclipClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      // Limit file size to 100MB to avoid local browser RAM limits during connection read
      if (file.size > 100 * 1024 * 1024) {
        alert("Dosya boyutu çok büyük (Limit: 100MB).");
        return;
      }
      onShareFile(file);
      // Reset input value to allow selecting same file again
      e.target.value = '';
    }
  };

  // Format date helper: returns "HH:MM"
  const formatTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  // Format bytes helper: e.g. "1.2 MB"
  const formatBytes = (bytes: number) => {
    if (isNaN(bytes) || bytes <= 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Trigger P2P file transfer download. The returned promise settles when the
  // transfer actually completes or fails, so the button state reflects reality.
  const triggerDownload = async (senderSocketId: string, file: SharedFileMeta) => {
    setDownloadingFiles(prev => ({ ...prev, [file.id]: true }));
    try {
      await onDownloadFile(senderSocketId, file);
    } catch (err: any) {
      console.error(err);
      alert(err?.message || 'Dosya indirilemedi. Lütfen tekrar deneyin.');
    } finally {
      setDownloadingFiles(prev => ({ ...prev, [file.id]: false }));
    }
  };

  return (
    <div
      ref={sheetRef}
      className={`chat-panel${isBottomSheet ? ' chat-sheet' : ''}${isDragging ? ' is-dragging' : ''}`}
      style={
        isBottomSheet
          ? { transform: hasEntered ? `translateY(${sheetOffset}px)` : 'translateY(100%)' }
          : undefined
      }
    >
      {/* Drag handle — the only surface that initiates a sheet drag */}
      {isBottomSheet && (
        <div
          className="chat-sheet-handle"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          role="button"
          tabIndex={0}
          aria-label="Sohbeti sürükle"
        >
          <span className="chat-sheet-grabber" />
        </div>
      )}

      {/* Header */}
      <div className="chat-header">
        <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>
          {isPiP ? 'Canlı Sohbet' : 'Oda Sohbeti'}
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {onDetach && !isPiP && (
            <button 
              type="button"
              onClick={onDetach}
              title="Sohbeti Ayrı Pencereye Al"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--color-text-secondary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center'
              }}
            >
              <ExternalLink size={18} />
            </button>
          )}
          <button 
            type="button"
            onClick={onClose}
            title={isPiP ? 'Pencereyi Kapat ve Odaya Dön' : 'Sohbeti Kapat'}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center'
            }}
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Message History */}
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div style={{
            color: 'var(--color-text-muted)',
            textAlign: 'center',
            fontSize: '0.85rem',
            marginTop: '40px'
          }}>
            Henüz mesaj yok. Yazışmaya başlayın!
          </div>
        ) : (
          messages.map((msg, index) => {
            const isSystem = msg.senderId === 'system';
            const isMe = msg.senderId === myId;
            const fileMeta = parseFileMessage(msg.text);

            if (isSystem) {
              return (
                <div key={index} className="chat-system-message">
                  <span>{msg.text}</span>
                </div>
              );
            }

            // File Sharing Card Rendering (falls through to plain text on malformed metadata)
            if (fileMeta) {
              const isDownloading = !!downloadingFiles[fileMeta.id];

              return (
                <div key={index} className={`chat-bubble file-card-bubble ${isMe ? 'self' : 'other'}`}>
                  {!isMe && (
                    <span className="chat-sender-name">{msg.senderName}</span>
                  )}
                  <div className="chat-file-card">
                    <div className="file-info-header">
                      <FileText size={28} className="file-icon" />
                      <div className="file-meta">
                        <span className="file-name" title={fileMeta.name}>{fileMeta.name}</span>
                        <span className="file-size">{formatBytes(fileMeta.size)}</span>
                      </div>
                    </div>
                    <div className="file-card-action">
                      {isMe ? (
                        <span className="file-status-sent">
                          <Check size={12} style={{ marginRight: '4px' }} /> Gönderildi
                        </span>
                      ) : (
                        <button
                          className={`btn-file-download ${isDownloading ? 'downloading' : ''}`}
                          onClick={() => triggerDownload(msg.senderId, fileMeta)}
                          disabled={isDownloading}
                        >
                          {isDownloading ? (
                            <>İndiriliyor...</>
                          ) : (
                            <>
                              <Download size={12} style={{ marginRight: '4px' }} /> P2P İndir
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                  <span className="chat-time">{formatTime(msg.timestamp)}</span>
                </div>
              );
            }

            return (
              <div 
                key={index} 
                className={`chat-bubble ${isMe ? 'self' : 'other'}`}
              >
                {!isMe && (
                  <span className="chat-sender-name">{msg.senderName}</span>
                )}
                <div className="chat-bubble-content">
                  {msg.text}
                </div>
                <span className="chat-time">{formatTime(msg.timestamp)}</span>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Hidden File Input */}
      <input 
        type="file" 
        ref={fileInputRef} 
        style={{ display: 'none' }} 
        onChange={handleFileChange} 
      />

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="chat-input-form">
        <button 
          type="button" 
          className="chat-action-btn clip"
          onClick={handlePaperclipClick}
          title="P2P Dosya Paylaş"
        >
          <Paperclip size={18} />
        </button>
        <input
          type="text"
          className="chat-input"
          placeholder="Mesajınızı yazın..."
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          maxLength={500}
        />
        <button type="submit" className="chat-send-btn">
          <Send size={16} />
        </button>
      </form>
    </div>
  );
};

// Memoised: the room re-renders on stats/participant updates, and this
// subtree is comparatively expensive to rebuild for no visual change.
export default React.memo(Chat);
