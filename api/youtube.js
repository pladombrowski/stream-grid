// YouTube offers no keyless live lookup. This endpoint reads the public watch or
// channel /live page and returns only the metadata the grid needs. No user
// cookies or account credentials leave this server. The page shape is
// undocumented: the parser is deliberately tolerant and degrades to "not live"
// instead of trusting partial data.
const { isIP } = require('node:net');
const cache = new Map(), pending = new Map(), clients = new Map(), pendingByClient = new Map();
const ttl = 30000, cacheLimit = 300, clientsLimit = 1000, requestsPerMinute = 60, pendingLimit = 500;
const clientPendingLimit = 16, maxPageBytes = 4 * 1024 * 1024;
let retryAt = 0;
class YouTubeError extends Error {
  constructor(status, code, retryAfter = 0) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HANDLE = /^@[A-Za-z0-9._-]{3,60}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const PAGE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+cb; SOCS=CAI',
};

function clientKey(value) {
  let address = String(value || '').trim().toLowerCase();
  if (address.startsWith('[')) {
    const end = address.indexOf(']');
    if (end > 0) address = address.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(address)) {
    address = address.slice(0, address.lastIndexOf(':'));
  }
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return address || 'unknown';
  // A v4-mapped address is a real IPv4 client; collapsing it into ::/48 would share one bucket.
  const mapped = /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(address);
  if (mapped) {
    if (mapped[1]) return mapped[1];
    const high = parseInt(mapped[2], 16), low = parseInt(mapped[3], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  const [left, right] = address.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  // One IPv6 /48 is one client: common subscriber delegation, so rotating /64s cannot mint identities.
  return groups.slice(0, 3).map(group => parseInt(group, 16).toString(16)).join(':') + '::/48';
}

function parseTarget(value) {
  const raw = String(value || '').trim();
  if (VIDEO_ID.test(raw)) return { kind: 'video', id: raw };
  if (CHANNEL_ID.test(raw)) return { kind: 'channel', path: 'channel/' + raw };
  if (HANDLE.test(raw)) return { kind: 'channel', path: raw.toLowerCase() };
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be')
    return parts.length === 1 && VIDEO_ID.test(parts[0] || '')
      ? { kind: 'video', id: parts[0] }
      : null;
  const [first, second, third] = parts;
  // Query strings are shared across YouTube pages; only /watch gives "v" its video meaning.
  if (first === 'watch') {
    const video = url.searchParams.get('v');
    if (VIDEO_ID.test(video || '')) return { kind: 'video', id: video };
  }
  if (['watch', 'live', 'embed', 'shorts'].includes(first))
    return parts.length === 2 && VIDEO_ID.test(second || '')
      ? { kind: 'video', id: second }
      : null;
  if (HANDLE.test(first || '') && (parts.length === 1 || (parts.length === 2 && second === 'live')))
    return { kind: 'channel', path: first.toLowerCase() };
  if (
    first === 'channel' &&
    CHANNEL_ID.test(second || '') &&
    (parts.length === 2 || (parts.length === 3 && third === 'live'))
  )
    return { kind: 'channel', path: 'channel/' + second };
  if (
    (first === 'c' || first === 'user') &&
    /^[A-Za-z0-9._-]{1,60}$/.test(second || '') &&
    (parts.length === 2 || (parts.length === 3 && third === 'live'))
  )
    return { kind: 'channel', path: first + '/' + second };
  return null;
}

function balancedJson(text, start) {
  let depth = 0, string = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (string) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') string = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return '';
}

function playerResponse(html) {
  for (const marker of [
    'ytInitialPlayerResponse =',
    'ytInitialPlayerResponse=',
    '["ytInitialPlayerResponse"]=',
  ]) {
    const at = html.indexOf(marker);
    if (at < 0) continue;
    const open = html.indexOf('{', at + marker.length);
    if (open < 0) continue;
    const json = balancedJson(html, open);
    if (!json) continue;
    try { return JSON.parse(json); } catch { /* try the next marker */ }
  }
  return null;
}

function parsePlayer(html, fallbackId = '') {
  const data = playerResponse(html);
  if (!data) return null;
  const details = data.videoDetails || {};
  const micro = data.microformat?.playerMicroformatRenderer || {};
  const videoId = details.videoId || fallbackId || '';
  const live = micro.liveBroadcastDetails?.isLiveNow === true
    && data.playabilityStatus?.status === 'OK'
    && data.playabilityStatus?.playableInEmbed !== false
    && details.isLive !== false
    && VIDEO_ID.test(videoId);
  // The watch page keeps the concurrent viewer count in its initial data, next to
  // the renderer's name; take the nearby original counter, never the lifetime views.
  const at = html.indexOf('"videoViewCountRenderer":{');
  const chunk = at >= 0 ? html.slice(at, at + 900) : '';
  const count = /"originalViewCount":"(\d+)"/.exec(chunk);
  return {
    live,
    videoId,
    title: details.title || micro.title?.simpleText || '',
    author: details.author || micro.ownerChannelName || '',
    channelId: details.channelId || '',
    thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '',
    viewers: live && count ? Number(count[1]) : 0,
    startedAt: Date.parse(micro.liveBroadcastDetails?.startTimestamp || '') || 0,
  };
}

async function lookup(target) {
  const video = target.kind === 'video';
  const url = video
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(target.id)}&hl=en&gl=US`
    : `https://www.youtube.com/${target.path}/live?hl=en&gl=US`;
  const response = await fetch(url, {
    headers: PAGE_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 404) return { live: false, videoId: video ? target.id : '' };
  if (response.status === 429) {
    const wait = Math.max(1, Math.min(Number(response.headers.get('Retry-After')) || 60, 60));
    retryAt = Date.now() + wait * 1000;
    throw new YouTubeError(429, 'YOUTUBE_BUSY', wait);
  }
  if (!response.ok) throw new Error('YOUTUBE_UNAVAILABLE');
  if (Number(response.headers.get('Content-Length')) > maxPageBytes)
    throw new YouTubeError(502, 'YOUTUBE_UNAVAILABLE');
  const html = await response.text();
  if (html.length > maxPageBytes) throw new YouTubeError(502, 'YOUTUBE_UNAVAILABLE');
  let fromUrl = '';
  if (!video && response.url) {
    try { fromUrl = new URL(response.url).searchParams.get('v') || ''; } catch { /* keep empty */ }
  }
  const parsed = parsePlayer(html, fromUrl || (video ? target.id : ''));
  // A watch page without player data is a consent or bot page, not a live.
  if (!parsed && video) throw new Error('YOUTUBE_UNAVAILABLE');
  return parsed || { live: false, videoId: video ? target.id : '' };
}

module.exports = async function youtube(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const fail = (status, error) => res.status(status).json({ error });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return fail(405, 'METHOD_NOT_ALLOWED');
  }
  const params = new URL(req.url, 'http://localhost').searchParams;
  const queries = params.getAll('q');
  const raw = queries.length === 1 ? queries[0].trim() : '';
  if (!raw || raw.length > 300 || /[\x00-\x1f]/.test(raw))
    return fail(400, 'INVALID_QUERY');
  const target = parseTarget(raw);
  if (!target) return fail(400, 'INVALID_QUERY');
  const key = target.kind + ':' + (target.id || target.path);
  const now = Date.now();
  // A cached answer is free: serve it before spending the client's rate budget.
  if (cache.get(key)?.expiresAt > now) return res.status(200).json(cache.get(key).data);
  // Cached answers stay available during a throttle; misses must not hammer a cooled-down host.
  if (retryAt > now) {
    res.setHeader('Retry-After', '60');
    return fail(429, 'YOUTUBE_BUSY');
  }
  // Caddy owns X-Forwarded-For; X-Real-IP passes through untouched and would let a client rotate identities
  const ip = clientKey(String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown');
  for (const [client, entry] of clients) if (entry.until <= now) clients.delete(client);
  const entry = clients.get(ip) || { count: 0, until: now + 60000 };
  if (entry.count >= requestsPerMinute) {
    res.setHeader('Retry-After', '60');
    return fail(429, 'YOUTUBE_BUSY');
  }
  if (!clients.has(ip) && clients.size >= clientsLimit) clients.delete(clients.keys().next().value);
  entry.count++;
  clients.set(ip, entry);
  try {
    if (!pending.has(key)) {
      if (pending.size >= pendingLimit || (pendingByClient.get(ip) || 0) >= clientPendingLimit) {
        res.setHeader('Retry-After', '10');
        return fail(429, 'YOUTUBE_BUSY');
      }
      pendingByClient.set(ip, (pendingByClient.get(ip) || 0) + 1);
      pending.set(key, lookup(target).finally(() => {
        pending.delete(key);
        const count = (pendingByClient.get(ip) || 1) - 1;
        if (count > 0) pendingByClient.set(ip, count);
        else pendingByClient.delete(ip);
      }));
    }
    const data = await pending.get(key);
    if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
    cache.set(key, { data, expiresAt: Date.now() + ttl });
    return res.status(200).json(data);
  } catch (error) {
    if (error.status === 429) {
      res.setHeader('Retry-After', String(error.retryAfter || 60));
      return fail(429, 'YOUTUBE_BUSY');
    }
    return fail(502, 'YOUTUBE_UNAVAILABLE');
  }
};

module.exports.parseTarget = parseTarget;
module.exports.parsePlayer = parsePlayer;
module.exports.clientKey = clientKey;
