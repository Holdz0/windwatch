import { SCREEN_SHARE_PRESETS } from './screenShare';
import type { VideoEncodingOptions } from './screenShare';

// Aggregate outgoing media payload, not a per-viewer allowance. RTP/UDP/ICE
// overhead, downloads and file transfers are outside this target budget.
export const SAVER_UPLOAD_BUDGET = 1_200_000;
export const SAVER_MICROPHONE_BITRATE = 24_000;
export const SAVER_SCREEN_AUDIO_BITRATE = 64_000;

export function saverBudget(viewers: number, active: { microphone: boolean; camera: boolean; screenAudio: boolean }) {
  const perViewer = Math.floor(SAVER_UPLOAD_BUDGET / Math.max(1, viewers));
  const microphone = active.microphone ? SAVER_MICROPHONE_BITRATE : 0;
  const screenAudio = active.screenAudio ? SAVER_SCREEN_AUDIO_BITRATE : 0;
  const remaining = Math.max(0, perViewer - microphone - screenAudio);
  const camera = active.camera ? Math.min(100_000, Math.floor(remaining * 0.15)) : 0;
  return { microphone, screenAudio, camera,
    screen: Math.min(SCREEN_SHARE_PRESETS.saver.maxBitrate, remaining - camera) };
}

export function saverCameraEncoding(track: MediaStreamTrack, maxBitrate: number): VideoEncodingOptions {
  const { width = 640, height = 360 } = track.getSettings();
  return { maxBitrate, maxFramerate: 15, degradationPreference: 'maintain-framerate',
    scaleResolutionDownBy: Math.max(1, width / 640, height / 360), priority: 'very-low' };
}

/** Prefer efficient screen codecs before negotiation, retaining every fallback
 * and repair codec. Both send and receive support are needed for sendrecv slots.
 * No SDP rewriting or extra encodes/simulcast layers are required. */
export function preferScreenCodecs(transceiver: RTCRtpTransceiver): void {
  if (!transceiver.setCodecPreferences) return;
  try {
    const send = RTCRtpSender.getCapabilities('video')?.codecs || [];
    const receive = RTCRtpReceiver.getCapabilities('video')?.codecs || [];
    const preferences = ['video/av1', 'video/vp9'];
    const rank = (codec: RTCRtpCodec) => {
      const index = preferences.indexOf(codec.mimeType.toLowerCase());
      const canSend = send.some(candidate => candidate.mimeType.toLowerCase() === codec.mimeType.toLowerCase() &&
        candidate.clockRate === codec.clockRate && candidate.sdpFmtpLine === codec.sdpFmtpLine);
      return canSend && index >= 0 ? index : preferences.length;
    };
    if (receive.some(codec => rank(codec) < preferences.length))
      transceiver.setCodecPreferences([...receive].sort((a, b) => rank(a) - rank(b)));
  } catch { /* Unsupported preferences leave native codec negotiation intact. */ }
}

export interface SaverStats {
  viewers: number;
  mediaBitrate: number | null;
  screenBitrateLimit: number;
  width: number;
  height: number;
  fps: number;
  limitedBy: string;
}

export interface TrafficSample { id: string; timestamp: number; bytes: number }

/** Deltas are keyed to the report/connection generation. A late join or a
 * reconnect must not turn historical byte counters into a traffic spike. */
export function trafficBitrate(previous: Map<string, TrafficSample>, samples: TrafficSample[]): number | null {
  let bitrate = 0;
  let measured = false;
  for (const sample of samples) {
    const before = previous.get(sample.id);
    const elapsed = before ? sample.timestamp - before.timestamp : 0;
    if (before && elapsed > 0 && elapsed <= 15_000 && sample.bytes >= before.bytes) {
      bitrate += (sample.bytes - before.bytes) * 8000 / elapsed;
      measured = true;
    }
  }
  previous.clear();
  for (const sample of samples) previous.set(sample.id, sample);
  return measured ? bitrate : null;
}
