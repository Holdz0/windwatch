import React, { useState, useEffect, useRef } from 'react';
import { Send, X, Paperclip, FileText, Download, Check } from 'lucide-react';
import type { ChatMessage } from './Room';

interface ChatProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  onShareFile: (file: File) => void;
  onDownloadFile: (senderSocketId: string, fileName: string, fileType: string) => void;
  myId: string;
  onClose: () => void;
}

const Chat: React.FC<ChatProps> = ({ 
  messages, 
  onSendMessage, 
  onShareFile, 
  onDownloadFile, 
  myId, 
  onClose 
}) => {
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Track downloading states: fileName -> boolean
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
  const formatBytes = (bytesStr: string) => {
    const bytes = parseInt(bytesStr, 10);
    if (isNaN(bytes) || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Trigger P2P file transfer download
  const triggerDownload = async (senderSocketId: string, fileName: string, fileType: string) => {
    setDownloadingFiles(prev => ({ ...prev, [fileName]: true }));
    try {
      await onDownloadFile(senderSocketId, fileName, fileType);
    } catch (err) {
      console.error(err);
    } finally {
      // Keep completed state representation briefly
      setTimeout(() => {
        setDownloadingFiles(prev => ({ ...prev, [fileName]: false }));
      }, 3000);
    }
  };

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Oda Sohbeti</h3>
        <button 
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--color-text-secondary)',
            cursor: 'pointer'
          }}
        >
          <X size={20} />
        </button>
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
            const isMe = msg.senderId === myId || msg.senderId === 'local';
            const isFile = msg.text.startsWith('[FILE]');

            if (isSystem) {
              return (
                <div key={index} className="chat-system-message">
                  <span>{msg.text}</span>
                </div>
              );
            }

            // File Sharing Card Rendering
            if (isFile) {
              try {
                // Parse format: [FILE]fileName|fileSize|fileType
                const rawMeta = msg.text.substring(6);
                const [fileName, fileSize, fileType] = rawMeta.split('|');
                const isDownloading = !!downloadingFiles[fileName];

                return (
                  <div key={index} className={`chat-bubble file-card-bubble ${isMe ? 'self' : 'other'}`}>
                    {!isMe && (
                      <span className="chat-sender-name">{msg.senderName}</span>
                    )}
                    <div className="chat-file-card">
                      <div className="file-info-header">
                        <FileText size={28} className="file-icon" />
                        <div className="file-meta">
                          <span className="file-name" title={fileName}>{fileName}</span>
                          <span className="file-size">{formatBytes(fileSize)}</span>
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
                            onClick={() => triggerDownload(msg.senderId, fileName, fileType)}
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
              } catch (err) {
                // fallback to regular message if format parsing fails
              }
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
          maxLength={200}
        />
        <button type="submit" className="chat-send-btn">
          <Send size={16} />
        </button>
      </form>
    </div>
  );
};

export default Chat;
