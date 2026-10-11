export interface Participant {
  socketId: string;
  peerId: string;
  username: string;
  isHost: boolean;
  stream?: MediaStream;
  screenStream?: MediaStream;
  isAudioMuted?: boolean;
  isVideoMuted?: boolean;
  isScreenSharing?: boolean;
  hasScreenAudio?: boolean;
  isReconnecting?: boolean;
  isMirrored?: boolean;
  connectionState?: RTCPeerConnectionState;
}

export interface ChatMessage {
  id?: string;
  senderId: string;
  senderPeerId?: string;
  senderName: string;
  text: string;
  timestamp: string;
}

export const FILE_MESSAGE_PREFIX = '[FILE]';
export const MAX_SHARE_FILE_SIZE = 100 * 1024 * 1024;

export interface SharedFileMeta {
  id: string;
  name: string;
  size: number;
  type: string;
  peerId?: string;
}

export function parseFileMessage(text: string): SharedFileMeta | null {
  if (!text.startsWith(FILE_MESSAGE_PREFIX)) return null;
  try {
    const meta = JSON.parse(text.slice(FILE_MESSAGE_PREFIX.length));
    if (typeof meta?.id !== 'string' || !meta.id || typeof meta.name !== 'string' ||
        !Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > MAX_SHARE_FILE_SIZE) return null;
    return { id: meta.id, name: meta.name, size: meta.size,
      type: typeof meta.type === 'string' ? meta.type : '',
      peerId: typeof meta.peerId === 'string' ? meta.peerId : undefined };
  } catch { return null; }
}
