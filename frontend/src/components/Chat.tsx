import React, { useState, useEffect, useRef } from 'react';
import { Send, X } from 'lucide-react';
import type { ChatMessage } from './Room';

interface ChatProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  myId: string;
  onClose: () => void;
}

const Chat: React.FC<ChatProps> = ({ messages, onSendMessage, myId, onClose }) => {
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

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

  // Format date helper: returns "HH:MM"
  const formatTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
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
            const isMe = msg.senderId === myId || msg.senderId === 'local';
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

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="chat-input-form">
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
