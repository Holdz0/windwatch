// Screen sharing capture + encoder tuning.
//
// The right trade-off depends entirely on what is being shared: static text needs
// resolution and sharpness (and tolerates a low frame rate), while video or games
// need a steady frame rate (and tolerate softer pixels). WebRTC exposes exactly
// these levers — contentHint, degradationPreference, maxFramerate and maxBitrate —
// so each preset drives all of them consistently.

export type ScreenShareQuality = 'detail' | 'balanced' | 'motion';

export interface ScreenSharePreset {
  id: ScreenShareQuality;
  label: string;
  hint: string;
  /** Encoder intent: 'detail' preserves sharpness, 'motion' preserves frame rate */
  contentHint: 'detail' | 'motion';
  maxWidth: number;
  maxHeight: number;
  frameRate: number;
  maxBitrate: number;
  degradationPreference: RTCDegradationPreference;
}

export const SCREEN_SHARE_PRESETS: Record<ScreenShareQuality, ScreenSharePreset> = {
  detail: {
    id: 'detail',
    label: 'Metin & Kod',
    hint: 'En keskin görüntü, düşük kare hızı. Doküman, kod ve sunum için.',
    contentHint: 'detail',
    maxWidth: 2560,
    maxHeight: 1440,
    frameRate: 8,
    maxBitrate: 2_500_000,
    degradationPreference: 'maintain-resolution'
  },
  balanced: {
    id: 'balanced',
    label: 'Dengeli',
    hint: 'Çoğu kullanım için dengeli kalite ve akıcılık.',
    contentHint: 'motion',
    maxWidth: 1920,
    maxHeight: 1080,
    frameRate: 30,
    maxBitrate: 4_000_000,
    degradationPreference: 'balanced'
  },
  motion: {
    id: 'motion',
    label: 'Video & Oyun',
    hint: 'En akıcı hareket, gerektiğinde çözünürlükten ödün verir.',
    contentHint: 'motion',
    maxWidth: 1920,
    maxHeight: 1080,
    frameRate: 60,
    maxBitrate: 8_000_000,
    degradationPreference: 'maintain-framerate'
  }
};

export const DEFAULT_SCREEN_QUALITY: ScreenShareQuality = 'balanced';

/** Adaptive bitrate never drops below this — under it the share is unreadable anyway. */
export const MIN_SCREEN_BITRATE = 500_000;

/** Encoder settings used for the camera, restored when a screen share ends. */
export const CAMERA_ENCODING = {
  maxBitrate: 1_500_000,
  degradationPreference: 'balanced' as RTCDegradationPreference,
  priority: 'low',
  networkPriority: 'low'
};

/** Capture constraints for getDisplayMedia derived from a preset. */
export function buildDisplayMediaConstraints(preset: ScreenSharePreset): MediaStreamConstraints {
  return {
    video: {
      width: { max: preset.maxWidth },
      height: { max: preset.maxHeight },
      frameRate: { ideal: preset.frameRate, max: preset.frameRate },
      // Keep the pointer visible — it is what viewers follow during a walkthrough
      cursor: 'always'
    },
    audio: {
      // System audio should not be processed like a microphone: these filters
      // wreck music and video playback shared from the desktop.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    // Chromium-only hints: don't offer the tab we're running in (avoids the
    // infinite-mirror effect) and let the user swap surfaces without restarting.
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include'
  } as MediaStreamConstraints;
}

export type DisplaySurface = 'browser' | 'window' | 'monitor' | 'unknown';

/** Reads which kind of surface the user picked in the browser's share dialog. */
export function getDisplaySurface(track: MediaStreamTrack): DisplaySurface {
  const settings = track.getSettings() as { displaySurface?: string };
  const surface = settings.displaySurface;
  if (surface === 'browser' || surface === 'window' || surface === 'monitor') {
    return surface;
  }
  return 'unknown';
}

/**
 * Whether the audio captured alongside this surface is safe to mix into our
 * outgoing stream.
 *
 * Screen ("monitor") and window captures take the machine's entire audio output,
 * which includes the other participants' voices being played on this machine.
 * Mixing that sends everyone their own voice back — a feedback loop the remote
 * side hears as an echo of themselves.
 *
 * Tab ("browser") audio is scoped to the captured tab, and the picker already
 * excludes our own tab via selfBrowserSurface, so it cannot contain the call.
 * An undetermined surface is treated as unsafe: a silent share is a far smaller
 * problem than an echo that makes the room unusable for everyone.
 */
export function canMixSystemAudio(surface: DisplaySurface): boolean {
  return surface === 'browser';
}

export const SYSTEM_AUDIO_ECHO_WARNING =
  'Sistem sesi paylaşılmadı: tüm ekran paylaşımında diğer katılımcılar kendi seslerini yankı olarak duyar. Ses de paylaşmak için tek bir sekme paylaşın.';

export interface VideoEncodingOptions {
  maxBitrate: number;
  maxFramerate?: number;
  degradationPreference?: RTCDegradationPreference;
  priority?: string;
  networkPriority?: string;
  scaleResolutionDownBy?: number;
}

/**
 * Applies encoder parameters to an RTCRtpSender.
 * Returns true when the parameters were accepted.
 */
export async function applyVideoEncoding(
  sender: RTCRtpSender,
  opts: VideoEncodingOptions
): Promise<boolean> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      // Some implementations hand back an empty list before the first negotiation
      params.encodings = [{}];
    }

    const encoding = params.encodings[0] as any;
    encoding.maxBitrate = opts.maxBitrate;
    if (opts.maxFramerate !== undefined) encoding.maxFramerate = opts.maxFramerate;
    if (opts.scaleResolutionDownBy !== undefined) {
      encoding.scaleResolutionDownBy = opts.scaleResolutionDownBy;
    } else {
      delete encoding.scaleResolutionDownBy;
    }
    if (opts.priority) encoding.priority = opts.priority;
    if (opts.networkPriority) encoding.networkPriority = opts.networkPriority;

    if (opts.degradationPreference) {
      (params as any).degradationPreference = opts.degradationPreference;
    }

    await sender.setParameters(params);
    return true;
  } catch (err) {
    console.warn('Failed to apply video sender parameters:', err);
    return false;
  }
}

/** Encoder options for an active screen share at a given (possibly adapted) bitrate. */
export function screenEncodingFor(preset: ScreenSharePreset, bitrate: number): VideoEncodingOptions {
  return {
    maxBitrate: bitrate,
    maxFramerate: preset.frameRate,
    degradationPreference: preset.degradationPreference,
    priority: 'high',
    networkPriority: 'high'
  };
}

export interface ScreenShareStats {
  width: number;
  height: number;
  fps: number;
  kbps: number;
  /** Why the encoder is holding back, if it is: 'bandwidth' | 'cpu' | 'none' | ... */
  limitation: string;
}

export function formatBitrate(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}
