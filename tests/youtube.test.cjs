const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const originalFetch = global.fetch;
let handler;
beforeEach(() => {
  delete require.cache[require.resolve('../api/youtube.js')];
  handler = require('../api/youtube.js');
});
afterEach(() => { global.fetch = originalFetch; });

function request(url = '/api/youtube?q=4t4AQ15yj1M', method = 'GET', ip = 'test-youtube', headers = {}) {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(n) { this.statusCode = n; return this; },
    json(body) { this.body = body; return this; },
    end(body) { this.body = body; },
  };
  return handler({ url, method, headers: { 'x-forwarded-for': ip, ...headers }, socket: { remoteAddress: ip } }, res).then(() => res);
}

test('rejects invalid queries and methods before contacting YouTube', async () => {
  global.fetch = () => { throw new Error('Unexpected request'); };
  for (const query of [
    '',
    'not a youtube address',
    'https://evil.example/watch?v=4t4AQ15yj1M',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/@LofiGirl/videos',
    'https://www.youtube.com/results?search_query=x&v=4t4AQ15yj1M',
    'https://www.youtube.com/playlist?list=PL123&v=4t4AQ15yj1M',
  ]) {
    const res = await request('/api/youtube?q=' + encodeURIComponent(query));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'INVALID_QUERY' });
  }
  const repeated = await request('/api/youtube?q=4t4AQ15yj1M&q=4t4AQ15yj1M');
  assert.equal(repeated.statusCode, 400);
  const post = await request('/api/youtube?q=4t4AQ15yj1M', 'POST');
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.deepEqual(post.body, { error: 'METHOD_NOT_ALLOWED' });
});

const liveResponse = {
  playabilityStatus: { status: 'OK', playableInEmbed: true },
  videoDetails: {
    videoId: '4t4AQ15yj1M',
    title: 'Lofi live',
    author: 'Lofi Girl',
    channelId: 'UCSJ4gkVC6NrvII8umztf0Ow',
    isLive: true,
  },
  microformat: {
    playerMicroformatRenderer: {
      title: { simpleText: 'Lofi live' },
      ownerChannelName: 'Lofi Girl',
      liveBroadcastDetails: {
        isLiveNow: true,
        startTimestamp: '2026-11-03T18:00:39+00:00',
      },
    },
  },
};
const livePage = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(liveResponse)};</script><script>"videoViewCountRenderer":{"viewCount":{"runs":[{"text":"5,421"},{"text":" watching now"}]},"isLive":true,"originalViewCount":"5421"}</script></html>`;

test('parses a live video page and its watching count', () => {
  const parsed = handler.parsePlayer(livePage, 'fallback');
  assert.equal(parsed.live, true);
  assert.equal(parsed.videoId, '4t4AQ15yj1M');
  assert.equal(parsed.title, 'Lofi live');
  assert.equal(parsed.author, 'Lofi Girl');
  assert.equal(parsed.channelId, 'UCSJ4gkVC6NrvII8umztf0Ow');
  assert.equal(parsed.thumbnail, 'https://i.ytimg.com/vi/4t4AQ15yj1M/hqdefault.jpg');
  assert.equal(parsed.viewers, 5421);
  assert.equal(parsed.startedAt, Date.parse('2026-11-03T18:00:39+00:00'));
});

test('a video lookup returns live metadata without exposing page internals', async () => {
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://www.youtube.com/watch?v=4t4AQ15yj1M&hl=en&gl=US');
    assert.match(options.headers['User-Agent'], /Mozilla/);
    assert.match(options.headers.Cookie, /CONSENT/);
    return new Response(livePage);
  };
  const res = await request('/api/youtube?q=' + encodeURIComponent('https://www.youtube.com/watch?v=4t4AQ15yj1M'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    live: true,
    videoId: '4t4AQ15yj1M',
    title: 'Lofi live',
    author: 'Lofi Girl',
    channelId: 'UCSJ4gkVC6NrvII8umztf0Ow',
    thumbnail: 'https://i.ytimg.com/vi/4t4AQ15yj1M/hqdefault.jpg',
    viewers: 5421,
    startedAt: Date.parse('2026-11-03T18:00:39+00:00'),
  });
});

test('a non-live video and an ended stream stay not live, while a page without player data is unavailable', async () => {
  const offline = {
    playabilityStatus: { status: 'OK', playableInEmbed: true },
    videoDetails: { videoId: 'jfKfPfyJRdk', title: 'Radio', author: 'Lofi Girl', isLive: false },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false } } },
  };
  const offlinePage = `<script>var ytInitialPlayerResponse = ${JSON.stringify(offline)};</script>`;
  assert.equal(handler.parsePlayer(offlinePage).live, false);
  assert.equal(handler.parsePlayer('<html>consent page</html>'), null);
  global.fetch = async () => new Response(offlinePage);
  const res = await request('/api/youtube?q=jfKfPfyJRdk', 'GET', 'offline-ip');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.live, false);
  assert.equal(res.body.videoId, 'jfKfPfyJRdk');
  global.fetch = async () => new Response('<html>consent page</html>');
  const blocked = await request('/api/youtube?q=4t4AQ15yj1M', 'GET', 'blocked-ip');
  assert.equal(blocked.statusCode, 502);
  assert.deepEqual(blocked.body, { error: 'YOUTUBE_UNAVAILABLE' });
});

test('a channel /live URL resolves to the current live video', async () => {
  global.fetch = async (url) => {
    assert.equal(String(url), 'https://www.youtube.com/@lofigirl/live?hl=en&gl=US');
    return new Response(livePage);
  };
  const res = await request('/api/youtube?q=' + encodeURIComponent('https://www.youtube.com/@LofiGirl/live'), 'GET', 'channel-ip');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.live, true);
  assert.equal(res.body.videoId, '4t4AQ15yj1M');
});

test('the v parameter only resolves videos on the watch path', async () => {
  assert.equal(handler.parseTarget('https://www.youtube.com/results?search_query=x&v=4t4AQ15yj1M'), null);
  assert.deepEqual(handler.parseTarget('https://www.youtube.com/@LofiGirl?v=4t4AQ15yj1M'), {
    kind: 'channel',
    path: '@lofigirl',
  });
  assert.deepEqual(handler.parseTarget('https://www.youtube.com/watch?v=4t4AQ15yj1M'), {
    kind: 'video',
    id: '4t4AQ15yj1M',
  });
  global.fetch = async (url) => {
    assert.equal(String(url), 'https://www.youtube.com/@lofigirl/live?hl=en&gl=US');
    return new Response(livePage);
  };
  const res = await request('/api/youtube?q=' + encodeURIComponent('https://www.youtube.com/@LofiGirl?v=4t4AQ15yj1M'), 'GET', 'handle-ip');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.live, true);
});

test('an upstream 404 means not live instead of an error', async () => {
  global.fetch = async () => new Response('not found', { status: 404 });
  const res = await request('/api/youtube?q=4t4AQ15yj1M', 'GET', '404-ip');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { live: false, videoId: '4t4AQ15yj1M' });
});

test('an oversized declared page is rejected before parsing', async () => {
  global.fetch = async () => new Response(null, {
    status: 200,
    headers: { 'content-length': '5000000' },
  });
  const res = await request('/api/youtube?q=' + encodeURIComponent('https://www.youtube.com/@LofiGirl/live'), 'GET', 'oversized-ip');
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'YOUTUBE_UNAVAILABLE' });
});

test('malformed or truncated player data parses as null', () => {
  assert.equal(handler.parsePlayer('<script>var ytInitialPlayerResponse = {"videoDetails":{'), null);
  assert.equal(handler.parsePlayer('<script>var ytInitialPlayerResponse = {not json};</script>'), null);
});

test('falls back to the requested video id when the page omits it', () => {
  const page = '<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"videoDetails":{"title":"T"}};</script>';
  const parsed = handler.parsePlayer(page, '4t4AQ15yj1M');
  assert.equal(parsed.videoId, '4t4AQ15yj1M');
  assert.equal(parsed.thumbnail, 'https://i.ytimg.com/vi/4t4AQ15yj1M/hqdefault.jpg');
  assert.equal(parsed.live, false);
});

test('unplayable or non-embeddable pages are not live', () => {
  const page = playability => `<script>var ytInitialPlayerResponse = ${JSON.stringify({
    playabilityStatus: playability,
    videoDetails: { videoId: '4t4AQ15yj1M', isLive: true },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true } } },
  })};</script>`;
  assert.equal(handler.parsePlayer(page({ status: 'LOGIN_REQUIRED' })).live, false);
  assert.equal(handler.parsePlayer(page({ status: 'OK', playableInEmbed: false })).live, false);
  assert.equal(handler.parsePlayer(page({ status: 'OK', playableInEmbed: true })).live, true);
});

test('a network rejection becomes a recoverable error', async () => {
  global.fetch = async () => { throw new Error('socket hang up'); };
  const res = await request('/api/youtube?q=4t4AQ15yj1M', 'GET', 'network-ip');
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'YOUTUBE_UNAVAILABLE' });
});

test('caches a lookup and shares one upstream request', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(livePage);
  };
  const [first, second] = await Promise.all([
    request('/api/youtube?q=4t4AQ15yj1M', 'GET', 'cache-ip'),
    request('/api/youtube?q=4t4AQ15yj1M', 'GET', 'cache-ip'),
  ]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(calls, 1);
  const third = await request('/api/youtube?q=4t4AQ15yj1M', 'GET', 'cache-ip');
  assert.equal(third.statusCode, 200);
  assert.equal(calls, 1);
});

test('an upstream failure becomes a recoverable error without leaking details', async () => {
  global.fetch = async () => Response.json({ error: 'private detail' }, { status: 500 });
  const res = await request('/api/youtube?q=4t4AQ15yj1M', 'GET', 'failure-ip');
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'YOUTUBE_UNAVAILABLE' });
});

test('rotating X-Real-IP does not bypass the per-client limiter', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(livePage);
  };
  const videoId = i => 'video' + String(i).padStart(6, '0');
  for (let i = 0; i < 60; i++) {
    const res = await request(`/api/youtube?q=${videoId(i)}`, 'GET', '203.0.113.7', {
      'x-real-ip': `198.51.100.${i % 250}`,
    });
    assert.equal(res.statusCode, 200);
  }
  const blocked = await request(`/api/youtube?q=${videoId(60)}`, 'GET', '203.0.113.7', {
    'x-real-ip': '198.51.100.50',
  });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '60');
  assert.deepEqual(blocked.body, { error: 'YOUTUBE_BUSY' });
  assert.equal(calls, 60);
});

test('cached responses bypass the limiter', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(livePage);
  };
  assert.equal((await request('/api/youtube?q=4t4AQ15yj1M', 'GET', 'cache-warm')).statusCode, 200);
  for (let i = 0; i < 65; i++)
    assert.equal((await request('/api/youtube?q=4t4AQ15yj1M', 'GET', 'cache-heavy')).statusCode, 200);
  assert.equal(calls, 1);
});

test('a full client map evicts the oldest client instead of locking out new ones', async () => {
  global.fetch = async () => new Response(livePage);
  const xff = i => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  const videoId = i => 'c' + String(i).padStart(10, '0');
  for (let i = 0; i < 1000; i++)
    assert.equal((await request(`/api/youtube?q=${videoId(i)}`, 'GET', xff(i))).statusCode, 200);
  assert.equal((await request(`/api/youtube?q=${videoId(1000)}`, 'GET', xff(1000))).statusCode, 200);
  assert.equal((await request(`/api/youtube?q=${videoId(1001)}`, 'GET', xff(999))).statusCode, 200);
});

test('bounds concurrent upstream lookups', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  global.fetch = async () => {
    await gate;
    return new Response(livePage);
  };
  const xff = i => `172.16.${(i >> 8) & 255}.${i & 255}`;
  const videoId = i => 'p' + String(i).padStart(10, '0');
  const inflight = [];
  for (let i = 0; i < 500; i++) inflight.push(request(`/api/youtube?q=${videoId(i)}`, 'GET', xff(i)));
  const blocked = await request(`/api/youtube?q=${videoId(500)}`, 'GET', '172.16.255.255');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '10');
  assert.deepEqual(blocked.body, { error: 'YOUTUBE_BUSY' });
  release();
  const finished = await Promise.all(inflight);
  assert.equal(finished.filter(res => res.statusCode === 200).length, 500);
});

test('an upstream throttle is preserved and cools down cache misses', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response('throttled', { status: 429, headers: { 'Retry-After': '30' } });
  };
  const throttled = await request('/api/youtube?q=4t4AQ15yj1M', 'GET', 'throttle-ip');
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.headers['Retry-After'], '30');
  assert.deepEqual(throttled.body, { error: 'YOUTUBE_BUSY' });
  const cooled = await request('/api/youtube?q=jfKfPfyJRdk', 'GET', 'throttle-ip');
  assert.equal(cooled.statusCode, 429);
  assert.deepEqual(cooled.body, { error: 'YOUTUBE_BUSY' });
  assert.equal(calls, 1);
});

test('normalizes client addresses to IPv4 or an IPv6 /48 prefix', () => {
  assert.equal(handler.clientKey('203.0.113.9'), '203.0.113.9');
  assert.equal(handler.clientKey('203.0.113.9:443'), '203.0.113.9');
  assert.equal(handler.clientKey('2001:db8:1:2::1'), '2001:db8:1::/48');
  assert.equal(handler.clientKey('2001:0db8:0001:0002::1'), '2001:db8:1::/48');
  assert.equal(handler.clientKey('[2001:db8:1:2::1]'), '2001:db8:1::/48');
  assert.equal(handler.clientKey('[2001:db8:1:2::1]:443'), '2001:db8:1::/48');
  assert.equal(handler.clientKey('unknown'), 'unknown');
});

test('IPv4-mapped IPv6 addresses stay distinct IPv4 clients', () => {
  assert.equal(handler.clientKey('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(handler.clientKey('::ffff:192.0.2.2'), '192.0.2.2');
  assert.notEqual(handler.clientKey('::ffff:192.0.2.1'), handler.clientKey('::ffff:192.0.2.2'));
  assert.equal(handler.clientKey('::ffff:c000:201'), '192.0.2.1');
  assert.equal(handler.clientKey('[::ffff:192.0.2.1]:443'), '192.0.2.1');
});

test('IPv6 clients share one /48 limiter bucket', async () => {
  global.fetch = async () => new Response(livePage);
  const videoId = i => 'v6' + String(i).padStart(9, '0');
  for (let i = 0; i < 60; i++)
    assert.equal((await request(`/api/youtube?q=${videoId(i)}`, 'GET', '2001:db8:1:2::1')).statusCode, 200);
  const blocked = await request(`/api/youtube?q=${videoId(60)}`, 'GET', '2001:db8:1:2::ffff');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '60');
  assert.deepEqual(blocked.body, { error: 'YOUTUBE_BUSY' });
});

test('a /56 cannot rotate /64s to bypass the limiter', async () => {
  global.fetch = async () => new Response(livePage);
  const videoId = i => 'v7' + String(i).padStart(9, '0');
  for (let i = 0; i < 60; i++)
    assert.equal(
      (await request(`/api/youtube?q=${videoId(i)}`, 'GET', `2001:db8:1:${i + 2}::1`)).statusCode,
      200,
    );
  const blocked = await request(`/api/youtube?q=${videoId(60)}`, 'GET', '2001:db8:1:100::1');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '60');
  assert.deepEqual(blocked.body, { error: 'YOUTUBE_BUSY' });
});

test('bounds pending lookups per client prefix', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    await gate;
    return new Response(livePage);
  };
  const videoId = i => 'q' + String(i).padStart(10, '0');
  const inflight = [];
  for (let i = 0; i < 16; i++)
    inflight.push(request(`/api/youtube?q=${videoId(i)}`, 'GET', '198.51.100.20'));
  const blocked = await request(`/api/youtube?q=${videoId(16)}`, 'GET', '198.51.100.20');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '10');
  assert.deepEqual(blocked.body, { error: 'YOUTUBE_BUSY' });
  assert.equal(calls, 16);
  release();
  const finished = await Promise.all(inflight);
  assert.equal(finished.filter(res => res.statusCode === 200).length, 16);
});

test('a timeout becomes a fixed unavailable code', async () => {
  global.fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
  const res = await request('/api/youtube?q=4t4AQ15yj1M', 'GET', 'timeout-ip');
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'YOUTUBE_UNAVAILABLE' });
});

test('handle case variants share one cache entry', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(livePage);
  };
  assert.deepEqual(handler.parseTarget('@LofiGirl'), handler.parseTarget('@lofigirl'));
  const first = await request('/api/youtube?q=' + encodeURIComponent('https://www.youtube.com/@LofiGirl/live'), 'GET', 'handle-case-ip');
  assert.equal(first.statusCode, 200);
  const second = await request('/api/youtube?q=' + encodeURIComponent('https://www.youtube.com/@lofigirl/live'), 'GET', 'handle-case-ip');
  assert.equal(second.statusCode, 200);
  assert.equal(calls, 1);
});
