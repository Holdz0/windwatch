import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import io, { Socket } from 'socket.io-client';
import { Peer } from 'peerjs';
import { Copy, Users, Lock, Unlock, KeyRound } from 'lucide-react';
import VideoGrid from './VideoGrid';
import Chat from './Chat';
import Controls from './Controls';
import {
  createSilentAudioTrack,
  createBlackVideoTrack,
  stopMediaTrack,
  getSharedAudioContext
} from '../utils/audio';
import {
  SCREEN_SHARE_PRESETS,
  DEFAULT_SCREEN_QUALITY,
  MIN_SCREEN_BITRATE,
  CAMERA_ENCODING,
  buildDisplayMediaConstraints,
  applyVideoEncoding,
  screenEncodingFor,
  getDisplaySurface,
  canMixSystemAudio,
  SYSTEM_AUDIO_ECHO_WARNING
} from '../utils/screenShare';
import type { ScreenShareQuality, ScreenShareStats } from '../utils/screenShare';

interface RoomProps {
  roomId: string;
  username: string;
  initialPassword: string | null;
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

// File-offer chat messages: "[FILE]" prefix followed by JSON metadata.
// JSON is used instead of a pipe-delimited format so file names containing
// special characters can't break parsing; the id decouples lookups from names.
export const FILE_MESSAGE_PREFIX = '[FILE]';

export interface SharedFileMeta {
  id: string;
  name: string;
  size: number;
  type: string;
}

export function parseFileMessage(text: string): SharedFileMeta | null {
  if (!text.startsWith(FILE_MESSAGE_PREFIX)) return null;
  try {
    const meta = JSON.parse(text.slice(FILE_MESSAGE_PREFIX.length));
    if (meta && typeof meta.id === 'string' && typeof meta.name === 'string') {
      return {
        id: meta.id,
        name: meta.name,
        size: Number(meta.size) || 0,
        type: typeof meta.type === 'string' ? meta.type : ''
      };
    }
  } catch {
    // malformed metadata falls through to plain-text rendering
  }
  return null;
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? 'http://localhost:5000' : window.location.origin);

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

const playNotificationSound = () => {
  try {
    const ctx = getSharedAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08);

    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch (err) {
    // ignore audio block
  }
};

const Room: React.FC<RoomProps> = ({ roomId, username, initialPassword, onLeave }) => {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  const [isAudioMuted, setIsAudioMuted] = useState(true);
  const [isVideoMuted, setIsVideoMuted] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(true);

  // Screen share tuning: the preset drives capture constraints and encoder behaviour,
  // and the live stats let the sharer see what viewers are actually receiving.
  const [screenQuality, setScreenQuality] = useState<ScreenShareQuality>(DEFAULT_SCREEN_QUALITY);
  const [screenShareStats, setScreenShareStats] = useState<ScreenShareStats | null>(null);

  // Immersive landscape stage.
  // Turning a phone sideways during a screen share used to keep the 64px header and
  // 80px control bar, which eat ~40% of a ~375px-tall viewport. When the viewport is
  // short and landscape we hand the whole screen to the stream and let the chrome
  // auto-hide, the way a video player does.
  const [isShortLandscape, setIsShortLandscape] = useState(false);
  const [isChromeHidden, setIsChromeHidden] = useState(false);
  const chromeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape) and (max-height: 550px)');
    const update = () => setIsShortLandscape(mq.matches);
    update();
    // The matchMedia 'change' event alone is not dependable across mobile
    // browsers when a device is rotated, so resize/orientationchange are used
    // as belt-and-braces — all three funnel into the same evaluation.
    mq.addEventListener('change', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      mq.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 640);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [hostSocketId, setHostSocketId] = useState<string | null>(null);
  const [showCopiedToast, setShowCopiedToast] = useState(false);

  // Non-fatal warning toast (rate limits etc.) — these must NOT kick the user out of the room
  const [warningToast, setWarningToast] = useState<string | null>(null);
  const warningTimerRef = useRef<number | null>(null);
  const showWarning = (msg: string) => {
    setWarningToast(msg);
    if (warningTimerRef.current) window.clearTimeout(warningTimerRef.current);
    warningTimerRef.current = window.setTimeout(() => setWarningToast(null), 3500);
  };
  useEffect(() => {
    return () => {
      if (warningTimerRef.current) window.clearTimeout(warningTimerRef.current);
    };
  }, []);

  // Password & Locking state
  const [password, setPassword] = useState<string | null>(initialPassword);
  const [isPasswordPromptOpen, setIsPasswordPromptOpen] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isRoomLocked, setIsRoomLocked] = useState(false);

  // Network stats state
  const [connectionStats, setConnectionStats] = useState<Record<string, { rtt: number; packetLoss: number }>>({});

  // Document PiP Chat Window state
  const [pipWindow, setPipWindow] = useState<Window | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  // Screen share encoder state, kept in refs so the stats loop and late-joiner
  // call setup can read the current values without re-subscribing.
  const screenQualityRef = useRef<ScreenShareQuality>(DEFAULT_SCREEN_QUALITY);
  useEffect(() => {
    screenQualityRef.current = screenQuality;
  }, [screenQuality]);

  // Bitrate actually in use — adapted downwards when the network can't keep up
  const activeBitrateRef = useRef<number>(SCREEN_SHARE_PRESETS[DEFAULT_SCREEN_QUALITY].maxBitrate);
  const prevOutboundRef = useRef<{ bytes: number; timestamp: number } | null>(null);

  // Mic + system audio mixer nodes on the shared AudioContext
  const mixerRef = useRef<{
    micSource: MediaStreamAudioSourceNode;
    screenSource: MediaStreamAudioSourceNode;
    dest: MediaStreamAudioDestinationNode;
  } | null>(null);
  const audioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  // File sharing refs (keyed by generated file id, so same-named files can't collide)
  const localSharedFilesRef = useRef<Record<string, File>>({});

  // Track active calls in a ref so we can close or modify them dynamically
  // Key: socketId, Value: PeerJS Call object
  const activeCalls = useRef<Record<string, any>>({});
  const socketUsersRef = useRef<Set<string>>(new Set());
  // Peer IDs of room members, used to authorize incoming file-transfer connections
  const allowedPeerIdsRef = useRef<Set<string>>(new Set());
  // True once we have successfully joined at least once (enables rejoin on reconnect)
  const hasJoinedRef = useRef(false);

  // Refs mirroring the latest state values for asynchronous handlers
  const passwordRef = useRef<string | null>(initialPassword);
  useEffect(() => {
    passwordRef.current = password;
  }, [password]);

  const isAudioMutedRef = useRef(isAudioMuted);
  useEffect(() => {
    isAudioMutedRef.current = isAudioMuted;
  }, [isAudioMuted]);

  const isVideoMutedRef = useRef(isVideoMuted);
  useEffect(() => {
    isVideoMutedRef.current = isVideoMuted;
  }, [isVideoMuted]);

  // onLeave lives in a ref so a re-render of App can't tear down and rebuild
  // the whole connection effect below.
  const onLeaveRef = useRef(onLeave);
  useEffect(() => {
    onLeaveRef.current = onLeave;
  }, [onLeave]);

  const pipWindowRef = useRef<Window | null>(null);
  useEffect(() => {
    pipWindowRef.current = pipWindow;
  }, [pipWindow]);

  // Clean up PiP window on unmount
  useEffect(() => {
    return () => {
      if (pipWindowRef.current) {
        pipWindowRef.current.close();
      }
    };
  }, []);

  // Request desktop notification permission on the first user gesture —
  // requesting without a gesture is ignored or auto-blocked by modern browsers.
  useEffect(() => {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    const request = () => {
      Notification.requestPermission();
    };
    document.addEventListener('click', request, { once: true });
    return () => document.removeEventListener('click', request);
  }, []);

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

  const updateLocalParticipant = (patch: Partial<Participant>) => {
    setParticipants(prev => prev.map(p => (p.socketId === 'local' ? { ...p, ...patch } : p)));
  };

  const emitMediaState = (state: { isAudioMuted?: boolean; isVideoMuted?: boolean }) => {
    socketRef.current?.emit('media-state', state);
  };

  const replaceAudioSenders = (track: MediaStreamTrack) => {
    Object.values(activeCalls.current).forEach((call: any) => {
      const senders = call.peerConnection.getSenders();
      const audioSender = senders.find((s: any) => s.track && s.track.kind === 'audio');
      if (audioSender) audioSender.replaceTrack(track);
    });
  };

  const replaceVideoSenders = (track: MediaStreamTrack) => {
    Object.values(activeCalls.current).forEach((call: any) => {
      const senders = call.peerConnection.getSenders();
      const videoSender = senders.find((s: any) => s.track && s.track.kind === 'video');
      if (videoSender) videoSender.replaceTrack(track);
    });
  };

  const getVideoSender = (call: any): RTCRtpSender | undefined => {
    if (!call || !call.peerConnection) return undefined;
    return call.peerConnection
      .getSenders()
      .find((s: RTCRtpSender) => s.track && s.track.kind === 'video');
  };

  // Applies the current screen-share encoder profile to one call.
  // A freshly created PeerJS call may not have its senders yet, so retry briefly —
  // without this, anyone joining mid-share received the default (low) bitrate.
  const applyScreenEncodingToCall = (call: any, attempt = 0) => {
    if (!screenStreamRef.current) return;

    const sender = getVideoSender(call);
    if (!sender) {
      if (attempt < 10) setTimeout(() => applyScreenEncodingToCall(call, attempt + 1), 400);
      return;
    }

    const preset = SCREEN_SHARE_PRESETS[screenQualityRef.current];
    applyVideoEncoding(sender, screenEncodingFor(preset, activeBitrateRef.current));
  };

  const applyScreenEncodingToAllCalls = () => {
    Object.values(activeCalls.current).forEach((call: any) => applyScreenEncodingToCall(call));
  };

  // Restores the modest camera profile on every call when a share ends
  const restoreCameraEncoding = () => {
    Object.values(activeCalls.current).forEach((call: any) => {
      const sender = getVideoSender(call);
      if (sender) applyVideoEncoding(sender, CAMERA_ENCODING);
    });
  };

  const teardownMixer = () => {
    const m = mixerRef.current;
    if (m) {
      try { m.micSource.disconnect(); } catch { /* already disconnected */ }
      try { m.screenSource.disconnect(); } catch { /* already disconnected */ }
    }
    mixerRef.current = null;
    audioDestinationRef.current = null;
  };

  // (Re)builds the mic + system-audio mixer on the shared AudioContext.
  // Returns the mixed track, or null when there is no screen audio to mix.
  const buildMixer = (): MediaStreamTrack | null => {
    teardownMixer();
    if (
      !screenStreamRef.current ||
      screenStreamRef.current.getAudioTracks().length === 0 ||
      !localStreamRef.current
    ) {
      return null;
    }
    try {
      const ctx = getSharedAudioContext();
      const micSource = ctx.createMediaStreamSource(localStreamRef.current);
      const screenSource = ctx.createMediaStreamSource(screenStreamRef.current);
      const dest = ctx.createMediaStreamDestination();
      micSource.connect(dest);
      screenSource.connect(dest);
      mixerRef.current = { micSource, screenSource, dest };
      audioDestinationRef.current = dest;
      return dest.stream.getAudioTracks()[0] || null;
    } catch (err) {
      console.warn('Could not mix audio streams, falling back to mic audio only:', err);
      return null;
    }
  };

  // Replaces the current mic track with a synthetic silent one and syncs peers.
  // Shared by the mute button and host-initiated remote mute.
  const muteLocalAudio = () => {
    if (!localStreamRef.current) return;

    const oldAudioTrack = localStreamRef.current.getAudioTracks()[0];
    stopMediaTrack(oldAudioTrack);
    if (oldAudioTrack) localStreamRef.current.removeTrack(oldAudioTrack);

    const silentAudioTrack = createSilentAudioTrack();
    localStreamRef.current.addTrack(silentAudioTrack);

    if (screenStreamRef.current) {
      const mixed = buildMixer();
      replaceAudioSenders(mixed ?? silentAudioTrack);
    } else {
      replaceAudioSenders(silentAudioTrack);
    }

    setIsAudioMuted(true);
    updateLocalParticipant({ isAudioMuted: true });
    emitMediaState({ isAudioMuted: true });
  };

  // Replaces the current camera track with a synthetic black one and syncs peers.
  const muteLocalVideo = () => {
    if (!localStreamRef.current) return;

    const oldVideoTrack = localStreamRef.current.getVideoTracks()[0];
    stopMediaTrack(oldVideoTrack);
    if (oldVideoTrack) localStreamRef.current.removeTrack(oldVideoTrack);

    const blackVideoTrack = createBlackVideoTrack();
    localStreamRef.current.addTrack(blackVideoTrack);

    if (!screenStreamRef.current) {
      replaceVideoSenders(blackVideoTrack);
    }

    setIsVideoMuted(true);
    updateLocalParticipant({ isVideoMuted: true, stream: getActiveStream() });
    emitMediaState({ isVideoMuted: true });
  };

  // Timer to fetch WebRTC statistics every 4 seconds
  useEffect(() => {
    const statsTimer = setInterval(async () => {
      const calls = Object.entries(activeCalls.current);
      if (calls.length === 0) {
        // Avoid a re-render every tick when idle
        setConnectionStats(prev => (Object.keys(prev).length ? {} : prev));
        return;
      }

      const statsMap: Record<string, { rtt: number; packetLoss: number }> = {};

      // Aggregated outbound telemetry for an active screen share
      const isSharing = !!screenStreamRef.current;
      let outWidth = 0;
      let outHeight = 0;
      let outFps = 0;
      let outBytes = 0;
      let outTimestamp = 0;
      let limitation = 'none';
      let sawOutbound = false;

      for (const [socketId, call] of calls) {
        if (call && call.peerConnection) {
          try {
            const stats = await call.peerConnection.getStats();
            let rtt = 0;
            let packetLoss = 0;

            stats.forEach((report: any) => {
              if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                if (typeof report.currentRoundTripTime === 'number') {
                  rtt = Math.round(report.currentRoundTripTime * 1000);
                }
              }
              if (report.type === 'inbound-rtp' && report.mediaType === 'video') {
                const packetsLost = report.packetsLost || 0;
                const packetsReceived = report.packetsReceived || 1;
                packetLoss = Math.round((packetsLost / (packetsLost + packetsReceived)) * 100);
              }
              // Outbound video: what viewers are actually being sent right now
              if (isSharing && report.type === 'outbound-rtp' && (report.kind || report.mediaType) === 'video') {
                sawOutbound = true;
                outWidth = Math.max(outWidth, report.frameWidth || 0);
                outHeight = Math.max(outHeight, report.frameHeight || 0);
                outFps = Math.max(outFps, Math.round(report.framesPerSecond || 0));
                outBytes += report.bytesSent || 0;
                outTimestamp = Math.max(outTimestamp, report.timestamp || 0);
                const reason = report.qualityLimitationReason;
                if (reason && reason !== 'none') limitation = reason;
              }
            });

            statsMap[socketId] = { rtt, packetLoss };
          } catch (err) {
            // ignore stats retrieval errors
          }
        }
      }

      setConnectionStats(statsMap);

      if (!isSharing) {
        setScreenShareStats(prev => (prev ? null : prev));
        prevOutboundRef.current = null;
      } else if (sawOutbound) {
        // bytes * 8 / milliseconds is already kilobits per second
        const prev = prevOutboundRef.current;
        let kbps = 0;
        if (prev && outTimestamp > prev.timestamp) {
          kbps = ((outBytes - prev.bytes) * 8) / (outTimestamp - prev.timestamp);
        }
        prevOutboundRef.current = { bytes: outBytes, timestamp: outTimestamp };

        setScreenShareStats({
          width: outWidth,
          height: outHeight,
          fps: outFps,
          kbps: Math.max(0, Math.round(kbps)),
          limitation
        });

        // Adaptive bitrate: back off when the network is the bottleneck, then
        // creep back up once the encoder stops reporting a limitation.
        const preset = SCREEN_SHARE_PRESETS[screenQualityRef.current];
        const current = activeBitrateRef.current;
        let next = current;

        if (limitation === 'bandwidth') {
          next = Math.max(MIN_SCREEN_BITRATE, Math.round(current * 0.75));
        } else if (limitation === 'none' && current < preset.maxBitrate) {
          next = Math.min(preset.maxBitrate, Math.round(current * 1.15));
        }

        if (Math.abs(next - current) / current > 0.05) {
          activeBitrateRef.current = next;
          applyScreenEncodingToAllCalls();
        }
      }
    }, 4000);

    return () => clearInterval(statsTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          stream.getTracks().forEach(track => stopMediaTrack(track));
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
          socket?.emit('join-room', { roomId, peerId, username, password: passwordRef.current });
        });

        // 4.2. Rejoin after a transient socket drop: Socket.io reconnects with a NEW
        // socket id, so without re-emitting join-room the server considers us gone
        // while the UI still shows the room (ghost session).
        socket.on('connect', () => {
          if (isCancelled) return;
          if (hasJoinedRef.current && peer?.id) {
            console.log('Socket reconnected, rejoining room...');
            socket?.emit('join-room', { roomId, peerId: peer.id, username, password: passwordRef.current });
          }
        });

        // 4.3. Recover the PeerJS signalling connection if it drops
        peer.on('disconnected', () => {
          if (isCancelled) return;
          try {
            peer?.reconnect();
          } catch (err) {
            console.warn('PeerJS reconnect failed:', err);
          }
        });

        // 4.5. Handle incoming P2P file transfer connection requests
        peer.on('connection', (conn) => {
          if (conn.label !== 'file-transfer') return;

          // Only serve files to peers that are actually members of this room
          if (!allowedPeerIdsRef.current.has(conn.peer)) {
            console.warn(`Blocked file-transfer connection from unknown peer: ${conn.peer}`);
            conn.on('open', () => conn.close());
            return;
          }

          conn.on('data', (data: any) => {
            if (data && data.type === 'request-file' && typeof data.fileId === 'string') {
              const file = localSharedFilesRef.current[data.fileId];
              if (file) {
                // Send file directly via PeerJS data channel
                conn.send({ type: 'file-response', fileId: data.fileId, file });
              } else {
                // Tell the requester explicitly instead of leaving them waiting forever
                conn.send({ type: 'file-error', fileId: data.fileId });
              }
            }
          });
        });

        // 5. Peer incoming call handler (answering calls from others)
        peer.on('call', (call) => {
          if (isCancelled) return;
          console.log(`Receiving call from Peer: ${call.peer}`);
          const callerSocketId = call.metadata?.callerSocketId;

          const answerCall = () => {
            if (isCancelled || !localStream) return;
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

            if (callerSocketId) {
              activeCalls.current[callerSocketId] = call;
            }
          };

          // SECURITY CHECK with retry: reject calls from Peer IDs not mapped to room members.
          // The whitelist is filled by the room-users event, which can arrive AFTER the
          // first incoming call (join broadcast race) — so retry briefly instead of
          // permanently rejecting a legitimate call with no recovery path.
          const tryAuthorize = (attempt: number) => {
            if (isCancelled) return;
            if (callerSocketId && socketUsersRef.current.has(callerSocketId)) {
              answerCall();
            } else if (attempt < 10) {
              setTimeout(() => tryAuthorize(attempt + 1), 500);
            } else {
              console.warn(`Blocked unauthorized PeerJS call from socketId: ${callerSocketId}`);
              call.close();
            }
          };
          tryAuthorize(0);
        });

        // 6. Socket room users list synchronization
        socket.on('room-users', ({ roomUsers, hostSocketId: currentHostSocketId }) => {
          if (isCancelled) return;
          console.log('Room users updated from server:', roomUsers);
          hasJoinedRef.current = true;
          setHostSocketId(currentHostSocketId);
          // A successful join settles any pending password prompt
          setIsPasswordPromptOpen(false);
          setPasswordError(null);

          // Update active socket users / peer id whitelist caches
          socketUsersRef.current.clear();
          allowedPeerIdsRef.current.clear();
          roomUsers.forEach((u: any) => {
            if (u.socketId !== socket?.id) {
              socketUsersRef.current.add(u.socketId);
              if (u.peerId) allowedPeerIdsRef.current.add(u.peerId);
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
                    isScreenSharing: u.isScreenSharing,
                    isAudioMuted: u.isAudioMuted,
                    isVideoMuted: u.isVideoMuted,
                    stream: existing?.stream // Preserve existing stream if available
                  };
                })
            ];
          });
        });

        // 7. Socket user connected (an existing user calls this new user)
        socket.on('user-connected', ({ socketId, peerId, username: newUsername, isHost: isNewUserHost, isAudioMuted: newUserAudioMuted, isVideoMuted: newUserVideoMuted }) => {
          if (isCancelled) return;
          console.log(`New user connected: ${newUsername} (${socketId})`);

          // Whitelist new socket user + peer id
          socketUsersRef.current.add(socketId);
          if (peerId) allowedPeerIdsRef.current.add(peerId);

          // Add to participant list first (as loader or just tag)
          setParticipants(prev => {
            if (prev.some(p => p.socketId === socketId)) return prev;
            return [...prev, {
              socketId,
              peerId,
              username: newUsername,
              isHost: isNewUserHost,
              isAudioMuted: newUserAudioMuted ?? true,
              isVideoMuted: newUserVideoMuted ?? true
            }];
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

            // If a screen share is already running, this new peer must get the
            // screen-share encoder profile too — otherwise late joiners see a
            // blurry, low-bitrate version of the share.
            if (screenStreamRef.current) {
              applyScreenEncodingToCall(call);
            }
          }
        });

        // 8. Socket chat message listener
        socket.on('receive-message', (message: ChatMessage) => {
          if (isCancelled) return;
          setChatMessages(prev => [...prev, message]);

          // Trigger notification & sound if tab is backgrounded / user is elsewhere (like during screen share)
          const isMe = message.senderId === socket?.id;
          const isSystem = message.senderId === 'system';
          if (!isMe && !isSystem && !document.hasFocus()) {
            playNotificationSound();
            if ('Notification' in window && Notification.permission === 'granted') {
              const fileMeta = parseFileMessage(message.text);
              const textToShow = fileMeta ? `📁 Dosya paylaştı: ${fileMeta.name}` : message.text;
              new Notification(message.senderName, {
                body: textToShow,
                tag: 'windwatch-chat',
                silent: true // Since we play our own synthesized sound
              });
            }
          }
        });

        // 8.2. Socket message history initialization
        socket.on('room-history', (history: ChatMessage[]) => {
          if (isCancelled) return;
          setChatMessages(history);
        });

        // 8.4. Socket password required query
        socket.on('password-required', () => {
          if (isCancelled) return;
          // If we actually sent a password and were still rejected, it was wrong
          if (passwordRef.current) {
            setPasswordError('Şifre yanlış. Lütfen tekrar deneyin.');
          }
          setIsPasswordPromptOpen(true);
        });

        // 8.6. Socket room lock state listener
        socket.on('room-locked-status', ({ isLocked }: { isLocked: boolean }) => {
          if (isCancelled) return;
          setIsRoomLocked(isLocked);
        });

        // 8.8. Socket kicked event
        socket.on('kicked', (msg: string) => {
          if (isCancelled) return;
          alert(msg);
          onLeaveRef.current();
        });

        // 8.9. Remote mute request listener (Host muting us)
        socket.on('mute-user-request', ({ trackKind }: { trackKind: 'audio' | 'video' }) => {
          if (isCancelled) return;
          if (trackKind === 'audio') {
            if (!isAudioMutedRef.current) {
              muteLocalAudio();
            }
            showWarning('Oda kurucusu mikrofonunuzu kapattı.');
          } else if (trackKind === 'video') {
            if (!isVideoMutedRef.current) {
              muteLocalVideo();
            }
            showWarning('Oda kurucusu kameranızı kapattı.');
          }
        });

        // 9. Socket user disconnected cleanup
        socket.on('user-disconnected', ({ socketId }) => {
          if (isCancelled) return;
          console.log(`Participant left room: ${socketId}`);

          // Remove from whitelists
          socketUsersRef.current.delete(socketId);
          setParticipants(prev => {
            const leaving = prev.find(p => p.socketId === socketId);
            if (leaving?.peerId) allowedPeerIdsRef.current.delete(leaving.peerId);
            return prev.filter(p => p.socketId !== socketId);
          });

          // Close WebRTC call
          if (activeCalls.current[socketId]) {
            activeCalls.current[socketId].close();
            delete activeCalls.current[socketId];
          }
        });

        // 10. Fatal errors: leave the room. Non-fatal issues arrive on 'warning-msg'.
        socket.on('error-msg', (msg) => {
          if (isCancelled) return;
          alert(`Hata: ${msg}`);
          onLeaveRef.current();
        });

        // 10.5. Non-fatal warnings (rate limits etc.) — show a toast, stay in the room
        socket.on('warning-msg', (msg: string) => {
          if (isCancelled) return;
          showWarning(msg);
        });

      } catch (err) {
        if (isCancelled) return;
        console.error('Media stream or connection initialization failed:', err);
        alert('Bağlantı kurulamadı. Lütfen tekrar deneyin.');
        onLeaveRef.current();
      }
    };

    initConnections();

    // Cleanup everything on unmount
    return () => {
      isCancelled = true;
      console.log('Cleaning up room connections...');

      // Stop all tracks in camera stream
      if (localStream) {
        (localStream as MediaStream).getTracks().forEach(track => stopMediaTrack(track));
      }

      // Stop all tracks in screen stream
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(track => track.stop());
        screenStreamRef.current = null;
      }

      // Tear down the audio mixer nodes
      teardownMixer();

      // Close all PeerJS calls
      Object.values(activeCalls.current).forEach((call: any) => call.close());
      activeCalls.current = {};

      // Disconnect socket
      if (socket) {
        (socket as Socket).disconnect();
      }

      // Destroy peerJS
      if (peer) {
        (peer as Peer).destroy();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, username]);

  // Copy invitation link to clipboard
  const copyRoomLink = () => {
    const inviteUrl = `${window.location.origin}/room/${encodeURIComponent(roomId)}`;
    navigator.clipboard.writeText(inviteUrl).then(() => {
      setShowCopiedToast(true);
      setTimeout(() => setShowCopiedToast(false), 2500);
    });
  };

  // Toggle Audio track status
  const toggleAudio = async () => {
    if (!localStreamRef.current) return;

    if (isAudioMuted) {
      // Turn on microphone
      try {
        // Echo cancellation is requested explicitly rather than left to the
        // browser default: without it the mic picks the other participants back
        // up from this machine's speakers and returns it to them.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        const realAudioTrack = stream.getAudioTracks()[0];
        if (!realAudioTrack) return;

        const oldAudioTrack = localStreamRef.current.getAudioTracks()[0];
        stopMediaTrack(oldAudioTrack);
        if (oldAudioTrack) localStreamRef.current.removeTrack(oldAudioTrack);
        localStreamRef.current.addTrack(realAudioTrack);

        if (screenStreamRef.current) {
          // Re-mix system audio with the new hardware mic track
          const mixed = buildMixer();
          replaceAudioSenders(mixed ?? realAudioTrack);
        } else {
          replaceAudioSenders(realAudioTrack);
        }

        setIsAudioMuted(false);
        updateLocalParticipant({ isAudioMuted: false });
        emitMediaState({ isAudioMuted: false });
      } catch (err) {
        console.error('Mikrofon erişimi alınamadı:', err);
        alert('Mikrofon erişim izni verilmedi.');
      }
    } else {
      // Turn off microphone: stop hardware track to release recording indicator
      muteLocalAudio();
    }
  };

  // Toggle Video track status
  const toggleVideo = async () => {
    if (!localStreamRef.current) return;

    if (isVideoMuted) {
      // Turn on camera
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const realVideoTrack = stream.getVideoTracks()[0];
        if (!realVideoTrack) return;

        const oldVideoTrack = localStreamRef.current.getVideoTracks()[0];
        stopMediaTrack(oldVideoTrack);
        if (oldVideoTrack) localStreamRef.current.removeTrack(oldVideoTrack);
        localStreamRef.current.addTrack(realVideoTrack);

        // Replace track in active calls (screen share video has priority while active)
        if (!screenStreamRef.current) {
          replaceVideoSenders(realVideoTrack);
        }

        setIsVideoMuted(false);
        updateLocalParticipant({ isVideoMuted: false, stream: getActiveStream() });
        emitMediaState({ isVideoMuted: false });
      } catch (err) {
        console.error('Kamera erişimi alınamadı:', err);
        alert('Kamera erişim izni verilmedi.');
      }
    } else {
      // Turn off camera: stop hardware track to release green light
      muteLocalVideo();
    }
  };

  // Screen Sharing logic: requests display stream and updates the tracks inside active peer calls
  const toggleScreenShare = async () => {
    if (isScreenSharing) {
      stopScreenSharing();
      return;
    }

    const preset = SCREEN_SHARE_PRESETS[screenQualityRef.current];
    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getDisplayMedia(
        buildDisplayMediaConstraints(preset) as any
      );
    } catch (err: any) {
      // The user cancelling the picker also lands here — never treat that as a failure
      if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
        return;
      }
      // Some browsers reject the richer constraint set (extra hints, audio constraints);
      // fall back to the minimal form rather than losing screen sharing entirely.
      console.warn('Gelişmiş ekran yakalama kısıtları reddedildi, temel ayarlara dönülüyor:', err);
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } catch (fallbackErr: any) {
        if (fallbackErr?.name !== 'NotAllowedError' && fallbackErr?.name !== 'AbortError') {
          console.error('Ekran paylaşımı başlatılamadı:', fallbackErr);
          showWarning('Ekran paylaşımı başlatılamadı.');
        }
        return;
      }
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }

    // The server enforces a single active sharer; ask before we rewire anything
    const ack: any = await new Promise((resolve) => {
      const socket = socketRef.current;
      if (!socket) return resolve({ ok: false, reason: 'no-socket' });
      const timer = setTimeout(() => resolve({ ok: true, timedOut: true }), 4000);
      socket.emit('toggle-screen-share', { isSharing: true }, (response: any) => {
        clearTimeout(timer);
        resolve(response || { ok: true });
      });
    });

    if (!ack.ok) {
      // Denied (someone else is sharing) — release the capture we just took
      stream.getTracks().forEach(t => t.stop());
      return;
    }

    // Drop system audio that would feed the call back to the people in it.
    // Capturing a whole screen takes the machine's entire audio output, which
    // includes the remote participants being played here, so mixing it makes
    // everyone hear their own voice returned through the share.
    const capturedAudioTracks = stream.getAudioTracks();
    if (capturedAudioTracks.length > 0 && !canMixSystemAudio(getDisplaySurface(videoTrack))) {
      capturedAudioTracks.forEach(track => {
        track.onended = null;
        track.stop();
        stream.removeTrack(track);
      });
      showWarning(SYSTEM_AUDIO_ECHO_WARNING);
    }

    screenStreamRef.current = stream;
    activeBitrateRef.current = preset.maxBitrate;
    prevOutboundRef.current = null;

    if ('contentHint' in videoTrack) {
      videoTrack.contentHint = preset.contentHint;
    }

    // Mix system audio with microphone if the screen stream has audio
    const mixedAudioTrack = buildMixer();
    if (mixedAudioTrack) {
      console.log('System audio mixed successfully with microphone.');
    }

    // Swap tracks + encoder profile on every active call
    await Promise.all(
      Object.values(activeCalls.current).map(async (call: any) => {
        const senders = call.peerConnection.getSenders();

        const videoSender = senders.find((s: any) => s.track && s.track.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(videoTrack);
          await applyVideoEncoding(videoSender, screenEncodingFor(preset, preset.maxBitrate));
        }

        if (mixedAudioTrack) {
          const audioSender = senders.find((s: any) => s.track && s.track.kind === 'audio');
          if (audioSender) await audioSender.replaceTrack(mixedAudioTrack);
        }
      })
    );

    setIsScreenSharing(true);
    updateLocalParticipant({ isScreenSharing: true, stream: getActiveStream() });

    // Stopping via the browser's own "Stop sharing" bar
    videoTrack.onended = () => {
      stopScreenSharing();
    };

    // Losing just the system-audio track (e.g. switching surfaces) must not kill
    // the share — rebuild the mixer so the microphone keeps flowing.
    const screenAudioTrack = stream.getAudioTracks()[0];
    if (screenAudioTrack) {
      screenAudioTrack.onended = () => {
        if (!screenStreamRef.current) return;
        buildMixer();
        const fallback =
          audioDestinationRef.current?.stream.getAudioTracks()[0] ||
          localStreamRef.current?.getAudioTracks()[0];
        if (fallback) replaceAudioSenders(fallback);
      };
    }
  };

  // Switching quality mid-share: re-negotiate capture constraints and encoder profile
  // in place, so the viewer never loses the stream.
  const changeScreenQuality = async (quality: ScreenShareQuality) => {
    setScreenQuality(quality);
    screenQualityRef.current = quality;

    const preset = SCREEN_SHARE_PRESETS[quality];
    activeBitrateRef.current = preset.maxBitrate;

    const stream = screenStreamRef.current;
    if (!stream) return; // Not sharing yet — the preset applies at capture time

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      if ('contentHint' in videoTrack) videoTrack.contentHint = preset.contentHint;
      try {
        await videoTrack.applyConstraints({
          width: { max: preset.maxWidth },
          height: { max: preset.maxHeight },
          frameRate: { ideal: preset.frameRate, max: preset.frameRate }
        });
      } catch (err) {
        // The capture source may refuse to change; the encoder caps below still apply
        console.warn('Ekran yakalama kısıtları güncellenemedi:', err);
      }
    }

    applyScreenEncodingToAllCalls();
  };

  const stopScreenSharing = () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => {
        track.onended = null;
        track.stop();
      });
      screenStreamRef.current = null;
    }

    // Tear down the audio mixer
    teardownMixer();
    setScreenShareStats(null);
    prevOutboundRef.current = null;

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
          await applyVideoEncoding(videoSender, CAMERA_ENCODING);
        }

        // Revert audio track to microphone
        const audioSender = senders.find((s: any) => s.track && s.track.kind === 'audio');
        if (audioSender && audioTrack) {
          await audioSender.replaceTrack(audioTrack);
        }
      });
    } else {
      restoreCameraEncoding();
    }

    setIsScreenSharing(false);
    updateLocalParticipant({
      isScreenSharing: false,
      stream: localStreamRef.current ?? undefined
    });

    socketRef.current?.emit('toggle-screen-share', { isSharing: false });
  };

  const toggleChatPiP = async () => {
    if (pipWindow) {
      pipWindow.close();
      setPipWindow(null);
      return;
    }

    if ('documentPictureInPicture' in window) {
      try {
        const pip = await (window as any).documentPictureInPicture.requestWindow({
          width: 380,
          height: 550,
        });

        // Copy styles to Document PiP window
        Array.from(document.styleSheets).forEach((sheet) => {
          try {
            const rules = Array.from(sheet.cssRules).map(r => r.cssText).join('');
            const style = pip.document.createElement('style');
            style.textContent = rules;
            pip.document.head.appendChild(style);
          } catch (e) {
            const link = pip.document.createElement('link');
            link.rel = 'stylesheet';
            link.type = 'text/css';
            link.href = sheet.href || '';
            pip.document.head.appendChild(link);
          }
        });

        // Style body
        pip.document.body.className = 'pip-body';
        pip.document.body.style.background = '#080808';
        pip.document.body.style.margin = '0';
        pip.document.body.style.overflow = 'hidden';

        // Listen for PiP window closing
        pip.addEventListener('unload', () => {
          setPipWindow(null);
        });

        setPipWindow(pip);
      } catch (err) {
        console.error('Failed to detach chat window:', err);
      }
    } else {
      alert('Tarayıcınız Document Picture-in-Picture API desteğine sahip değil. Lütfen güncel Chrome veya Edge kullanın.');
    }
  };

  const handleSendMessage = (text: string) => {
    if (socketRef.current && text.trim()) {
      socketRef.current.emit('send-message', { roomId, text });
    }
  };

  const handleShareFile = (file: File) => {
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    localSharedFilesRef.current[fileId] = file;
    const meta: SharedFileMeta = { id: fileId, name: file.name, size: file.size, type: file.type };
    // Broadcast file offer metadata in chat channel
    handleSendMessage(`${FILE_MESSAGE_PREFIX}${JSON.stringify(meta)}`);
  };

  // Requests a shared file from its sender over a P2P data channel.
  // Resolves when the download completes; rejects on timeout, transfer errors,
  // or when the sender no longer has the file.
  const handleDownloadFile = (senderSocketId: string, fileMeta: SharedFileMeta): Promise<void> => {
    return new Promise((resolve, reject) => {
      const participant = participants.find(p => p.socketId === senderSocketId);
      if (!participant || !peerRef.current) {
        reject(new Error('Kullanıcı odada bulunamadı veya P2P bağlantısı kurulamıyor.'));
        return;
      }

      const conn = peerRef.current.connect(participant.peerId, { label: 'file-transfer' });

      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        try { conn.close(); } catch { /* already closed */ }
        if (err) reject(err); else resolve();
      };

      const timeoutId = window.setTimeout(
        () => finish(new Error('Dosya indirme zaman aşımına uğradı.')),
        60000
      );

      conn.on('open', () => {
        conn.send({ type: 'request-file', fileId: fileMeta.id });
      });

      conn.on('data', (data: any) => {
        if (!data) return;
        if (data.type === 'file-response' && data.fileId === fileMeta.id && data.file) {
          const blob = new Blob([data.file], { type: fileMeta.type || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fileMeta.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          finish();
        } else if (data.type === 'file-error') {
          finish(new Error('Gönderen bu dosyayı artık paylaşmıyor.'));
        }
      });

      conn.on('error', (err) => {
        console.error('File transfer connection error:', err);
        finish(new Error('Dosya indirilemedi. Lütfen tekrar deneyin.'));
      });
    });
  };

  const toggleLockRoom = () => {
    socketRef.current?.emit('toggle-lock-room');
  };

  const handleKickUser = (targetSocketId: string) => {
    if (confirm('Bu kullanıcıyı odadan atmak istediğinize emin misiniz?')) {
      socketRef.current?.emit('kick-user', { targetSocketId });
    }
  };

  const handleRemoteMute = (targetSocketId: string, trackKind: 'audio' | 'video') => {
    socketRef.current?.emit('mute-user-request', { targetSocketId, trackKind });
  };

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordInput.trim()) return;
    setPassword(passwordInput);
    setPasswordError(null);
    setIsPasswordPromptOpen(false);

    // Retry join-room
    socketRef.current?.emit('join-room', {
      roomId,
      peerId: peerRef.current?.id,
      username,
      password: passwordInput
    });
  };

  const hasActiveScreenShare = participants.some(p => p.isScreenSharing);
  const showMobileScreenShareChat = isMobile && hasActiveScreenShare && isChatOpen && !pipWindow;

  // A phone held sideways while someone is sharing gets the full-bleed player layout
  const isImmersiveStage = isShortLandscape && hasActiveScreenShare && !pipWindow;

  // Show the chrome briefly when the stage takes over so the controls stay
  // discoverable, then fade it away.
  useEffect(() => {
    if (chromeTimerRef.current) window.clearTimeout(chromeTimerRef.current);

    if (!isImmersiveStage) {
      setIsChromeHidden(false);
      return;
    }

    setIsChromeHidden(false);
    chromeTimerRef.current = window.setTimeout(() => setIsChromeHidden(true), 2500);

    return () => {
      if (chromeTimerRef.current) window.clearTimeout(chromeTimerRef.current);
    };
  }, [isImmersiveStage]);

  // Tapping the stage toggles the chrome, like tapping a video player
  const handleStageTap = () => {
    if (!isImmersiveStage) return;
    if (chromeTimerRef.current) window.clearTimeout(chromeTimerRef.current);

    setIsChromeHidden(prev => {
      const next = !prev;
      if (!next) {
        chromeTimerRef.current = window.setTimeout(() => setIsChromeHidden(true), 3500);
      }
      return next;
    });
  };

  // Only one member can share at a time; surface who is holding it
  const remoteSharer = participants.find(p => p.isScreenSharing && p.socketId !== 'local');

  const localIsHost = participants.find(p => p.socketId === 'local')?.isHost || (hostSocketId && socketRef.current?.id === hostSocketId);

  return (
    <div className={`room-container${isImmersiveStage ? ' immersive-stage' : ''}${isImmersiveStage && isChromeHidden ? ' chrome-hidden' : ''}`}>
      {/* Toast notifications — stacked so they never overlap or leave a gap */}
      <div className="toast-stack" aria-live="polite">
        {showCopiedToast && (
          <div className="toast-notification">Davet linki panoya kopyalandı!</div>
        )}
        {warningToast && (
          <div className="toast-notification warning">{warningToast}</div>
        )}
      </div>

      {/* Password Prompt Overlay */}
      {isPasswordPromptOpen && (
        <div className="password-prompt-overlay">
          <div className="password-prompt-card">
            <KeyRound size={32} className="password-icon" />
            <h3>Şifreli Oda</h3>
            <p>Bu odaya girmek için kurucusu tarafından belirlenen şifreyi yazın.</p>
            {passwordError && <div className="error-alert">{passwordError}</div>}
            <form onSubmit={handlePasswordSubmit}>
              <input
                type="password"
                className="form-input"
                placeholder="Oda Şifresi"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                autoFocus
                required
              />
              <div className="password-prompt-buttons">
                <button type="button" className="btn btn-secondary" onClick={onLeave}>Geri Dön</button>
                <button type="submit" className="btn btn-primary">Giriş Yap</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="main-screen">
        {/* Header */}
        <header className="room-header">
          <div className="room-title" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span className="live-badge">Yayında</span>
            {isRoomLocked && (
              <span className="lock-badge" title="Oda kilitli, yeni katılımcı giremez">
                <Lock size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} /> Kilitli
              </span>
            )}
            {localIsHost && (
              <button
                onClick={toggleLockRoom}
                className={`lock-room-btn ${isRoomLocked ? 'locked' : ''}`}
                title={isRoomLocked ? 'Odayı Girişlere Aç' : 'Odayı Girişlere Kilitle'}
              >
                {isRoomLocked ? <Unlock size={14} /> : <Lock size={14} />}
                <span>{isRoomLocked ? 'Kilidi Aç' : 'Odayı Kilitle'}</span>
              </button>
            )}
            <div className="room-id-tag" onClick={copyRoomLink}>
              <span className="room-id-label">Oda ID: </span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{roomId}</span> <Copy size={14} style={{ marginLeft: '4px', verticalAlign: 'middle' }} />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-text-secondary)', fontSize: '0.9rem' }}>
            <Users size={16} />
            <span>{participants.length} <span className="participant-label">Katılımcı</span></span>
          </div>
        </header>

        {/* Video stream feeds workspace */}
        <div
          className={`video-workspace ${showMobileScreenShareChat ? 'mobile-ss-chat-active' : ''}`}
          onClick={handleStageTap}
        >
          <VideoGrid
            participants={participants}
            hostSocketId={hostSocketId}
            mySocketId={socketRef.current?.id || ''}
            connectionStats={connectionStats}
            onKickUser={handleKickUser}
            onRemoteMute={handleRemoteMute}
            hideThumbnails={showMobileScreenShareChat}
            screenShareStats={screenShareStats}
          />
          {showMobileScreenShareChat && (
            <div className="mobile-chat-container">
              <Chat
                messages={chatMessages}
                onSendMessage={handleSendMessage}
                onShareFile={handleShareFile}
                onDownloadFile={handleDownloadFile}
                myId={socketRef.current?.id || ''}
                onClose={() => setIsChatOpen(false)}
                isPiP={false}
              />
            </div>
          )}
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
          screenQuality={screenQuality}
          onChangeScreenQuality={changeScreenQuality}
          screenShareBlockedBy={remoteSharer?.username}
        />
      </div>

      {/* Slide-out Chat Pane or popped out Document PiP */}
      {isChatOpen && !showMobileScreenShareChat && (
        pipWindow ? (
          createPortal(
            <Chat
              messages={chatMessages}
              onSendMessage={handleSendMessage}
              onShareFile={handleShareFile}
              onDownloadFile={handleDownloadFile}
              myId={socketRef.current?.id || ''}
              onClose={() => { pipWindow.close(); setPipWindow(null); }}
              isPiP={true}
            />,
            pipWindow.document.body
          )
        ) : (
          <>
            <div className="chat-backdrop" onClick={() => setIsChatOpen(false)} />
            <Chat
              messages={chatMessages}
              onSendMessage={handleSendMessage}
              onShareFile={handleShareFile}
              onDownloadFile={handleDownloadFile}
              myId={socketRef.current?.id || ''}
              onClose={() => setIsChatOpen(false)}
              onDetach={toggleChatPiP}
              isPiP={false}
            />
          </>
        )
      )}
    </div>
  );
};

export default Room;
