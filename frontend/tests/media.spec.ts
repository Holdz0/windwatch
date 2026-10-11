import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { buildDisplayMediaConstraints, canShareDisplayAudio, normalizeCustomSettings, SCREEN_SHARE_PRESETS } from '../src/utils/screenShare';
import { parseFileMessage } from '../src/types';
import { SAVER_UPLOAD_BUDGET, saverBudget, trafficBitrate } from '../src/utils/saver';

test('saver budgets all viewers together and traffic samples ignore new connection counters', () => {
  for (let viewers = 1; viewers <= 7; viewers++) {
    for (const camera of [true, false]) for (const microphone of [true, false]) for (const screenAudio of [true, false]) {
      const budget = saverBudget(viewers, { camera, microphone, screenAudio });
      expect((budget.screen + budget.camera + budget.microphone + budget.screenAudio) * viewers).toBeLessThanOrEqual(SAVER_UPLOAD_BUDGET);
      expect(budget.screen).toBeGreaterThan(0);
      expect(budget.screen).toBeLessThanOrEqual(500_000);
      expect(budget.camera).toBeLessThanOrEqual(100_000);
    }
  }
  const samples = new Map();
  expect(trafficBitrate(samples, [{ id: 'a', timestamp: 1000, bytes: 1_000_000 }])).toBeNull();
  expect(trafficBitrate(samples, [{ id: 'a', timestamp: 2000, bytes: 1_010_000 },
    { id: 'late', timestamp: 2000, bytes: 9_000_000 }])).toBe(80_000);
  expect(trafficBitrate(samples, [{ id: 'a', timestamp: 3000, bytes: 1_010_000 }])).toBe(0);
  expect(trafficBitrate(samples, [{ id: 'reconnect', timestamp: 4000, bytes: 500 }])).toBeNull();
});

test('capture requests exclude WindWatch audio and unsafe sources fail closed', () => {
  const options = buildDisplayMediaConstraints(SCREEN_SHARE_PRESETS.balanced, true) as any;
  expect(options.audio.restrictOwnAudio).toBe(true);
  expect(options.systemAudio).toBe('include');
  expect(options.selfBrowserSurface).toBe('exclude');
  expect((buildDisplayMediaConstraints(SCREEN_SHARE_PRESETS.balanced, false) as any).systemAudio).toBe('exclude');
  expect(canShareDisplayAudio('monitor', false)).toBe(false);
  expect(canShareDisplayAudio('window', false)).toBe(false);
  expect(canShareDisplayAudio('unknown', false)).toBe(false);
  expect(canShareDisplayAudio('monitor', true)).toBe(true);
  expect(canShareDisplayAudio('browser', false)).toBe(true);
  expect(normalizeCustomSettings({ maxHeight: Infinity, frameRate: -20, maxBitrate: 100_000_000 }))
    .toEqual({ maxHeight: 1080, frameRate: 5, maxBitrate: 15_000_000 });
  expect(parseFileMessage('[FILE]{"id":"a","name":"bad","size":-1}')).toBeNull();
});

async function instrument(context: BrowserContext) {
  await context.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    const state = window as any;
    state.testConnections = [];
    state.testCaptures = [];
    const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => [...await enumerate(), ...(state.testDeviceFixtures || [])];
    const setSink = HTMLMediaElement.prototype.setSinkId;
    HTMLMediaElement.prototype.setSinkId = async function (id) {
      if (id.startsWith('fixture-')) { await setSink.call(this, ''); (this as any).testSink = id; }
      else { await setSink.call(this, id); (this as any).testSink = id; }
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this instanceof HTMLAudioElement && state.testBlockAudio) return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
      return play.call(this);
    };
    const NativeConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativeConnection {
      constructor(configuration?: RTCConfiguration) { super(configuration); state.testConnections.push(this); }
    };
    state.testScreenEncodingChanges = [];
    const setParameters = RTCRtpSender.prototype.setParameters;
    RTCRtpSender.prototype.setParameters = function (params) {
      const pc = state.testConnections.find((connection: RTCPeerConnection) => connection.getTransceivers()[2]?.sender === this);
      if (pc) state.testScreenEncodingChanges.push({ time: Date.now(), pc: state.testConnections.indexOf(pc),
        preference: params.degradationPreference, encoding: structuredClone(params.encodings?.[0]) });
      return setParameters.call(this, params);
    };
    const setCodecPreferences = RTCRtpTransceiver.prototype.setCodecPreferences;
    RTCRtpTransceiver.prototype.setCodecPreferences = function (codecs) {
      // Exercise real negotiation without AV1/VP9, as with older endpoints.
      return setCodecPreferences.call(this, state.testBaselineScreen
        ? codecs.filter(codec => ['video/vp8', 'video/rtx', 'video/red', 'video/ulpfec'].includes(codec.mimeType.toLowerCase()))
        : codecs);
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const options = structuredClone(constraints!);
      let alias = '';
      for (const kind of ['audio', 'video'] as const) {
        const selected = (options[kind] as MediaTrackConstraints)?.deviceId as { exact?: string } | undefined;
        if (selected?.exact?.startsWith('fixture-')) {
          alias = selected.exact;
          if (alias.includes('broken')) throw new DOMException('Device in use', 'NotReadableError');
          delete (options[kind] as MediaTrackConstraints).deviceId;
        }
      }
      const stream = await getUserMedia(options);
      if (alias) for (const track of stream.getTracks()) {
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), deviceId: alias });
      }
      state.testCaptures.push(stream);
      if (state.testDelayCapture) await new Promise(resolve => setTimeout(resolve, 1500));
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = async options => {
      state.testDisplayOptions = options;
      const canvas = document.createElement('canvas');
      canvas.width = state.testScene === 'static' ? 1920 : 1280;
      canvas.height = state.testScene === 'static' ? 1080 : 720;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#123456'; context.fillRect(0, 0, 1280, 720);
      const drawScene = (frame: number) => {
        context.fillStyle = '#15202f'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#f0f6fc'; context.font = '24px monospace';
        for (let line = 0; line < 18; line++) context.fillText(`${line + 1}  const readableText = "WindWatch ekran paylaşımı";`, 28, 40 + line * 34);
        if (state.testScene === 'motion') {
          for (let i = 0; i < 36; i++) {
            context.fillStyle = `hsl(${i * 37 % 360} 70% 55%)`;
            context.fillRect((frame * (3 + i % 5) + i * 67) % 1280, 70 + i * 47 % 540, 42, 42);
          }
        }
      };
      if (state.testScene) drawScene(0);
      const stream = canvas.captureStream(state.testScene ? 30 : 10);
      const video = stream.getVideoTracks()[0];
      let frame = 0;
      const frames = setInterval(() => {
        if (video.readyState === 'ended') { clearInterval(frames); void audio.close(); return; }
        if (state.testScene === 'motion') drawScene(frame++);
        else if (!state.testScene) {
          context.fillStyle = frame++ % 2 ? '#123456' : '#234567';
          context.fillRect(0, 0, 1280, 720);
        }
      }, state.testScene ? 1000 / 30 : 100);
      const settings = video.getSettings.bind(video);
      video.getSettings = () => ({ ...settings(), displaySurface: state.testSurface || 'monitor' });
      const audio = new AudioContext();
      void audio.resume();
      const oscillator = audio.createOscillator();
      oscillator.frequency.value = 440;
      const destination = audio.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      const track = destination.stream.getAudioTracks()[0];
      const audioSettings = track.getSettings.bind(track);
      track.getSettings = () => ({ ...audioSettings(), restrictOwnAudio: state.testRestrictOwnAudio !== false } as MediaTrackSettings);
      track.applyConstraints = async () => {};
      stream.addTrack(track);
      state.testCaptures.push(stream);
      if (state.testEndShareEarly) setTimeout(() => video.dispatchEvent(new Event('ended')), 10);
      if (state.testDropSignaling) await state.testDisconnect();
      return stream;
    };
  });
}

async function member(browser: Browser, roomId: string, name: string, mobile = false, blockAudio = false, baselineScreen = false) {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 850 } });
  await instrument(context);
  await context.addInitScript(({ blocked, baseline }) => {
    (window as any).testBlockAudio = blocked;
    (window as any).testBaselineScreen = baseline;
  }, { blocked: blockAudio, baseline: baselineScreen });
  const page = await context.newPage();
  await page.goto(`/room/${roomId}`);
  await page.locator('input[type="text"]:enabled').fill(name);
  await page.getByRole('button', { name: 'Odaya Katıl' }).click();
  await expect(page.locator('.live-badge')).toHaveText('Bağlı');
  return { context, page };
}

async function connected(page: Page, count: number) {
  await expect(page.locator('[data-connection-state="connected"]')).toHaveCount(count);
}

async function createRoom(request: any) {
  const response = await request.post('http://localhost:5018/create-room', { data: {} });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).roomId as string;
}

async function outboundBytes(page: Page, slot: number) {
  return page.evaluate(async index => {
    const connection = (window as any).testConnections.find((pc: RTCPeerConnection) => pc.connectionState === 'connected') as RTCPeerConnection;
    if (!connection) return 0;
    const stats = await connection.getTransceivers()[index].sender.getStats();
    let bytes = 0;
    stats.forEach(report => { if (report.type === 'outbound-rtp') bytes += report.bytesSent || 0; });
    return bytes;
  }, slot);
}

async function chooseQuality(page: Page, label: string) {
  await page.getByRole('button', { name: 'Ekran paylaşımı ayarları', exact: true }).click();
  await page.locator('.quality-option').filter({ has: page.locator('.quality-option-label', { hasText: label }) }).click();
}

async function senderParameters(page: Page) {
  return page.evaluate(() => {
    const pc = (window as any).testConnections.find((connection: RTCPeerConnection) => connection.connectionState === 'connected') as RTCPeerConnection;
    return pc.getTransceivers().map(transceiver => ({ ...transceiver.sender.getParameters().encodings[0],
      trackId: transceiver.sender.track?.id || null }));
  });
}

async function screenStats(page: Page) {
  return page.evaluate(async () => {
    const pc = (window as any).testConnections.find((connection: RTCPeerConnection) => connection.connectionState === 'connected') as RTCPeerConnection;
    const reports = await pc.getTransceivers()[2].sender.getStats();
    let screen: any = null;
    reports.forEach(report => { if (report.type === 'outbound-rtp' && report.kind === 'video') screen = report; });
    return screen ? { bytes: screen.bytesSent, frames: screen.framesEncoded, width: screen.frameWidth,
      height: screen.frameHeight, fps: screen.framesPerSecond, codec: reports.get(screen.codecId)?.mimeType } : null;
  });
}

test('screen recovery restores real received frames after simulated connection improvement and isolates viewers', async ({ browser, request }) => {
  test.setTimeout(60_000);
  const id = await createRoom(request);
  const host = await member(browser, id, 'Paylaşan');
  const viewer = await member(browser, id, 'İzleyen');
  const second = await member(browser, id, 'İyi bağlantı');
  try {
    await connected(host.page, 2);
    await host.page.evaluate(() => { (window as any).testScene = 'motion'; });
    await chooseQuality(host.page, 'Tasarruf');
    await host.page.getByRole('button', { name: 'Mikrofonu aç', exact: true }).click();
    await host.page.getByRole('button', { name: 'Ekranını paylaş', exact: true }).click();
    await expect.poll(() => viewer.page.locator('.screen-share video').evaluate(video => (video as HTMLVideoElement).videoHeight)).toBe(720);
    await expect.poll(() => second.page.locator('.screen-share video').evaluate(video => (video as HTMLVideoElement).videoHeight)).toBe(720);
    const original = await senderParameters(host.page);
    await host.page.evaluate(async () => {
      const state = window as any;
      const pc = state.testConnections.find((connection: RTCPeerConnection) => connection.connectionState === 'connected') as RTCPeerConnection;
      state.testRecoveryPc = state.testConnections.indexOf(pc);
      state.testConnectionRecovered = false;
      const sender = pc.getTransceivers()[2].sender;
      const params = sender.getParameters();
      params.encodings[0].scaleResolutionDownBy = 4;
      await sender.setParameters(params);
      const getStats = pc.getStats.bind(pc);
      // Inject ONLY network feedback. Dimensions, encoded/decoded frames,
      // packets, media tracks and the data channel remain real WebRTC.
      pc.getStats = async (...args) => {
        const reports = await getStats(...args);
        let screen: any;
        reports.forEach(report => { if (report.type === 'outbound-rtp' && report.mid === pc.getTransceivers()[2].mid) screen = report; });
        if (screen) {
          const transport = reports.get(screen.transportId);
          const pair = reports.get(transport?.selectedCandidatePairId);
          const remote = reports.get(screen.remoteId);
          if (pair) pair.availableOutgoingBitrate = state.testConnectionRecovered ? 8_000_000 : 160_000;
          if (remote) { remote.fractionLost = state.testConnectionRecovered ? 0 : 0.15;
            remote.roundTripTime = state.testConnectionRecovered ? 0.02 : 0.8; }
        }
        return reports;
      };
      state.testScreenEncodingChanges = [];
    });
    await expect.poll(() => viewer.page.locator('.screen-share video').evaluate(video => (video as HTMLVideoElement).videoHeight)).toBe(180);
    const low = await screenStats(host.page);
    const bytes = await outboundBytes(host.page, 0);
    // Wait for two full quality samples while feedback is still unhealthy.
    await expect.poll(async () => await outboundBytes(host.page, 0) - bytes, { timeout: 10_000 }).toBeGreaterThan(8000);
    expect(await viewer.page.locator('.screen-share video').evaluate(video => (video as HTMLVideoElement).videoHeight)).toBe(180);
    expect(await host.page.evaluate(() => (window as any).testScreenEncodingChanges.length)).toBe(0);
    await host.page.evaluate(() => { (window as any).testConnectionRecovered = true; });
    await expect.poll(() => viewer.page.locator('.screen-share video').evaluate(video => (video as HTMLVideoElement).videoHeight), { timeout: 20_000 }).toBe(720);
    const recovered = await screenStats(host.page);
    console.log('SCREEN FEEDBACK RECOVERY', { low, recovered });
    expect(recovered!.frames).toBeGreaterThan(low!.frames);
    const parameters = await senderParameters(host.page);
    expect(parameters.map(sender => sender.trackId)).toEqual(original.map(sender => sender.trackId));
    expect(parameters[2]).toMatchObject({ maxBitrate: 500_000, maxFramerate: 30, scaleResolutionDownBy: 1 });
    const changes = await host.page.evaluate(() => (window as any).testScreenEncodingChanges);
    expect(changes.map((change: any) => change.preference)).toEqual(['balanced', 'maintain-framerate']);
    expect(new Set(changes.map((change: any) => change.pc)).size).toBe(1);
    for (const change of changes) expect(change.encoding).toMatchObject({ maxBitrate: 500_000, maxFramerate: 30 });
    expect(await second.page.locator('.screen-share video').evaluate(video => (video as HTMLVideoElement).videoHeight)).toBe(720);
    const microphoneBytes = await outboundBytes(host.page, 0);
    await expect.poll(() => outboundBytes(host.page, 0)).toBeGreaterThan(microphoneBytes);
    const fileBytes = Buffer.alloc(64 * 1024 + 7, 41);
    await host.page.locator('input[type="file"]').setInputFiles({ name: 'toparlanma.bin', mimeType: 'application/octet-stream', buffer: fileBytes });
    const download = viewer.page.waitForEvent('download');
    await viewer.page.getByRole('button', { name: 'P2P İndir', exact: true }).click();
    const file = await download, stream = await file.createReadStream(), chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(fileBytes);
    expect(await host.page.evaluate(() => (window as any).testConnections.length)).toBe(2);
    await connected(viewer.page, 2);
    await host.page.getByRole('button', { name: 'Paylaşımı durdur', exact: true }).click();
    const stopped = await host.page.evaluate(() => {
      const state = window as any;
      const pc = state.testConnections[state.testRecoveryPc] as RTCPeerConnection;
      const getStats = pc.getStats.bind(pc);
      state.testQualityReadsAfterStop = 0;
      pc.getStats = async (...args) => { state.testQualityReadsAfterStop++; return getStats(...args); };
      return Date.now();
    });
    await expect.poll(() => host.page.evaluate(() => Date.now()) , { timeout: 6000 }).toBeGreaterThan(stopped + 2500);
    expect(await host.page.evaluate(() => (window as any).testQualityReadsAfterStop)).toBe(0);
  } finally {
    await host.context.close(); await viewer.context.close(); await second.context.close();
  }
});

test('saver negotiates efficient screen video, caps every sender and restores live media', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Tasarruf');
  const viewer = await member(browser, id, 'İzleyen');
  try {
    await connected(host.page, 1); await connected(viewer.page, 1);
    await host.page.evaluate(() => { (window as any).testScene = 'motion'; });
    await host.page.getByRole('button', { name: 'Mikrofonu aç', exact: true }).click();
    await host.page.getByRole('button', { name: 'Kamerayı aç', exact: true }).click();
    await chooseQuality(host.page, 'Tasarruf');
    await host.page.getByRole('button', { name: 'Ekranını paylaş', exact: true }).click();
    await expect.poll(async () => (await screenStats(host.page))?.frames || 0).toBeGreaterThan(30);
    const params = await senderParameters(host.page);
    expect(params[0].maxBitrate).toBe(24_000);
    expect(params[1].maxBitrate).toBe(100_000);
    expect(params[1].scaleResolutionDownBy).toBe(2);
    expect(params[1].maxFramerate).toBe(15);
    expect(params[2].maxBitrate).toBe(500_000);
    expect(params[2].maxFramerate).toBe(30);
    expect(params[3].maxBitrate).toBe(64_000);
    expect((await screenStats(host.page))?.codec).toBe('video/AV1');
    await host.page.getByRole('button', { name: 'Ekran paylaşımı ayarları', exact: true }).click();
    await expect(host.page.locator('.saver-status strong')).toContainText('MB/saat');
    const before = (await screenStats(host.page))!;
    const start = Date.now();
    await expect.poll(async () => ((await screenStats(host.page))?.frames || 0) - before.frames).toBeGreaterThan(120);
    const after = (await screenStats(host.page))!;
    const seconds = (Date.now() - start) / 1000;
    const measured = { fps: (after.frames - before.frames) / seconds,
      kbps: (after.bytes - before.bytes) * 8 / seconds / 1000, width: after.width, height: after.height, codec: after.codec };
    console.log('SAVER MOTION SAMPLE', measured);
    expect(measured.fps).toBeGreaterThan(20);
    expect(measured.kbps).toBeLessThan(600);
    await viewer.page.screenshot({ path: 'test-results/saver-motion-viewer.png' });
    await host.page.screenshot({ path: 'test-results/saver-menu.png' });
    await host.page.setViewportSize({ width: 390, height: 844 });
    await expect(host.page.locator('.saver-status')).toBeVisible();
    expect(await host.page.locator('.quality-menu').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
    })).toBe(true);
    await host.page.locator('.saver-status').scrollIntoViewIfNeeded();
    expect(await host.page.locator('.saver-status').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    })).toBe(true);
    await host.page.screenshot({ path: 'test-results/saver-menu-mobile.png' });
    await host.page.setViewportSize({ width: 1280, height: 850 });
    await host.page.getByRole('button', { name: 'Ekran paylaşımı ayarları', exact: true }).click();
    await chooseQuality(host.page, 'Dengeli');
    await expect.poll(async () => (await senderParameters(host.page))[2].maxBitrate).toBe(4_000_000);
    const restored = await senderParameters(host.page);
    expect(restored.map(sender => sender.trackId)).toEqual(params.map(sender => sender.trackId));
    expect(restored[0].maxBitrate).toBeUndefined(); expect(restored[3].maxBitrate).toBeUndefined();
    expect(restored[1].maxBitrate).toBe(1_500_000); expect(restored[1].scaleResolutionDownBy).toBe(1);
    expect(restored[1].maxFramerate).toBe(30);
    await chooseQuality(host.page, 'Tasarruf');
    await host.page.getByRole('button', { name: 'Paylaşımı durdur', exact: true }).click();
    await expect.poll(async () => (await senderParameters(host.page))[1].maxBitrate).toBe(1_500_000);
    await expect.poll(() => outboundBytes(host.page, 0)).toBeGreaterThan(0);
  } finally { await host.context.close(); await viewer.context.close(); }
});

async function fixtureDevices(page: Page) {
  await page.evaluate(() => {
    (window as any).testDeviceFixtures = [
      { kind: 'audioinput', deviceId: 'fixture-mic-a', label: 'USB Mikrofon', groupId: 'a' },
      { kind: 'audioinput', deviceId: 'fixture-mic-b', label: 'Kulaklık Mikrofonu', groupId: 'b' },
      { kind: 'audioinput', deviceId: 'fixture-mic-broken', label: 'Meşgul Mikrofon', groupId: 'broken' },
      { kind: 'videoinput', deviceId: 'fixture-camera-a', label: 'USB Kamera', groupId: 'a' },
      { kind: 'videoinput', deviceId: 'fixture-camera-b', label: 'İkinci Kamera', groupId: 'b' },
      { kind: 'videoinput', deviceId: 'fixture-camera-broken', label: 'Meşgul Kamera', groupId: 'broken' },
      { kind: 'audiooutput', deviceId: 'fixture-speaker-a', label: 'USB Kulaklık', groupId: 'a' }
    ];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
}

test('prejoin device tests are opt-in, release capture and remember camera selection', async ({ browser, request }) => {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
  await instrument(context);
  const page = await context.newPage();
  try {
    const id = await createRoom(request);
    await page.goto(`/room/${id}`);
    await page.getByRole('button', { name: 'Kamera ve ses cihazlarını kontrol et', exact: true }).click();
    expect(await page.evaluate(() => (window as any).testCaptures.length)).toBe(0);
    await fixtureDevices(page);
    await page.getByLabel('Kamera', { exact: true }).selectOption('fixture-camera-b');
    await page.getByLabel('Mikrofon', { exact: true }).selectOption('fixture-mic-a');
    await page.getByRole('button', { name: 'Kamerayı test et', exact: true }).click();
    await page.getByRole('button', { name: 'Mikrofonu test et', exact: true }).click();
    await expect.poll(() => page.getByLabel('Kamera önizlemesi').evaluate(video => (video as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).testCaptures.length)).toBe(2);
    await expect(page.getByRole('progressbar', { name: 'Mikrofon seviyesi' })).toBeVisible();
    await page.screenshot({ path: 'test-results/device-prejoin.png' });
    await page.getByRole('button', { name: 'Cihaz testlerini kapat', exact: true }).click();
    expect(await page.evaluate(() => (window as any).testCaptures.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
    await page.locator('input[type="text"]:enabled').fill('Cihaz');
    await page.getByRole('button', { name: 'Odaya Katıl', exact: true }).click();
    await expect(page.locator('.live-badge')).toHaveText('Bağlı');
    await page.getByRole('button', { name: 'Kamerayı aç', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).testCaptures.at(-1)?.getVideoTracks()[0]?.getSettings().deviceId)).toBe('fixture-camera-b');
  } finally { await context.close(); }
});

test('closing device tests during pending permission stops eventual tracks', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
  await instrument(context);
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.evaluate(() => { (window as any).testDelayCapture = true; });
    await page.getByRole('button', { name: 'Kamera ve ses cihazlarını kontrol et', exact: true }).click();
    await page.getByRole('button', { name: 'Kamerayı test et', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).testCaptures.length)).toBe(1);
    await page.getByRole('button', { name: 'Cihaz testlerini kapat', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).testCaptures.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  } finally { await context.close(); }
});

test('live device replacement preserves share and connections; failures preserve microphone; unplug falls back', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Cihaz');
  const viewer = await member(browser, id, 'Dinleyen');
  try {
    await connected(host.page, 1);
    await fixtureDevices(host.page);
    await host.page.getByRole('button', { name: 'Mikrofonu aç', exact: true }).click();
    await host.page.getByRole('button', { name: 'Kamerayı aç', exact: true }).click();
    await host.page.getByRole('button', { name: 'Ekranını paylaş', exact: true }).click();
    await expect.poll(() => outboundBytes(host.page, 2)).toBeGreaterThan(0);
    const before = await senderParameters(host.page);
    await host.page.getByRole('button', { name: 'Cihaz ayarları', exact: true }).click();
    await host.page.getByLabel('Mikrofon', { exact: true }).selectOption('fixture-mic-a');
    await expect.poll(async () => (await senderParameters(host.page))[0].trackId).not.toBe(before[0].trackId);
    await host.page.getByLabel('Kamera', { exact: true }).selectOption('fixture-camera-b');
    await expect.poll(async () => (await senderParameters(host.page))[1].trackId).not.toBe(before[1].trackId);
    const replaced = await senderParameters(host.page);
    expect(replaced[2].trackId).toBe(before[2].trackId); expect(replaced[3].trackId).toBe(before[3].trackId);
    await expect.poll(() => host.page.getByLabel('Kamera önizlemesi').evaluate(video => (video as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
    const cameraBytes = await outboundBytes(host.page, 1);
    await expect.poll(() => outboundBytes(host.page, 1)).toBeGreaterThan(cameraBytes);
    await host.page.getByLabel('Kamera', { exact: true }).selectOption('fixture-camera-broken');
    await expect(host.page.locator('.device-error')).toContainText('Cihaz açılamadı');
    expect((await senderParameters(host.page))[1].trackId).toBe(replaced[1].trackId);
    await host.page.getByLabel('Mikrofon', { exact: true }).selectOption('fixture-mic-broken');
    await expect(host.page.locator('.device-error')).toContainText('Cihaz açılamadı');
    expect((await senderParameters(host.page))[0].trackId).toBe(replaced[0].trackId);
    await host.page.getByLabel('Hoparlör / kulaklık', { exact: true }).selectOption('fixture-speaker-a');
    await expect.poll(() => host.page.evaluate(() => localStorage.getItem('windwatch:mediaDevices'))).toContain('fixture-speaker-a');
    await host.page.getByRole('button', { name: 'Hoparlörü test et', exact: true }).click();
    await expect(host.page.getByRole('button', { name: 'Test sesi çalıyor…', exact: true })).toBeVisible();
    await host.page.screenshot({ path: 'test-results/device-room.png' });
    await host.page.evaluate(() => {
      const state = window as any;
      state.testDeviceFixtures = state.testDeviceFixtures.filter((device: MediaDeviceInfo) => !['fixture-mic-a', 'fixture-camera-b', 'fixture-speaker-a'].includes(device.deviceId));
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    });
    await expect(host.page.getByLabel('Mikrofon', { exact: true })).toHaveValue('');
    await expect(host.page.getByLabel('Kamera', { exact: true })).toHaveValue('');
    await expect(host.page.getByLabel('Hoparlör / kulaklık', { exact: true })).toHaveValue('');
    await host.page.getByRole('button', { name: 'Cihaz ayarlarını kapat', exact: true }).click();
    await host.page.setViewportSize({ width: 390, height: 844 });
    await host.page.getByRole('button', { name: 'Cihaz ayarları', exact: true }).click();
    await expect(host.page.getByRole('dialog', { name: 'Cihaz ayarları', exact: true })).toBeVisible();
    await expect.poll(() => host.page.getByLabel('Kamera önizlemesi').evaluate(video => (video as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
    await host.page.screenshot({ path: 'test-results/device-room-mobile.png' });
    await host.page.keyboard.press('Escape');
    await expect(host.page.getByRole('dialog', { name: 'Cihaz ayarları', exact: true })).toHaveCount(0);
    const bytes = await outboundBytes(host.page, 0);
    await expect.poll(() => outboundBytes(host.page, 0)).toBeGreaterThan(bytes);
    await connected(host.page, 1); await connected(viewer.page, 1);
    await expect.poll(() => host.page.evaluate(() => (window as any).testConnections.length)).toBe(1);
  } finally { await host.context.close(); await viewer.context.close(); }
});

test('file progress survives chat closure; cancelling allows immediate clean retry without interrupting share', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Gönderen');
  const viewer = await member(browser, id, 'İndiren');
  try {
    await connected(host.page, 1);
    await host.page.getByRole('button', { name: 'Ekranını paylaş', exact: true }).click();
    await host.page.locator('input[type="file"]').setInputFiles({ name: 'ilk.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1024 * 1024, 77) });
    await viewer.page.getByLabel('Dosya aktarım hız sınırı').selectOption(String(64 * 1024));
    await viewer.page.getByRole('button', { name: 'P2P İndir', exact: true }).click();
    await expect(viewer.page.locator('.file-transfer[data-transfer-status="active"]')).toContainText('KB/sn');
    await viewer.page.getByRole('button', { name: 'Sohbeti gizle', exact: true }).click();
    await viewer.page.getByRole('button', { name: 'Sohbeti göster', exact: true }).click();
    await expect(viewer.page.locator('.file-transfer[data-transfer-status="active"]')).toContainText('kaldı');
    await viewer.page.screenshot({ path: 'test-results/file-progress.png' });
    await viewer.page.setViewportSize({ width: 390, height: 844 });
    await expect(viewer.page.locator('.mobile-chat-container')).toBeVisible();
    const cancel = viewer.page.getByRole('button', { name: 'Dosya aktarımını iptal et', exact: true });
    await cancel.scrollIntoViewIfNeeded();
    await expect.poll(() => cancel.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    })).toBe(true);
    await viewer.page.screenshot({ path: 'test-results/file-progress-mobile.png' });
    await viewer.page.getByRole('button', { name: 'Dosya aktarımını iptal et', exact: true }).click();
    await expect(host.page.locator('.file-transfer[data-transfer-status="cancelled"]')).toContainText('iptal');
    const bytes = Buffer.from(Array.from({ length: 256 * 1024 + 31 }, (_, i) => i % 251));
    await host.page.locator('input[type="file"]').setInputFiles({ name: 'ikinci.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await expect(viewer.page.locator('.file-name').last()).toHaveText('ikinci.bin');
    const download = viewer.page.waitForEvent('download');
    await viewer.page.getByRole('button', { name: 'P2P İndir', exact: true }).last().click();
    const file = await download, stream = await file.createReadStream(), chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    await expect(host.page.locator('.file-transfer[data-transfer-status="complete"]')).toContainText('tamamlandı');
    const before = await outboundBytes(host.page, 2);
    await expect.poll(() => outboundBytes(host.page, 2)).toBeGreaterThan(before);
    await connected(host.page, 1);
  } finally { await host.context.close(); await viewer.context.close(); }
});

test('file upload rate is shared by simultaneous recipients and sender cancellation stops downloads', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Gönderen');
  const first = await member(browser, id, 'Birinci');
  const second = await member(browser, id, 'İkinci');
  try {
    await connected(host.page, 2);
    await host.page.getByRole('button', { name: 'Mikrofonu aç', exact: true }).click();
    const bytes = Buffer.alloc(256 * 1024, 55);
    await host.page.locator('input[type="file"]').setInputFiles({ name: 'sinir.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await host.page.getByLabel('Dosya aktarım hız sınırı').selectOption(String(64 * 1024));
    await first.page.getByLabel('Dosya aktarım hız sınırı').selectOption('0');
    await second.page.getByLabel('Dosya aktarım hız sınırı').selectOption('0');
    const one = first.page.waitForEvent('download'), two = second.page.waitForEvent('download');
    const start = Date.now();
    await first.page.getByRole('button', { name: 'P2P İndir', exact: true }).click();
    await second.page.getByRole('button', { name: 'P2P İndir', exact: true }).click();
    const files = await Promise.all([one, two]);
    expect(Date.now() - start).toBeGreaterThan(6500);
    for (const file of files) { const stream = await file.createReadStream(), chunks = []; for await (const chunk of stream!) chunks.push(chunk); expect(Buffer.concat(chunks)).toEqual(bytes); }
    await expect(host.page.locator('.file-transfer[data-transfer-status="complete"]')).toHaveCount(2);
    await first.page.getByRole('button', { name: 'P2P İndir', exact: true }).click();
    await expect(host.page.getByRole('button', { name: 'Dosya aktarımını iptal et', exact: true })).toBeVisible();
    await host.page.getByRole('button', { name: 'Dosya aktarımını iptal et', exact: true }).click();
    await expect(first.page.locator('.file-transfer[data-transfer-status="cancelled"]')).toBeVisible();
    const before = await outboundBytes(host.page, 0);
    await expect.poll(() => outboundBytes(host.page, 0)).toBeGreaterThan(before);
  } finally { await host.context.close(); await first.context.close(); await second.context.close(); }
});

test('saver rebalances on late joins and departures; a VP8-only share still works', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Paylaşan', false, false, true);
  const first = await member(browser, id, 'İlk', false, false, true);
  let second: Awaited<ReturnType<typeof member>> | undefined;
  let third: Awaited<ReturnType<typeof member>> | undefined;
  try {
    await connected(host.page, 1);
    await chooseQuality(host.page, 'Tasarruf');
    await host.page.getByRole('button', { name: 'Ekranını paylaş', exact: true }).click();
    await expect.poll(async () => (await screenStats(host.page))?.frames || 0).toBeGreaterThan(0);
    expect((await screenStats(host.page))?.codec).toBe('video/VP8');
    second = await member(browser, id, 'İkinci', false, false, true);
    third = await member(browser, id, 'Üçüncü', false, false, true);
    await connected(host.page, 3);
    const expected = saverBudget(3, { camera: false, microphone: false, screenAudio: true }).screen;
    await expect.poll(() => host.page.evaluate(() => (window as any).testConnections
      .filter((pc: RTCPeerConnection) => pc.connectionState === 'connected')
      .map((pc: RTCPeerConnection) => pc.getTransceivers()[2].sender.getParameters().encodings[0].maxBitrate)))
      .toEqual([expected, expected, expected]);
    await expect.poll(() => third!.page.locator('.screen-share video').evaluate(video => (video as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
    await third.page.getByRole('button', { name: 'Odadan ayrıl', exact: true }).click();
    await connected(host.page, 2);
    await expect.poll(() => host.page.evaluate(() => (window as any).testConnections
      .filter((pc: RTCPeerConnection) => pc.connectionState === 'connected')
      .map((pc: RTCPeerConnection) => pc.getTransceivers()[2].sender.getParameters().encodings[0].maxBitrate)))
      .toEqual([500_000, 500_000]);
  } finally { await host.context.close(); await first.context.close(); await second?.context.close(); await third?.context.close(); }
});

test('saver keeps a static 1080p document sharp without continuously sending frames', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Belge');
  const viewer = await member(browser, id, 'Okuyan');
  try {
    await connected(host.page, 1);
    await host.page.evaluate(() => { (window as any).testScene = 'static'; });
    await chooseQuality(host.page, 'Tasarruf');
    await host.page.getByRole('button', { name: 'Ekranını paylaş', exact: true }).click();
    await expect.poll(async () => (await screenStats(host.page))?.height).toBe(1080);
    await expect.poll(() => viewer.page.locator('.screen-share video').evaluate(video => (video as HTMLVideoElement).videoHeight)).toBe(1080);
    const before = (await screenStats(host.page))!;
    // Wait for a real stats interval using the settings UI, rather than forcing
    // duplicate frames or an artificial heartbeat into a static source.
    await host.page.getByRole('button', { name: 'Ekran paylaşımı ayarları', exact: true }).click();
    await expect(host.page.locator('.saver-status strong')).toContainText('MB/saat');
    const after = (await screenStats(host.page))!;
    console.log('SAVER STATIC SAMPLE', { frames: after.frames - before.frames, bytes: after.bytes - before.bytes, height: after.height, codec: after.codec });
    expect(after.frames - before.frames).toBeLessThan(10);
    expect(after.bytes - before.bytes).toBeLessThan(100_000);
    await viewer.page.screenshot({ path: 'test-results/saver-static-viewer.png' });
  } finally { await host.context.close(); await viewer.context.close(); }
});

test('real WebRTC carries mic, camera and share separately; mobile chat preserves all audio', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Kurucu');
  const viewer = await member(browser, id, 'İzleyici', true);
  try {
    await connected(host.page, 1); await connected(viewer.page, 1);
    await host.page.getByRole('button', { name: 'Mikrofonu aç', exact: true }).click();
    await host.page.getByRole('button', { name: 'Kamerayı aç', exact: true }).click();
    await expect.poll(() => outboundBytes(host.page, 0)).toBeGreaterThan(0);
    await expect.poll(() => outboundBytes(host.page, 1)).toBeGreaterThan(0);
    await host.page.getByRole('button', { name: 'Ekranını paylaş', exact: true }).click();
    await expect(host.page.getByRole('button', { name: 'Paylaşımı durdur', exact: true })).toBeEnabled();
    await expect.poll(() => outboundBytes(host.page, 2)).toBeGreaterThan(0);
    await expect.poll(() => outboundBytes(host.page, 3)).toBeGreaterThan(0);
    await viewer.page.getByRole('button', { name: 'Sohbeti göster', exact: true }).click();
    await expect(viewer.page.locator('.mobile-chat-container')).toBeVisible();
    await expect.poll(() => viewer.page.locator('.thumbnail-hidden').evaluateAll(elements => elements.every(element => getComputedStyle(element).display === 'none'))).toBe(true);
    await expect(viewer.page.locator('.remote-audio audio')).toHaveCount(2);
    await expect.poll(() => viewer.page.locator('.remote-audio audio').evaluateAll(elements => elements.every(element => !(element as HTMLAudioElement).paused))).toBe(true);
    const third = await member(browser, id, 'Konuşan');
    try {
      await connected(viewer.page, 2);
      await third.page.getByRole('button', { name: 'Mikrofonu aç', exact: true }).click();
      const thirdPeerId = await third.page.locator('[data-connection-state="local"]').getAttribute('data-peer-id');
      await expect(viewer.page.locator('.remote-audio audio')).toHaveCount(4);
      await expect.poll(() => viewer.page.locator(`[data-audio-peer="${thirdPeerId}"] audio`).first().evaluate(element => !(element as HTMLAudioElement).paused)).toBe(true);
      await viewer.page.screenshot({ path: 'test-results/mobile-sharing-chat.png' });
      await host.page.screenshot({ path: 'test-results/desktop-sharing.png' });
    } finally { await third.page.getByRole('button', { name: 'Odadan ayrıl', exact: true }).click(); await third.context.close(); }
    await host.page.getByRole('button', { name: 'Mikrofonu kapat', exact: true }).click();
    const before = await outboundBytes(host.page, 3);
    await expect.poll(() => outboundBytes(host.page, 3)).toBeGreaterThan(before);
    await host.page.getByRole('button', { name: 'Paylaşımı durdur', exact: true }).click();
    await expect(host.page.getByRole('button', { name: 'Ekranını paylaş', exact: true })).toBeEnabled();
    expect(await host.page.evaluate(() => {
      const pc = (window as any).testConnections.find((connection: RTCPeerConnection) => connection.connectionState === 'connected');
      return pc.getTransceivers().map((t: RTCRtpTransceiver) => t.sender.track?.kind || null);
    })).toEqual([null, 'video', null, null]);
    await connected(viewer.page, 1);
    await host.page.screenshot({ path: 'test-results/desktop-room.png' });
    await viewer.page.screenshot({ path: 'test-results/mobile-room.png' });
  } finally { await host.context.close(); await viewer.context.close(); }
});

test('late joins receive every active media channel and file history without restarting existing streams', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Yayıncı');
  const first = await member(browser, id, 'İlk izleyici');
  let late: Awaited<ReturnType<typeof member>> | undefined;
  try {
    await connected(host.page, 1);
    await host.page.getByRole('button', { name: 'Mikrofonu aç', exact: true }).click();
    await host.page.getByRole('button', { name: 'Kamerayı aç', exact: true }).click();
    await host.page.getByRole('button', { name: 'Ekranını paylaş', exact: true }).click();
    await first.page.getByRole('button', { name: 'Mikrofonu aç', exact: true }).click();
    const fileBytes = Buffer.from(Array.from({ length: 64 * 1024 + 31 }, (_, index) => index % 251));
    await host.page.locator('input[type="file"]').setInputFiles({ name: 'katılmadan-once.bin', mimeType: 'application/octet-stream', buffer: fileBytes });
    await expect(first.page.locator('.file-name')).toHaveText('katılmadan-once.bin');
    const originalTracks = (await senderParameters(host.page)).map(sender => sender.trackId);
    const hostPeerId = await host.page.locator('[data-connection-state="local"]').getAttribute('data-peer-id');
    const before = await outboundBytes(host.page, 2);

    late = await member(browser, id, 'Sonradan gelen', true);
    await connected(late.page, 2); await connected(host.page, 2); await connected(first.page, 2);
    await expect(late.page.locator('.screen-share')).toHaveCount(1);
    await expect.poll(() => late!.page.locator('.screen-share video').evaluate(video => (video as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
    // Verify received/decoded RTP, including camera hidden by mobile layout.
    await expect.poll(() => late!.page.evaluate(async () => {
      const pcs = (window as any).testConnections.filter((pc: RTCPeerConnection) => pc.connectionState === 'connected') as RTCPeerConnection[];
      const channels = await Promise.all(pcs.map(async pc => {
        const mids = pc.getTransceivers().map(transceiver => transceiver.mid);
        const received = [0, 0, 0, 0];
        const reports = await pc.getStats();
        reports.forEach((report: any) => {
          if (report.type !== 'inbound-rtp') return;
          const slot = mids.indexOf(report.mid);
          if (slot >= 0 && report.bytesReceived > 0 && (report.kind !== 'video' || report.framesDecoded > 0))
            received[slot] = report.bytesReceived;
        });
        return received;
      }));
      return channels.some(slots => slots.every(bytes => bytes > 0));
    })).toBe(true);
    await expect.poll(() => late!.page.locator(`[data-audio-peer="${hostPeerId}"] audio`).evaluateAll(elements =>
      elements.length === 2 && elements.every(element => !(element as HTMLAudioElement).paused))).toBe(true);
    await late.page.getByRole('button', { name: 'Mikrofonu aç', exact: true }).click();
    await expect.poll(() => outboundBytes(late!.page, 0)).toBeGreaterThan(0);
    await late.page.getByRole('button', { name: 'Sohbeti göster', exact: true }).click();
    await expect(late.page.locator('.file-name')).toHaveText('katılmadan-once.bin');
    const download = late.page.waitForEvent('download');
    await late.page.getByRole('button', { name: 'P2P İndir', exact: true }).click();
    const file = await download, stream = await file.createReadStream(), chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(fileBytes);
    expect((await senderParameters(host.page)).map(sender => sender.trackId)).toEqual(originalTracks);
    await expect.poll(() => outboundBytes(host.page, 2)).toBeGreaterThan(before);
    expect(await host.page.evaluate(() => (window as any).testConnections.length)).toBe(2);
  } finally { await host.context.close(); await first.context.close(); await late?.context.close(); }
});

test('late joiners receive active share; unfiltered desktop audio is never sent', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Paylaşan');
  await host.page.evaluate(() => { (window as any).testRestrictOwnAudio = false; });
  await host.page.getByRole('button', { name: 'Ekranını paylaş', exact: true }).click();
  await expect(host.page.locator('.toast-notification.warning')).toContainText('WindWatch sesini sistem sesinden ayıramıyor');
  const viewer = await member(browser, id, 'Sonradan');
  try {
    await connected(host.page, 1); await connected(viewer.page, 1);
    await expect.poll(() => outboundBytes(host.page, 2)).toBeGreaterThan(0);
    expect(await host.page.evaluate(() => {
      const pc = (window as any).testConnections.find((connection: RTCPeerConnection) => connection.connectionState === 'connected');
      return pc.getTransceivers()[3].sender.track;
    })).toBeNull();
    await expect(viewer.page.locator('.screen-share')).toHaveCount(1);
  } finally { await host.context.close(); await viewer.context.close(); }
});

test('leaving during a permission request stops the eventual hardware track', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Ayrılan');
  try {
    await host.page.evaluate(() => { (window as any).testDelayCapture = true; });
    await host.page.getByRole('button', { name: 'Kamerayı aç', exact: true }).click();
    await host.page.getByRole('button', { name: 'Odadan ayrıl', exact: true }).click();
    await expect(host.page.locator('.landing-card')).toBeVisible();
    await expect.poll(() => host.page.evaluate(() => (window as any).testCaptures.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  } finally { await host.context.close(); }
});

test('chunked file transfer downloads the original bytes over the media connection', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Dosya');
  const viewer = await member(browser, id, 'İndiren');
  try {
    await connected(host.page, 1); await connected(viewer.page, 1);
    const bytes = Buffer.alloc(1024 * 1024 + 13, 77);
    await host.page.locator('input[type="file"]').setInputFiles({ name: 'aktarim.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await expect(viewer.page.locator('.file-name')).toHaveText('aktarim.bin');
    const downloaded = viewer.page.waitForEvent('download');
    await viewer.page.getByRole('button', { name: 'P2P İndir' }).click();
    const file = await downloaded;
    const stream = await file.createReadStream();
    const chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
  } finally { await host.context.close(); await viewer.context.close(); }
});

test('a failed media connection is rebuilt without losing hardware state', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'A');
  const viewer = await member(browser, id, 'B');
  try {
    await connected(host.page, 1); await connected(viewer.page, 1);
    await host.page.getByRole('button', { name: 'Mikrofonu aç', exact: true }).click();
    await expect.poll(() => outboundBytes(host.page, 0)).toBeGreaterThan(0);
    await host.page.evaluate(() => {
      const connection = (window as any).testConnections.find((pc: RTCPeerConnection) => pc.connectionState === 'connected');
      connection.close();
      connection.dispatchEvent(new Event('connectionstatechange'));
    });
    await expect.poll(() => host.page.evaluate(() => (window as any).testConnections.filter((pc: RTCPeerConnection) => pc.connectionState === 'connected').length)).toBe(1);
    await connected(viewer.page, 1);
    await expect.poll(() => outboundBytes(host.page, 0)).toBeGreaterThan(0);
    await expect(host.page.getByRole('button', { name: 'Mikrofonu kapat', exact: true })).toBeEnabled();
  } finally { await host.context.close(); await viewer.context.close(); }
});

test('a share with no server acknowledgement releases capture and leaves no local share', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Onay');
  try {
    await host.page.exposeFunction('testDisconnect', () => host.context.setOffline(true));
    await host.page.evaluate(() => { (window as any).testDropSignaling = true; });
    await host.page.getByRole('button', { name: 'Ekranını paylaş', exact: true }).click();
    await expect.poll(() => host.page.evaluate(() => (window as any).testCaptures.length)).toBe(1);
    await expect.poll(() => host.page.evaluate(() => (window as any).testCaptures.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
    await expect(host.page.getByRole('button', { name: 'Paylaşımı durdur', exact: true })).toHaveCount(0);
  } finally { await host.context.close(); }
});

test('blocked remote playback displays an explicit audio unlock button', async ({ browser, request }) => {
  const id = await createRoom(request);
  const host = await member(browser, id, 'Ses');
  const viewer = await member(browser, id, 'Dinleyen', false, true);
  try {
    await connected(host.page, 1); await connected(viewer.page, 1);
    await host.page.getByRole('button', { name: 'Mikrofonu aç', exact: true }).click();
    await expect(viewer.page.locator('.audio-unlock-banner')).toBeVisible();
    await viewer.page.evaluate(() => { (window as any).testBlockAudio = false; });
    await viewer.page.locator('.audio-unlock-banner').click();
    await expect(viewer.page.locator('.audio-unlock-banner')).toHaveCount(0);
    await expect.poll(() => viewer.page.locator('.remote-audio audio').first().evaluate(element => !(element as HTMLAudioElement).paused)).toBe(true);
  } finally { await host.context.close(); await viewer.context.close(); }
});
