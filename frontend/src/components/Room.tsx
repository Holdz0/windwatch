import React, { useEffect, useRef, useState, useCallback } from 'react';
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
  getSharedAudioContext,
  primeAudioUnlock,
  resetAudioUnlock
} from '../utils/audio';
import { startWakeLock, stopWakeLock } from '../utils/wakeLock';
import { startCallMediaSession, updateCallMediaSession } from '../utils/mediaSession';
import { isMobileDevice, buildCameraConstraints } from '../utils/device';
import type { FacingMode } from '../utils/device';
import { watchCall, isCallDead, shouldInitiateCall, recallDelay } from '../utils/webrtcRecovery';
import { getClientId } from '../utils/session';
import {
  DEFAULT_SCREEN_QUALITY,
  DEFAULT_CUSTOM_SETTINGS,
  SCREEN_SHARE_PRESETS,
  CAMERA_ENCODING,
  buildDisplayMediaConstraints,
  applyVideoEncoding,
  screenEncodingFor,
  resolveScreenSharePreset,
  getDisplaySurface,
  canMixSystemAudio,
  SYSTEM_AUDIO_BLOCKED_HINT,
  DESKTOP_AUDIO_ECHO_HINT
} from '../utils/screenShare';
import type { ScreenShareQuality, ScreenShareStats, CustomScreenShareSettings } from '../utils/screenShare';

interface RoomProps {
  roomId: string;
  username: string;
  initialPassword: string | null;
  /** Leaves the room; `reason` is shown on the landing page when set. */
  onLeave: (reason?: string) => void;
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
  /** Their connection dropped; the server is holding their seat for a moment */
  isReconnecting?: boolean;
  /** Mirror the local preview — the convention for a front-facing camera.
   *  Only ever set on our own tile; remote peers see us unmirrored. */
  isMirrored?: boolean;
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

// Files are held in memory and shipped as one DataChannel message — cap them so
// a single upload can't pin both browsers.
export const MAX_SHARE_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export interface SharedFileMeta {
  id: string;
  name: string;
  size: number;
  type: string;
  /** Sharer's PeerJS id — stable across their socket reconnects, unlike the chat sender id */
  peerId?: string;
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
        type: typeof meta.type === 'string' ? meta.type : '',
        peerId: typeof meta.peerId === 'string' ? meta.peerId : undefined
      };
    }
  } catch {
    // malformed metadata falls through to plain-text rendering
  }
  return null;
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? 'http://localhost:5000' : window.location.origin);

// ICE servers for PeerJS. Google's public STUN is always included; a TURN relay
// is appended only when configured via env vars, since it costs real bandwidth.
function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];
  const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
  if (turnUrl) {
    servers.push({
      urls: turnUrl.split(',').map(u => u.trim()),
      username: import.meta.env.VITE_TURN_USERNAME as string | undefined,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined
    });
  }
  return servers;
}

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
      secure: url.protocol === 'https:',
      // STUN alone cannot connect users behind symmetric NATs — a TURN relay is
      // the only fallback that guarantees a connection. Set VITE_TURN_URL /
      // VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL to enable one (e.g. a
      // coturn instance or a metered provider like Cloudflare/metered.ca).
      config: buildIceServers()
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

  // Front/rear camera. Phones start on the front camera, the same as every
  // other call app. The ref mirrors it for use inside async handlers.
  const [facingMode, setFacingMode] = useState<FacingMode>('user');
  const facingModeRef = useRef<FacingMode>('user');
  useEffect(() => {
    facingModeRef.current = facingMode;
  }, [facingMode]);

  // Only worth offering the switch when the device actually has a second camera
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false);
  const [isSwitchingCamera, setIsSwitchingCamera] = useState(false);

  useEffect(() => {
    if (!isMobileDevice() || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;

    const detect = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setHasMultipleCameras(devices.filter(d => d.kind === 'videoinput').length > 1);
      } catch {
        // Enumeration blocked — leave the switch hidden rather than guessing
      }
    };

    detect();
    // Re-run whenever the camera is turned on: before permission is granted the
    // browser reports a redacted device list, which can undercount cameras.
    navigator.mediaDevices.addEventListener?.('devicechange', detect);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.('devicechange', detect);
    };
  }, [isVideoMuted]);

  // Screen share tuning: the preset drives capture constraints and encoder behaviour,
  // and the live stats let the sharer see what viewers are actually receiving.
  // The last quality the user picked is remembered across sessions.
  const [screenQuality, setScreenQuality] = useState<ScreenShareQuality>(() => {
    try {
      const saved = localStorage.getItem('windwatch:screenQuality');
      if (saved === 'custom' || (saved && saved in SCREEN_SHARE_PRESETS)) {
        return saved as ScreenShareQuality;
      }
    } catch {
      // storage unavailable — use the default
    }
    return DEFAULT_SCREEN_QUALITY;
  });
  const [screenShareStats, setScreenShareStats] = useState<ScreenShareStats | null>(null);

  // Manual resolution/fps/bitrate profile for the 'custom' quality option. The
  // numbers are remembered across sessions (tuning them once shouldn't need
  // repeating), independent of which quality happens to be selected on join.
  const [screenCustomSettings, setScreenCustomSettings] = useState<CustomScreenShareSettings>(() => {
    try {
      const raw = localStorage.getItem('windwatch:screenCustom');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          typeof parsed?.maxHeight === 'number' &&
          typeof parsed?.frameRate === 'number' &&
          typeof parsed?.maxBitrate === 'number'
        ) {
          return parsed;
        }
      }
    } catch {
      // corrupted/old-format storage — fall through to the default
    }
    return DEFAULT_CUSTOM_SETTINGS;
  });
  const screenCustomSettingsRef = useRef(screenCustomSettings);
  useEffect(() => {
    screenCustomSettingsRef.current = screenCustomSettings;
    try {
      localStorage.setItem('windwatch:screenCustom', JSON.stringify(screenCustomSettings));
    } catch {
      // storage unavailable (private mode) — the preference just won't persist
    }
  }, [screenCustomSettings]);

  // Opt-in for sharing desktop application audio (Steam/Discord/game sound).
  // It is the only way to capture a native app's sound, but it also captures the
  // call itself, so it stays off until the user asks for it. Remembered across
  // sessions because it is a deliberate, recurring preference.
  const [allowDesktopAudio, setAllowDesktopAudio] = useState(() => {
    try {
      return localStorage.getItem('windwatch:desktopAudio') === '1';
    } catch {
      return false;
    }
  });
  const allowDesktopAudioRef = useRef(allowDesktopAudio);
  useEffect(() => {
    allowDesktopAudioRef.current = allowDesktopAudio;
    try {
      localStorage.setItem('windwatch:desktopAudio', allowDesktopAudio ? '1' : '0');
    } catch {
      // storage unavailable (private mode) — the preference just won't persist
    }
  }, [allowDesktopAudio]);

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

  // Arm the automatic audio-playback unlock for this room session: the first
  // user gesture of any kind silently starts remote audio that the browser
  // blocked from autoplaying. No prompt or button — see utils/audio.ts.
  useEffect(() => {
    primeAudioUnlock();
    return resetAudioUnlock;
  }, []);

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
  const screenQualityRef = useRef<ScreenShareQuality>(screenQuality);
  useEffect(() => {
    screenQualityRef.current = screenQuality;
    try {
      localStorage.setItem('windwatch:screenQuality', screenQuality);
    } catch {
      // storage unavailable (private mode) — the preference just won't persist
    }
  }, [screenQuality]);

  // Previous outbound byte counter, for the sharer's live kbps readout
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

  // Active PeerJS calls keyed by the remote PEER id. Peer ids survive socket
  // reconnects (socket ids do not), so a signalling blip never touches media.
  const callsRef = useRef<Map<string, any>>(new Map());
  // Other room members (peerId -> info), straight from the server's list.
  // Also the whitelist for incoming calls and file-transfer connections.
  const membersRef = useRef<Map<string, { socketId: string; isReconnecting: boolean }>>(new Map());
  // Re-sends join-room from outside the connection effect (password prompt)
  const joinRoomRef = useRef<(() => void) | null>(null);

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

  // Keep the screen from sleeping/locking for the duration of the call —
  // otherwise mobile browsers dim and lock the screen mid-conversation even
  // though audio/video is actively streaming.
  useEffect(() => {
    startWakeLock();
    return stopWakeLock;
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

    // Audio: mixed (mic + system) when the mixer is active; otherwise the raw
    // screen audio during a share; otherwise the microphone / silent track
    if (audioDestinationRef.current) {
      const mixedAudioTrack = audioDestinationRef.current.stream.getAudioTracks()[0];
      if (mixedAudioTrack) tracks.push(mixedAudioTrack);
    } else if (screenStreamRef.current && screenStreamRef.current.getAudioTracks().length > 0) {
      tracks.push(screenStreamRef.current.getAudioTracks()[0]);
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

  const findSender = (call: any, kind: 'audio' | 'video'): RTCRtpSender | undefined => {
    if (!call || !call.peerConnection) return undefined;
    return call.peerConnection
      .getSenders()
      .find((s: RTCRtpSender) => s.track && s.track.kind === kind);
  };

  const replaceAudioSenders = (track: MediaStreamTrack) => {
    callsRef.current.forEach((call: any) => {
      findSender(call, 'audio')?.replaceTrack(track).catch(() => {});
    });
  };

  const replaceVideoSenders = (track: MediaStreamTrack) => {
    callsRef.current.forEach((call: any) => {
      findSender(call, 'video')?.replaceTrack(track).catch(() => {});
    });
  };

  const getVideoSender = (call: any) => findSender(call, 'video');

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

    const preset = resolveScreenSharePreset(screenQualityRef.current, screenCustomSettingsRef.current);
    applyVideoEncoding(sender, screenEncodingFor(preset));
  };

  const applyScreenEncodingToAllCalls = () => {
    callsRef.current.forEach((call: any) => applyScreenEncodingToCall(call));
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
      console.warn('Could not mix audio streams, falling back to raw share audio:', err);
      return null;
    }
  };

  // A mixer built on a still-suspended AudioContext outputs pure silence. In
  // practice the click that started the share resumes the context, but if it
  // has not come up shortly after, drop the mix and send the raw share audio —
  // total silence for every viewer is the one unacceptable outcome.
  const verifyMixerAlive = () => {
    window.setTimeout(() => {
      if (!mixerRef.current || !screenStreamRef.current) return;
      const ctx = getSharedAudioContext();
      if (ctx.state === 'running') return;
      console.warn('[windwatch-audio] AudioContext still suspended; switching to raw share audio.');
      teardownMixer();
      const raw = screenStreamRef.current.getAudioTracks()[0];
      if (raw) replaceAudioSenders(raw);
    }, 700);
  };

  // Picks (and wires up) the correct outgoing audio for the current state.
  //
  //   sharing + screen audio + mic LIVE   -> mixer(mic + share)
  //   sharing + screen audio + mic muted  -> RAW share audio track (no Web Audio
  //                                          in the path at all — this is the
  //                                          movie-night case and must be bulletproof)
  //   otherwise                           -> microphone / silent placeholder
  //
  // Returns the track every peer's audio sender should carry.
  const rebuildOutgoingAudio = (): MediaStreamTrack | null => {
    const screenAudio = screenStreamRef.current?.getAudioTracks()[0] ?? null;
    const micTrack = localStreamRef.current?.getAudioTracks()[0] ?? null;

    if (screenAudio) {
      if (!isAudioMutedRef.current && micTrack) {
        const mixed = buildMixer();
        if (mixed) {
          verifyMixerAlive();
          return mixed;
        }
        // Mixing unavailable: favour the share audio over the mic
        teardownMixer();
        return screenAudio;
      }
      teardownMixer();
      return screenAudio;
    }

    teardownMixer();
    return micTrack;
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

    // Muting must be reflected in the ref BEFORE choosing the outgoing audio,
    // so a running share keeps sending its raw audio instead of a mic mix
    isAudioMutedRef.current = true;
    replaceAudioSenders(rebuildOutgoingAudio() ?? silentAudioTrack);

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
      // getStats() on every peer connection is not free. While the tab is
      // hidden nobody can see the result, so skip the work entirely — this is
      // the single biggest background battery saving on mobile.
      if (document.hidden) return;

      // Keyed by remote peer id, matching Participant.peerId
      const calls = Array.from(callsRef.current.entries());
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

      for (const [peerId, call] of calls) {
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
              if (report.type === 'inbound-rtp' && (report.kind || report.mediaType) === 'video') {
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

            statsMap[peerId] = { rtt, packetLoss };
          } catch (err) {
            // ignore stats retrieval errors
          }
        }
      }

      // Only push new state when a number actually moved. RTT is quantised to
      // whole milliseconds and often repeats tick after tick, so bailing out
      // here removes most re-renders of the entire room tree.
      setConnectionStats(prev => {
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(statsMap);
        if (prevKeys.length === nextKeys.length) {
          const unchanged = nextKeys.every(k => {
            const a = prev[k];
            const b = statsMap[k];
            return a && b && a.rtt === b.rtt && a.packetLoss === b.packetLoss;
          });
          if (unchanged) return prev;
        }
        return statsMap;
      });

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
    const clientId = getClientId();

    // Calls closed on purpose (leaving, replaced by a newer call, member gone)
    // must not trigger recovery.
    const intentionallyClosed = new WeakSet<object>();
    // Per-peer re-dial bookkeeping
    const recallAttempts = new Map<string, number>();
    const recallTimers = new Map<string, number>();
    let peerReconnectTimer: number | null = null;
    let peerReconnectAttempts = 0;

    const log = (msg: string) => console.warn(`[windwatch-webrtc] ${msg}`);

    const closeCall = (peerId: string) => {
      const call = callsRef.current.get(peerId);
      if (call) {
        intentionallyClosed.add(call);
        try { call.close(); } catch { /* already closed */ }
        callsRef.current.delete(peerId);
      }
      const timer = recallTimers.get(peerId);
      if (timer !== undefined) window.clearTimeout(timer);
      recallTimers.delete(peerId);
    };

    const closeAllCalls = () => {
      Array.from(callsRef.current.keys()).forEach(closeCall);
      recallAttempts.clear();
    };

    const setParticipantStream = (peerId: string, stream: MediaStream) => {
      setParticipants(prev => prev.map(p => (p.peerId === peerId ? { ...p, stream } : p)));
    };

    // Tracks a call (incoming or outgoing) as THE call for this peer
    const registerCall = (peerId: string, call: any) => {
      const previous = callsRef.current.get(peerId);
      if (previous && previous !== call) {
        intentionallyClosed.add(previous);
        try { previous.close(); } catch { /* already closed */ }
      }
      callsRef.current.set(peerId, call);

      call.on('stream', (remoteStream: MediaStream) => {
        if (isCancelled || callsRef.current.get(peerId) !== call) return;
        setParticipantStream(peerId, remoteStream);
      });

      watchCall(call, {
        onConnected: () => recallAttempts.delete(peerId),
        onDead: (reason) => handleDeadCall(peerId, call, reason)
      });

      if (screenStreamRef.current) applyScreenEncodingToCall(call);
    };

    const placeCall = (peerId: string) => {
      if (isCancelled || !peer || !peer.open || !localStream) return;
      const call = peer.call(peerId, getActiveStream(), {
        metadata: { callerUsername: username }
      });
      // PeerJS returns nothing while its signalling link is down
      if (!call) return;
      registerCall(peerId, call);
    };

    // Places every call this side is responsible for (see shouldInitiateCall)
    // and that does not exist yet. Idempotent — run it whenever anything changes.
    const reconcileCalls = () => {
      if (isCancelled || !peer || !peer.open || !localStream) return;
      const myPeerId = peer.id;
      membersRef.current.forEach((member, peerId) => {
        if (member.isReconnecting) return;
        if (callsRef.current.has(peerId) || recallTimers.has(peerId)) return;
        if (!shouldInitiateCall(myPeerId, peerId)) return;
        placeCall(peerId);
      });
    };

    function handleDeadCall(peerId: string, call: any, reason: string) {
      if (isCancelled || intentionallyClosed.has(call)) return;
      if (callsRef.current.get(peerId) !== call) return;

      intentionallyClosed.add(call);
      try { call.close(); } catch { /* already closed */ }
      callsRef.current.delete(peerId);

      if (!membersRef.current.has(peerId) || !peer) return;
      if (!shouldInitiateCall(peer.id, peerId)) {
        log(`call to ${peerId} lost (${reason}); waiting for them to call back`);
        return;
      }

      const attempt = recallAttempts.get(peerId) ?? 0;
      recallAttempts.set(peerId, attempt + 1);
      const delay = recallDelay(attempt);
      log(`call to ${peerId} lost (${reason}); re-dialling in ${delay}ms`);
      recallTimers.set(peerId, window.setTimeout(() => {
        recallTimers.delete(peerId);
        reconcileCalls();
      }, delay));
    }

    // Sends (or re-sends) our membership with the current media state. The
    // server treats a repeat from the same clientId as a silent rejoin.
    const joinRoom = () => {
      if (isCancelled || !socket || !socket.connected || !peer || !peer.open) return;
      socket.emit('join-room', {
        roomId,
        peerId: peer.id,
        clientId,
        username,
        password: passwordRef.current,
        media: {
          isAudioMuted: isAudioMutedRef.current,
          isVideoMuted: isVideoMutedRef.current,
          isScreenSharing: !!screenStreamRef.current
        }
      });
    };
    joinRoomRef.current = joinRoom;

    // Reconnects the PeerJS signalling link with exponential backoff; calling
    // reconnect() straight from 'disconnected' spun in a tight loop while offline.
    const schedulePeerReconnect = (immediate = false) => {
      if (isCancelled || peerReconnectTimer !== null) return;
      const delay = immediate ? 0 : Math.min(15000, 1000 * 2 ** peerReconnectAttempts);
      peerReconnectAttempts++;
      peerReconnectTimer = window.setTimeout(() => {
        peerReconnectTimer = null;
        if (isCancelled || !peer) return;
        if (peer.destroyed) {
          createPeer();
        } else if (peer.disconnected) {
          try { peer.reconnect(); } catch (err) { log(`PeerJS reconnect failed: ${err}`); }
        }
      }, delay);
    };

    function createPeer() {
      const p = new Peer(undefined as any, getPeerConfig());
      peer = p;
      peerRef.current = p;

      p.on('open', (id) => {
        if (isCancelled || peer !== p) return;
        console.log(`My PeerJS ID: ${id}`);
        peerReconnectAttempts = 0;
        joinRoom();
        reconcileCalls();
      });

      p.on('disconnected', () => {
        if (isCancelled || peer !== p) return;
        schedulePeerReconnect();
      });

      // Destroyed (fatal error): start over with a new identity. The server
      // announces the new peer id and the calls are rebuilt from scratch.
      p.on('close', () => {
        if (isCancelled || peer !== p) return;
        log('PeerJS peer destroyed; creating a new one');
        closeAllCalls();
        schedulePeerReconnect();
      });

      p.on('error', (err: any) => {
        if (isCancelled || peer !== p) return;
        // 'peer-unavailable': the peer we dialled is gone — PeerJS closes that
        // call, and handleDeadCall takes it from there.
        if (err?.type !== 'peer-unavailable') log(`PeerJS error: ${err?.type || err}`);
        if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(err?.type)) {
          schedulePeerReconnect();
        }
      });

      // Incoming P2P file transfer requests — only served to room members
      p.on('connection', (conn) => {
        if (conn.label !== 'file-transfer') return;
        if (!membersRef.current.has(conn.peer)) {
          console.warn(`Blocked file-transfer connection from unknown peer: ${conn.peer}`);
          conn.on('open', () => conn.close());
          return;
        }

        conn.on('data', (data: any) => {
          if (data && data.type === 'request-file' && typeof data.fileId === 'string') {
            const file = localSharedFilesRef.current[data.fileId];
            if (file) {
              conn.send({ type: 'file-response', fileId: data.fileId, file });
            } else {
              // Tell the requester explicitly instead of leaving them waiting forever
              conn.send({ type: 'file-error', fileId: data.fileId });
            }
          }
        });
      });

      // Incoming calls. Only room members may call; the member list can arrive
      // just after the call (join race), so retry briefly before rejecting.
      p.on('call', (call) => {
        if (isCancelled || peer !== p) return;
        const tryAuthorize = (attempt: number) => {
          if (isCancelled || peer !== p) {
            try { call.close(); } catch { /* ignore */ }
            return;
          }
          if (membersRef.current.has(call.peer) && localStream) {
            call.answer(getActiveStream());
            // A newer call from them replaces whatever we had (they rebuilt it)
            const timer = recallTimers.get(call.peer);
            if (timer !== undefined) window.clearTimeout(timer);
            recallTimers.delete(call.peer);
            registerCall(call.peer, call);
          } else if (attempt < 10) {
            window.setTimeout(() => tryAuthorize(attempt + 1), 500);
          } else {
            console.warn(`Blocked PeerJS call from non-member peer: ${call.peer}`);
            call.close();
          }
        };
        tryAuthorize(0);
      });
    }

    // Tab back in the foreground: mobile OSes freeze background tabs, so the
    // events that would have told us about dead links may never have fired.
    const visibilityHandler = () => {
      if (isCancelled || document.visibilityState !== 'visible') return;
      if (socket && !socket.connected) socket.connect();
      if (peer && (peer.disconnected || peer.destroyed)) {
        if (peerReconnectTimer !== null) {
          window.clearTimeout(peerReconnectTimer);
          peerReconnectTimer = null;
        }
        schedulePeerReconnect(true);
      }
      callsRef.current.forEach((call, peerId) => {
        if (isCallDead(call)) handleDeadCall(peerId, call, 'dead after resume');
      });
      reconcileCalls();
    };
    document.addEventListener('visibilitychange', visibilityHandler);

    const initConnections = () => {
      try {
        // 1. Start with fake (silent/black) tracks to avoid immediate hardware prompts
        const stream = new MediaStream([createSilentAudioTrack(), createBlackVideoTrack()]);
        localStream = stream;
        localStreamRef.current = stream;

        setParticipants([{
          socketId: 'local',
          peerId: 'local-peer',
          username: `${username} (Siz)`,
          isHost: false,
          stream,
          isAudioMuted: true,
          isVideoMuted: true
        }]);

        // 2. Signalling socket. Every (re)connect re-sends join-room; the
        // server recognises our clientId and just refreshes the socket id.
        socket = io(BACKEND_URL);
        socketRef.current = socket;
        socket.on('connect', joinRoom);

        // 3. PeerJS
        createPeer();

        // 4. The member list is the single source of truth for who is here
        socket.on('room-users', ({ roomUsers, hostSocketId: currentHostSocketId }) => {
          if (isCancelled) return;
          setHostSocketId(currentHostSocketId);
          // A successful join settles any pending password prompt
          setIsPasswordPromptOpen(false);
          setPasswordError(null);

          const myPeerId = peer?.id;
          const others = roomUsers.filter((u: any) => u.socketId !== socket?.id && u.peerId !== myPeerId);

          membersRef.current = new Map(
            others.map((u: any) => [u.peerId, { socketId: u.socketId, isReconnecting: !!u.isReconnecting }])
          );

          // Drop calls to peers that are no longer in the room (left, or
          // reloaded with a new peer id)
          Array.from(callsRef.current.keys()).forEach(peerId => {
            if (!membersRef.current.has(peerId)) closeCall(peerId);
          });

          setParticipants(prev => {
            const localUser = prev.find(p => p.socketId === 'local');
            if (!localUser) return prev;
            return [
              { ...localUser, isHost: currentHostSocketId === socket?.id },
              ...others.map((u: any) => {
                const existing = prev.find(p => p.peerId === u.peerId);
                return {
                  socketId: u.socketId,
                  peerId: u.peerId,
                  username: u.username,
                  isHost: u.isHost,
                  isScreenSharing: u.isScreenSharing,
                  isAudioMuted: u.isAudioMuted,
                  isVideoMuted: u.isVideoMuted,
                  isReconnecting: !!u.isReconnecting,
                  // Streams belong to peer ids, so a socket reconnect keeps them
                  stream: existing?.stream
                };
              })
            ];
          });

          reconcileCalls();
        });

        // 5. Someone left for good
        socket.on('user-disconnected', ({ peerId }: { socketId: string; peerId?: string }) => {
          if (isCancelled || !peerId) return;
          membersRef.current.delete(peerId);
          closeCall(peerId);
          recallAttempts.delete(peerId);
          setParticipants(prev => prev.filter(p => p.peerId !== peerId));
        });

        // 6. Chat
        socket.on('receive-message', (message: ChatMessage) => {
          if (isCancelled) return;
          setChatMessages(prev => [...prev, message]);

          // Notify when the tab is backgrounded / user is elsewhere (like during screen share)
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

        socket.on('room-history', (history: ChatMessage[]) => {
          if (isCancelled) return;
          setChatMessages(history);
        });

        socket.on('password-required', () => {
          if (isCancelled) return;
          // If we actually sent a password and were still rejected, it was wrong
          if (passwordRef.current) {
            setPasswordError('Şifre yanlış. Lütfen tekrar deneyin.');
          }
          setIsPasswordPromptOpen(true);
        });

        socket.on('room-locked-status', ({ isLocked }: { isLocked: boolean }) => {
          if (isCancelled) return;
          setIsRoomLocked(isLocked);
        });

        socket.on('kicked', (msg: string) => {
          if (isCancelled) return;
          onLeaveRef.current(msg);
        });

        socket.on('session-replaced', () => {
          if (isCancelled) return;
          onLeaveRef.current('Bu oda başka bir sekmede açıldı; bu sekmedeki bağlantı kapatıldı.');
        });

        // Remote mute request (host muting us)
        socket.on('mute-user-request', ({ trackKind }: { trackKind: 'audio' | 'video' }) => {
          if (isCancelled) return;
          if (trackKind === 'audio') {
            if (!isAudioMutedRef.current) muteLocalAudio();
            showWarning('Oda kurucusu mikrofonunuzu kapattı.');
          } else if (trackKind === 'video') {
            if (!isVideoMutedRef.current) muteLocalVideo();
            showWarning('Oda kurucusu kameranızı kapattı.');
          }
        });

        // Fatal errors: leave the room. Non-fatal issues arrive on 'warning-msg'.
        socket.on('error-msg', (msg: string) => {
          if (isCancelled) return;
          onLeaveRef.current(msg);
        });

        socket.on('warning-msg', (msg: string) => {
          if (isCancelled) return;
          showWarning(msg);
        });
      } catch (err) {
        if (isCancelled) return;
        console.error('Media stream or connection initialization failed:', err);
        onLeaveRef.current('Bağlantı kurulamadı. Lütfen tekrar deneyin.');
      }
    };

    initConnections();

    // Cleanup everything on unmount
    return () => {
      isCancelled = true;
      console.log('Cleaning up room connections...');
      joinRoomRef.current = null;

      document.removeEventListener('visibilitychange', visibilityHandler);
      if (peerReconnectTimer !== null) window.clearTimeout(peerReconnectTimer);

      if (localStream) {
        localStream.getTracks().forEach(track => stopMediaTrack(track));
      }

      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(track => track.stop());
        screenStreamRef.current = null;
      }

      teardownMixer();

      // Clear playback-unlock state so it doesn't leak into the next room
      resetAudioUnlock();

      closeAllCalls();
      membersRef.current = new Map();

      if (socket) socket.disconnect();
      if (peer) peer.destroy();
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

        // Unmuting must be reflected in the ref BEFORE choosing the outgoing
        // audio, so an active share switches from raw share audio to the mix
        isAudioMutedRef.current = false;
        replaceAudioSenders(rebuildOutgoingAudio() ?? realAudioTrack);

        setIsAudioMuted(false);
        updateLocalParticipant({ isAudioMuted: false });
        emitMediaState({ isAudioMuted: false });
      } catch (err) {
        console.error('Mikrofon erişimi alınamadı:', err);
        showWarning('Mikrofon erişim izni verilmedi.');
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
        const stream = await navigator.mediaDevices.getUserMedia(
          buildCameraConstraints(facingModeRef.current, false)
        );
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
        updateLocalParticipant({
          isVideoMuted: false,
          stream: getActiveStream(),
          isMirrored: isMobileDevice() && facingModeRef.current === 'user'
        });
        emitMediaState({ isVideoMuted: false });
      } catch (err) {
        console.error('Kamera erişimi alınamadı:', err);
        showWarning('Kamera erişim izni verilmedi.');
      }
    } else {
      // Turn off camera: stop hardware track to release green light
      muteLocalVideo();
    }
  };

  // Swap between the front and rear camera.
  //
  // The current track is released *before* opening the other camera: most phones
  // cannot hold both open at once, so requesting the second while the first is
  // live fails on a lot of hardware. That leaves a window where we have no
  // camera, so a failure path restores the one we just gave up rather than
  // silently leaving the user dark.
  const switchCamera = useCallback(async () => {
    const localStream = localStreamRef.current;
    if (!localStream || isVideoMutedRef.current || isSwitchingCamera) return;

    const previous = facingModeRef.current;
    const target: FacingMode = previous === 'user' ? 'environment' : 'user';
    setIsSwitchingCamera(true);

    const oldTrack = localStream.getVideoTracks()[0];
    stopMediaTrack(oldTrack);
    if (oldTrack) localStream.removeTrack(oldTrack);

    const attach = (track: MediaStreamTrack, mode: FacingMode) => {
      localStream.addTrack(track);
      // While screen sharing, the share owns the outgoing video track
      if (!screenStreamRef.current) replaceVideoSenders(track);
      facingModeRef.current = mode;
      setFacingMode(mode);
      updateLocalParticipant({
        stream: getActiveStream(),
        isMirrored: isMobileDevice() && mode === 'user'
      });
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(buildCameraConstraints(target, true));
      const newTrack = stream.getVideoTracks()[0];
      if (!newTrack) throw new Error('No video track returned for the requested camera');
      attach(newTrack, target);
    } catch (err) {
      console.warn('[windwatch-camera] Switch failed, restoring previous camera:', err);
      try {
        const restored = await navigator.mediaDevices.getUserMedia(
          buildCameraConstraints(previous, false)
        );
        const restoredTrack = restored.getVideoTracks()[0];
        if (restoredTrack) {
          attach(restoredTrack, previous);
        } else {
          muteLocalVideo();
        }
      } catch {
        // Neither camera could be opened — reflect that honestly in the UI
        // instead of showing a frozen last frame.
        muteLocalVideo();
      }
      showWarning('Kamera değiştirilemedi.');
    } finally {
      setIsSwitchingCamera(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSwitchingCamera]);

  // Publish the call to the OS media controls (Android lock screen / notification
  // shade). Registered once for the room; the handlers are read through refs so
  // they always invoke the current toggles without re-registering.
  const mediaSessionHandlersRef = useRef({ toggleAudio, toggleVideo });
  useEffect(() => {
    mediaSessionHandlersRef.current = { toggleAudio, toggleVideo };
  });

  useEffect(() => {
    return startCallMediaSession({
      onToggleMicrophone: () => mediaSessionHandlersRef.current.toggleAudio(),
      onToggleCamera: () => mediaSessionHandlersRef.current.toggleVideo(),
      onHangUp: () => {
        socketRef.current?.emit('leave-room');
        onLeaveRef.current();
      }
    });
  }, []);

  // Keep the OS-level metadata and button states in sync
  useEffect(() => {
    updateCallMediaSession({
      roomTitle: 'WindWatch görüşmesi',
      participantCount: participants.length,
      isMicrophoneActive: !isAudioMuted,
      isCameraActive: !isVideoMuted
    });
  }, [participants.length, isAudioMuted, isVideoMuted]);

  // Screen Sharing logic: requests display stream and updates the tracks inside active peer calls
  const toggleScreenShare = async () => {
    if (isScreenSharing) {
      stopScreenSharing();
      return;
    }

    const preset = resolveScreenSharePreset(screenQualityRef.current, screenCustomSettingsRef.current);
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

    // Desktop audio carries the call itself back to the room (see canMixSystemAudio),
    // so it is only mixed when the user has opted into that trade-off.
    const surface = getDisplaySurface(videoTrack);
    const capturedAudioTracks = stream.getAudioTracks();
    if (capturedAudioTracks.length > 0) {
      if (!canMixSystemAudio(surface, allowDesktopAudioRef.current)) {
        capturedAudioTracks.forEach(track => {
          track.onended = null;
          track.stop();
          stream.removeTrack(track);
        });
        showWarning(SYSTEM_AUDIO_BLOCKED_HINT);
      } else if (surface !== 'browser') {
        // Sharing it deliberately — make the echo risk explicit rather than a surprise
        showWarning(DESKTOP_AUDIO_ECHO_HINT);
      }
    }

    screenStreamRef.current = stream;
    prevOutboundRef.current = null;

    if ('contentHint' in videoTrack) {
      videoTrack.contentHint = preset.contentHint;
    }

    // Choose the outgoing audio for the share: raw share audio while the mic is
    // muted (no Web Audio in the path), the mic+share mix while it is live
    const outgoingAudio = rebuildOutgoingAudio();
    if (outgoingAudio) {
      console.log(
        audioDestinationRef.current
          ? '[windwatch-audio] Sending mic + share audio mix.'
          : '[windwatch-audio] Sending raw share/mic audio track.'
      );
    }

    // Swap tracks + encoder profile on every active call. The encoder profile
    // goes first so the very first screen frame is already encoded with the
    // share's bitrate ceiling and degradation preference, not the camera's.
    await Promise.all(
      Array.from(callsRef.current.values()).map(async (call: any) => {
        try {
          const videoSender = findSender(call, 'video');
          if (videoSender) {
            await applyVideoEncoding(videoSender, screenEncodingFor(preset));
            await videoSender.replaceTrack(videoTrack);
          }
          if (outgoingAudio) {
            await findSender(call, 'audio')?.replaceTrack(outgoingAudio);
          }
        } catch (err) {
          // One broken call must not abort the share for everyone else
          console.warn('Failed to switch a call to the screen share:', err);
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
    // the share — re-pick the outgoing audio so the microphone keeps flowing.
    const screenAudioTrack = stream.getAudioTracks()[0];
    if (screenAudioTrack) {
      screenAudioTrack.onended = () => {
        if (!screenStreamRef.current) return;
        screenStreamRef.current.removeTrack(screenAudioTrack);
        const fallback = rebuildOutgoingAudio() ?? localStreamRef.current?.getAudioTracks()[0];
        if (fallback) replaceAudioSenders(fallback);
      };
    }
  };

  // Switching quality mid-share: re-negotiate capture constraints and encoder profile
  // in place, so the viewer never loses the stream.
  const changeScreenQuality = async (quality: ScreenShareQuality) => {
    setScreenQuality(quality);
    screenQualityRef.current = quality;

    const preset = resolveScreenSharePreset(quality, screenCustomSettingsRef.current);

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

  // Applies an edit from the custom resolution/fps/bitrate sliders. Always
  // updates the remembered numbers; only re-negotiates live if 'custom' is
  // actually the active quality (editing a profile you're not using shouldn't
  // touch anything mid-share).
  const applyCustomScreenSettings = (partial: Partial<CustomScreenShareSettings>) => {
    const next = { ...screenCustomSettingsRef.current, ...partial };
    screenCustomSettingsRef.current = next;
    setScreenCustomSettings(next);

    if (screenQualityRef.current === 'custom') {
      changeScreenQuality('custom');
    }
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

    // Revert every call to the camera (or its black placeholder) + microphone
    const videoTrack = localStreamRef.current?.getVideoTracks()[0];
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    callsRef.current.forEach(async (call: any) => {
      try {
        const videoSender = findSender(call, 'video');
        if (videoSender) {
          if (videoTrack) await videoSender.replaceTrack(videoTrack);
          await applyVideoEncoding(videoSender, CAMERA_ENCODING);
        }
        if (audioTrack) await findSender(call, 'audio')?.replaceTrack(audioTrack);
      } catch (err) {
        console.warn('Failed to revert a call to the camera:', err);
      }
    });

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
      showWarning('Tarayıcınız sohbeti ayrı pencereye almayı desteklemiyor. Lütfen güncel Chrome veya Edge kullanın.');
    }
  };

  // The handlers below are memoised because they are handed to the memoised
  // VideoGrid/Chat/Controls; a fresh identity each render would defeat those.
  const handleSendMessage = useCallback((text: string) => {
    if (socketRef.current && text.trim()) {
      socketRef.current.emit('send-message', { roomId, text });
    }
  }, [roomId]);

  const handleShareFile = useCallback((file: File) => {
    // The whole file is held in memory and sent over one DataChannel message
    // (see handleDownloadFile) — a hard cap keeps a huge upload from pinning
    // both browsers until the tab crashes.
    if (file.size > MAX_SHARE_FILE_SIZE) {
      showWarning(`Dosya çok büyük. En fazla ${MAX_SHARE_FILE_SIZE / (1024 * 1024)} MB paylaşılabilir.`);
      return;
    }
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    localSharedFilesRef.current[fileId] = file;
    const meta: SharedFileMeta = {
      id: fileId,
      name: file.name,
      size: file.size,
      type: file.type,
      peerId: peerRef.current?.id
    };
    // Broadcast file offer metadata in chat channel
    handleSendMessage(`${FILE_MESSAGE_PREFIX}${JSON.stringify(meta)}`);
  }, [handleSendMessage]);

  // Requests a shared file from its sender over a P2P data channel.
  // Resolves when the download completes; rejects on timeout, transfer errors,
  // or when the sender no longer has the file.
  const handleDownloadFile = (senderSocketId: string, fileMeta: SharedFileMeta): Promise<void> => {
    return new Promise((resolve, reject) => {
      // Prefer the peer id carried in the offer: the chat sender id is a socket
      // id, which changes whenever the sharer's connection is re-established.
      const senderPeerId = fileMeta.peerId && participants.some(p => p.peerId === fileMeta.peerId)
        ? fileMeta.peerId
        : participants.find(p => p.socketId === senderSocketId)?.peerId;
      if (!senderPeerId || !peerRef.current) {
        reject(new Error('Kullanıcı odada bulunamadı veya P2P bağlantısı kurulamıyor.'));
        return;
      }

      const conn = peerRef.current.connect(senderPeerId, { label: 'file-transfer' });

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

  const closeChat = useCallback(() => setIsChatOpen(false), []);
  const toggleChat = useCallback(() => setIsChatOpen(v => !v), []);

  const handleKickUser = useCallback((targetSocketId: string) => {
    if (confirm('Bu kullanıcıyı odadan atmak istediğinize emin misiniz?')) {
      socketRef.current?.emit('kick-user', { targetSocketId });
    }
  }, []);

  const handleRemoteMute = useCallback((targetSocketId: string, trackKind: 'audio' | 'video') => {
    socketRef.current?.emit('mute-user-request', { targetSocketId, trackKind });
  }, []);

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordInput.trim()) return;
    setPassword(passwordInput);
    passwordRef.current = passwordInput;
    setPasswordError(null);
    setIsPasswordPromptOpen(false);

    // Retry join-room with the new password
    joinRoomRef.current?.();
  };

  // The Leave button: tell the server this is deliberate, so our seat is freed
  // right away instead of being held for a reconnect.
  const leaveRoom = useCallback(() => {
    socketRef.current?.emit('leave-room');
    onLeaveRef.current();
  }, []);

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
                <button type="button" className="btn btn-secondary" onClick={leaveRoom}>Geri Dön</button>
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
                onClose={closeChat}
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
          toggleChat={toggleChat}
          onLeave={leaveRoom}
          screenQuality={screenQuality}
          onChangeScreenQuality={changeScreenQuality}
          screenShareBlockedBy={remoteSharer?.username}
          allowDesktopAudio={allowDesktopAudio}
          onToggleDesktopAudio={setAllowDesktopAudio}
          screenCustomSettings={screenCustomSettings}
          onChangeCustomScreenSettings={applyCustomScreenSettings}
          canSwitchCamera={hasMultipleCameras && !isVideoMuted && !isScreenSharing}
          isSwitchingCamera={isSwitchingCamera}
          facingMode={facingMode}
          onSwitchCamera={switchCamera}
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
            <div className="chat-backdrop" onClick={closeChat} />
            <Chat
              messages={chatMessages}
              onSendMessage={handleSendMessage}
              onShareFile={handleShareFile}
              onDownloadFile={handleDownloadFile}
              myId={socketRef.current?.id || ''}
              onClose={closeChat}
              onDetach={toggleChatPiP}
              isPiP={false}
              // Bottom sheet on a phone held upright. In the short-landscape
              // immersive layout the side overlay is the better fit — there is
              // barely any vertical room for a sheet to travel.
              isBottomSheet={isMobile && !isShortLandscape}
            />
          </>
        )
      )}
    </div>
  );
};

export default Room;
