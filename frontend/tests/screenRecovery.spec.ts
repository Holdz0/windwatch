import { expect, test } from '@playwright/test';
import { readScreenQuality, ScreenQualityRecovery, refreshScreenEncoding } from '../src/utils/screenRecovery';
import type { ScreenQualitySample } from '../src/utils/screenRecovery';

const target = { width: 1920, height: 1080, fps: 30, bitrate: 4_000_000, otherBitrate: 88_000 };
function sample(timestamp: number, overrides: Partial<ScreenQualitySample> = {}): ScreenQualitySample {
  return { id: 'screen', timestamp, frames: timestamp * 0.03, width: 320, height: 180, fps: 30,
    sourceFps: 30, sourceWidth: 1920, sourceHeight: 1080, screenBytes: timestamp * 40,
    otherBytes: timestamp * 10, targetBitrate: 320_000, availableBitrate: 5_000_000,
    loss: 0, rtt: 0.03, feedbackTimestamp: timestamp, limitedBy: 'none', ...overrides };
}

test('screen recovery waits for sustained improvement and backs off if quality stays low', () => {
  const recovery = new ScreenQualityRecovery();
  for (let time = 2000; time <= 10_000; time += 2000)
    expect(recovery.observe(sample(time, { availableBitrate: 160_000, loss: 0.15, rtt: 0.8, limitedBy: 'bandwidth' }), target)).toBe(false);
  for (let time = 12_000; time < 18_000; time += 2000) expect(recovery.observe(sample(time), target)).toBe(false);
  expect(recovery.observe(sample(18_000), target)).toBe(true);
  for (let time = 20_000; time < 48_000; time += 2000) expect(recovery.observe(sample(time), target)).toBe(false);
  expect(recovery.observe(sample(48_000), target)).toBe(true);
  for (let time = 50_000; time < 108_000; time += 2000) expect(recovery.observe(sample(time), target)).toBe(false);
  expect(recovery.observe(sample(108_000), target)).toBe(true);
});

test('loss, CPU, stale feedback, exhausted shared bandwidth and static FPS never trigger recovery', () => {
  const cases: Partial<ScreenQualitySample>[] = [
    { loss: 0.04 }, { limitedBy: 'cpu' }, { limitedBy: 'other' }, { feedbackTimestamp: 0 },
    { loss: undefined }, { rtt: undefined }, { availableBitrate: 400_000 },
    { availableBitrate: undefined },
    { width: 1920, height: 1080, frames: 1, fps: 0 },
    { width: 1920, height: 1080, sourceFps: 10, fps: 10 }
  ];
  for (const values of cases) {
    const recovery = new ScreenQualityRecovery();
    for (let time = 2000; time <= 20_000; time += 2000)
      expect(recovery.observe(sample(time, values), target), JSON.stringify(values)).toBe(false);
  }
  const loaded = new ScreenQualityRecovery();
  for (let time = 2000; time <= 20_000; time += 2000)
    expect(loaded.observe(sample(time, { availableBitrate: 1_000_000, otherBytes: time * 120 }), target)).toBe(false);
});

test('fresh receiver reports recover without bandwidth estimates and one healthy viewer is independent', () => {
  const weak = new ScreenQualityRecovery(), healthy = new ScreenQualityRecovery();
  weak.observe(sample(2000), target);
  healthy.observe(sample(2000, { loss: 0.2, limitedBy: 'bandwidth' }), target);
  // The first report supplies the baseline; evidence of congestion comes next.
  healthy.observe(sample(4000, { loss: 0.2, limitedBy: 'bandwidth' }), target);
  for (let time = 4000; time <= 12_000; time += 2000)
    expect(weak.observe(sample(time, { loss: 0.2, availableBitrate: 100_000 }), target)).toBe(false);
  for (let time = 6000; time < 12_000; time += 2000)
    expect(healthy.observe(sample(time, { availableBitrate: undefined }), target)).toBe(false);
  expect(healthy.observe(sample(12_000, { availableBitrate: undefined }), target)).toBe(true);
});

test('new stats generations and sleep gaps need a new healthy baseline; source dimensions bound recovery', () => {
  const recovery = new ScreenQualityRecovery();
  for (let time = 2000; time <= 6000; time += 2000) recovery.observe(sample(time), target);
  expect(recovery.observe(sample(8000, { id: 'new-report' }), target)).toBe(false);
  expect(recovery.observe(sample(30_000, { id: 'new-report' }), target)).toBe(false);
  for (let time = 32_000; time < 38_000; time += 2000)
    expect(recovery.observe(sample(time, { id: 'new-report' }), target)).toBe(false);
  expect(recovery.observe(sample(38_000, { id: 'new-report' }), target)).toBe(true);
  const smallSource = new ScreenQualityRecovery();
  for (let time = 2000; time <= 20_000; time += 2000)
    expect(smallSource.observe(sample(time, { width: 640, height: 360, sourceWidth: 640, sourceHeight: 360 }), target)).toBe(false);
});

test('stats extraction uses the screen transport and accounts for camera/audio bandwidth', () => {
  const reports = new Map([
    ['screen', { id: 'screen', type: 'outbound-rtp', mid: '2', kind: 'video', timestamp: 10_000,
      frameWidth: 320, frameHeight: 180, framesEncoded: 100, bytesSent: 40_000, headerBytesSent: 1000,
      transportId: 'transport', remoteId: 'remote', mediaSourceId: 'source' }],
    ['camera', { id: 'camera', type: 'outbound-rtp', mid: '1', kind: 'video', bytesSent: 100_000, headerBytesSent: 2000 }],
    ['audio', { id: 'audio', type: 'outbound-rtp', mid: '0', kind: 'audio', bytesSent: 30_000 }],
    ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' }],
    ['old', { id: 'old', type: 'candidate-pair', availableOutgoingBitrate: 90_000_000 }],
    ['selected', { id: 'selected', type: 'candidate-pair', availableOutgoingBitrate: 500_000, currentRoundTripTime: 0.1 }],
    ['remote', { id: 'remote', type: 'remote-inbound-rtp', timestamp: 9000, fractionLost: 0.03 }],
    ['source', { id: 'source', type: 'media-source', width: 320, height: 180, framesPerSecond: 30 }]
  ]) as unknown as RTCStatsReport;
  expect(readScreenQuality(reports, '2', { width: 1920, height: 1080 })).toMatchObject({
    id: 'screen', screenBytes: 41_000, otherBytes: 132_000, availableBitrate: 500_000,
    loss: 0.03, rtt: 0.1, feedbackTimestamp: 9000, sourceWidth: 1920, sourceHeight: 1080
  });
  expect(readScreenQuality(reports, null, {})).toBeNull();
});

test('recovery keeps saver/custom limits in force and restores preferences even after unsupported hints', async () => {
  for (const preference of ['balanced', 'maintain-framerate', 'maintain-resolution'] as const) {
    const changes: any[] = [];
    const sender = { getParameters: () => ({ encodings: [{}] }), setParameters: async (params: any) => {
      changes.push(structuredClone(params));
      if (changes.length === 1) throw new DOMException('Unsupported', 'NotSupportedError');
    } } as unknown as RTCRtpSender;
    await refreshScreenEncoding(sender, { maxBitrate: 312_000, maxFramerate: 15, degradationPreference: preference });
    expect(changes).toHaveLength(2);
    for (const params of changes) expect(params.encodings[0]).toMatchObject({ maxBitrate: 312_000, maxFramerate: 15, scaleResolutionDownBy: 1 });
    expect(changes[1].degradationPreference).toBe(preference);
  }
});
