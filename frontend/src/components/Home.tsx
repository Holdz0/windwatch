import React, { useState, useEffect } from 'react';
import { Video, ArrowRight, Loader, User, Link as LinkIcon, Plus, LogIn, Lock } from 'lucide-react';

interface HomeProps {
  onJoinRoom: (roomId: string, username: string, password?: string) => void;
  initialRoomId: string | null;
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? 'http://localhost:5000' : window.location.origin);

const Home: React.FC<HomeProps> = ({ onJoinRoom, initialRoomId }) => {
  const [username, setUsername] = useState('');
  const [roomIdInput, setRoomIdInput] = useState(initialRoomId || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'create' | 'join'>(initialRoomId ? 'join' : 'create');
  const [usePassword, setUsePassword] = useState(false);
  const [roomPassword, setRoomPassword] = useState('');

  // If initialRoomId changes, sync the active tab and input
  useEffect(() => {
    if (initialRoomId) {
      setRoomIdInput(initialRoomId);
      setActiveTab('join');
    }
  }, [initialRoomId]);

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setError('Lütfen bir isim girin.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${BACKEND_URL}/create-room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: usePassword ? roomPassword : null })
      });

      if (!response.ok) {
        throw new Error('Oda oluşturulamadı.');
      }

      const data = await response.json();
      onJoinRoom(data.roomId, username, usePassword ? roomPassword : undefined);
    } catch (err: any) {
      console.error(err);
      setError('Sunucu bağlantı hatası. Lütfen sunucunun açık olduğundan emin olun.');
    } finally {
      setLoading(false);
    }
  };

  const handleJoinExistingRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setError('Lütfen bir isim girin.');
      return;
    }

    let targetRoomId = roomIdInput.trim();

    // If a full room URL was pasted, extract the room ID segment
    if (targetRoomId.includes('/room/')) {
      const parts = targetRoomId.split('/room/');
      if (parts[1]) {
        targetRoomId = parts[1].split('?')[0].split('#')[0];
      }
    } else if (targetRoomId.startsWith('http')) {
      try {
        const url = new URL(targetRoomId);
        const pathParts = url.pathname.split('/');
        targetRoomId = pathParts[pathParts.length - 1] || targetRoomId;
      } catch (err) {
        // ignore
      }
    }

    if (!targetRoomId) {
      setError('Lütfen geçerli bir Oda ID veya Linki girin.');
      return;
    }

    setError(null);
    onJoinRoom(targetRoomId, username);
  };

  return (
    <div className="landing-container">
      {/* Dynamic Animated Background Glow Blobs */}
      <div className="bg-glow blob-1"></div>
      <div className="bg-glow blob-2"></div>
      <div className="bg-glow blob-3"></div>

      <div className="landing-card">
        {/* Brand Header */}
        <div className="brand-container">
          <div className="brand-logo-icon">
            <Video size={28} />
          </div>
          <h1 className="landing-logo">WindWatch</h1>
        </div>
        
        <p className="landing-subtitle">
          {initialRoomId 
            ? 'Bir odaya davet edildiniz. Katılmak için bilgilerinizi girin.'
            : 'Herhangi bir hesap oluşturmadan anında sesli, görüntülü sohbet ve ekran paylaşımı.'}
        </p>

        {error && (
          <div className="error-alert">
            {error}
          </div>
        )}

        {/* Tab Selection (Only shown if NOT joining via invite link) */}
        {!initialRoomId && (
          <div className="tab-container">
            <button 
              type="button"
              className={`tab-btn ${activeTab === 'create' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('create');
                setError(null);
              }}
            >
              <Plus size={16} />
              Oda Oluştur
            </button>
            <button 
              type="button"
              className={`tab-btn ${activeTab === 'join' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('join');
                setError(null);
              }}
            >
              <LogIn size={16} />
              Odaya Katıl
            </button>
          </div>
        )}

        {/* Form rendering based on active state */}
        <div className="tab-content-wrapper">
          {activeTab === 'create' ? (
            <form onSubmit={handleCreateRoom} className="fade-in">
              <div className="form-group">
                <label className="form-label">İsminiz (Görünen Ad)</label>
                <div className="input-with-icon-wrapper">
                  <User className="input-icon" size={18} />
                  <input 
                    type="text" 
                    className="form-input with-icon" 
                    placeholder="Örn: Elif" 
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    maxLength={20}
                    required
                    autoFocus
                  />
                </div>
              </div>

              <div className="form-group" style={{ marginTop: '16px', marginBottom: '16px' }}>
                <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none', color: 'var(--color-text-secondary)', fontSize: '0.9rem' }}>
                  <input 
                    type="checkbox" 
                    checked={usePassword} 
                    onChange={(e) => setUsePassword(e.target.checked)} 
                    style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: 'var(--color-blue)' }}
                  />
                  <span>Odayı Şifreyle Koru</span>
                </label>
              </div>

              {usePassword && (
                <div className="form-group fade-in" style={{ marginTop: '12px', marginBottom: '16px' }}>
                  <label className="form-label">Oda Şifresi</label>
                  <div className="input-with-icon-wrapper">
                    <Lock className="input-icon" size={18} />
                    <input 
                      type="password" 
                      className="form-input with-icon" 
                      placeholder="Şifrenizi yazın" 
                      value={roomPassword}
                      onChange={(e) => setRoomPassword(e.target.value)}
                      maxLength={20}
                      required={usePassword}
                    />
                  </div>
                </div>
              )}

              <button type="submit" className="btn btn-primary btn-glow" disabled={loading}>
                {loading ? (
                  <>Oda Hazırlanıyor... <Loader className="animate-spin" size={18} /></>
                ) : (
                  <>Yeni Oda Oluştur <ArrowRight size={18} /></>
                )}
              </button>
            </form>
          ) : (
            <form onSubmit={handleJoinExistingRoom} className="fade-in">
              {initialRoomId ? (
                /* Invitation Link Mode */
                <>
                  <div className="form-group">
                    <label className="form-label">Oda ID</label>
                    <div className="input-with-icon-wrapper">
                      <LinkIcon className="input-icon" size={18} />
                      <input 
                        type="text" 
                        className="form-input with-icon" 
                        value={roomIdInput} 
                        disabled 
                        style={{ opacity: 0.6, cursor: 'not-allowed' }}
                      />
                    </div>
                  </div>
                  
                  <div className="form-group">
                    <label className="form-label">İsminiz (Görünen Ad)</label>
                    <div className="input-with-icon-wrapper">
                      <User className="input-icon" size={18} />
                      <input 
                        type="text" 
                        className="form-input with-icon" 
                        placeholder="Örn: Ahmet" 
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        maxLength={20}
                        required
                        autoFocus
                      />
                    </div>
                  </div>

                  <button type="submit" className="btn btn-primary btn-glow">
                    Odaya Katıl <ArrowRight size={18} />
                  </button>
                </>
              ) : (
                /* Manual Join Mode */
                <>
                  <div className="form-group">
                    <label className="form-label">İsminiz (Görünen Ad)</label>
                    <div className="input-with-icon-wrapper">
                      <User className="input-icon" size={18} />
                      <input 
                        type="text" 
                        className="form-input with-icon" 
                        placeholder="Örn: Ahmet" 
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        maxLength={20}
                        required
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Oda ID veya Davet Linki</label>
                    <div className="input-with-icon-wrapper">
                      <LinkIcon className="input-icon" size={18} />
                      <input 
                        type="text" 
                        className="form-input with-icon" 
                        placeholder="Oda ID veya linkini yapıştırın" 
                        value={roomIdInput}
                        onChange={(e) => setRoomIdInput(e.target.value)}
                        required
                      />
                    </div>
                  </div>

                  <button type="submit" className="btn btn-primary btn-glow">
                    Odaya Katıl <ArrowRight size={18} />
                  </button>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default Home;
