# YouTube Live Streams in the Grid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a viewer paste a YouTube live URL, a channel `/live` URL, a handle, or a video ID into the search field and watch that YouTube live stream, with its YouTube live chat, in the same reorderable and spotlight-capable grid as Twitch channels.

**Architecture:** YouTube lives are resolved by a new `GET /api/youtube?q=…` Node endpoint that reads YouTube's public watch or `/live` page and returns only live metadata. A YouTube tile keeps the existing Twitch-centric `Channel.twitch` field as its unique key (`yt:<videoId>`) and adds `platform` and `youtubeId`; this preserves every saved layout and avoids rewriting the 4,000-line workspace. Playback uses a small adapter over YouTube's official IFrame Player API that implements the same player interface as Twitch's embed, so mute, volume, pause, spotlight, chat sizing, grids, and drag reordering keep working. YouTube chat is the official `youtube.com/live_chat` iframe.

**Tech Stack:** React 19, strict TypeScript, Vite 8, Node 24 built-in HTTP, Playwright, YouTube IFrame Player API, YouTube public live pages.

---

## Scope and deliberate limits

- YouTube tiles support playback, live chat, pause, mute, volume, spotlight, fullscreen, drag reordering, saved grids, global pause/mute, sound follow, the sound board, and restoration across reloads.
- YouTube tiles do not join Twitch follows, Twitch favorites, Twitch collaborations, or Twitch extensions. They are added from the search field and stay in the grid through the saved layout.
- YouTube lives always use YouTube's official iframe and its native controls. The custom HLS player, Twitch embed toggle, resolution menu, and latency settings remain Twitch-only.
- No YouTube API key is required. The server reads public page metadata, as the existing app already reads undocumented Twitch playback data. The page shape is undocumented and can change.
- A YouTube live added by video URL stays tied to that video. A channel `/live` URL resolves to the video that is live at that moment. When it ends, the tile goes offline like a Twitch stream that ends.

---

## File structure

| File | Responsibility |
| --- | --- |
| `api/youtube.js` | Validate the query, cache/rate-limit lookups, read YouTube watch or `/live` pages, parse the embedded player response, return live metadata. |
| `api/youtube.d.ts` | Declaration for the Vite config import, mirroring the other API routes. |
| `tests/youtube.test.cjs` | Endpoint validation, page parser, live/non-live, channel resolution, cache, dedupe and failure tests. |
| `src/services/youtube.ts` | Query detection, endpoint client, `Channel` factory, restore factory, watch and chat URLs. |
| `src/services/youtubePlayer.ts` | `TwitchPlayer`-compatible adapter over the YouTube IFrame Player API. |
| `src/types/domain.ts` | Add `Platform`, `platform` and `youtubeId` to `Channel`. |
| `src/types/player.ts` | Add `videoId` to player options and type the YouTube API globals. |
| `src/services/library.ts` | Add `isYouTubeKey`, `isYouTubeChannel`, `validChannelKey`. |
| `src/components/StreamTile.tsx` | YouTube badge, platform-aware chat link, hidden Twitch player toggle. |
| `src/components/ChannelList.tsx` | YouTube badge in search results, no favorite star for YouTube, no Twitch preview. |
| `src/controllers/videoLayout.ts` | YouTube poster URL without the Twitch CDN fallback. |
| `src/controllers/preview.ts` | Do not mount a Twitch preview for a YouTube row. |
| `src/controllers/workspace.tsx` | Search, add, restore, chat, player selection, refresh and Twitch-only guards. |
| `src/styles/grid.css` | Tile YouTube badge. |
| `src/styles/sidebar.css` | List YouTube badge. |
| `src/services/translations.ts` | FR/EN/NL strings for all new copy. |
| `vite.config.mts` | Serve `/api/youtube` in development and preview. |
| `production.cjs` | Route `/api/youtube` in production. |
| `package.json` | Include the endpoint in `check` and the test in `test:server`. |
| `tests/fixtures.cjs` | Mock YouTube IFrame API for browser tests. |
| `tests/grid.spec.js` | YouTube search, tile, chat, persistence and offline browser tests. |
| `tests/production.test.cjs` | Verify the production route rejects invalid input. |
| `README.md` | Document YouTube lives, the endpoint and its limits. |

---

## Task 1: Server endpoint `GET /api/youtube`

**Files:**
- Create: `tests/youtube.test.cjs`
- Create: `api/youtube.js`
- Create: `api/youtube.d.ts`
- Modify: `vite.config.mts`
- Modify: `production.cjs`
- Modify: `package.json`
- Modify: `tests/production.test.cjs`

- [ ] **Step 1: Write the failing validation test**

Create `tests/youtube.test.cjs`:

```js
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const originalFetch = global.fetch;
let handler;
beforeEach(() => {
  delete require.cache[require.resolve('../api/youtube.js')];
  handler = require('../api/youtube.js');
});
afterEach(() => { global.fetch = originalFetch; });

function request(url = '/api/youtube?q=4t4AQ15yj1M', method = 'GET', ip = 'test-youtube') {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(n) { this.statusCode = n; return this; },
    json(body) { this.body = body; return this; },
    end(body) { this.body = body; },
  };
  return handler({ url, method, headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } }, res).then(() => res);
}

test('rejects invalid queries and methods before contacting YouTube', async () => {
  global.fetch = () => { throw new Error('Unexpected request'); };
  for (const query of [
    '',
    'not a youtube address',
    'https://evil.example/watch?v=4t4AQ15yj1M',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/@LofiGirl/videos',
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/youtube.test.cjs`
Expected: FAIL with `Cannot find module '../api/youtube.js'`.

- [ ] **Step 3: Create the endpoint skeleton**

Create `api/youtube.js` with validation, target parsing, rate limiting, cache plumbing and a temporary lookup. The page parser is added in Step 7.

```js
// YouTube offers no keyless live lookup. This endpoint reads the public watch or
// channel /live page and returns only the metadata the grid needs. No user
// cookies or account credentials leave this server. The page shape is
// undocumented: the parser is deliberately tolerant and degrades to "not live"
// instead of trusting partial data.
const cache = new Map(), pending = new Map(), clients = new Map();
const ttl = 30000, cacheLimit = 300, clientsLimit = 1000, requestsPerMinute = 60;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HANDLE = /^@[A-Za-z0-9._-]{3,60}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const PAGE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+cb; SOCS=CAI',
};

function parseTarget(value) {
  const raw = String(value || '').trim();
  if (VIDEO_ID.test(raw)) return { kind: 'video', id: raw };
  if (CHANNEL_ID.test(raw)) return { kind: 'channel', path: 'channel/' + raw };
  if (HANDLE.test(raw)) return { kind: 'channel', path: raw };
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
  const video = url.searchParams.get('v');
  if (VIDEO_ID.test(video || '')) return { kind: 'video', id: video };
  const [first, second, third] = parts;
  if (['watch', 'live', 'embed', 'shorts'].includes(first))
    return parts.length === 2 && VIDEO_ID.test(second || '')
      ? { kind: 'video', id: second }
      : null;
  if (HANDLE.test(first || '') && (parts.length === 1 || (parts.length === 2 && second === 'live')))
    return { kind: 'channel', path: first };
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

async function lookup(target) {
  return { live: false, videoId: target.kind === 'video' ? target.id : '' };
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
  const ip = req.headers?.['x-real-ip']
    || String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
  for (const [client, entry] of clients) if (entry.until <= now) clients.delete(client);
  const entry = clients.get(ip) || { count: 0, until: now + 60000 };
  if (entry.count >= requestsPerMinute || (!clients.has(ip) && clients.size >= clientsLimit)) {
    res.setHeader('Retry-After', '60');
    return fail(429, 'YOUTUBE_BUSY');
  }
  entry.count++;
  clients.set(ip, entry);
  try {
    if (!pending.has(key)) pending.set(key, lookup(target).finally(() => pending.delete(key)));
    const data = await pending.get(key);
    if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
    cache.set(key, { data, expiresAt: Date.now() + ttl });
    return res.status(200).json(data);
  } catch {
    return fail(502, 'YOUTUBE_UNAVAILABLE');
  }
};

module.exports.parseTarget = parseTarget;
```

Create `api/youtube.d.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
declare function youtube(req: IncomingMessage, res: ServerResponse): Promise<void>;
export = youtube;
```

- [ ] **Step 4: Run the validation test to verify it passes**

Run: `node --test tests/youtube.test.cjs`
Expected: PASS for the validation test.

- [ ] **Step 5: Add the live-page parser tests**

Append to `tests/youtube.test.cjs`:

```js
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

test('a non-live video, an ended stream and a page without player data stay not live', async () => {
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
    assert.equal(String(url), 'https://www.youtube.com/@LofiGirl/live?hl=en&gl=US');
    return new Response(livePage);
  };
  const res = await request('/api/youtube?q=' + encodeURIComponent('https://www.youtube.com/@LofiGirl/live'), 'GET', 'channel-ip');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.live, true);
  assert.equal(res.body.videoId, '4t4AQ15yj1M');
});
```

- [ ] **Step 6: Run the parser tests to verify they fail**

Run: `node --test tests/youtube.test.cjs`
Expected: FAIL because `handler.parsePlayer` is undefined and `lookup` always returns not live.

- [ ] **Step 7: Implement the page parser and lookup**

Replace the temporary `lookup` in `api/youtube.js` with the parser and page fetch:

```js
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
  if (!response.ok) throw new Error('YOUTUBE_UNAVAILABLE');
  const html = await response.text();
  let fromUrl = '';
  if (!video && response.url) {
    try { fromUrl = new URL(response.url).searchParams.get('v') || ''; } catch { /* keep empty */ }
  }
  const parsed = parsePlayer(html, fromUrl || (video ? target.id : ''));
  // A watch page without player data is a consent or bot page, not a live.
  if (!parsed && video) throw new Error('YOUTUBE_UNAVAILABLE');
  return parsed || { live: false, videoId: video ? target.id : '' };
}
```

Add the parser export next to `parseTarget`:

```js
module.exports.parsePlayer = parsePlayer;
```

- [ ] **Step 8: Run the parser tests to verify they pass**

Run: `node --test tests/youtube.test.cjs`
Expected: all tests PASS.

- [ ] **Step 9: Add cache, dedupe and failure tests**

Append to `tests/youtube.test.cjs`:

```js
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
```

- [ ] **Step 10: Run all endpoint tests**

Run: `node --test tests/youtube.test.cjs`
Expected: all tests PASS.

- [ ] **Step 11: Wire the endpoint into development and production**

In `vite.config.mts`, import the handler and add it to the route list:

```ts
import youtube from "./api/youtube.js";
// ...
  for (const [path, handler] of [
    ["/api/search", search],
    ["/api/stream", stream],
    ["/api/extensions", extensions],
    ["/api/youtube", youtube],
  ] as const) {
```

In `production.cjs`, import it and route it:

```js
const youtube = require('./api/youtube.js');
// ...
      const handler = path === '/api/search' ? search
        : path === '/api/stream' ? stream
        : path === '/api/extensions' ? extensions
        : path === '/api/youtube' ? youtube
        : null;
```

In `package.json`, add the syntax check and the test file:

```json
"check": "tsc --noEmit && node --check api/stream.js && node --check api/search.js && node --check api/extensions.js && node --check api/youtube.js && node --check server.cjs && node --check production.cjs",
"test:server": "node --test tests/stream.test.cjs tests/search.test.cjs tests/extensions.test.cjs tests/extensionWindowGeometry.test.cjs tests/extensionsService.test.cjs tests/extensionWindows.test.cjs tests/youtube.test.cjs tests/i18n.test.cjs tests/watchtime.test.cjs tests/production.test.cjs tests/server-cli.test.cjs"
```

In `tests/production.test.cjs`, add the invalid-query assertion next to the existing validation checks:

```js
  assert.equal((await request('/api/youtube?q=not-a-youtube-address')).status, 400);
```

- [ ] **Step 12: Run the server checks and tests**

Run: `pnpm check && pnpm test:server`
Expected: TypeScript and syntax checks pass; all server tests pass.

- [ ] **Step 13: Review the diff**

Run: `git diff -- api/youtube.js api/youtube.d.ts tests/youtube.test.cjs vite.config.mts production.cjs package.json tests/production.test.cjs`
Expected: only the new endpoint, its tests and the route wiring. Do not commit unless the user asks.

---

## Task 2: Client model and YouTube service

**Files:**
- Modify: `src/types/domain.ts`
- Modify: `src/services/library.ts`
- Create: `src/services/youtube.ts`

- [ ] **Step 1: Add the platform fields to `Channel`**

In `src/types/domain.ts`, add the platform type above `Channel` and the two optional fields:

```ts
export type Platform = "twitch" | "youtube";
export type AccountMode = "guest" | "connected";
// ...
export interface Channel {
  twitch: string; // unique tile key: Twitch login, or "yt:<videoId>" for YouTube
  platform?: Platform; // absent means Twitch, so old saved layouts keep working
  youtubeId?: string;
  display: string;
  // ... the existing fields stay unchanged
}
```

The final interface starts like this:

```ts
export interface Channel {
  twitch: string;
  platform?: Platform;
  youtubeId?: string;
  display: string;
  profileUrl: string;
  previewUrl: string;
  offlineUrl: string;
  online: boolean | null;
  game: string;
  title: string;
  viewersAmount: { number: number; formatted: string };
  startedAt: number;
}
```

- [ ] **Step 2: Add key helpers to `src/services/library.ts`**

Place these next to `validLogin`:

```ts
const youTubeKey = (value: unknown): value is string =>
  typeof value === "string" && /^yt:[A-Za-z0-9_-]{11}$/.test(value);
const validChannelKey = (value: unknown): value is string =>
  validLogin(value) || youTubeKey(value);
const isYouTubeChannel = (s: Channel) =>
  s.platform === "youtube" || youTubeKey(s.twitch);
```

Add them to the existing export block at the bottom:

```ts
export {
  channel,
  readStored,
  writeStored,
  validLogin,
  validChannelKey,
  isYouTubeKey: youTubeKey,
  isYouTubeChannel,
  TwitchLibrary,
  numberFormat,
};
```

- [ ] **Step 3: Create the YouTube service**

Create `src/services/youtube.ts`:

```ts
import type { Channel } from "../types/domain";
import { HttpError, numberFormat, validLogin } from "./library";
import { tr } from "./preferences";

const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
const handlePattern = /^@[A-Za-z0-9._-]{3,60}$/;
const youtubeUrlPattern =
  /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i;

export interface YouTubeLive {
  live: boolean;
  videoId: string;
  title: string;
  author: string;
  channelId: string;
  thumbnail: string;
  viewers: number;
  startedAt: number;
}

// A bare 11-character ID is also a valid Twitch login. Keep Twitch search for
// those ambiguous strings; a YouTube URL, youtu.be link, @handle, channel ID or
// an ID containing a dash or uppercase letter is unambiguous.
export function isYouTubeQuery(value: string) {
  const raw = value.trim();
  if (videoIdPattern.test(raw)) return !validLogin(raw);
  return (
    handlePattern.test(raw) ||
    channelIdPattern.test(raw) ||
    youtubeUrlPattern.test(raw)
  );
}

export function youtubeChannel(data: YouTubeLive): Channel {
  const videoId = data.videoId;
  const thumbnail = /^https:\/\//.test(data.thumbnail) ? data.thumbnail : "";
  return {
    twitch: "yt:" + videoId,
    platform: "youtube",
    youtubeId: videoId,
    display: data.author || data.title || "YouTube",
    profileUrl: thumbnail || "favicon.svg",
    previewUrl: thumbnail,
    offlineUrl: "",
    online: data.live,
    game: "YouTube",
    title: data.title,
    startedAt: data.startedAt,
    viewersAmount: {
      number: data.viewers,
      formatted: data.viewers > 0 ? numberFormat.format(data.viewers) : "",
    },
  };
}

export function restoreYouTubeChannel(data: Partial<Channel>): Channel {
  const key = typeof data.twitch === "string" ? data.twitch : "";
  const videoId = data.youtubeId || key.replace(/^yt:/, "");
  return {
    twitch: "yt:" + videoId,
    platform: "youtube",
    youtubeId: videoId,
    display: data.display || data.title || "YouTube",
    profileUrl: /^https:\/\//.test(data.profileUrl || "")
      ? data.profileUrl!
      : "favicon.svg",
    previewUrl: /^https:\/\//.test(data.previewUrl || "")
      ? data.previewUrl!
      : "",
    offlineUrl: /^https:\/\//.test(data.offlineUrl || "")
      ? data.offlineUrl!
      : "",
    online: data.online ?? null,
    game: data.game || "YouTube",
    title: data.title || "",
    startedAt: data.startedAt || 0,
    viewersAmount:
      data.viewersAmount && typeof data.viewersAmount.number === "number"
        ? data.viewersAmount
        : { number: 0, formatted: "" },
  };
}

export async function youtubeLive(
  query: string,
  signal?: AbortSignal,
): Promise<Channel | null> {
  const response = await fetch(
    "/api/youtube?q=" + encodeURIComponent(query),
    {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
        : AbortSignal.timeout(12000),
    },
  );
  if (!response.ok) {
    const error = new HttpError(
      response.status === 429
        ? tr("Trop de recherches. Réessaie dans une minute.")
        : tr("La recherche YouTube est indisponible pour le moment."),
    );
    error.status = response.status;
    throw error;
  }
  const data = (await response.json()) as Partial<YouTubeLive>;
  if (
    data.live !== true ||
    typeof data.videoId !== "string" ||
    !videoIdPattern.test(data.videoId)
  )
    return null;
  return youtubeChannel({
    live: true,
    videoId: data.videoId,
    title: typeof data.title === "string" ? data.title : "",
    author: typeof data.author === "string" ? data.author : "",
    channelId: typeof data.channelId === "string" ? data.channelId : "",
    thumbnail: typeof data.thumbnail === "string" ? data.thumbnail : "",
    viewers: Number.isFinite(data.viewers) ? Number(data.viewers) : 0,
    startedAt: Number.isFinite(data.startedAt) ? Number(data.startedAt) : 0,
  });
}

export function youtubeWatchUrl(videoId: string) {
  return "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId);
}

export function youtubeChatUrl(videoId: string, dark: boolean) {
  const params = new URLSearchParams({
    v: videoId,
    embed_domain: location.hostname,
  });
  if (dark) params.set("dark_theme", "1");
  return "https://www.youtube.com/live_chat?" + params;
}
```

- [ ] **Step 4: Run the TypeScript check**

Run: `pnpm check`
Expected: PASS with no type errors.

There is no Node-only unit test for this module because it imports the browser preferences module (`localStorage`, `matchMedia`); the Playwright tests in Task 6 exercise it.

- [ ] **Step 5: Review the diff**

Run: `git diff -- src/types/domain.ts src/services/library.ts src/services/youtube.ts`
Expected: the channel key still accepts every legacy Twitch login, and YouTube keys are opt-in. Do not commit unless the user asks.

---

## Task 3: YouTube IFrame player adapter

**Files:**
- Modify: `src/types/player.ts`
- Create: `src/services/youtubePlayer.ts`

- [ ] **Step 1: Add the player option and YouTube globals to `src/types/player.ts`**

Add `videoId` to the constructor options:

```ts
    options: {
      channel: string;
      videoId?: string;
      parent: string[];
      // ... the existing options stay unchanged
    },
```

Add these exported types before the `declare global` block:

```ts
export interface YouTubePlayerInstance {
  playVideo(): void;
  pauseVideo(): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(value: number): void;
  getVolume(): number;
  getPlayerState(): number;
  getIframe?(): HTMLIFrameElement;
  destroy(): void;
}
export interface YouTubeNamespace {
  Player: new (
    element: HTMLElement | string,
    options: {
      videoId: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: { target: YouTubePlayerInstance }) => void;
        onStateChange?: (event: {
          data: number;
          target: YouTubePlayerInstance;
        }) => void;
        onError?: (event: { data: number; target: YouTubePlayerInstance }) => void;
      };
    },
  ) => YouTubePlayerInstance;
  PlayerState: {
    UNSTARTED: number;
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
}
```

Extend the existing `Window` declaration:

```ts
  interface Window {
    Twitch?: { Player: PlayerConstructor };
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
```

- [ ] **Step 2: Create the adapter**

Create `src/services/youtubePlayer.ts`:

```ts
import type {
  PlayerConstructor,
  TwitchPlayer,
  YouTubePlayerInstance,
} from "../types/player";

type Options = ConstructorParameters<PlayerConstructor>[1];

let api: Promise<void> | null = null;

function loadAPI() {
  if (window.YT?.Player) return Promise.resolve();
  if (api) return api;
  api = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      api = null;
      reject(new Error("YOUTUBE_UNAVAILABLE"));
    }, 12000);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      window.clearTimeout(timer);
      resolve();
    };
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.youtube.com/iframe_api"]',
    );
    if (existing) return;
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      api = null;
      script.remove();
      reject(new Error("YOUTUBE_UNAVAILABLE"));
    };
    document.head.append(script);
  });
  return api;
}

// YouTube's official player behind the same interface as Twitch's embed. The
// workspace keeps ownership of pause, mute, volume and spotlight; YouTube keeps
// its own controls, quality and latency handling.
export class YouTubePlayer implements TwitchPlayer {
  static READY = "ready";
  static PLAYING = "playing";
  private element: HTMLElement;
  private videoId: string;
  private listeners = new Map<string, (() => void)[]>();
  private player: YouTubePlayerInstance | null = null;
  private target = document.createElement("div");
  private destroyed = false;
  private ready = false;
  private failed = false;
  private state = -1;
  private muted: boolean;
  private volume = 1;
  private wantPlay = false;

  constructor(element: HTMLElement, options: Options) {
    this.element = element;
    this.videoId = options.videoId || "";
    this.muted = options.muted;
    this.target.style.width = "100%";
    this.target.style.height = "100%";
    element.append(this.target);
    // The listeners are attached by the caller right after construction.
    queueMicrotask(() => void this.load());
  }

  private async load() {
    if (!this.videoId) {
      this.fail();
      return;
    }
    try {
      await loadAPI();
    } catch {
      this.fail();
      return;
    }
    if (this.destroyed || !window.YT) return;
    const YT = window.YT;
    try {
      this.player = new YT.Player(this.target, {
      videoId: this.videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: 0,
        controls: 1, // YouTube's own chrome; the tile header drives play and sound too
        disablekb: 1,
        enablejsapi: 1,
        fs: 1,
        playsinline: 1,
        rel: 0,
        origin: location.origin,
        hl: document.documentElement.lang || "en",
      },
      events: {
        onReady: () => {
          if (this.destroyed || !this.player) return;
          this.ready = true;
          this.state = this.player.getPlayerState();
          this.player.setVolume(this.volume * 100);
          if (this.muted) this.player.mute();
          else this.player.unMute();
          this.emit("ready");
          if (this.wantPlay) this.play();
        },
        onStateChange: (event) => {
          if (this.destroyed) return;
          this.state = event.data;
          if (event.data === 1) {
            this.emit("play");
            this.emit("playing");
          } else if (event.data === 2) this.emit("pause");
          else if (event.data === 0) {
            this.emit("ended");
            this.emit("offline");
          } else this.emit("state");
        },
        onError: () => {
          if (!this.destroyed) {
            this.failed = true;
            this.emit("error");
          }
        },
      },
    });
    } catch {
      this.fail();
    }
  }

  private fail() {
    if (this.destroyed) return;
    this.failed = true;
    this.emit("error");
  }

  private emit(event: string) {
    if (!this.destroyed)
      for (const callback of this.listeners.get(event) || []) callback();
  }

  addEventListener(event: string, callback: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) || []), callback]);
  }

  getPlayerState() {
    if (this.failed) return { playback: "Error" };
    switch (this.state) {
      case 1:
        return { playback: "Playing" };
      case 2:
        return { playback: "Paused" };
      case 3:
        return { playback: "Buffering" };
      case 0:
        return { playback: "Offline" };
      default:
        return { playback: "Paused" };
    }
  }

  setControls(_value: boolean) {
    /* YouTube keeps its own controls; the tile header and the global keys drive it */
  }
  setQuality(_value: string) {
    /* the YouTube player chooses its own resolution */
  }
  getQuality() {
    return "auto";
  }
  setSpotlight(_front: boolean, _available: boolean) {
    /* the tile header owns the spotlight button */
  }
  setMuted(value: boolean) {
    this.muted = value;
    if (!this.player) return;
    if (value) this.player.mute();
    else this.player.unMute();
  }
  getMuted() {
    return this.player ? this.player.isMuted() : this.muted;
  }
  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value));
    this.player?.setVolume(this.volume * 100);
  }
  getVolume() {
    return this.player ? this.player.getVolume() / 100 : this.volume;
  }
  play() {
    this.wantPlay = true;
    if (this.ready) this.player?.playVideo();
  }
  pause() {
    this.wantPlay = false;
    this.player?.pauseVideo();
  }
  destroy() {
    this.destroyed = true;
    this.listeners.clear();
    try {
      this.player?.destroy();
    } catch {
      /* a player that never finished loading has nothing to remove */
    }
    this.player = null;
    this.target.remove();
    this.element.replaceChildren();
  }
}
```

- [ ] **Step 3: Run the TypeScript check**

Run: `pnpm check`
Expected: PASS. The class is structurally a `PlayerConstructor` and implements `TwitchPlayer`.

- [ ] **Step 4: Review the diff**

Run: `git diff -- src/types/player.ts src/services/youtubePlayer.ts`
Expected: no workspace wiring yet; the adapter only exposes the existing player interface. Do not commit unless the user asks.

---

## Task 4: Tile and list UI

**Files:**
- Modify: `src/components/StreamTile.tsx`
- Modify: `src/components/ChannelList.tsx`
- Modify: `src/styles/grid.css`
- Modify: `src/styles/sidebar.css`
- Modify: `src/services/translations.ts`

- [ ] **Step 1: Add the platform prop and YouTube badge to `StreamTile`**

Change the imports and props:

```tsx
import type { ChatPosition, Platform } from "../types/domain";
interface Props {
  display: string;
  platform?: Platform;
  // ... the existing props stay unchanged
}
export function StreamTile({
  display,
  platform,
  // ... the existing props stay unchanged
}: Props) {
```

Add the badge immediately after the name:

```tsx
        <b>{display}</b>
        {platform === "youtube" && (
          <span className="platform-badge" title="YouTube" aria-label="YouTube">
            YouTube
          </span>
        )}
```

Hide the Twitch player toggle for YouTube:

```tsx
          <button
            title="Utiliser le lecteur Twitch"
            data-i18n-title="Utiliser le lecteur Twitch"
            aria-label="Utiliser le lecteur Twitch"
            data-i18n-aria-label="Utiliser le lecteur Twitch"
            aria-pressed="false"
            className="player-toggle"
            hidden={platform === "youtube"}
            onClick={(e) => {
              e.stopPropagation();
              onPlayerToggle();
            }}
          >
```

Make the chat menu link platform-aware:

```tsx
              <a
                target="_blank"
                rel="noopener"
                data-i18n={
                  platform === "youtube"
                    ? "Ouvrir sur YouTube ↗"
                    : "Ouvrir sur Twitch ↗"
                }
              >
                {platform === "youtube"
                  ? "Ouvrir sur YouTube ↗"
                  : "Ouvrir sur Twitch ↗"}
              </a>
```

- [ ] **Step 2: Add the YouTube badge to `ChannelList`**

Inside the `rows.map((s) => {` block, add:

```tsx
        const youtube = s.platform === "youtube";
```

Add the platform attributes and skip the Twitch preview for YouTube:

```tsx
          <li
            key={s.twitch}
            data-login={s.twitch}
            data-platform={s.platform || "twitch"}
            className={/* the existing expression stays unchanged */}
            onPointerEnter={(e) => {
              if (e.pointerType !== "touch" && e.shiftKey && !youtube)
                onPreview(e.currentTarget);
            }}
            onPointerLeave={onLeavePreview}
          >
```

Add the badge next to the name:

```tsx
                <span className="name">{s.display}</span>
                {youtube && (
                  <span className="platform" title="YouTube" aria-label="YouTube">
                    YouTube
                  </span>
                )}
```

Use the platform fallback and hide the favorite star:

```tsx
                <div className="g">
                  {[s.online === false ? tr("Hors ligne") : "", s.game]
                    .filter(Boolean)
                    .join(" · ") ||
                    tr(youtube ? "Chaîne YouTube" : "Chaîne Twitch")}
                </div>
```

```tsx
            <button
              className="favorite"
              hidden={connected || youtube}
              // ... the existing attributes stay unchanged
            >
```

- [ ] **Step 3: Add the tile badge style**

Append to `src/styles/grid.css` after the `.tile .viewers` rule:

```css
/* A YouTube tile keeps YouTube's player and its own chat: the badge marks the source. */
.platform-badge {
  flex: none;
  padding: 1px 4px;
  border-radius: 3px;
  background: #f00;
  color: #fff;
  font-size: 10px;
  line-height: 14px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
```

- [ ] **Step 4: Add the list badge style**

Append to `src/styles/sidebar.css` after the `#list .g` rule:

```css
#list .platform {
  display: inline-block;
  margin-left: 6px;
  padding: 0 4px;
  border-radius: 3px;
  background: #f00;
  color: #fff;
  font-size: 10px;
  line-height: 15px;
  font-weight: 700;
  vertical-align: middle;
}
```

- [ ] **Step 5: Add the translations**

Append these entries before the final `};` of `src/services/translations.ts`:

```ts
  "Ouvrir sur YouTube ↗": ["Open on YouTube ↗", "Openen op YouTube ↗"],
  "Chaîne YouTube": ["YouTube channel", "YouTube-kanaal"],
  "Recherche sur YouTube…": ["Searching YouTube…", "Zoeken op YouTube…"],
  "Aucune live YouTube pour cette adresse.": [
    "No YouTube live at this address.",
    "Geen YouTube-live op dit adres.",
  ],
  "La recherche YouTube est indisponible pour le moment.": [
    "YouTube search is unavailable right now.",
    "YouTube zoeken is momenteel niet beschikbaar.",
  ],
  "Le lecteur YouTube est indisponible. Recharge la page pour réessayer.": [
    "The YouTube player is unavailable. Reload the page to try again.",
    "De YouTube-speler is niet beschikbaar. Herlaad de pagina om het opnieuw te proberen.",
  ],
```

- [ ] **Step 6: Run the checks and translation test**

Run: `pnpm check && pnpm test:server`
Expected: PASS. The i18n test finds the new copy; existing Twitch tiles render unchanged.

- [ ] **Step 7: Review the diff**

Run: `git diff -- src/components/StreamTile.tsx src/components/ChannelList.tsx src/styles/grid.css src/styles/sidebar.css src/services/translations.ts`
Expected: no workspace wiring yet; Twitch tiles are visually unchanged because `platform` is undefined. Do not commit unless the user asks.

---

## Task 5: Workspace integration

**Files:**
- Modify: `src/controllers/workspace.tsx`
- Modify: `src/controllers/videoLayout.ts`
- Modify: `src/controllers/preview.ts`

- [ ] **Step 1: Add the imports**

At the top of `src/controllers/workspace.tsx`, extend the library import:

```ts
import {
  channel,
  readStored,
  writeStored,
  validLogin,
  validChannelKey,
  isYouTubeKey,
  isYouTubeChannel,
  TwitchLibrary,
  numberFormat,
  refreshNumberFormat,
} from "../services/library";
```

Add the YouTube services and player after it:

```ts
import {
  isYouTubeQuery,
  restoreYouTubeChannel,
  youtubeChatUrl,
  youtubeLive,
  youtubeWatchUrl,
} from "../services/youtube";
import { YouTubePlayer } from "../services/youtubePlayer";
```

- [ ] **Step 2: Accept YouTube keys in saved state and keep the live grid Twitch-only**

Change the sound-follow filter near the top:

```ts
  let soundFollow: string[] | null = Array.isArray(storedFollow)
    ? storedFollow.filter(validChannelKey)
    : null;
```

In `syncLiveGrid`, skip YouTube tiles in the removal pass:

```ts
    for (const login of [...tiles.keys()]) {
      const t = tiles.get(login)!;
      if (isYouTubeChannel(t.channel)) continue;
      if (!follows.some((s) => s.twitch === login)) remove(login, true, true);
    }
```

In `refreshCollaborations`, exclude YouTube keys before asking Twitch:

```ts
      .filter(
        (s) =>
          validLogin(s.twitch) &&
          (s.online || (tiles.has(s.twitch) && s.online !== false)) &&
          (!collaborations.has(s.twitch) ||
            Date.now() - collaborations.get(s.twitch)!.checkedAt >= 60000),
      )
```

- [ ] **Step 3: Save and restore the platform identity**

Replace the `channels` mapping in `currentLayout`:

```ts
      channels: order.map((login) => {
        const {
          twitch,
          display,
          profileUrl,
          previewUrl,
          offlineUrl,
          platform,
          youtubeId,
          title,
          game,
        } = tiles.get(login)!.channel;
        return {
          twitch,
          display,
          profileUrl,
          previewUrl,
          offlineUrl,
          platform,
          youtubeId,
          title,
          game,
        };
      }),
```

Replace the beginning of `restore` through the restore loop:

```ts
  function restore() {
    if (!layoutMode || restored) return;
    const st =
      gridStore?.active.layout ||
      readStored<LayoutSnapshot>("tg.layout." + layoutMode, {});
    const savedChannels = Array.isArray(st.channels) ? st.channels : [];
    const orderKeys = Array.isArray(st.order) ? [...new Set(st.order)] : [];
    // A YouTube-only layout must restore even when the Twitch SDK is blocked.
    const needsTwitch =
      orderKeys.some((key) => !isYouTubeKey(key)) ||
      savedChannels.some((s) => s && !isYouTubeKey(s.twitch));
    if (needsTwitch && !playerConstructor()) return;
    allPaused = !!st.allPaused;
    mutedAll = Array.isArray(st.mutedAll)
      ? st.mutedAll.filter(validChannelKey)
      : null; // a global mute outranks whatever the tiles saved
    batching = true;
    liveLayoutToRestore = isLiveGrid() ? structuredClone(st) : null;
    for (const login of !isLiveGrid()
      ? orderKeys.filter(validChannelKey)
      : []) {
      const saved = savedChannels.find((x) => x?.twitch === login);
      const s =
        streamers.find((x) => x.twitch === login) ||
        (isYouTubeKey(login)
          ? restoreYouTubeChannel(saved || { twitch: login })
          : channel(saved || { twitch: login }));
      if (s) restoreChannel(s, st);
    }
```

After `syncChat();` in `restore`, add:

```ts
    void refreshYouTubeTiles();
```

- [ ] **Step 4: Route chat and playback by platform**

Make YouTube tiles always own their controls:

```ts
  function ownsControls(t: Tile) {
    return (
      isYouTubeChannel(t.channel) ||
      t.controls ||
      (t.playerMode ?? preferences.player) === "custom"
    );
  }
```

In `syncChat`, replace the first line of the loop and the chat URL:

```ts
  function syncChat() {
    for (const [login, t] of tiles) {
      const youtube = isYouTubeChannel(t.channel);
      const allowed =
          t.controls && t.chatFits && (!youtube || !!t.channel.youtubeId),
        open =
          !t.chatOverride && focused === login
            ? preferences.spotlightChat === "on"
            : t.chatOpen,
        visible = restored && open && allowed;
```

```ts
      const dark = document.documentElement.dataset.theme === "dark";
      const chatSrc = youtube
        ? youtubeChatUrl(t.channel.youtubeId!, dark)
        : `https://www.twitch.tv/embed/${login}/chat?parent=${encodeURIComponent(location.hostname)}` +
          (dark ? "&darkpopout=1" : "");
```

Guard the Twitch player toggle:

```ts
  function togglePlayer(t: Tile) {
    if (isYouTubeChannel(t.channel)) return;
    setPlayerMode(
      t,
      (t.playerMode ?? preferences.player) === "custom" ? "embed" : "custom",
    );
  }
  function setPlayerMode(t: Tile, mode: "embed" | "custom") {
    if (isYouTubeChannel(t.channel)) return;
    // ... the existing body stays unchanged
  }
```

In `mountPlayer`, select the constructor and suppress the custom-player class:

```ts
  function mountPlayer(t: Tile, controls: boolean) {
    // Removing a fullscreen iframe also forces the browser to exit fullscreen.
    if (t.player && inFullscreen(t)) return;
    const youtube = isYouTubeChannel(t.channel);
    const Constructor = youtube ? YouTubePlayer : playerConstructor(t.playerMode);
    if (!Constructor) return;
    t.el.classList.toggle(
      "custom",
      !youtube && (t.playerMode ?? preferences.player) === "custom",
    );
```

```ts
    // Leave `const latency = wantedLatency(t);` unchanged. The YouTube adapter
    // accepts the option and ignores it; its own player owns quality and latency.
```

Pass the video ID to the constructor:

```ts
    const player = new Constructor(embed, {
      channel: t.el.dataset.login!,
      videoId: t.channel.youtubeId,
      parent: [location.hostname],
      // ... the existing options stay unchanged
    });
```

Guard both `nameFrame` calls, because YouTube creates its iframe only when ready:

```ts
    const initialFrame = container.querySelector<
      HTMLIFrameElement | HTMLVideoElement
    >("iframe, video");
    if (initialFrame)
      nameFrame(
        initialFrame,
        tr("Stream de {name}", { name: t.channel.display }),
      );
```

Inside the `READY` listener, after `t.ready = true;`, add:

```ts
      const readyFrame = container.querySelector<
        HTMLIFrameElement | HTMLVideoElement
      >("iframe, video");
      if (readyFrame)
        nameFrame(
          readyFrame,
          tr("Stream de {name}", { name: t.channel.display }),
        );
```

A failed YouTube API must leave the loader, not spin forever. Replace the
existing error block in the player event loop with:

```ts
        if (event === "playbackBlocked") t.playbackBlocked = true;
        if (event === "playing" || event === "offline" || event === "error")
          t.playbackBlocked = false;
        if (event === "error") {
          t.playbackError = true;
          if (isYouTubeChannel(t.channel) && !t.ready) {
            t.ready = true;
            t.readyAt = 0;
            notice(
              tr(
                "Le lecteur YouTube est indisponible. Recharge la page pour réessayer.",
              ),
            );
          }
        }
```

- [ ] **Step 5: Wire the tile creation**

In `add`, let YouTube tiles through when the Twitch SDK is unavailable:

```ts
    if (!isYouTubeChannel(s) && !playerConstructor()) {
      notice(
        tr(
          "Le lecteur Twitch est indisponible. Recharge la page pour réessayer.",
        ),
      );
      return false;
    }
```

Mark the tile and pass its platform to the React shell:

```ts
    const el = document.createElement("div");
    el.className = "tile loading";
    el.dataset.login = s.twitch;
    el.dataset.platform = s.platform || "twitch";
    el.dataset.playerMode = isYouTubeChannel(s) ? "embed" : preferences.player;
```

```tsx
      <StreamTile
        display={s.display}
        platform={s.platform}
        onSpotlight={() => focus(s.twitch)}
        // ... the existing props stay unchanged
      />
```

Add `playerMode` to the `t` literal:

```ts
    const t: Tile = {
      el,
      bar,
      // ... the existing fields stay unchanged
      playerMode: isYouTubeChannel(s) ? "embed" : undefined,
    };
```

After `setupChatResize(t, save);`, hide the Twitch-only menus:

```ts
    setupChatResize(t, save);
    if (isYouTubeChannel(s)) {
      t.extensions.hidden = true;
      t.collaboration.hidden = true;
      t.bar.querySelector<HTMLButtonElement>(".player-toggle")!.hidden = true;
    }
```

Give the chat menu the YouTube watch page when applicable:

```ts
    const chatLink = t.chatOptions.querySelector<HTMLAnchorElement>("a")!;
    chatLink.href =
      isYouTubeChannel(s) && s.youtubeId
        ? youtubeWatchUrl(s.youtubeId)
        : `https://www.twitch.tv/popout/${s.twitch}/chat?popout=` +
          (document.documentElement.dataset.theme === "dark"
            ? "&darkpopout=1"
            : "");
```

- [ ] **Step 6: Keep Twitch-only discovery off YouTube tiles**

In `refreshExtensions`, stop before the network call:

```ts
  async function refreshExtensions(t: Tile) {
    const login = t.el.dataset.login!;
    if (
      isYouTubeChannel(t.channel) ||
      t.channel.online === false ||
      t.extensionsLoading
    )
      return;
```

In `updateTileInfo`, replace the collaboration and extension block:

```ts
    renderCollaboration(
      t,
      isYouTubeChannel(s) || s.online === false
        ? []
        : collaborations.get(s.twitch)?.participants || [],
    );
    if (isYouTubeChannel(s)) {
      if (t.extensionsList.length || !t.extensions.hidden)
        renderExtensions(t, []);
    } else if (s.online === false) {
      closeExtensionWindows(s.twitch);
      if (t.extensionsList.length || !t.extensions.hidden)
        renderExtensions(t, []);
    } else if (wasOnline === false && s.online === true) {
      t.extensionsCheckedAt = 0;
      t.extensionsFailed = false;
      void refreshExtensions(t);
    }
```

- [ ] **Step 7: Search YouTube when the query is a YouTube address**

Add the search platform next to the search state:

```ts
  let searching = false,
    searchPlatform: "twitch" | "youtube" = "twitch",
    refreshInFlight = false,
    // ... the existing declarations stay unchanged
```

Replace the whole `search` function:

```ts
  async function search() {
    searchController?.abort();
    const version = ++searchVersion,
      query = $<HTMLInputElement>("#q").value.trim();
    results = [];
    searchError = "";
    searchPlatform = isYouTubeQuery(query) ? "youtube" : "twitch";
    searching = query.length >= 2;
    rebuild();
    if (!searching) return;
    searchController = new AbortController();
    try {
      if (searchPlatform === "youtube") {
        const found = await youtubeLive(query, searchController.signal);
        if (version !== searchVersion) return;
        results = found ? [found] : [];
        if (!found)
          searchError = tr("Aucune live YouTube pour cette adresse.");
        return;
      }
      const found = await (library || new TwitchLibrary("")).search(
        loginFromQuery(query) || query,
        searchController.signal,
      );
      if (version !== searchVersion) return;
      results = found;
    } catch (cause) {
      const error =
        cause instanceof Error
          ? (cause as HttpError)
          : new HttpError(String(cause));
      if (version !== searchVersion || error.name === "AbortError") return;
      if (searchPlatform === "youtube") {
        searchError = error.status
          ? error.message
          : tr("La recherche YouTube est indisponible pour le moment.");
      } else if (error.status === 401) handleError(error);
      else
        searchError = error.status
          ? error.message
          : tr(
              "La recherche Twitch est indisponible pour le moment. Tu peux ajouter un pseudo directement.",
            );
    } finally {
      if (version === searchVersion) {
        searching = false;
        rebuild();
      }
    }
  }
```

Update the debounced input so its loading copy matches the query:

```ts
  actions.searchInput = () => {
    clearTimeout(searchTimer);
    searchController?.abort();
    searchVersion++;
    results = [];
    searchError = "";
    const value = $<HTMLInputElement>("#q").value.trim();
    searchPlatform = isYouTubeQuery(value) ? "youtube" : "twitch";
    searching = value.length >= 2;
    rebuild();
    searchTimer = setTimeout(search, 300);
  };
```

Let Enter add the live YouTube result:

```ts
  actions.searchKey = (e) => {
    if (e.key !== "Enter") return;
    if (searchPlatform === "youtube") {
      const found = results.find(
        (s) => s.platform === "youtube" && s.online === true,
      );
      if (found) {
        hidePreview();
        if (!tiles.has(found.twitch)) toggle(found);
        $<HTMLInputElement>("#q").value = "";
        search();
      }
      return;
    }
    if (!$<HTMLButtonElement>("#add-login").hidden)
      $<HTMLButtonElement>("#add-login").click();
  };
```

- [ ] **Step 8: Update the search copy and action visibility**

In `renderList`, hide the Twitch "add without verification" action for YouTube:

```ts
    $("#search-actions").hidden =
      !searchError || connected || searchPlatform === "youtube";
```

```ts
    const login = loginFromQuery(q);
    $<HTMLButtonElement>("#add-login").hidden =
      connected ||
      searchPlatform === "youtube" ||
      !searchError ||
      !login ||
      favorites.some((s) => s.twitch === login);
```

Use the platform-aware loading message:

```ts
    $("#search-state").textContent = !q
      ? ""
      : q.length < 2
        ? tr("Saisis au moins 2 caractères.")
        : searching
          ? tr(
              searchPlatform === "youtube"
                ? "Recherche sur YouTube…"
                : "Recherche sur Twitch…",
            )
          : searchError ||
            (rows.length
              ? tr(
                  rows.length === 1
                    ? "{count} chaîne trouvée"
                    : "{count} chaînes trouvées",
                  { count: rows.length },
                )
              : tr("Aucune chaîne trouvée."));
```

- [ ] **Step 9: Keep Twitch status requests free of YouTube keys**

In `refresh`, filter the Helix request and guard the update loop:

```ts
      const logins = [
        ...new Set(
          [...nextChannels, ...order.map((twitch) => ({ twitch }))].map(
            (s) => s.twitch,
          ),
        ),
      ];
      const live = await library.live(logins.filter(validLogin));
```

```ts
      results = results.map((s) =>
        isYouTubeChannel(s) ? s : logins.includes(s.twitch) ? update(s) : s,
      );
```

```ts
      for (const [login, t] of tiles)
        if (!isYouTubeChannel(t.channel) && logins.includes(login)) {
          updateTileInfo(t, update(t.channel));
          void refreshExtensions(t);
        }
```

- [ ] **Step 10: Refresh YouTube live status separately**

Add this function immediately after `refresh`:

```ts
  let youTubeRefreshInFlight = false;
  async function refreshYouTubeTiles() {
    if (lifecycle.disposed || youTubeRefreshInFlight || document.hidden) return;
    const youtubeTiles = [...tiles.values()].filter(
      (t) => isYouTubeChannel(t.channel) && !!t.channel.youtubeId,
    );
    if (!youtubeTiles.length) return;
    youTubeRefreshInFlight = true;
    try {
      await Promise.all(
        youtubeTiles.map(async (t) => {
          const key = t.el.dataset.login!;
          try {
            const next = await youtubeLive(t.channel.youtubeId!);
            if (tiles.get(key) !== t) return;
            if (!next) {
              updateTileInfo(t, { ...t.channel, online: false });
              return;
            }
            updateTileInfo(t, {
              ...t.channel,
              online: true,
              display: next.display || t.channel.display,
              profileUrl: next.profileUrl || t.channel.profileUrl,
              previewUrl: next.previewUrl || t.channel.previewUrl,
              title: next.title,
              viewersAmount: next.viewersAmount,
            });
          } catch {
            /* a transient lookup leaves the tile as it is */
          }
        }),
      );
    } finally {
      youTubeRefreshInFlight = false;
    }
  }
```

Call it with the other periodic refresh and when the tab becomes visible again:

```ts
  setInterval(() => {
    if (!document.hidden) void refreshYouTubeTiles();
  }, 60000);
```

```ts
  listenDocument("visibilitychange", () => {
    if (!document.hidden) {
      tiles.forEach(sync);
      refreshPosters();
      refresh();
      void refreshYouTubeTiles();
    }
  });
```

- [ ] **Step 11: Keep preference refreshes platform-aware**

In `refreshPreferences`, skip YouTube tiles when the Twitch player setting changes:

```ts
    if (currentPlayerMode !== preferences.player) {
      for (const t of tiles.values()) {
        if (isYouTubeChannel(t.channel)) continue;
        delete t.playerMode;
        delete t.el.dataset.playerMode;
      }
      currentPlayerMode = preferences.player;
      hidePreview();
      for (const t of tiles.values())
        if (!isYouTubeChannel(t.channel)) releasePlayer(t);
      if (playerConstructor()) {
        restore();
        layout();
        refresh();
      } else loadPlayer();
    }
```

Keep the extensions refresh Twitch-only:

```ts
      if (isYouTubeChannel(t.channel)) {
        if (t.extensionsList.length || !t.extensions.hidden)
          renderExtensions(t, []);
      } else if (t.channel.online !== false) {
        renderExtensions(t, t.extensionsList);
      }
```

Replace the unconditional chat link assignment in that loop:

```ts
      const chatLink = t.chatOptions.querySelector<HTMLAnchorElement>("a")!;
      chatLink.href =
        isYouTubeChannel(t.channel) && t.channel.youtubeId
          ? youtubeWatchUrl(t.channel.youtubeId)
          : `https://www.twitch.tv/popout/${t.el.dataset.login!}/chat?popout=` +
            (document.documentElement.dataset.theme === "dark"
              ? "&darkpopout=1"
              : "");
```

- [ ] **Step 12: Give YouTube tiles a poster and skip the Twitch preview**

In `src/controllers/videoLayout.ts`, start `previewImageURL` with the YouTube branch:

```ts
export function previewImageURL(s: Channel) {
  if (s.platform === "youtube") return s.previewUrl || s.offlineUrl || "";
  if (s.online === false) return s.offlineUrl || ""; // the banner the channel set for its offline screen, when it has one
  // ... the existing Twitch fallback stays unchanged
}
```

In `src/controllers/preview.ts`, stop `showPreview` for YouTube rows before it constructs a Twitch player:

```ts
  function showPreview(row: HTMLLIElement) {
    const s = getChannels().find((s) => s.twitch === row.dataset.login!);
    if (
      !s ||
      s.online === false ||
      s.platform === "youtube" ||
      !row.isConnected ||
      document.hidden
    ) {
      hidePreview();
      return;
    }
```

- [ ] **Step 13: Run the TypeScript check**

Run: `pnpm check`
Expected: PASS. Confirm that `youtubeChatUrl`, `youtubeLive`, `youtubeWatchUrl`, `YouTubePlayer`, `validChannelKey`, `isYouTubeKey` and `isYouTubeChannel` are all used, so `noUnusedLocals` stays quiet.

- [ ] **Step 14: Review the diff**

Run: `git diff -- src/controllers/workspace.tsx src/controllers/videoLayout.ts src/controllers/preview.ts`
Expected: YouTube keys touch only the guards named in this task; Twitch follows, favorites, extensions, collaborations, notifications and preference refreshes stay Twitch-only. Do not commit unless the user asks.

---

## Task 6: Browser tests

**Files:**
- Modify: `tests/fixtures.cjs`
- Modify: `tests/grid.spec.js`

- [ ] **Step 1: Add a YouTube IFrame API mock**

In `tests/fixtures.cjs`, add this constant before `module.exports`:

```js
const mockYouTube = `window.YT = {
  PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  Player: class {
    constructor(node, options) {
      this.node = node; this.options = options; this.state = -1;
      this.muted = false; this.volume = 100; this.destroyed = false;
      this.iframe = document.createElement('iframe');
      node.append(this.iframe);
      setTimeout(() => { if (!this.destroyed) this.options.events?.onReady?.({ target: this }); }, 0);
    }
    playVideo() {
      if (this.destroyed || this.state === 1) return;
      this.state = 1;
      this.options.events?.onStateChange?.({ data: 1, target: this });
    }
    pauseVideo() {
      if (this.destroyed || this.state === 2) return;
      this.state = 2;
      this.options.events?.onStateChange?.({ data: 2, target: this });
    }
    mute() { this.muted = true; }
    unMute() { this.muted = false; }
    isMuted() { return this.muted; }
    setVolume(value) { this.volume = value; }
    getVolume() { return this.volume; }
    getPlayerState() { return this.state; }
    getIframe() { return this.iframe; }
    destroy() { this.destroyed = true; this.iframe.remove(); }
  }
};
window.onYouTubeIframeAPIReady?.();`;
```

Change the export:

```js
module.exports = { mockPlayer, mockYouTube, choose };
```

- [ ] **Step 2: Add the YouTube routes to the test setup**

At the top of `tests/grid.spec.js`, import the new mock:

```js
const { mockPlayer, mockYouTube, choose } = require('./fixtures.cjs');
```

Add a fixture helper before `setup`:

```js
function youtubeFixture(query) {
  return {
    live: !/offline/i.test(query),
    videoId: 'ytlive00001',
    title: 'YouTube live test',
    author: 'YouTube test channel',
    channelId: 'UCtesttesttesttesttesttest',
    thumbnail: 'https://i.ytimg.com/vi/ytlive00001/hqdefault.jpg',
    viewers: 1234,
    startedAt: Date.now(),
  };
}
```

Add these routes inside `setup`, after the `/api/extensions` route:

```js
  await page.route('https://www.youtube.com/iframe_api', r =>
    r.fulfill({ contentType: 'text/javascript', body: mockYouTube }),
  );
  await page.route('https://www.youtube.com/live_chat**', r =>
    r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>chat</title>' }),
  );
  await page.route('**/api/youtube?**', route => {
    const query = new URL(route.request().url()).searchParams.get('q') || '';
    return route.fulfill({ json: youtubeFixture(query) });
  });
```

- [ ] **Step 3: Add the YouTube browser tests**

Append to `tests/grid.spec.js`:

```js
test('a YouTube live joins the grid with its chat and survives a reload', async ({ page }) => {
  const errors = await setup(page);
  await page.goto('/');
  await page.locator('#q').fill('https://www.youtube.com/watch?v=ytlive00001');
  const row = page.locator('#list [data-login="yt:ytlive00001"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.platform')).toHaveText('YouTube');
  await row.locator('.channel').click();
  const tile = page.locator('#grid [data-login="yt:ytlive00001"]');
  await expect(tile).toHaveCount(1);
  await expect(tile).toHaveAttribute('data-platform', 'youtube');
  await readyPlayers(page);
  await expect(tile.locator('.platform-badge')).toHaveText('YouTube');
  await expect(tile.locator('.extensions')).toBeHidden();
  await expect(tile.locator('.collaboration')).toBeHidden();
  await expect(tile.locator('.player-toggle')).toBeHidden();

  await tile.locator('.chat-toggle').click();
  const chat = tile.locator('.chat iframe');
  await expect(chat).toHaveAttribute('src', /youtube\.com\/live_chat\?v=ytlive00001/);
  await expect(chat).toHaveAttribute('src', /embed_domain=localhost/);
  await tile.locator('.chat-options summary').click();
  await expect(tile.locator('.chat-menu a')).toHaveAttribute(
    'href',
    'https://www.youtube.com/watch?v=ytlive00001',
  );
  await tile.locator('.chat-options summary').click();

  await tile.locator('.pp').click();
  await expect
    .poll(() => page.evaluate(() => tiles.get('yt:ytlive00001').player.getPlayerState().playback))
    .toBe('Paused');
  await tile.locator('.pp').click();
  await expect
    .poll(() => page.evaluate(() => tiles.get('yt:ytlive00001').player.getPlayerState().playback))
    .toBe('Playing');

  await tile.locator('.snd').click();
  await expect
    .poll(() => page.evaluate(() => tiles.get('yt:ytlive00001').player.getMuted()))
    .toBe(false);

  await favorite(page, 'mistermv');
  await page.locator('#list [data-login="mistermv"] .channel').click();
  await expect(page.locator('#grid .tile')).toHaveCount(2);

  await page.reload();
  await expect(page.locator('#grid .tile')).toHaveCount(2);
  await readyPlayers(page);
  await expect(page.locator('#grid [data-login="yt:ytlive00001"]')).toHaveAttribute(
    'data-platform',
    'youtube',
  );
  const layout = await page.evaluate(() => JSON.parse(localStorage.getItem('tg.layout.guest')));
  expect(layout.order).toContain('yt:ytlive00001');
  expect(layout.order).toContain('mistermv');
  expect(layout.channels.find(c => c.twitch === 'yt:ytlive00001')).toMatchObject({
    platform: 'youtube',
    youtubeId: 'ytlive00001',
  });
  expect(errors).toEqual([]);
});

test('a YouTube address without a live shows a message and no row', async ({ page }) => {
  const errors = await setup(page);
  await page.route('**/api/youtube?**', route =>
    route.fulfill({ json: { live: false, videoId: 'ytlive00001' } }),
  );
  await page.goto('/');
  await page.locator('#q').fill('https://www.youtube.com/watch?v=ytlive00001');
  await expect(page.locator('#search-state')).toContainText(
    'Aucune live YouTube pour cette adresse.',
  );
  await expect(page.locator('#list [data-login="yt:ytlive00001"]')).toHaveCount(0);
  await expect(page.locator('#add-login')).toBeHidden();
  expect(errors).toEqual([]);
});

test('an 11-character Twitch login is not treated as a YouTube ID', async ({ page }) => {
  const errors = await setup(page);
  await page.goto('/');
  await page.locator('#q').fill('abcdefghijk');
  await expect(page.locator('#list [data-login="abcdefghijk"]')).toBeVisible();
  await expect(page.locator('#list [data-login^="yt:"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
```

- [ ] **Step 4: Run the focused YouTube browser tests**

Run: `pnpm exec playwright test tests/grid.spec.js -g "YouTube"`
Expected: the three tests PASS. The mock API script loads only when the first YouTube tile mounts; the chat iframe is routed to a local empty page.

- [ ] **Step 5: Run the full browser suite**

Run: `pnpm test`
Expected: PASS. Existing tests are unaffected because they never add a YouTube tile; the default `/api/youtube` mock returns a live fixture only if a YouTube query is typed.

- [ ] **Step 6: Review the diff**

Run: `git diff -- tests/fixtures.cjs tests/grid.spec.js`
Expected: one mock, three routes and three focused tests. Do not commit unless the user asks.

---

## Task 7: Documentation and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Mention YouTube in the introduction**

Change the first line:

```markdown
# Twitch grid

Watch several Twitch and YouTube live streams on one screen, arrange their tiles, put one in spotlight, and choose the sound for each stream.
```

- [ ] **Step 2: Document YouTube lives**

Add this section after “Chat” and before “Twitch extensions”:

```markdown
## YouTube lives

Paste a YouTube live URL, a `youtu.be` link, a channel `/live` URL, an `@handle`,
a channel ID, or an unambiguous 11-character video ID into the search field. The
result row carries a YouTube badge; clicking it adds the tile to the grid beside
Twitch channels. The tile keeps the usual pause, sound, volume, spotlight,
fullscreen, chat, drag and saved-grid behaviour.

YouTube tiles use YouTube's official iframe player and its native controls. The
custom HLS player, the Twitch embed switch, the resolution menu and the latency
settings remain Twitch-only. YouTube lives are not part of Twitch follows or
favorites and have no Twitch collaborations or extensions. A live added by a
video URL stays tied to that video; a channel `/live` URL resolves to the video
that is live at that moment.

Chat uses YouTube's official `youtube.com/live_chat` embed with `embed_domain`
set to the page hostname. The page's `strict-origin-when-cross-origin` referrer
policy supplies the matching origin. YouTube may disable embedding or chat for a
particular broadcast; the tile then shows YouTube's own message or the app's
unavailable state.

`GET /api/youtube?q=…` reads the public watch page, or the channel's `/live`
page, and extracts the live metadata from the embedded player response. It
returns only public data (video ID, title, author, channel ID, thumbnail,
watching count and start time), caches results for 30 seconds, shares concurrent
lookups, and limits each client address to 60 lookups per minute. No API key or
credentials are required. YouTube's page shape is undocumented: if a watch page
can no longer be read, the endpoint answers `YOUTUBE_UNAVAILABLE`; a channel
`/live` page that cannot be read is reported as not live.
```

- [ ] **Step 3: Update the code-structure list**

In the “Code structure” section, include the new route and the fourth API route:

```markdown
- `api/search.js`, `api/stream.js`, `api/extensions.js` and `api/youtube.js` are shared by local development and the production Node server.
- `production.cjs` serves the four API routes and `/healthz` using Node's built-in HTTP server; it needs no installed runtime dependencies.
```

- [ ] **Step 4: Run the full verification**

Run:

```sh
pnpm check
pnpm test:server
pnpm test
pnpm build
```

Expected: all commands pass. `pnpm build` produces `dist` without errors.

- [ ] **Step 5: Review the complete diff and stop for approval**

Run:

```sh
git status --short && git diff --stat
```

Expected: only the files listed in this plan. The working tree may already contain unrelated removals of the GitHub links in `src/components/Sidebar.tsx` and `src/components/Workspace.tsx`; preserve them. Do not commit, push or merge; wait for the user's approval.

---

## Self-review checklist

- [ ] Pasting a YouTube video URL, `youtu.be` link, `/live` channel URL, `@handle`, channel ID or unambiguous 11-character video ID shows a YouTube result row.
- [ ] An ambiguous 11-character string that is a valid Twitch login still searches Twitch.
- [ ] Clicking the YouTube row adds a tile with `data-platform="youtube"` and `data-login="yt:<videoId>"`.
- [ ] The YouTube tile plays through the official iframe and responds to the header pause, sound, volume and spotlight controls.
- [ ] Chat opens with `https://www.youtube.com/live_chat?v=<id>&embed_domain=<hostname>` and follows the chat position and resize controls.
- [ ] YouTube tiles hide the Twitch player toggle, extensions menu and collaboration menu.
- [ ] Twitch and YouTube tiles coexist, reorder, spotlight, mute, pause and restore from saved grids.
- [ ] A YouTube layout restores even when the Twitch player SDK is unavailable.
- [ ] An ended YouTube live is marked offline and removed after one minute unless spotlighted or locked.
- [ ] Twitch follows, favorites, collaborations, extensions and status refresh never send a `yt:` key to Twitch.
- [ ] FR, EN and NL strings exist for every new `data-i18n` key and notice.
- [ ] `pnpm check`, `pnpm test:server`, `pnpm test` and `pnpm build` pass.
- [ ] Review the diff and wait for approval before any commit.
