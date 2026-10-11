import { test, expect, chromium } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sourceFromUrl, expectedPosition, startPosition } from '../src/utils/watch';

const clip = readFileSync(path.resolve('tests/fixtures/watch.webm'));
let sourceServer: ReturnType<typeof createServer>, sourceUrl: string;
test.beforeAll(async () => {
  sourceServer = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (/^\/hls\/(?:stream\.m3u8|segment-\d+\.ts)$/.test(req.url || '')) {
      res.setHeader('Content-Type', req.url!.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
      res.end(readFileSync(path.resolve(`tests/fixtures${req.url}`))); return;
    }
    if (req.url?.startsWith('/movie.webm') || req.url?.startsWith('/second.webm')) {
      res.setHeader('Content-Type', 'video/webm'); res.setHeader('Accept-Ranges', 'bytes');
      const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
      if (range) { const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1; res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${clip.length}`); res.setHeader('Content-Length', end - start + 1); res.end(clip.subarray(start, end + 1)); }
      else { res.setHeader('Content-Length', clip.length); res.end(clip); }
      return;
    }
    if (req.url?.startsWith('/late') || req.url?.startsWith('/external')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><title>Sonradan başlayan video</title></head><body style="background:#101114;color:white;font:18px system-ui"><h1>Kaynak site</h1><button id="start">Videoyu başlat</button><div id="target"></div><script>document.getElementById('start').onclick=()=>{let v=document.querySelector('video');if(!v){v=document.createElement('video');v.controls=true;v.style.width='640px';v.src='/movie.webm';document.getElementById('target').append(v);}v.play();};</script></body></html>`); return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => sourceServer.listen(0, '127.0.0.1', resolve));
  sourceUrl = `http://127.0.0.1:${(sourceServer.address() as { port: number }).port}`;
});
test.afterAll(async () => { sourceServer.closeAllConnections(); await new Promise<void>(resolve => sourceServer.close(() => resolve())); });

async function createRoom(request: any) { return (await (await request.post('http://localhost:5018/create-room', { data: {} })).json()).roomId as string; }
async function join(context: BrowserContext, room: string, name: string) {
  await context.addInitScript(() => {
    const state = window as any; state.watchConnections = [];
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native { constructor(config?: RTCConfiguration) { super(config); state.watchConnections.push(this); } };
  });
  const page = await context.newPage(); await page.goto(`http://localhost:5178/room/${room}`);
  await page.locator('input[type=text]:enabled').fill(name); await page.getByRole('button', { name: 'Odaya Katıl' }).click();
  await expect(page.locator('.live-badge')).toHaveText('Bağlı'); return page;
}
async function enterLink(page: Page, url: string) {
  await page.getByRole('button', { name: 'Birlikte izle', exact: true }).click();
  await page.getByLabel('Video veya sayfa bağlantısı').fill(url);
}
async function playing(page: Page) { await expect.poll(() => page.locator('.watch-video').evaluate((video: HTMLVideoElement) => !video.paused && video.currentTime > 0)).toBe(true); }
async function difference(a: Page, b: Page) { return Math.abs(await a.locator('.watch-video').evaluate((video: HTMLVideoElement) => video.currentTime) - await b.locator('.watch-video').evaluate((video: HTMLVideoElement) => video.currentTime)); }
async function extensionContext() {
  const extensionPath = path.resolve('../extension');
  const context = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', baseURL: 'http://localhost:5178', args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  return context;
}

test('watch URL routing rejects fake providers and applies source timestamps and server clock', () => {
  expect(sourceFromUrl('https://www.youtube.com/watch?v=abcdefghijk')?.mediaId).toBe('abcdefghijk');
  expect(sourceFromUrl('https://youtu.be/abcdefghijk?t=1m20s')?.kind).toBe('youtube');
  expect(sourceFromUrl('https://vimeo.com/12345678')?.kind).toBe('vimeo');
  expect(sourceFromUrl('https://cdn.example.org/live.m3u8?token=abc')?.kind).toBe('hls');
  expect(sourceFromUrl('https://youtube.com.evil.org/watch?v=abcdefghijk')).toBeNull();
  expect(sourceFromUrl('javascript:alert(1)')).toBeNull();
  expect(startPosition('https://youtu.be/abcdefghijk?t=1h2m3s')).toBe(3723);
  expect(startPosition('https://example.org/movie.webm#t=20')).toBe(20);
  expect(expectedPosition({ position: 10, paused: false, updatedAt: 1000, rate: 1.5 } as any, 200, 1800)).toBe(11.5);
});

test('shared native video synchronizes pause, seek, rate, permissions, late join and queue while call audio continues', async ({ browser, request }) => {
  const id = await createRoom(request), a = await browser.newContext(), b = await browser.newContext(), c = await browser.newContext();
  try {
    const host = await join(a, id, 'İzleme yöneticisi'), viewer = await join(b, id, 'İzleyici');
    await expect(host.locator('[data-connection-state=connected]')).toHaveCount(1);
    await host.getByRole('button', { name: 'Mikrofonu aç', exact: true }).click();
    await enterLink(host, `${sourceUrl}/movie.webm`);
    await host.getByRole('button', { name: 'Videoyu tespit et', exact: true }).click();
    await playing(host); await playing(viewer);
    await expect(viewer.getByRole('button', { name: 'Videoyu duraklat', exact: true })).toBeDisabled();
    await host.getByRole('button', { name: 'Videoyu duraklat', exact: true }).click();
    await expect.poll(() => viewer.locator('.watch-video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
    for (const position of ['4', '9', '12']) await host.getByLabel('Video zamanı', { exact: true }).fill(position);
    await expect.poll(() => viewer.locator('.watch-video').evaluate((video: HTMLVideoElement) => Math.abs(video.currentTime - 12))).toBeLessThan(0.3);
    await host.getByLabel('Video oynatma hızı').selectOption('1.5');
    await expect.poll(() => viewer.locator('.watch-video').evaluate((video: HTMLVideoElement) => video.playbackRate)).toBe(1.5);
    await host.getByLabel('Herkes oynatıcıyı kontrol edebilir').check();
    await viewer.getByRole('button', { name: 'Videoyu oynat', exact: true }).click();
    await playing(viewer);
    const late = await join(c, id, 'Sonradan gelen'); await playing(late);
    await expect.poll(() => difference(host, late)).toBeLessThan(0.5);
    await viewer.getByLabel('Video ses seviyesi').fill('0.15');
    await expect.poll(() => viewer.locator('.watch-video').evaluate((video: HTMLVideoElement) => video.volume)).toBe(0.15);
    expect(await host.locator('.watch-video').evaluate((video: HTMLVideoElement) => video.volume)).toBe(0.7);
    const mic = () => host.evaluate(async () => { const pc = (window as any).watchConnections.find((item: RTCPeerConnection) => item.connectionState === 'connected') as RTCPeerConnection; const reports = await pc.getTransceivers()[0].sender.getStats(); let bytes = 0; reports.forEach(item => { if (item.type === 'outbound-rtp') bytes += item.bytesSent || 0; }); return bytes; });
    const before = await mic(); await expect.poll(mic).toBeGreaterThan(before);
    await host.getByRole('button', { name: 'Video bağlantıları', exact: true }).click();
    await host.getByLabel('Kuyruğa ekle', { exact: true }).check();
    await host.getByLabel('Video veya sayfa bağlantısı').fill(`${sourceUrl}/second.webm`);
    await host.getByRole('button', { name: 'Videoyu tespit et', exact: true }).click();
    await expect(host.locator('.watch-queue')).toContainText('second.webm');
    await host.getByRole('button', { name: 'Sıradaki videoya geç' }).click();
    await expect(viewer.locator('.watch-video')).toHaveAttribute('src', `${sourceUrl}/second.webm`);
    await playing(viewer);
    await host.getByRole('button', { name: 'Video bağlantıları', exact: true }).click();
    await viewer.screenshot({ path: 'test-results/watch-desktop.png' });
    await viewer.setViewportSize({ width: 390, height: 844 });
    await viewer.screenshot({ path: 'test-results/watch-mobile.png' });
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await viewer.getByRole('button', { name: 'Videoyu duraklat', exact: true }).click();
    await host.getByRole('button', { name: 'Birlikte izlemeyi bitir', exact: true }).click();
    await expect(viewer.locator('.watch-video')).toHaveCount(0);
    await expect(host.locator('[data-connection-state=connected]')).toHaveCount(2);
  } finally { await Promise.allSettled([a.close(), b.close(), c.close()]); }
});

test('real helper detects a dynamically started video, rescan reuses its tab, pauses duplicate source sound and rejects untrusted pages', async ({ request }) => {
  const context = await extensionContext();
  try {
    const app = await join(context, await createRoom(request), 'Video tespiti');
    await enterLink(app, `${sourceUrl}/late`);
    await expect(app.locator('.watch-helper-badge')).toHaveText('Video yardımcısı bağlı');
    await app.getByRole('button', { name: 'Videoyu tespit et', exact: true }).click();
    await expect.poll(() => context.pages().filter(page => page.url() === `${sourceUrl}/late`).length).toBe(1);
    const source = context.pages().find(page => page.url() === `${sourceUrl}/late`)!;
    await expect(app.locator('.watch-video')).toHaveCount(0);
    await app.getByRole('button', { name: 'Tekrar tespit et', exact: true }).click();
    expect(context.pages().filter(page => page.url() === `${sourceUrl}/late`).length).toBe(1);
    await source.getByRole('button', { name: 'Videoyu başlat' }).click();
    await playing(app);
    await expect.poll(() => source.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
    await expect(app.locator('.watch-video')).toHaveAttribute('src', `${sourceUrl}/movie.webm`);
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => worker.evaluate(async () => Object.values((await (globalThis as any).chrome.storage.session.get('jobs')).jobs || {}).every((job: any) => job.suspended))).toBe(true);
    const denied = await source.evaluate(() => new Promise(resolve => {
      window.addEventListener('message', function listener(event) { if (event.data?.channel === 'windwatch-helper:reply' && event.data.id === 'untrusted-test') { window.removeEventListener('message', listener); resolve(event.data.result); } });
      window.postMessage({ channel: 'windwatch-helper:request', id: 'untrusted-test', action: 'open', url: 'https://example.org/' }, location.origin);
    }));
    expect((denied as any).ok).toBe(false);
    await app.getByRole('button', { name: 'Birlikte izlemeyi bitir', exact: true }).click();
    await expect.poll(() => worker.evaluate(async () => Object.keys((await (globalThis as any).chrome.storage.session.get('jobs')).jobs || {}).length)).toBe(0);
  } finally { await context.close(); }
});

test('source-site playback synchronizes the actual external player and supports source controls and closed-tab recovery', async ({ request }) => {
  const context = await extensionContext();
  try {
    const app = await join(context, await createRoom(request), 'Kaynak izleme');
    await enterLink(app, `${sourceUrl}/external`);
    await app.getByLabel('Tespit edilince otomatik başlat').uncheck();
    await app.getByRole('button', { name: 'Kaynak sekmesinde tespit et', exact: true }).click();
    await expect.poll(() => context.pages().filter(page => page.url() === `${sourceUrl}/external`).length).toBe(1);
    const source = context.pages().find(page => page.url() === `${sourceUrl}/external`)!;
    await source.getByRole('button', { name: 'Videoyu başlat' }).click();
    await app.getByRole('button', { name: 'Kaynak sitede senkron izle', exact: true }).click();
    await expect(app.locator('.watch-external-stage')).toBeVisible();
    await expect(app.locator('.watch-info')).toContainText('Hazır');
    await app.getByRole('button', { name: 'Videoyu duraklat', exact: true }).click();
    await expect(app.getByRole('button', { name: 'Videoyu oynat', exact: true })).toBeVisible();
    await expect.poll(() => source.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
    await app.getByLabel('Video zamanı', { exact: true }).fill('15');
    await expect.poll(() => source.locator('video').evaluate((video: HTMLVideoElement) => Math.abs(video.currentTime - 15))).toBeLessThan(0.4);
    // A native source-site action updates the authoritative room timeline.
    await source.locator('video').evaluate((video: HTMLVideoElement) => { video.currentTime = 20; });
    await expect.poll(() => app.getByLabel('Video zamanı', { exact: true }).inputValue()).toMatch(/^2[01](?:\.|$)/);
    await source.close();
    await expect(app.locator('.watch-info')).toContainText('Kaynak sekmesi bekleniyor');
    await app.getByRole('button', { name: 'Kaynak sekmesini aç', exact: true }).click();
    await expect.poll(() => context.pages().filter(page => page.url() === `${sourceUrl}/external`).length).toBe(1);
    const reopened = context.pages().find(page => page.url() === `${sourceUrl}/external`)!;
    await reopened.getByRole('button', { name: 'Videoyu başlat' }).click();
    await expect(app.locator('.watch-info')).toContainText('Hazır');
    await expect.poll(() => reopened.locator('video').evaluate((video: HTMLVideoElement) => video.paused && Math.abs(video.currentTime - 20) < 0.4 && video.volume === 0.7)).toBe(true);
    await app.getByRole('button', { name: 'Videoyu oynat', exact: true }).click();
    await expect.poll(() => reopened.locator('video').evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
    await app.getByRole('button', { name: 'Birlikte izlemeyi bitir', exact: true }).click();
    await expect.poll(() => reopened.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
    expect(reopened.isClosed()).toBe(false);
  } finally { await context.close(); }
});

test('HLS playback loads real manifest segments and recovers after a viewer autoplay block', async ({ browser, request }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  for (const context of [a, b]) await context.addInitScript(() => {
    const canPlay = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) { return /mpegurl/i.test(type) ? '' : canPlay.call(this, type); };
  });
  await b.addInitScript(() => {
    const state = window as any; state.blockWatch = true;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.classList.contains('watch-video') && state.blockWatch) return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
      return play.call(this);
    };
  });
  try {
    const id = await createRoom(request), host = await join(a, id, 'HLS yönetici'), viewer = await join(b, id, 'HLS izleyici');
    await enterLink(host, `${sourceUrl}/hls/stream.m3u8`);
    await host.getByRole('button', { name: 'Videoyu tespit et', exact: true }).click();
    await playing(host);
    await expect(viewer.getByRole('button', { name: 'Bu cihazda izlemeyi başlat', exact: true })).toBeVisible();
    await viewer.evaluate(() => { (window as any).blockWatch = false; });
    await viewer.getByRole('button', { name: 'Bu cihazda izlemeyi başlat', exact: true }).click();
    await playing(viewer);
    await expect.poll(() => difference(host, viewer)).toBeLessThan(0.7);
    await expect(host.getByLabel('Video görüntü kalitesi')).toBeVisible();
    await host.getByLabel('Video görüntü kalitesi').selectOption('0');
    await host.getByRole('button', { name: 'Videoyu duraklat', exact: true }).click();
    await expect.poll(() => viewer.locator('.watch-video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  } finally { await Promise.allSettled([a.close(), b.close()]); }
});

test('ending a movie automatically advances the shared queue', async ({ browser, request }) => {
  const context = await browser.newContext();
  try {
    const host = await join(context, await createRoom(request), 'Otomatik kuyruk');
    await enterLink(host, `${sourceUrl}/movie.webm`);
    await host.getByRole('button', { name: 'Videoyu tespit et', exact: true }).click();
    await playing(host);
    await host.getByRole('button', { name: 'Video bağlantıları', exact: true }).click();
    await host.getByLabel('Kuyruğa ekle', { exact: true }).check();
    await host.getByLabel('Video veya sayfa bağlantısı').fill(`${sourceUrl}/second.webm`);
    await host.getByRole('button', { name: 'Videoyu tespit et', exact: true }).click();
    await expect(host.locator('.watch-queue')).toContainText('second.webm');
    await host.getByLabel('Video zamanı', { exact: true }).fill('44.8');
    await expect(host.locator('.watch-video')).toHaveAttribute('src', `${sourceUrl}/second.webm`);
    await playing(host);
    await expect(host.locator('.watch-queue')).toContainText('Video kuyruğu · 0/20');
  } finally { await context.close(); }
});
