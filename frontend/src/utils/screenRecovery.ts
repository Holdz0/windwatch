import { applyVideoEncoding } from './screenShare';
import type { VideoEncodingOptions } from './screenShare';

export const SCREEN_QUALITY_INTERVAL = 2000;

interface RemoteFeedback extends RTCStats {
  fractionLost?: number;
  roundTripTime?: number;
}
interface VideoSource extends RTCStats {
  width?: number;
  height?: number;
  framesPerSecond?: number;
}

export interface ScreenQualitySample {
  id: string;
  timestamp: number;
  frames: number;
  width: number;
  height: number;
  fps: number;
  sourceFps?: number;
  sourceWidth: number;
  sourceHeight: number;
  screenBytes: number;
  otherBytes: number;
  targetBitrate?: number;
  availableBitrate?: number;
  loss?: number;
  rtt?: number;
  feedbackTimestamp?: number;
  limitedBy?: string;
}

/** Use the screen sender's transport/RTCP reports, never a different video or
 * an obsolete ICE pair. Bandwidth estimates cover ALL streams on this link. */
export function readScreenQuality(reports: RTCStatsReport, mid: string | null,
  settings: MediaTrackSettings): ScreenQualitySample | null {
  let screen: RTCOutboundRtpStreamStats | undefined;
  let otherBytes = 0;
  reports.forEach((report: RTCOutboundRtpStreamStats) => {
    if (report.type !== 'outbound-rtp') return;
    if (mid !== null && report.mid === mid && report.kind === 'video') screen = report;
    else otherBytes += (report.bytesSent || 0) + (report.headerBytesSent || 0);
  });
  if (!screen || !screen.frameWidth || !screen.frameHeight) return null;
  const transport: RTCTransportStats | undefined = screen.transportId ? reports.get(screen.transportId) : undefined;
  const pair: RTCIceCandidatePairStats | undefined = transport?.selectedCandidatePairId
    ? reports.get(transport.selectedCandidatePairId) : undefined;
  const remote: RemoteFeedback | undefined = screen.remoteId ? reports.get(screen.remoteId) : undefined;
  const source: VideoSource | undefined = screen.mediaSourceId ? reports.get(screen.mediaSourceId) : undefined;
  return { id: screen.id, timestamp: screen.timestamp, frames: screen.framesEncoded || 0,
    width: screen.frameWidth, height: screen.frameHeight, fps: screen.framesPerSecond || 0,
    sourceFps: source?.framesPerSecond, sourceWidth: Math.max(source?.width || 0, settings.width || 0, screen.frameWidth),
    sourceHeight: Math.max(source?.height || 0, settings.height || 0, screen.frameHeight),
    screenBytes: (screen.bytesSent || 0) + (screen.headerBytesSent || 0), otherBytes,
    targetBitrate: screen.targetBitrate, availableBitrate: pair?.availableOutgoingBitrate,
    loss: remote?.fractionLost, rtt: remote?.roundTripTime ?? pair?.currentRoundTripTime,
    feedbackTimestamp: remote?.timestamp, limitedBy: screen.qualityLimitationReason };
}

/** Native congestion control still lowers quality immediately. This only
 * releases stale adaptation after sustained healthy feedback, with a bounded
 * retry backoff. It never lowers a ceiling that would prevent native ramp-up. */
export class ScreenQualityRecovery {
  private previous: ScreenQualitySample | null = null;
  private healthySince: number | null = null;
  private healthySamples = 0;
  private lowestRtt = Infinity;
  private sawCongestion = false;
  private nextProbe = 0;
  private probeDelay = 30_000;

  observe(sample: ScreenQualitySample, target: { width: number; height: number; fps: number; bitrate: number;
    otherBitrate: number }): boolean {
    const before = this.previous;
    this.previous = sample;
    const elapsed = before ? sample.timestamp - before.timestamp : 0;
    if (!before || before.id !== sample.id || elapsed <= 0 || elapsed > 10_000 ||
      sample.frames < before.frames || sample.screenBytes < before.screenBytes || sample.otherBytes < before.otherBytes) {
      this.healthySince = null; this.healthySamples = 0;
      return false;
    }
    if (sample.rtt !== undefined && Number.isFinite(sample.rtt) && sample.rtt >= 0)
      this.lowestRtt = Math.min(this.lowestRtt, sample.rtt);
    const congested = (sample.loss !== undefined && sample.loss > 0.02) ||
      (sample.rtt !== undefined && sample.rtt > Math.max(0.3, this.lowestRtt * 1.75));
    if (congested || sample.limitedBy === 'bandwidth') this.sawCongestion = true;

    const scale = Math.min(1, target.width / sample.sourceWidth, target.height / sample.sourceHeight);
    const lowResolution = sample.width < sample.sourceWidth * scale * 0.85 ||
      sample.height < sample.sourceHeight * scale * 0.85;
    // A static document or a source that produces 10 fps is not a stuck 30 fps
    // encoder. Only compare FPS against actually arriving source frames.
    const sourceFps = Math.min(target.fps, sample.sourceFps || 0);
    const lowFps = (sample.frames - before.frames) * 1000 / elapsed >= 5 && sourceFps >= 5 && sample.fps < sourceFps * 0.65;
    if (!lowResolution && !lowFps) { this.probeDelay = 30_000; this.sawCongestion = false; }

    const otherBitrate = Math.max(target.otherBitrate, (sample.otherBytes - before.otherBytes) * 8000 / elapsed);
    const screenBitrate = (sample.screenBytes - before.screenBytes) * 8000 / elapsed;
    const required = Math.min(target.bitrate, Math.max(120_000, (sample.targetBitrate || screenBitrate) * 1.35));
    const hasEstimate = sample.availableBitrate !== undefined && Number.isFinite(sample.availableBitrate);
    const hasHeadroom = hasEstimate && sample.availableBitrate! * 0.85 - otherBitrate >= required;
    const freshFeedback = sample.feedbackTimestamp !== undefined &&
      sample.timestamp - sample.feedbackTimestamp >= 0 && sample.timestamp - sample.feedbackTimestamp <= 6000;
    // Browsers without a bandwidth estimate need evidence that a previously
    // congested connection has recovered, including fresh receiver feedback.
    const healthy = !congested && sample.limitedBy !== 'cpu' && sample.limitedBy !== 'other' &&
      sample.loss !== undefined && freshFeedback && sample.rtt !== undefined &&
      (hasEstimate ? hasHeadroom : this.sawCongestion && sample.loss <= 0.01);
    if (!healthy || (!lowResolution && !lowFps) || target.bitrate <= 0) {
      this.healthySince = null; this.healthySamples = 0;
      return false;
    }
    this.healthySince ??= sample.timestamp;
    this.healthySamples++;
    if (this.healthySamples < 3 || sample.timestamp - this.healthySince < 6000 || sample.timestamp < this.nextProbe)
      return false;
    this.nextProbe = sample.timestamp + this.probeDelay;
    this.probeDelay = Math.min(120_000, this.probeDelay * 2);
    this.healthySince = null; this.healthySamples = 0;
    return true;
  }
}

/** Crossing balanced clears libwebrtc's old resolution/FPS restrictions.
 * Restore the chosen preference immediately; bitrate/FPS ceilings remain in
 * force during both steps. No renegotiation, track replacement or forced frames.
 * Unsupported hints fail harmlessly and leave native adaptation running. */
export async function refreshScreenEncoding(sender: RTCRtpSender, options: VideoEncodingOptions): Promise<void> {
  const temporary = options.degradationPreference === 'balanced' ? 'maintain-framerate' : 'balanced';
  try {
    await applyVideoEncoding(sender, { ...options, degradationPreference: temporary });
  } finally {
    await applyVideoEncoding(sender, options);
  }
}
