import React, { useEffect, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';
import { Peer } from 'peerjs';
import { Copy, Users } from 'lucide-react';
import VideoGrid from './VideoGrid';
import Chat from './Chat';
import Controls from './Controls';

interface RoomProps {
  roomId: string;
  username: string;
  onLeave: () => void;
}

export interface Participant {
  socketId: string;
  peerId: string;
  username: string;
  isHost: boolean;
  stream?: MediaStream;
  isAudioMuted?: boolean;
  isVideoMuted?: boolean;
  isScreenSharing?: boolean;
}

export interface ChatMessage {
  senderId: string;
  senderName: string;
  text: string;
  timestamp: string;
}

// Helper to create a silent audio track without requesting hardware permission
const createSilentAudioTrack = () => {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const oscillator = ctx.createOscillator();
  const dst = ctx.createMediaStreamDestination();
  oscillator.connect(dst);
  oscillator.start();
  const track = dst.stream.getAudioTracks()[0];
  track.enabled = false;
  return track;
};

// Helper to create a black video track without requesting hardware permission
const createBlackVideoTrack = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const stream = (canvas as any).captureStream ? (canvas as any).captureStream(1) : (canvas as any).mozCaptureStream(1);
  const track = stream.getVideoTracks()[0];
  track.enabled = false;
  return track;
};

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

// Helper to parse the VITE_BACKEND_URL into host, port, and secure parameters for PeerJS
const getPeerConfig = () => {
  try {
    const url = new URL(BACKEND_URL);
    const host = url.hostname;
    
    let port = 80;
    if (url.port) {
      port = parseInt(url.port);
    } else if (url.protocol === 'https:') {
      port = 443;
    }
    
    return {
      host,
      port,
      path: '/peer',
      secure: url.protocol === 'https:'
    };
  } catch (err) {
    return {
      host: 'localhost',
      port: 5000,
      path: '/peer',
      secure: false
    };
  }
};

const Room: React.FC<RoomProps> = ({ roomId, username, onLeave }) => {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  
  const [isAudioMuted, setIsAudioMuted] = useState(true);
  const [isVideoMuted, setIsVideoMuted] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(true);
  
  const [hostSocketId, setHostSocketId] = useState<string | null>(null);
  const [showCopiedToast, setShowCopiedToast] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  
  // Track active calls in a ref so we can close or modify them dynamically
  // Key: socketId, Value: PeerJS Call object
  const activeCalls = useRef<Record<string, any>>({});
  const socketUsersRef = useRef<Set<string>>(new Set());

  // Helper to compose a MediaStream containing only the currently active tracks
  const getActiveStream = () => {
    const tracks: MediaStreamTrack[] = [];
    
    // Video Track: Use screen video if sharing, otherwise camera video
    if (screenStreamRef.current) {
      const screenVideoTrack = screenStreamRef.current.getVideoTracks()[0];
      if (screenVideoTrack) tracks.push(screenVideoTrack);
    } else if (localStreamRef.current) {
      const camVideoTrack = localStreamRef.current.getVideoTracks()[0];
      if (camVideoTrack) tracks.push(camVideoTrack);
    }

    // Audio Track: Use mixed audio (mic + system) if screen sharing, otherwise microphone
    if (audioDestinationRef.current) {
      const mixedAudioTrack = audioDestinationRef.current.stream.getAudioTracks()[0];
      if (mixedAudioTrack) tracks.push(mixedAudioTrack);
    } else if (localStreamRef.current) {
      const micAudioTrack = localStreamRef.current.getAudioTracks()[0];
      if (micAudioTrack) tracks.push(micAudioTrack);
    }

    return new MediaStream(tracks);
  };

  useEffect(() => {
    let isCancelled = false;
    let localStream: MediaStream | null = null;
    let socket: Socket | null = null;
    let peer: Peer | null = null;

    const initConnections = async () => {
      try {
        // 1. Initialize with fake (silent/black) tracks to avoid immediate browser hardware prompts
        const silentAudio = createSilentAudioTrack();
        const blackVideo = createBlackVideoTrack();
        const stream = new MediaStream([silentAudio, blackVideo]);

        if (isCancelled) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        localStream = stream;
        localStreamRef.current = stream;
        
        // Temporarily render local stream locally
        // We will add ourselves as a participant with socketId: 'local'
        setParticipants([{
          socketId: 'local',
          peerId: 'local-peer',
          username: `${username} (Siz)`,
          isHost: false,
          stream: stream,
          isAudioMuted: true,
          isVideoMuted: true
        }]);

        // 2. Initialize Socket.io client
        socket = io(BACKEND_URL);
        socketRef.current = socket;

        // 3. Initialize PeerJS client using parsed configuration
        peer = new Peer(undefined as any, getPeerConfig());
        peerRef.current = peer;

        // 4. Peer registered event
        peer.on('open', (peerId) => {
          if (isCancelled) return;
          console.log(`My PeerJS ID: ${peerId}`);
          // Join socket.io room
          socket?.emit('join-room', { roomId, peerId, username });
        });

        // 5. Peer incoming call handler (answering calls from others)
        peer.on('call', (call) => {
          if (isCancelled) return;
          console.log(`Receiving call from Peer: ${call.peer}`);
          const callerSocketId = call.metadata?.callerSocketId;
          
          // STRICT SECURITY CHECK: Reject calls from Peer IDs not mapped to socket users in the room
          const isAuthorized = socketUsersRef.current.has(callerSocketId);
          if (!isAuthorized) {
            console.warn(`Blocked unauthorized PeerJS call from socketId: ${callerSocketId}`);
            call.close();
            return;
          }
          
          if (localStream) {
            call.answer(getActiveStream());
            
            call.on('stream', (remoteStream) => {
              if (isCancelled) return;
              console.log(`Received remote stream on answer`);
              // Associate stream with participant
              setParticipants(prev => prev.map(p => {
                if (p.peerId === call.peer || p.socketId === callerSocketId) {
                  return { ...p, stream: remoteStream };
                }
                return p;
              }));
            });

            // Store call
            if (callerSocketId) {
              activeCalls.current[callerSocketId] = call;
            }
          }
        });

        // 6. Socket room users list synchronization
        socket.on('room-users', ({ roomUsers, hostSocketId: currentHostSocketId }) => {
          if (isCancelled) return;
          console.log('Room users updated from server:', roomUsers);
          setHostSocketId(currentHostSocketId);

          // Update active socket users whitelist cache
          socketUsersRef.current.clear();
          roomUsers.forEach((u: any) => {
            if (u.socketId !== socket?.id) {
              socketUsersRef.current.add(u.socketId);
            }
          });

          setParticipants(prev => {
            const localUser = prev.find(p => p.socketId === 'local');
            if (!localUser) return prev;
            
            // Map the users list from server
            return [
              { ...localUser, isHost: currentHostSocketId === socket?.id },
              ...roomUsers
                .filter((u: any) => u.socketId !== socket?.id)
                .map((u: any) => {
                  const existing = prev.find(p => p.socketId === u.socketId);
                  return {
                    socketId: u.socketId,
                    peerId: u.peerId,
                    username: u.username,
                    isHost: u.isHost,
                    stream: existing?.stream // Preserve existing stream if available
                  };
                })
            ];
          });
        });

        // 7. Socket user connected (an existing user calls this new user)
        socket.on('user-connected', ({ socketId, peerId, username: newUsername, isHost: isNewUserHost }) => {
          if (isCancelled) return;
          console.log(`New user connected: ${newUsername} (${socketId})`);
          
          // Whitelist new socket user
          socketUsersRef.current.add(socketId);

          // Add to participant list first (as loader or just tag)
          setParticipants(prev => {
            if (prev.some(p => p.socketId === socketId)) return prev;
            return [...prev, { socketId, peerId, username: newUsername, isHost: isNewUserHost }];
          });

          // Call the newly connected user, sending our local video stream
          if (localStream && peer) {
            console.log(`Calling new user ${newUsername} (${peerId})`);
            const call = peer.call(peerId, getActiveStream(), {
              metadata: { callerSocketId: socket?.id, callerUsername: username }
            });

            call.on('stream', (remoteStream) => {
              if (isCancelled) return;
              console.log(`Received remote stream on call`);
              setParticipants(prev => prev.map(p => {
                if (p.socketId === socketId) {
                  return { ...p, stream: remoteStream };
                }
                return p;
              }));
            });

            // Store call
            activeCalls.current[socketId] = call;
          }
        });

        // 8. Socket chat message listener
        socket.on('receive-message', (message: ChatMessage) => {
          if (isCancelled) return;
          setChatMessages(prev => [...prev, message]);
        });

        // 9. Socket user disconnected cleanup
        socket.on('user-disconnected', ({ socketId }) => {
          if (isCancelled) return;
          console.log(`Participant left room: ${socketId}`);
          
          // Remove from whitelist
          socketUsersRef.current.delete(socketId);

          // Close WebRTC call
          if (activeCalls.current[socketId]) {
            activeCalls.current[socketId].close();
            delete activeCalls.current[socketId];
          }

          // Remove from state
          setParticipants(prev => prev.filter(p => p.socketId !== socketId));
        });

        // 10. General Socket Error Msg
        socket.on('error-msg', (msg) => {
          if (isCancelled) return;
          alert(`Hata: ${msg}`);
          onLeave();
        });

      } catch (err) {
        if (isCancelled) return;
        console.error('Media stream or connection initialization failed:', err);
        alert('Kamera veya mikrofon erişimi reddedildi.');
        onLeave();
      }
    };

    initConnections();

    // Cleanup everything on unmount
    return () => {
      isCancelled = true;
      console.log('Cleaning up room connections...');
      
      // Stop all tracks in camera stream
      if (localStream) {
        (localStream as MediaStream).getTracks().forEach(track => track.stop());
      }

      // Stop all tracks in screen stream
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(track => track.stop());
      }

      // Close all PeerJS calls
      Object.values(activeCalls.current).forEach((call: any) => call.close());

      // Disconnect socket
      if (socket) {
        (socket as Socket).disconnect();
      }

      // Destroy peerJS
      if (peer) {
        (peer as Peer).destroy();
      }
    };
  }, [roomId, username, onLeave]);

  // Copy invitation link to clipboard
  const copyRoomLink = () => {
    const inviteUrl = `${window.location.origin}/room/${roomId}`;
    navigator.clipboard.writeText(inviteUrl).then(() => {
      setShowCopiedToast(true);
      setTimeout(() => setShowCopiedToast(false), 2500);
    });
  };

  // Toggle Audio track status
  const toggleAudio = async () => {
    if (!localStreamRef.current) return;

    const oldAudioTrack = localStreamRef.current.getAudioTracks()[0];

    if (isAudioMuted) {
      // Turn on microphone
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const realAudioTrack = stream.getAudioTracks()[0];
        
        if (realAudioTrack) {
          if (oldAudioTrack) {
            oldAudioTrack.stop();
            localStreamRef.current.removeTrack(oldAudioTrack);
          }
          localStreamRef.current.addTrack(realAudioTrack);

          // Update active calls
          if (!screenStreamRef.current) {
            Object.values(activeCalls.current).forEach((call: any) => {
              const senders = call.peerConnection.getSenders();
              const audioSender = senders.find((s: any) => s.track && s.track.kind === 'audio');
              if (audioSender) {
                audioSender.replaceTrack(realAudioTrack);
              }
            });
          } else if (screenStreamRef.current && audioContextRef.current) {
            // Reconnect audio mixing with the new hardware track
            audioContextRef.current.close();
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            const audioCtx = new AudioContextClass();
            audioContextRef.current = audioCtx;

            const micSource = audioCtx.createMediaStreamSource(localStreamRef.current);
            const screenSource = audioCtx.createMediaStreamSource(screenStreamRef.current);
            const dest = audioCtx.createMediaStreamDestination();
            audioDestinationRef.current = dest;

            micSource.connect(dest);
            screenSource.connect(dest);

            const mixedAudioTrack = dest.stream.getAudioTracks()[0];
            Object.values(activeCalls.current).forEach((call: any) => {
              const senders = call.peerConnection.getSenders();
              const audioSender = senders.find((s: any) => s.track && s.track.kind === 'audio');
              if (audioSender && mixedAudioTrack) {
                audioSender.replaceTrack(mixedAudioTrack);
              }
            });
          }

          setIsAudioMuted(false);
          setParticipants(prev => prev.map(p => {
            if (p.socketId === 'local') {
              return { ...p, isAudioMuted: false };
            }
            return p;
          }));
        }
      } catch (err) {
        console.error('Mikrofon erişimi alınamadı:', err);
        alert('Mikrofon erişim izni verilmedi.');
      }
    } else {
      // Turn off microphone: stop hardware track to release recording indicator
      if (oldAudioTrack) {
        oldAudioTrack.stop();
      }

      const silentAudioTrack = createSilentAudioTrack();
      localStreamRef.current.removeTrack(oldAudioTrack);
      localStreamRef.current.addTrack(silentAudioTrack);

      if (!screenStreamRef.current) {
        Object.values(activeCalls.current).forEach((call: any) => {
          const senders = call.peerConnection.getSenders();
          const audioSender = senders.find((s: any) => s.track && s.track.kind === 'audio');
          if (audioSender) {
            audioSender.replaceTrack(silentAudioTrack);
          }
        });
      } else if (screenStreamRef.current && audioContextRef.current) {
        // Reconnect audio mixing (with the silent track replacing the microphone)
        audioContextRef.current.close();
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const audioCtx = new AudioContextClass();
        audioContextRef.current = audioCtx;

        const micSource = audioCtx.createMediaStreamSource(localStreamRef.current);
        const screenSource = audioCtx.createMediaStreamSource(screenStreamRef.current);
        const dest = audioCtx.createMediaStreamDestination();
        audioDestinationRef.current = dest;

        micSource.connect(dest);
        screenSource.connect(dest);

        const mixedAudioTrack = dest.stream.getAudioTracks()[0];
        Object.values(activeCalls.current).forEach((call: any) => {
          const senders = call.peerConnection.getSenders();
          const audioSender = senders.find((s: any) => s.track && s.track.kind === 'audio');
          if (audioSender && mixedAudioTrack) {
            audioSender.replaceTrack(mixedAudioTrack);
          }
        });
      }

      setIsAudioMuted(true);
      setParticipants(prev => prev.map(p => {
        if (p.socketId === 'local') {
          return { ...p, isAudioMuted: true };
        }
        return p;
      }));
    }
  };

  // Toggle Video track status
  const toggleVideo = async () => {
    if (!localStreamRef.current) return;

    const oldVideoTrack = localStreamRef.current.getVideoTracks()[0];

    if (isVideoMuted) {
      // Turn on camera
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const realVideoTrack = stream.getVideoTracks()[0];
        
        if (realVideoTrack) {
          if (oldVideoTrack) {
            oldVideoTrack.stop();
            localStreamRef.current.removeTrack(oldVideoTrack);
          }
          localStreamRef.current.addTrack(realVideoTrack);

          // Replace track in active calls
          if (!screenStreamRef.current) {
            Object.values(activeCalls.current).forEach((call: any) => {
              const senders = call.peerConnection.getSenders();
              const videoSender = senders.find((s: any) => s.track && s.track.kind === 'video');
              if (videoSender) {
                videoSender.replaceTrack(realVideoTrack);
              }
            });
          }

          setIsVideoMuted(false);
          setParticipants(prev => prev.map(p => {
            if (p.socketId === 'local') {
              return { ...p, isVideoMuted: false, stream: getActiveStream() };
            }
            return p;
          }));
        }
      } catch (err) {
        console.error('Kamera erişimi alınamadı:', err);
        alert('Kamera erişim izni verilmedi.');
      }
    } else {
      // Turn off camera: stop hardware track to release green light
      if (oldVideoTrack) {
        oldVideoTrack.stop();
      }

      const blackVideoTrack = createBlackVideoTrack();
      localStreamRef.current.removeTrack(oldVideoTrack);
      localStreamRef.current.addTrack(blackVideoTrack);

      if (!screenStreamRef.current) {
        Object.values(activeCalls.current).forEach((call: any) => {
          const senders = call.peerConnection.getSenders();
          const videoSender = senders.find((s: any) => s.track && s.track.kind === 'video');
          if (videoSender) {
            videoSender.replaceTrack(blackVideoTrack);
          }
        });
      }

      setIsVideoMuted(true);
      setParticipants(prev => prev.map(p => {
        if (p.socketId === 'local') {
          return { ...p, isVideoMuted: true, stream: getActiveStream() };
        }
        return p;
      }));
    }
  };

  // Screen Sharing logic: requests display stream and updates the tracks inside active peer calls
  const toggleScreenShare = async () => {
    if (!isScreenSharing) {
      try {
        // High quality screen sharing constraints (ideal 30fps, max 60fps, 1080p limit)
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { max: 1920 },
            height: { max: 1080 },
            frameRate: { ideal: 30, max: 60 }
          },
          audio: true // Ask user to share system audio
        });
        screenStreamRef.current = stream;

        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack && 'contentHint' in videoTrack) {
          videoTrack.contentHint = 'motion'; // Optimize encoder for motion rendering (high FPS)
        }

        let mixedAudioTrack: MediaStreamTrack | null = null;

        // If screen sharing stream has audio tracks, mix them with microphone
        if (stream.getAudioTracks().length > 0 && localStreamRef.current) {
          try {
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            const audioCtx = new AudioContextClass();
            audioContextRef.current = audioCtx;

            const micSource = audioCtx.createMediaStreamSource(localStreamRef.current);
            const screenSource = audioCtx.createMediaStreamSource(stream);
            const dest = audioCtx.createMediaStreamDestination();
            audioDestinationRef.current = dest;

            micSource.connect(dest);
            screenSource.connect(dest);

            mixedAudioTrack = dest.stream.getAudioTracks()[0];
            console.log("System audio mixed successfully with microphone.");
          } catch (audioErr) {
            console.warn("Could not mix audio streams, falling back to mic audio only:", audioErr);
          }
        }

        // Replace tracks in all active P2P calls
        Object.values(activeCalls.current).forEach(async (call: any) => {
          const senders = call.peerConnection.getSenders();
          
          // Replace video track
          const videoSender = senders.find((s: any) => s.track && s.track.kind === 'video');
          if (videoSender && videoTrack) {
            await videoSender.replaceTrack(videoTrack);
            
            // Adjust encoding parameters for high-priority 4 Mbps screen share
            try {
              const params = videoSender.getParameters();
              if (params.encodings && params.encodings.length > 0) {
                params.encodings[0].maxBitrate = 4000000; // 4 Mbps (crisp resolution)
                params.encodings[0].priority = 'high';
                params.encodings[0].networkPriority = 'high';
                await videoSender.setParameters(params);
              }
            } catch (pErr) {
              console.warn("Failed to set video sender parameters:", pErr);
            }
          }

          // Replace audio track with mixed stream if available
          if (mixedAudioTrack) {
            const audioSender = senders.find((s: any) => s.track && s.track.kind === 'audio');
            if (audioSender) {
              await audioSender.replaceTrack(mixedAudioTrack);
            }
          }
        });

        // Replace track in local rendering representation
        setParticipants(prev => prev.map(p => {
          if (p.socketId === 'local') {
            return { ...p, stream: getActiveStream() };
          }
          return p;
        }));

        setIsScreenSharing(true);
        
        socketRef.current?.emit('toggle-screen-share', { isSharing: true });

        setParticipants(prev => prev.map(p => {
          if (p.socketId === 'local') {
            return { ...p, isScreenSharing: true };
          }
          return p;
        }));

        // Listen for user stopping screen share via browser bar
        videoTrack.onended = () => {
          stopScreenSharing();
        };

      } catch (err) {
        console.error('Ekran paylaşımı başarısız oldu:', err);
      }
    } else {
      stopScreenSharing();
    }
  };

  const stopScreenSharing = () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
      screenStreamRef.current = null;
    }

    // Clean up AudioContext
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    audioDestinationRef.current = null;

    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      const audioTrack = localStreamRef.current.getAudioTracks()[0];

      // Revert tracks in all active calls
      Object.values(activeCalls.current).forEach(async (call: any) => {
        const senders = call.peerConnection.getSenders();
        
        // Revert video track to camera
        const videoSender = senders.find((s: any) => s.track && s.track.kind === 'video');
        if (videoSender && videoTrack) {
          await videoSender.replaceTrack(videoTrack);
          
          // Revert encoding parameters back to standard values
          try {
            const params = videoSender.getParameters();
            if (params.encodings && params.encodings.length > 0) {
              params.encodings[0].maxBitrate = 1500000; // Standard 1.5 Mbps camera
              params.encodings[0].priority = 'low';
              await videoSender.setParameters(params);
            }
          } catch (pErr) {
            console.warn(pErr);
          }
        }

        // Revert audio track to microphone
        const audioSender = senders.find((s: any) => s.track && s.track.kind === 'audio');
        if (audioSender && audioTrack) {
          await audioSender.replaceTrack(audioTrack);
        }
      });

      // Revert local state rendering stream
      setParticipants(prev => prev.map(p => {
        if (p.socketId === 'local') {
          return { ...p, stream: localStreamRef.current! };
        }
        return p;
      }));
    }

    setIsScreenSharing(false);

    socketRef.current?.emit('toggle-screen-share', { isSharing: false });

    setParticipants(prev => prev.map(p => {
      if (p.socketId === 'local') {
        return { ...p, isScreenSharing: false };
      }
      return p;
    }));
  };

  const handleSendMessage = (text: string) => {
    if (socketRef.current && text.trim()) {
      socketRef.current.emit('send-message', { roomId, text });
    }
  };

  return (
    <div className="room-container">
      {/* Toast Notification */}
      <div className={`toast-notification ${showCopiedToast ? 'show' : ''}`}>
        Davet linki panoya kopyalandı!
      </div>

      <div className="main-screen">
        {/* Header */}
        <header className="room-header">
          <div className="room-title">
            <span className="live-badge">Yayında</span>
            <div className="room-id-tag" onClick={copyRoomLink}>
              Oda ID: <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{roomId}</span> <Copy size={14} style={{ marginLeft: '4px', verticalAlign: 'middle' }} />
            </div>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-text-secondary)', fontSize: '0.9rem' }}>
            <Users size={16} />
            <span>{participants.length} Katılımcı</span>
          </div>
        </header>

        {/* Video stream feeds workspace */}
        <div className="video-workspace">
          <VideoGrid 
            participants={participants} 
            hostSocketId={hostSocketId} 
            mySocketId={socketRef.current?.id || ''}
          />
        </div>

        {/* Controls menu */}
        <Controls
          isAudioMuted={isAudioMuted}
          isVideoMuted={isVideoMuted}
          isScreenSharing={isScreenSharing}
          isChatOpen={isChatOpen}
          toggleAudio={toggleAudio}
          toggleVideo={toggleVideo}
          toggleScreenShare={toggleScreenShare}
          toggleChat={() => setIsChatOpen(!isChatOpen)}
          onLeave={onLeave}
        />
      </div>

      {/* Slide-out Chat Pane */}
      {isChatOpen && (
        <Chat 
          messages={chatMessages} 
          onSendMessage={handleSendMessage} 
          myId={socketRef.current?.id || ''}
          onClose={() => setIsChatOpen(false)}
        />
      )}
    </div>
  );
};

export default Room;
