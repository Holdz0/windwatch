// Screen sharing capture + encoder tuning.
//
// The right trade-off depends entirely on what is being shared: static text needs
// resolution and sharpness (and tolerates a low frame rate), while video or games
// need a steady frame rate (and tolerate softer pixels). WebRTC exposes exactly
// these levers — contentHint, degradationPreference, maxFramerate and maxBitrate —
// so each preset drives all of them consistently.

export type BuiltInScreenShareQuality = 'detail' | 'balanced' | 'motion';
/** 'custom' resolves through resolveScreenSharePreset() using the user's own numbers. */
export type ScreenShareQuality = BuiltInScreenShareQuality | 'custom';

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

export const SCREEN_SHARE_PRESETS: Record<BuiltInScreenShareQuality, ScreenSharePreset> = {
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

// --- Custom (manual) profile -----------------------------------------------
//
// The three presets above cover the common cases; power users on a strong
// connection (or a deliberately poor one) may want to pick exact numbers
// instead. 'custom' resolves to a preset built from these numbers rather than
// a fixed table entry — everything downstream (capture constraints, encoder
// params, adaptive bitrate) already just consumes a ScreenSharePreset, so no
// other code needs to know custom mode exists.

export interface CustomScreenShareSettings {
  maxHeight: number;
  frameRate: number;
  maxBitrate: number;
}

export const DEFAULT_CUSTOM_SETTINGS: CustomScreenShareSettings = {
  maxHeight: 1080,
  frameRate: 30,
  maxBitrate: 4_000_000
};

// Curated resolution/fps choices rather than free-form numbers: a capture
// request for an arbitrary height (e.g. 1032p) buys nothing since the source
// display doesn't have that resolution anyway, and round numbers read better.
export const CUSTOM_RESOLUTION_OPTIONS: { label: string; height: number }[] = [
  { label: '480p', height: 480 },
  { label: '720p (HD)', height: 720 },
  { label: '900p', height: 900 },
  { label: '1080p (Full HD)', height: 1080 },
  { label: '1440p (2K)', height: 1440 },
  { label: '2160p (4K)', height: 2160 }
];

export const CUSTOM_FRAMERATE_OPTIONS: number[] = [5, 10, 15, 24, 30, 45, 60];

// Bitrate is a genuine continuum (unlike resolution/fps, there's no natural set
// of "correct" stops), so it's the one true slider — floor kept below
// MIN_SCREEN_BITRATE to let someone on a very poor link go lower than the
// adaptive algorithm's own backoff floor if they choose to.
export const CUSTOM_BITRATE_BOUNDS = { min: 200_000, max: 15_000_000, step: 100_000 };

/** 16:9 width for a given height, rounded to an even number (codecs prefer even dimensions). */
function widthFor16by9(height: number): number {
  return Math.round((height * 16) / 9 / 2) * 2;
}

function degradationPreferenceForFrameRate(frameRate: number): RTCDegradationPreference {
  if (frameRate <= 15) return 'maintain-resolution';
  if (frameRate >= 45) return 'maintain-framerate';
  return 'balanced';
}

/** Builds the full preset for the custom profile from the user's chosen numbers. */
export function buildCustomPreset(settings: CustomScreenShareSettings): ScreenSharePreset {
  return {
    id: 'custom',
    label: 'Özel',
    hint: 'Çözünürlük, kare hızı ve bitrate elle ayarlanır.',
    contentHint: settings.frameRate <= 15 ? 'detail' : 'motion',
    maxWidth: widthFor16by9(settings.maxHeight),
    maxHeight: settings.maxHeight,
    frameRate: settings.frameRate,
    maxBitrate: settings.maxBitrate,
    degradationPreference: degradationPreferenceForFrameRate(settings.frameRate)
  };
}

/** Resolves the active quality selection (built-in or custom) to a full preset. */
export function resolveScreenSharePreset(
  quality: ScreenShareQuality,
  custom: CustomScreenShareSettings
): ScreenSharePreset {
  if (quality === 'custom') return buildCustomPreset(custom);
  return SCREEN_SHARE_PRESETS[quality];
}

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
 * Whether the audio captured alongside this surface may be mixed into our
 * outgoing stream.
 *
 * Tab ("browser") audio is scoped to the captured tab, and the picker excludes
 * our own tab via selfBrowserSurface, so it cannot contain the call — always safe.
 *
 * Screen and window captures take the machine's entire audio output. That is the
 * only way to share a desktop application's sound (a game, Steam or Discord voice
 * chat), but it also picks up the other participants being played on this machine
 * and sends them their own voice back as an echo. There is no way to capture one
 * without the other, so this is the caller's decision: `allowDesktopAudio` opts
 * into that trade-off, and it defaults to off.
 */
export function canMixSystemAudio(surface: DisplaySurface, allowDesktopAudio: boolean): boolean {
  if (surface === 'browser') return true;
  return allowDesktopAudio;
}

/** Shown when desktop audio was captured but the user has not opted in. */
export const SYSTEM_AUDIO_BLOCKED_HINT =
  'Sistem sesi paylaşılmadı. Steam, Discord veya oyun sesini paylaşmak için ayarlar menüsünden "Masaüstü sesini paylaş" seçeneğini açın.';

/** Shown when desktop audio is being shared, so the echo risk is not a surprise. */
export const DESKTOP_AUDIO_ECHO_HINT =
  'Masaüstü sesi paylaşılıyor. Konuşan katılımcılar kendi seslerini yankı olarak duyabilir — konuşmayanların mikrofonu kapalı tutması önerilir.';

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
