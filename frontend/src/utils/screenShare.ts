// Screen sharing capture + encoder tuning.
//
// The right trade-off depends entirely on what is being shared: static text needs
// resolution and sharpness (and tolerates a low frame rate), while video or games
// need a steady frame rate (and tolerate softer pixels). WebRTC exposes exactly
// these levers — contentHint, degradationPreference, maxFramerate and maxBitrate —
// so each preset drives all of them consistently.

export type BuiltInScreenShareQuality = 'saver' | 'detail' | 'balanced' | 'motion';
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
  saver: {
    id: 'saver',
    label: 'Tasarruf',
    hint: 'Az veriyle akıcı paylaşım. Sabit yazılar net kalır; harekette çözünürlük uyarlanır.',
    contentHint: 'detail',
    maxWidth: 1920,
    maxHeight: 1080,
    frameRate: 30,
    maxBitrate: 500_000,
    degradationPreference: 'maintain-framerate'
  },
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

// --- Custom (manual) profile -----------------------------------------------
//
// The built-in presets above cover the common cases; power users on a strong
// connection (or a deliberately poor one) may want to pick exact numbers
// instead. 'custom' resolves to a preset built from these numbers rather than
// a fixed table entry — everything downstream (capture constraints, encoder
// params) already just consumes a ScreenSharePreset, so no
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
// of "correct" stops), so it's the one true slider. It is a ceiling: WebRTC's
// own congestion control sends less whenever the link can't carry it.
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
  settings = normalizeCustomSettings(settings);
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
  maxFramerate: 30,
  degradationPreference: 'balanced' as RTCDegradationPreference
};

export function normalizeCustomSettings(settings: Partial<CustomScreenShareSettings>): CustomScreenShareSettings {
  const bound = (value: number | undefined, min: number, max: number, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;
  return {
    maxHeight: bound(settings.maxHeight, 480, 2160, DEFAULT_CUSTOM_SETTINGS.maxHeight),
    frameRate: bound(settings.frameRate, 5, 60, DEFAULT_CUSTOM_SETTINGS.frameRate),
    maxBitrate: bound(settings.maxBitrate, CUSTOM_BITRATE_BOUNDS.min, CUSTOM_BITRATE_BOUNDS.max, DEFAULT_CUSTOM_SETTINGS.maxBitrate)
  };
}

export function supportsOwnAudioRestriction(): boolean {
  return !!(navigator.mediaDevices?.getSupportedConstraints() as
    (MediaTrackSupportedConstraints & { restrictOwnAudio?: boolean }) | undefined)?.restrictOwnAudio;
}

/** Capture constraints for getDisplayMedia derived from a preset. */
export function buildDisplayMediaConstraints(preset: ScreenSharePreset, restrictOwnAudio = supportsOwnAudioRestriction()): DisplayMediaStreamOptions {
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
      autoGainControl: false,
      restrictOwnAudio: true,
      suppressLocalAudioPlayback: false
    },
    // Chromium-only hints: don't offer the tab we're running in (avoids the
    // infinite-mirror effect) and let the user swap surfaces without restarting.
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    systemAudio: restrictOwnAudio ? 'include' : 'exclude',
    windowAudio: restrictOwnAudio ? 'system' : 'window'
  } as DisplayMediaStreamOptions;
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

/** Tab audio is scoped to another tab. Desktop/window audio must confirm that
 * the browser excluded audio produced by the WindWatch document. */
export function canShareDisplayAudio(surface: DisplaySurface, ownAudioRestricted: boolean): boolean {
  if (surface === 'browser') return true;
  return ownAudioRestricted;
}

export const SYSTEM_AUDIO_BLOCKED_HINT =
  'Tarayıcınız WindWatch sesini sistem sesinden ayıramıyor. Yankıyı önlemek için yalnızca görüntü paylaşılıyor. Ses için başka bir tarayıcı sekmesi paylaşın veya güncel Chrome / Edge kullanın.';

/** Validate the actual track before sending it. An unsupported constraint is
 * silently ignored, so requesting the filter alone is insufficient. */
export async function protectDisplayAudio(stream: MediaStream): Promise<boolean> {
  const video = stream.getVideoTracks()[0];
  const surface = video ? getDisplaySurface(video) : 'unknown';
  let blocked = false;
  for (const track of stream.getAudioTracks()) {
    const restricted = () => (track.getSettings() as MediaTrackSettings & { restrictOwnAudio?: boolean }).restrictOwnAudio === true;
    if (surface !== 'browser' && !restricted() && supportsOwnAudioRestriction()) {
      try {
        await track.applyConstraints({ restrictOwnAudio: { exact: true } } as MediaTrackConstraints);
      } catch { /* The selected source cannot provide the filter. */ }
    }
    if (!canShareDisplayAudio(surface, restricted())) {
      track.stop();
      stream.removeTrack(track);
      blocked = true;
    }
  }
  return blocked;
}

export interface VideoEncodingOptions {
  maxBitrate: number;
  maxFramerate?: number;
  degradationPreference?: RTCDegradationPreference;
  scaleResolutionDownBy?: number;
  priority?: RTCPriorityType;
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
      return false;
    }

    const encoding = params.encodings[0];
    encoding.maxBitrate = opts.maxBitrate;
    if (opts.maxFramerate !== undefined) encoding.maxFramerate = opts.maxFramerate;
    // Reset scaling and priority when leaving saver mode as well.
    encoding.scaleResolutionDownBy = opts.scaleResolutionDownBy ?? 1;
    encoding.priority = opts.priority ?? 'low';
    if (opts.degradationPreference) {
      params.degradationPreference = opts.degradationPreference;
    }

    await sender.setParameters(params);
    return true;
  } catch {
    // Encoding hints are optional; native congestion control still runs.
    return false;
  }
}

/** Audio retains its own bitrate budget, independent of either video sender. */
export async function applyAudioEncoding(sender: RTCRtpSender, maxBitrate?: number): Promise<boolean> {
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) return false;
    const encoding = params.encodings[0];
    if (maxBitrate === undefined) delete encoding.maxBitrate;
    else encoding.maxBitrate = maxBitrate;
    encoding.priority = 'high';
    await sender.setParameters(params);
    return true;
  } catch { return false; }
}

/**
 * Encoder options for an active screen share. maxBitrate is only a ceiling:
 * WebRTC's congestion control already sends less when the link can't carry it,
 * so lowering the ceiling ourselves just stops it from ramping back up.
 */
export function screenEncodingFor(preset: ScreenSharePreset): VideoEncodingOptions {
  return {
    maxBitrate: preset.maxBitrate,
    maxFramerate: preset.frameRate,
    degradationPreference: preset.degradationPreference
  };
}

export function formatBitrate(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}
