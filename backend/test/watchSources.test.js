const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicAddress, classifySource, extractSources, discoverSources, fetchPublicPage, validateSource } = require('../src/watchSources');

test('page discovery handles relative sources, metadata, embedded providers and escaped HLS without running scripts', () => {
  const html = `<title>A &amp; B</title><base href="https://cdn.example.org/media/"><video><source src="movie?id=42" type="video/mp4"></video>
    <meta property="og:video" content="https://cdn.example.org/full.mp4"><iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>
    <script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://cdn.example.org/ld.webm"}</script>
    <script>window.notExecuted = true; const source = "https:\\/\\/cdn.example.org\\/stream.m3u8?token=a\\u0026b=2";</script>`;
  const found = extractSources(html, 'https://example.org/watch');
  assert.equal(found.length, 5);
  assert.equal(found[0].url, 'https://cdn.example.org/media/movie?id=42');
  assert.equal(found[0].kind, 'video');
  assert.equal(found[0].title, 'A & B');
  assert.equal(found.find(source => source.kind === 'hls').url, 'https://cdn.example.org/stream.m3u8?token=a&b=2');
  assert.equal(found.find(source => source.kind === 'youtube').mediaId, 'abcdefghijk');
  assert.equal(global.notExecuted, undefined);
});
test('discovery retries can detect video that was absent in the first response; direct links never fetch page bodies', async () => {
  let html = '<title>Later</title>', calls = 0;
  const fetchPage = async url => { calls++; return { url, type: 'text/html', html }; };
  assert.equal((await discoverSources('https://example.org/watch', null, fetchPage)).candidates.length, 0);
  html += '<video src="/movie.mp4"></video>';
  assert.equal((await discoverSources('https://example.org/watch', null, fetchPage)).candidates[0].url, 'https://example.org/movie.mp4');
  await discoverSources('https://example.org/movie.mp4', null, fetchPage);
  assert.equal(calls, 2);
});
test('resolver rejects private IPs, URL credentials and alternate ports, including IPv4 mapped IPv6', async () => {
  for (const address of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '172.16.0.2', '192.168.1.1', '100.64.0.1', '198.18.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::1', '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
  for (const url of ['http://127.0.0.1', 'http://[::ffff:127.0.0.1]', 'https://user:pass@example.org/watch', 'https://example.org:444/watch']) await assert.rejects(fetchPublicPage(url));
  assert.equal(validateSource({ kind: 'video', url: 'javascript:alert(1)' }), null);
  assert.equal(classifySource('https://youtube.com.evil.org/watch?v=abcdefghijk'), null);
  assert.equal(validateSource({ kind: 'youtube', url: 'https://example.org/watch?v=abcdefghijk', mediaId: 'abcdefghijk' }), null);
});
