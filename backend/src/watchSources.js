const { load } = require('cheerio');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_URL_LENGTH = 4096;

function webUrl(value, base) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value.trim(), base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

function classifySource(value, title = '') {
  const url = webUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let kind = null, mediaId;
  if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'youtu.be'].includes(host)) {
    mediaId = host === 'youtu.be' ? url.pathname.split('/')[1] : url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1];
    if (/^[\w-]{11}$/.test(mediaId || '')) kind = 'youtube';
  } else if (['vimeo.com', 'player.vimeo.com'].includes(host)) {
    mediaId = url.pathname.match(/(?:^|\/)(\d+)(?:\/|$)/)?.[1];
    if (mediaId) kind = 'vimeo';
  } else if (/\.m3u8$/i.test(url.pathname)) kind = 'hls';
  else if (/\.(?:mp4|webm|ogv|m4v|mov)$/i.test(url.pathname)) kind = 'video';
  return kind ? { kind, url: url.href, title: ((typeof title === 'string' && title) || mediaId || url.pathname.split('/').pop() || host).slice(0, 160), ...(mediaId ? { mediaId } : {}) } : null;
}

// Never fetch private, loopback, link-local, documentation, multicast or mapped
// private addresses. DNS is resolved once and pinned into the actual request.
function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) === 6) {
    // Global unicast only; mapped IPv4 and transition mechanisms are excluded.
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(normalized) && !/^2002:|^2001:(?::|(?:db8|0|10|20):)|^3fff:/i.test(normalized);
  }
  return false;
}

async function fetchPublicPage(value, signal, redirects = 0) {
  const url = webUrl(value);
  if (!url || !['', '80', '443'].includes(url.port)) throw new Error('Yalnızca standart HTTP/HTTPS bağlantıları taranabilir.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Yerel veya özel ağ adresleri sunucudan taranamaz.');
  if (signal?.aborted) throw new Error('Tespit iptal edildi.');
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {
      signal, timeout: 8000, headers: { 'User-Agent': 'WindWatch/1.0 VideoDiscovery', Accept: 'text/html,video/*,application/vnd.apple.mpegurl;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'identity' },
      lookup: (_host, options, callback) => options?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family)
    }, response => {
      const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        const next = webUrl(response.headers.location, url);
        if (!next || redirects >= 3) return reject(new Error('Bağlantının yönlendirmeleri takip edilemedi.'));
        fetchPublicPage(next.href, signal, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) { response.destroy(); return reject(new Error(`Kaynak site yanıt vermedi (${response.statusCode}). Kaynak sekmesinde tespiti deneyin.`)); }
      if (type.startsWith('video/') || ['application/vnd.apple.mpegurl', 'application/x-mpegurl'].includes(type)) {
        response.destroy(); return resolve({ url: url.href, type, html: '' });
      }
      if (type && !['text/html', 'application/xhtml+xml', 'text/plain'].includes(type)) { response.destroy(); return reject(new Error('Bu bağlantıda desteklenen bir video veya sayfa bulunamadı.')); }
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_PAGE_BYTES) { response.destroy(new Error('Kaynak sayfa tarama boyutunu aşıyor. Kaynak sekmesinde tespit edin.')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ url: url.href, type, html: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Site taraması zaman aşımına uğradı. Tekrar tespit edebilirsiniz.')));
    request.on('error', reject);
  });
}

function extractSources(html, pageUrl) {
  const $ = load(html);
  const base = webUrl($('base[href]').first().attr('href'), pageUrl)?.href || pageUrl;
  const title = ($('meta[property="og:title"]').attr('content') || $('title').text() || '').trim().slice(0, 160);
  const candidates = new Map();
  function add(value, method, score, mime = '') {
    const url = webUrl(value, base);
    if (!url) return;
    const source = classifySource(url.href, title) || (/^video\//i.test(mime) ? { kind: 'video', url: url.href, title: title || 'Video' } : /mpegurl/i.test(mime) ? { kind: 'hls', url: url.href, title: title || 'Canlı yayın' } : null);
    if (source && (!candidates.has(source.url) || candidates.get(source.url).score < score)) candidates.set(source.url, { ...source, method, score });
  }
  $('video').each((_i, element) => {
    add($(element).attr('src'), 'Sayfadaki video', 90, $(element).attr('type'));
    $(element).find('source').each((_j, source) => add($(source).attr('src'), 'Sayfadaki video', 85, $(source).attr('type')));
  });
  $('meta[property^="og:video"], meta[name="twitter:player:stream"]').each((_i, element) => add($(element).attr('content'), 'Video meta bilgisi', 75));
  $('iframe[src], embed[src]').each((_i, element) => add($(element).attr('src'), 'Gömülü oynatıcı', 80));
  $('script[type="application/ld+json"]').each((_i, element) => {
    try {
      const walk = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 12) return;
        if (Array.isArray(value)) { value.slice(0, 100).forEach(item => walk(item, depth + 1)); return; }
        if (value['@type'] === 'VideoObject' || value.contentUrl || value.embedUrl) { add(value.contentUrl, 'Video bilgisi', 80); add(value.embedUrl, 'Gömülü oynatıcı', 75); }
        Object.values(value).slice(0, 100).forEach(item => walk(item, depth + 1));
      };
      walk(JSON.parse($(element).text()));
    } catch { /* Invalid metadata does not prevent other methods. */ }
  });
  // Configuration strings are inspected, never evaluated. Actual playing
  // videos and manifests from dynamic pages are detected by the browser helper.
  const plain = html.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
  for (const match of plain.matchAll(/https?:\/\/[^\s"'<>\\]{1,4000}\.(?:m3u8|mp4|webm)(?:\?[^\s"'<>\\]*)?/gi)) add(match[0], 'Oynatıcı yapılandırması', 40);
  return [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 15);
}

async function discoverSources(value, signal, fetchPage = fetchPublicPage) {
  const url = webUrl(value);
  if (!url) throw new Error('Geçerli bir HTTP/HTTPS video veya sayfa bağlantısı girin.');
  const direct = classifySource(url.href);
  if (direct) return { candidates: [{ ...direct, method: 'Doğrudan bağlantı', score: 100 }], pageUrl: url.href };
  const page = await fetchPage(url.href, signal);
  if (page.type.startsWith('video/') || /mpegurl/.test(page.type)) return { candidates: [{ kind: /mpegurl/.test(page.type) ? 'hls' : 'video', url: page.url, title: 'Video', method: 'Video yanıtı', score: 100 }], pageUrl: page.url };
  return { candidates: extractSources(page.html, page.url), pageUrl: page.url };
}

function validateSource(input) {
  if (!input || typeof input !== 'object') return null;
  const url = webUrl(input.url);
  if (!url) return null;
  const detected = classifySource(url.href, input.title);
  const pageUrl = webUrl(input.pageUrl)?.href;
  if (detected && detected.kind === input.kind) return { ...detected, ...(pageUrl ? { pageUrl } : {}) };
  if (['video', 'hls', 'external'].includes(input.kind)) return { kind: input.kind, url: url.href, title: typeof input.title === 'string' ? input.title.trim().slice(0, 160) || 'Video' : 'Video', ...(pageUrl ? { pageUrl } : {}) };
  return null;
}

module.exports = { webUrl, classifySource, publicAddress, fetchPublicPage, extractSources, discoverSources, validateSource };
