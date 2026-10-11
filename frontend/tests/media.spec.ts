import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { buildDisplayMediaConstraints, canShareDisplayAudio, normalizeCustomSettings, SCREEN_SHARE_PRESETS } from '../src/utils/screenShare';
import { parseFileMessage } from '../src/types';

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
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this instanceof HTMLAudioElement && state.testBlockAudio) return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
      return play.call(this);
    };
    const NativeConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativeConnection {
      constructor(configuration?: RTCConfiguration) { super(configuration); state.testConnections.push(this); }
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getUserMedia(constraints);
      state.testCaptures.push(stream);
      if (state.testDelayCapture) await new Promise(resolve => setTimeout(resolve, 1500));
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = async options => {
      state.testDisplayOptions = options;
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#123456'; context.fillRect(0, 0, 1280, 720);
      const stream = canvas.captureStream(10);
      const video = stream.getVideoTracks()[0];
      let frame = 0;
      const frames = setInterval(() => {
        if (video.readyState === 'ended') { clearInterval(frames); void audio.close(); return; }
        context.fillStyle = frame++ % 2 ? '#123456' : '#234567';
        context.fillRect(0, 0, 1280, 720);
      }, 100);
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

async function member(browser: Browser, roomId: string, name: string, mobile = false, blockAudio = false) {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 850 } });
  await instrument(context);
  await context.addInitScript(blocked => { (window as any).testBlockAudio = blocked; }, blockAudio);
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
