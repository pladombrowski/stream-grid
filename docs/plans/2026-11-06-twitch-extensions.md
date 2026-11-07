# Twitch Extensions Discovery and Companion Windows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect the Twitch extensions active on each live channel and let the viewer open each extension's official Twitch popout page in a companion window positioned over the tile, because Twitch blocks embedding extension iframes on third-party sites.

**Architecture:** A new `GET /api/extensions?channel=<login>` Node endpoint queries Twitch's public GraphQL for a channel's active extension installations and returns only public metadata. The browser caches the list per channel and renders an “Extensions” details menu in each tile header. Choosing an extension opens `https://www.twitch.tv/popout/<channel>/extensions/<id>/<view>` with `window.open`, sized and placed over the tile's video area. No extension code runs in the grid page.

**Tech Stack:** React 19, strict TypeScript, Vite 8, Node 24 built-in HTTP, Playwright, Twitch GraphQL (public web client ID, already used by `api/stream.js`).

---

## Why the extension cannot render inside the tile

This is not a missing iframe option. Twitch explicitly prevents it:

- `https://supervisor.ext-twitch.tv/supervisor/v1/index.html` sends
  `content-security-policy: frame-ancestors https://*.twitch.tv https://*.twitch.tech ...`.
- The extension iframe sends
  `content-security-policy: frame-ancestors https://supervisor.ext-twitch.tv https://extension-files.twitch.tv https://*.twitch.tv https://*.twitch.tech ...`.
- `https://www.twitch.tv/popout/...` sends `x-frame-options: SAMEORIGIN`.
- The official `player.twitch.tv` and `embed.twitch.tv` players make no `ext-twitch.tv` requests; verified in Chromium against live channels with active extensions.

The only supported way to show a released extension outside Twitch's own page is to open its official Twitch popout in a separate window. The implementation below does that and makes the window follow the tile's position and size as closely as the browser allows.

---

## File structure

| File | Responsibility |
| --- | --- |
| `api/extensions.js` | Query Twitch GraphQL, filter active installations, map to public metadata, cache and rate limit. |
| `api/extensions.d.ts` | Declaration for the Vite config import, mirroring search/stream. |
| `tests/extensions.test.cjs` | Unit tests for validation, mapping, filtering, caching and upstream failures. |
| `tests/extensionsService.test.cjs` | Client cache/normalization tests. |
| `tests/extensionWindows.test.cjs` | Window lifecycle tests. |
| `tests/extensionWindowGeometry.test.cjs` | Geometry tests. |
| `src/services/extensions.ts` | Browser-side typed client, per-channel cache and in-flight dedupe. |
| `src/services/extensionWindows.ts` | Open, focus, position and close the Twitch popout windows. |
| `src/services/extensionWindowGeometry.ts` | Pure popup geometry. |
| `src/components/ExtensionsMenu.tsx` | React list rendered inside the tile's extensions menu. |
| `src/components/StreamTile.tsx` | Add the extensions details shell to the tile header. |
| `src/types/player.ts` | Add extension fields to `Tile`. |
| `src/controllers/workspace.tsx` | Wire discovery, menu positioning, popout actions, tile removal and account switches. |
| `src/styles/grid.css` | Extensions button, menu, rows and note. |
| `src/styles/workspace.css` | Light-theme overrides. |
| `src/services/translations.ts` | FR/EN/NL strings. |
| `vite.config.mts` | Serve `/api/extensions` in development and preview. |
| `production.cjs` | Route `/api/extensions` in production. |
| `package.json` | Include the new endpoint in `check` and the new test in `test:server`. |
| `tests/grid.spec.js` | Mock the endpoint and test the tile menu and `window.open` call. |
| `tests/production.test.cjs` | Verify the production route rejects an invalid channel. |
| `README.md` | Document the limitation, endpoint and companion-window behavior. |

---

## Task 1: Server endpoint `GET /api/extensions`

> **Implementation note:** the final endpoint serves cached channels before the limiter, uses 300 cache-miss requests per minute keyed on `X-Forwarded-For`, caps concurrent upstream lookups at 500, and evicts the oldest client when the map is full. The tests cover those boundaries.

**Files:**
- Create: `api/extensions.js`
- Test: `tests/extensions.test.cjs`
- Modify: `package.json`
- Modify: `vite.config.mts`
- Modify: `production.cjs`
- Modify: `tests/production.test.cjs`

- [ ] **Step 1: Write the failing validation test**

Create `tests/extensions.test.cjs` with the request helper and the first test:

```js
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/extensions.js');
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

function request(url = '/api/extensions?channel=example', method = 'GET', ip = 'test-extensions') {
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

test('rejects invalid channels and methods before contacting Twitch', async () => {
  global.fetch = () => { throw new Error('Unexpected request'); };
  assert.equal((await request('/api/extensions?channel=../private')).statusCode, 400);
  assert.equal((await request('/api/extensions?channel=')).statusCode, 400);
  assert.equal((await request('/api/extensions?channel=example', 'POST')).statusCode, 405);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/extensions.test.cjs`
Expected: FAIL with `Cannot find module '../api/extensions.js'`.

- [ ] **Step 3: Create the endpoint skeleton**

Create `api/extensions.js` with validation, rate limiting, cache plumbing and a `fail` helper. The GraphQL call is added in Step 5.

```js
// Twitch extensions cannot be embedded outside twitch.tv (CSP frame-ancestors).
// This endpoint only discovers the public metadata needed to offer the official popout page.
const cache = new Map(), pending = new Map(), clients = new Map();
const ttl = 300000; // extensions change rarely; five minutes keeps GraphQL traffic low
const clientId = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // public web client, already used by api/stream.js
const clientsLimit = 1000, requestsPerMinute = 60, cacheLimit = 200;

module.exports = async function extensions(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const fail = (status, error) => res.status(status).json({ error });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return fail(405, 'METHOD_NOT_ALLOWED');
  }
  const login = new URL(req.url, 'http://localhost').searchParams.get('channel')?.trim().toLowerCase();
  if (!login || !/^[a-z0-9_]{1,25}$/.test(login)) return fail(400, 'INVALID_CHANNEL');
  const now = Date.now();
  const ip = req.headers?.['x-real-ip']
    || String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
  for (const [client, entry] of clients) if (entry.until <= now) clients.delete(client);
  const entry = clients.get(ip) || { count: 0, until: now + 60000 };
  if (entry.count >= requestsPerMinute || (!clients.has(ip) && clients.size >= clientsLimit)) {
    res.setHeader('Retry-After', '60');
    return fail(429, 'EXTENSIONS_BUSY');
  }
  entry.count++;
  clients.set(ip, entry);
  const key = 'channel:' + login;
  if (cache.get(key)?.expiresAt > now) return res.status(200).json(cache.get(key).data);
  try {
    if (!pending.has(key)) pending.set(key, lookup(login).finally(() => pending.delete(key)));
    const data = await pending.get(key);
    if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
    cache.set(key, { data, expiresAt: Date.now() + ttl });
    return res.status(200).json(data);
  } catch {
    return fail(502, 'EXTENSIONS_UNAVAILABLE');
  }
};

async function lookup(login) {
  return { channel: login, extensions: [] };
}
```

- [ ] **Step 4: Run the validation test to verify it passes**

Run: `node --test tests/extensions.test.cjs`
Expected: PASS for the validation test.

- [ ] **Step 5: Add the mapping test with a Twitch fixture**

Append to `tests/extensions.test.cjs`:

```js
const fixture = {
  data: {
    user: {
      id: '406461346',
      channel: {
        id: '406461346',
        selfInstalledExtensions: [
          {
            installation: {
              id: 'k6ji:3.4.1:406461346',
              extension: {
                clientID: 'k6ji189bf7i4ge8il4iczzw7kpgmjt',
                name: '7 Days to Die Integration',
                description: 'Viewers interact with the live game.',
                version: '3.4.1',
                iconURLs: { square24: 'https://cdn.example/24.png', square100: 'https://cdn.example/100.png' },
                state: 'RELEASED',
                views: { videoOverlay: { viewerURL: 'https://k6ji.ext-twitch.tv/video_overlay.html' }, component: null, panel: null },
              },
              activationConfig: { anchor: 'VIDEO_OVERLAY', slot: 'extension-overlay-1', state: 'ACTIVE', x: null, y: null },
            },
          },
          {
            installation: {
              id: 'blerp:3.2.21:406461346',
              extension: {
                clientID: 'oafn7vvzfyzyccwrwrt233221oe5wq',
                name: 'Blerp',
                description: 'Alerts.',
                version: '3.2.21',
                iconURLs: { square24: '', square100: '' },
                state: 'RELEASED',
                views: { videoOverlay: null, component: { viewerURL: 'https://blerp.ext-twitch.tv/component.html', targetHeight: 9200, aspectRatioX: 40000, aspectRatioY: 58500 }, panel: { viewerURL: 'https://blerp.ext-twitch.tv/panel.html', height: 496 } },
              },
              activationConfig: { anchor: 'COMPONENT', slot: 'extension-component-2', state: 'ACTIVE', x: 0, y: 0 },
            },
          },
          {
            installation: {
              id: 'timezone:0.0.1:406461346',
              extension: {
                clientID: 'zowhdiwf4lqqoa99rphz5y38235qxu',
                name: 'Timezone',
                description: 'Local time.',
                version: '0.0.1',
                iconURLs: { square24: '', square100: '' },
                state: 'RELEASED',
                views: { videoOverlay: null, component: null, panel: { viewerURL: 'https://timezone.ext-twitch.tv/panel.html', height: 150 } },
              },
              activationConfig: { anchor: 'PANEL', slot: 'extension-panel-2', state: 'ACTIVE', x: null, y: null },
            },
          },
          {
            installation: {
              id: 'inactive:1:406461346',
              extension: {
                clientID: 'inactive000000000000000',
                name: 'Inactive',
                description: '',
                version: '1',
                iconURLs: { square24: '', square100: '' },
                state: 'RELEASED',
                views: { videoOverlay: { viewerURL: 'https://inactive.ext-twitch.tv/overlay.html' }, component: null, panel: null },
              },
              activationConfig: { anchor: 'VIDEO_OVERLAY', slot: 'extension-overlay-1', state: 'INACTIVE', x: null, y: null },
            },
          },
        ],
      },
    },
  },
};

test('maps active overlay, component and panel extensions and filters inactive ones', async () => {
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://gql.twitch.tv/gql');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Client-ID'], 'kimne78kx3ncx6brgo4mv6wki5h1ko');
    const body = JSON.parse(options.body);
    assert.equal(body.variables.login, 'tiranumisu');
    assert.match(body.query, /selfInstalledExtensions/);
    return Response.json(fixture);
  };
  const res = await request('/api/extensions?channel=tiranumisu');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.channel, 'tiranumisu');
  assert.deepEqual(res.body.extensions.map(extension => extension.type), ['overlay', 'component', 'panel']);
  assert.deepEqual(res.body.extensions.map(extension => extension.id), [
    'k6ji189bf7i4ge8il4iczzw7kpgmjt',
    'oafn7vvzfyzyccwrwrt233221oe5wq',
    'zowhdiwf4lqqoa99rphz5y38235qxu',
  ]);
  assert.equal(res.body.extensions[0].icon, 'https://cdn.example/100.png');
  assert.equal(res.body.extensions[0].viewerUrl, 'https://k6ji.ext-twitch.tv/video_overlay.html');
  assert.equal(res.body.extensions[1].targetHeight, 9200);
  assert.equal(res.body.extensions[1].aspectRatio, 40000 / 58500);
  assert.equal(res.body.extensions[2].height, 150);
  assert.equal(res.body.extensions[0].token, undefined);
  assert.equal(res.body.extensions[0].popoutUrl, undefined);
});
```

- [ ] **Step 6: Run the mapping test to verify it fails**

Run: `node --test tests/extensions.test.cjs`
Expected: FAIL because `lookup()` still returns an empty list.

- [ ] **Step 7: Implement the GraphQL query and mapping**

Replace the `lookup()` function in `api/extensions.js`:

```js
const query = `query ChannelExtensionsByLogin($login: String!) {
  user(login: $login) {
    id
    channel {
      id
      selfInstalledExtensions {
        installation {
          id
          extension {
            clientID
            name
            description
            version
            iconURLs { square24 square100 }
            state
            views {
              panel { viewerURL height }
              component { viewerURL targetHeight aspectRatioX aspectRatioY }
              videoOverlay { viewerURL }
            }
          }
          activationConfig { anchor slot state x y }
        }
      }
    }
  }
}`;

const anchors = { VIDEO_OVERLAY: 'overlay', COMPONENT: 'component', PANEL: 'panel' };

function mapExtensions(login, payload) {
  const edges = payload?.data?.user?.channel?.selfInstalledExtensions;
  if (!Array.isArray(edges)) return { channel: login, extensions: [] };
  const extensions = new Map();
  for (const edge of edges) {
    const installation = edge?.installation;
    const extension = installation?.extension;
    const activation = installation?.activationConfig;
    const type = anchors[activation?.anchor];
    if (!extension?.clientID || !type || activation?.state !== 'ACTIVE') continue;
    const view = type === 'overlay' ? extension.views?.videoOverlay
      : type === 'component' ? extension.views?.component
      : extension.views?.panel;
    if (!view?.viewerURL) continue;
    const icon = extension.iconURLs?.square100 || extension.iconURLs?.square24 || '';
    extensions.set(extension.clientID, {
      id: extension.clientID,
      name: extension.name || extension.clientID,
      description: extension.description || '',
      icon: /^https:\/\//.test(icon) ? icon : '',
      version: extension.version || '',
      type,
      slot: activation.slot || '',
      viewerUrl: view.viewerURL,
      height: type === 'panel' && Number.isFinite(view.height) ? view.height : null,
      targetHeight: type === 'component' && Number.isFinite(view.targetHeight) ? view.targetHeight : null,
      aspectRatio: type === 'component' && view.aspectRatioX > 0 && view.aspectRatioY > 0
        ? view.aspectRatioX / view.aspectRatioY
        : null,
    });
  }
  return { channel: login, extensions: [...extensions.values()] };
}

async function lookup(login) {
  const response = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: { 'Client-ID': clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { login } }),
  });
  if (!response.ok) throw new Error('EXTENSIONS_UNAVAILABLE');
  const payload = await response.json();
  if (payload?.errors?.length) throw new Error('EXTENSIONS_UNAVAILABLE');
  return mapExtensions(login, payload);
}
```

- [ ] **Step 8: Run the tests to verify mapping and validation pass**

Run: `node --test tests/extensions.test.cjs`
Expected: PASS for both tests.

- [ ] **Step 9: Add caching, dedupe and failure tests**

Append:

```js
test('caches a channel result and shares one upstream request', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return Response.json(fixture);
  };
  const [first, second] = await Promise.all([
    request('/api/extensions?channel=cachetest', 'GET', 'test-extensions-cache'),
    request('/api/extensions?channel=cachetest', 'GET', 'test-extensions-cache'),
  ]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(calls, 1);
  const third = await request('/api/extensions?channel=cachetest', 'GET', 'test-extensions-cache');
  assert.equal(third.statusCode, 200);
  assert.equal(calls, 1);
});

test('an unknown channel returns an empty list', async () => {
  global.fetch = async () => Response.json({ data: { user: null } });
  const res = await request('/api/extensions?channel=nobody', 'GET', 'test-extensions-unknown');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { channel: 'nobody', extensions: [] });
});

test('upstream failures become a recoverable error without leaking details', async () => {
  global.fetch = async () => Response.json({ errors: [{ message: 'private detail' }] });
  const res = await request('/api/extensions?channel=example', 'GET', 'test-extensions-failure');
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'EXTENSIONS_UNAVAILABLE' });
});
```

- [ ] **Step 10: Run the endpoint tests**

Run: `node --test tests/extensions.test.cjs`
Expected: all tests PASS.

- [ ] **Step 11: Wire the endpoint into development and production**

In `vite.config.mts`, import the handler and add it to the route list:

```ts
import extensions from "./api/extensions.js";
// ...
  for (const [path, handler] of [
    ["/api/search", search],
    ["/api/stream", stream],
    ["/api/extensions", extensions],
  ] as const) {
```

In `production.cjs`, import it and route it:

```js
const extensions = require('./api/extensions.js');
// ...
      const handler = path === '/api/search' ? search
        : path === '/api/stream' ? stream
        : path === '/api/extensions' ? extensions
        : null;
```

In `package.json`, add the syntax check and the test file:

```json
"check": "tsc --noEmit && node --check api/stream.js && node --check api/search.js && node --check api/extensions.js && node --check server.cjs && node --check production.cjs",
"test:server": "node --test tests/stream.test.cjs tests/search.test.cjs tests/extensions.test.cjs tests/i18n.test.cjs tests/watchtime.test.cjs tests/production.test.cjs tests/server-cli.test.cjs"
```

In `tests/production.test.cjs`, add the invalid-channel route assertion next to the existing validation checks:

```js
  assert.equal((await request('/api/extensions?channel=../private')).status, 400);
```

- [ ] **Step 12: Run the server checks and tests**

Run: `pnpm check && pnpm test:server`
Expected: TypeScript and syntax checks pass; all server tests pass.

- [ ] **Step 13: Review the diff**

Run: `git diff -- api/extensions.js tests/extensions.test.cjs vite.config.mts production.cjs package.json tests/production.test.cjs`
Expected: only the new endpoint, tests and route wiring. Do not commit unless the user asks.

---

## Task 2: Browser services for discovery and windows

> **Implementation note:** the final code removed the optional `AbortSignal`, extracted the pure `src/services/extensionWindowGeometry.ts` helper, and added `tests/extensionWindowGeometry.test.cjs`, `tests/extensionsService.test.cjs`, and `tests/extensionWindows.test.cjs`.

**Files:**
- Create: `src/services/extensions.ts`
- Create: `src/services/extensionWindows.ts`

- [ ] **Step 1: Create the typed discovery service**

Create `src/services/extensions.ts`:

```ts
export type ExtensionType = "overlay" | "component" | "panel";

export interface ChannelExtension {
  id: string;
  name: string;
  description: string;
  icon: string;
  version: string;
  type: ExtensionType;
  slot: string;
  viewerUrl: string;
  height: number | null;
  targetHeight: number | null;
  aspectRatio: number | null;
}

const ttl = 5 * 60 * 1000;
const cache = new Map<string, { at: number; data: ChannelExtension[] }>();
const pending = new Map<string, Promise<ChannelExtension[]>>();

function validExtension(value: unknown): value is ChannelExtension {
  if (!value || typeof value !== "object") return false;
  const extension = value as Partial<ChannelExtension>;
  return (
    typeof extension.id === "string" &&
    /^[a-z0-9]{10,40}$/i.test(extension.id) &&
    typeof extension.name === "string" &&
    typeof extension.viewerUrl === "string" &&
    /^https:\/\//.test(extension.viewerUrl) &&
    (extension.type === "overlay" ||
      extension.type === "component" ||
      extension.type === "panel")
  );
}

export async function channelExtensions(
  login: string,
  signal?: AbortSignal,
): Promise<ChannelExtension[]> {
  const cached = cache.get(login);
  if (cached && Date.now() - cached.at < ttl) return cached.data;
  const inflight = pending.get(login);
  if (inflight) return inflight;
  const request = fetch(
    "/api/extensions?channel=" + encodeURIComponent(login),
    {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    },
  )
    .then(async (response) => {
      if (!response.ok) throw new Error("EXTENSIONS_UNAVAILABLE");
      const payload = (await response.json()) as { extensions?: unknown };
      const list = Array.isArray(payload.extensions)
        ? payload.extensions.filter(validExtension)
        : [];
      cache.set(login, { at: Date.now(), data: list });
      return list;
    })
    .finally(() => pending.delete(login));
  pending.set(login, request);
  return request;
}

export function extensionPopoutUrl(
  login: string,
  extension: ChannelExtension,
): string {
  const view = extension.type === "overlay" ? "video_overlay" : extension.type;
  return (
    "https://www.twitch.tv/popout/" +
    encodeURIComponent(login) +
    "/extensions/" +
    encodeURIComponent(extension.id) +
    "/" +
    view
  );
}

```

- [ ] **Step 2: Create the companion-window manager**

Create `src/services/extensionWindows.ts`:

```ts
import {
  extensionPopoutUrl,
  type ChannelExtension,
} from "./extensions";

const windows = new Map<string, Window>();

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function screenBounds() {
  const left = Number.isFinite(screen.availLeft) ? screen.availLeft : 0;
  const top = Number.isFinite(screen.availTop) ? screen.availTop : 0;
  return {
    left,
    top,
    right: left + screen.availWidth,
    bottom: top + screen.availHeight,
  };
}

function windowBox(extension: ChannelExtension, rect: DOMRect) {
  const bounds = screenBounds();
  const chrome = Math.max(0, window.outerHeight - window.innerHeight);
  let width: number, height: number, left: number, top: number;
  if (extension.type === "overlay") {
    width = clamp(rect.width * 0.33, 300, 420);
    height = clamp(rect.height, 300, 820);
    left = window.screenX + rect.left;
    top = window.screenY + chrome + rect.top;
  } else if (extension.type === "component") {
    const target = clamp((extension.targetHeight || 7000) / 10000, 0.2, 0.95);
    height = clamp(rect.height * target, 180, 620);
    width = clamp(height * (extension.aspectRatio || 4 / 3), 220, 620);
    left = window.screenX + rect.left + 16;
    top = window.screenY + chrome + rect.top + 16;
  } else {
    width = clamp(rect.width, 320, 520);
    height = clamp(extension.height || 150, 120, 300);
    left = window.screenX + rect.left;
    top = window.screenY + chrome + rect.bottom - height;
  }
  width = Math.round(clamp(width, 240, bounds.right - bounds.left));
  height = Math.round(clamp(height, 160, bounds.bottom - bounds.top));
  left = Math.round(clamp(left, bounds.left, bounds.right - width));
  top = Math.round(clamp(top, bounds.top, bounds.bottom - height));
  return { width, height, left, top };
}

function key(login: string, extension: ChannelExtension) {
  return login + ":" + extension.id;
}

export function openExtensionWindow(
  login: string,
  extension: ChannelExtension,
  anchor: HTMLElement,
): boolean {
  const id = key(login, extension);
  const existing = windows.get(id);
  if (existing && !existing.closed) {
    existing.focus();
    return true;
  }
  const box = windowBox(extension, anchor.getBoundingClientRect());
  const features =
    "popup=yes,width=" +
    box.width +
    ",height=" +
    box.height +
    ",left=" +
    box.left +
    ",top=" +
    box.top +
    ",resizable=yes,scrollbars=no";
  const popup = window.open(
    extensionPopoutUrl(login, extension),
    "tg-ext-" + login + "-" + extension.id,
    features,
  );
  if (!popup) return false;
  try {
    popup.opener = null;
  } catch {
    /* A cross-origin popup may refuse; the Twitch URL itself is trusted. */
  }
  windows.set(id, popup);
  popup.focus();
  return true;
}

export function closeExtensionWindows(login?: string) {
  for (const [id, popup] of windows) {
    if (login && !id.startsWith(login + ":")) continue;
    if (!popup.closed) popup.close();
    windows.delete(id);
  }
}
```

- [ ] **Step 3: Run the TypeScript check**

Run: `pnpm check`
Expected: PASS with no type errors.

- [ ] **Step 4: Review the diff**

Run: `git diff -- src/services/extensions.ts src/services/extensionWindows.ts`
Expected: two focused services. Do not commit unless the user asks.

---

## Task 3: Tile menu shell, list component and styles

> **Implementation note:** the final component adds `referrerPolicy="no-referrer"` to the icon, `data-extension` on each row for focus restoration, name-specific `tr()` labels, and an `aria-hidden` visual count; `tests/i18n.test.cjs` covers the type labels.

**Files:**
- Create: `src/components/ExtensionsMenu.tsx`
- Modify: `src/components/StreamTile.tsx`
- Modify: `src/styles/grid.css`
- Modify: `src/styles/workspace.css`
- Modify: `src/services/translations.ts`

- [ ] **Step 1: Create the extensions list component**

Create `src/components/ExtensionsMenu.tsx`:

```tsx
import type { ChannelExtension, ExtensionType } from "../services/extensions";

function typeKey(type: ExtensionType) {
  return type === "overlay" ? "Overlay" : type === "component" ? "Composant" : "Panneau";
}

export function ExtensionsList({
  extensions,
  onOpen,
  popoutUrl,
}: {
  extensions: ChannelExtension[];
  onOpen: (extension: ChannelExtension) => void;
  popoutUrl: (extension: ChannelExtension) => string;
}) {
  return (
    <>
      {extensions.map((extension) => (
        <div className="extensions-row" key={extension.id}>
          <img src={extension.icon || "favicon.svg"} alt="" loading="lazy" />
          <div>
            <span className="extensions-name" title={extension.description}>
              {extension.name}
            </span>
            <small data-i18n={typeKey(extension.type)}>
              {typeKey(extension.type)}
            </small>
          </div>
          <button type="button" onClick={() => onOpen(extension)} data-i18n="Ouvrir la fenêtre">
            Ouvrir la fenêtre
          </button>
          <a
            href={popoutUrl(extension)}
            target="_blank"
            rel="noopener noreferrer"
            title="Ouvrir sur Twitch ↗"
            data-i18n-title="Ouvrir sur Twitch ↗"
            aria-label="Ouvrir sur Twitch ↗"
            data-i18n-aria-label="Ouvrir sur Twitch ↗"
          >
            Twitch ↗
          </a>
        </div>
      ))}
    </>
  );
}
```

- [ ] **Step 2: Add the details shell to `StreamTile.tsx`**

Insert this block immediately before the existing `<details className="collaboration" hidden>`:

```tsx
          <details className="extensions" hidden>
            <summary
              title="Extensions Twitch"
              data-i18n-title="Extensions Twitch"
              aria-label="Extensions Twitch"
              data-i18n-aria-label="Extensions Twitch"
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.5h1.5a2.5 2.5 0 0 1 0 5H2V19a2 2 0 0 0 2 2h4v-1.5a2.5 2.5 0 0 1 5 0V21h4a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 1 0-5Z" />
              </svg>
              <span className="extensions-count"></span>
            </summary>
            <div className="extensions-menu">
              <span className="extensions-heading" data-i18n="Extensions actives">
                Extensions actives
              </span>
              <div className="extensions-list"></div>
              <p
                className="extensions-note"
                data-i18n="Les extensions Twitch s’ouvrent dans une fenêtre séparée ; Twitch ne permet pas de les intégrer à un autre site."
              >
                Les extensions Twitch s’ouvrent dans une fenêtre séparée ;
                Twitch ne permet pas de les intégrer à un autre site.
              </p>
            </div>
          </details>
```

- [ ] **Step 3: Add the styles**

Append to `src/styles/grid.css` after the collaboration rules:

```css
.extensions {
  flex: none;
}
.extensions summary {
  @apply flex items-center;
  @apply gap-[5px] h-[28px];
  padding: 0 6px;
  @apply rounded-[4px];
  font-size: 12px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  list-style: none;
  @apply cursor-pointer;
  background: #ffffff18;
  transition: background-color 0.2s var(--ease);
}
.extensions summary::-webkit-details-marker {
  @apply hidden;
}
.extensions summary:hover,
.extensions[open] summary {
  background: #ffffff30;
}
.extensions summary span {
  color: var(--fg);
}
.extensions-menu {
  @apply fixed;
  z-index: 20;
  @apply overflow-y-auto p-[8px];
  border: 1px solid var(--line);
  @apply rounded-[8px];
  background: var(--panel);
  color: var(--fg);
  box-shadow: 0 12px 32px #181818a6;
  @apply cursor-default;
  animation: menu-in 0.3s var(--ease);
}
.extensions-heading {
  @apply block;
  padding: 4px 4px 8px;
  color: var(--dim);
  font-size: 12px;
  line-height: 16px;
  @apply font-semibold;
}
.extensions-row {
  @apply flex items-center;
  @apply gap-[8px];
  padding: 6px 4px;
  @apply rounded-[6px];
  transition: background-color 0.2s var(--ease);
}
.extensions-row:hover {
  background: #ffffff0a;
}
.extensions-row img {
  flex: none;
  @apply w-[28px] h-[28px];
  @apply rounded-[6px] object-cover;
}
.extensions-row > div {
  flex: 1;
  min-width: 0;
}
.extensions-name {
  @apply block overflow-hidden;
  @apply text-ellipsis whitespace-nowrap;
  color: var(--fg);
  font-size: 12px;
  line-height: 16px;
  @apply font-semibold;
}
.extensions-row small {
  @apply block overflow-hidden;
  @apply text-ellipsis whitespace-nowrap;
  color: var(--dim);
  font-size: 12px;
  line-height: 16px;
}
.tile .extensions-row button {
  flex: none;
  @apply h-[28px] rounded-[4px];
  padding: 0 8px;
  background: #9147ff40;
  color: var(--fg);
  font-size: 12px;
  @apply font-semibold;
  transition:
    background-color 0.2s var(--ease),
    transform 0.2s var(--ease);
}
.tile .extensions-row button:hover:not(:disabled) {
  background: var(--accent);
}
.tile .extensions-row button:active:not(:disabled) {
  transform: scale(0.98);
}
.tile .extensions-row a {
  flex: none;
  color: var(--dim);
  font-size: 12px;
  text-decoration: none;
}
.tile .extensions-row a:hover {
  color: var(--fg);
}
.extensions-note {
  padding: 8px 4px 4px;
  margin-top: 6px;
  border-top: 1px solid var(--line);
  color: var(--dim);
  font-size: 11px;
  line-height: 15px;
}
```

- [ ] **Step 4: Add the light-theme overrides**

In `src/styles/workspace.css`, add `.extensions summary` to the existing light background selector and `.extensions-row:hover` to the existing hover selector, and `.extensions-menu` to the shadow selector:

```css
[data-theme="light"] .chat-options summary:hover,
[data-theme="light"] .chat-options[open] summary,
[data-theme="light"] .collaboration summary,
[data-theme="light"] .extensions summary {
  background: #7734d81a;
}
```

```css
[data-theme="light"] .collaboration-row:hover,
[data-theme="light"] .extensions-row:hover,
[data-theme="light"] .chat-menu a:hover {
  background: #7734d80f;
}
```

```css
[data-theme="light"] .chat-menu,
[data-theme="light"] .collaboration-menu,
[data-theme="light"] .extensions-menu,
[data-theme="light"] .grid-menu {
  box-shadow: 0 12px 32px #20202726;
}
```

- [ ] **Step 5: Add the translations**

Add these entries to `src/services/translations.ts`:

```ts
  "Extensions Twitch": ["Twitch extensions", "Twitch-extensies"],
  "Extensions actives": ["Active extensions", "Actieve extensies"],
  "Ouvrir la fenêtre": ["Open window", "Venster openen"],
  Overlay: ["Overlay", "Overlay"],
  Composant: ["Component", "Component"],
  Panneau: ["Panel", "Paneel"],
  "Les extensions Twitch s’ouvrent dans une fenêtre séparée ; Twitch ne permet pas de les intégrer à un autre site.":
    [
      "Twitch extensions open in a separate window; Twitch does not allow embedding them on another site.",
      "Twitch-extensies openen in een apart venster; Twitch staat niet toe ze op een andere site in te sluiten.",
    ],
  "Autorise les fenêtres pop-up pour ouvrir les extensions Twitch.": [
    "Allow pop-up windows to open Twitch extensions.",
    "Sta pop-upvensters toe om Twitch-extensies te openen.",
  ],
```

- [ ] **Step 6: Run the checks and translation test**

Run: `pnpm check && pnpm test:server`
Expected: PASS. The i18n test finds translations for every new `data-i18n` key.

- [ ] **Step 7: Review the diff**

Run: `git diff -- src/components/ExtensionsMenu.tsx src/components/StreamTile.tsx src/styles/grid.css src/styles/workspace.css src/services/translations.ts`
Expected: the shell is hidden by default; no controller wiring yet. Do not commit unless the user asks.

---

## Task 4: Controller wiring

> **Implementation note:** the final controller also retries a failed lookup after 60 seconds (and refreshes a successful list after five minutes), preserves focus across re-renders and after opening a window, includes `.extensions`, `.chat-menu` and `.collaboration-menu` in the drag exclusion, and repositions the menu from `layout()`.

**Files:**
- Modify: `src/types/player.ts`
- Modify: `src/controllers/workspace.tsx`

- [ ] **Step 1: Add the tile fields**

In `src/types/player.ts`, add the import and fields:

```ts
import type { ChannelExtension } from "../services/extensions";
```

```ts
  extensions: HTMLDetailsElement;
  extensionsList: ChannelExtension[];
  extensionsCheckedAt?: number;
  extensionsLoading?: boolean;
```

- [ ] **Step 2: Add the imports**

At the top of `src/controllers/workspace.tsx`:

```ts
import { ExtensionsList } from "../components/ExtensionsMenu";
import {
  channelExtensions,
  extensionPopoutUrl,
  type ChannelExtension,
} from "../services/extensions";
import {
  closeExtensionWindows,
  openExtensionWindow,
} from "../services/extensionWindows";
```

- [ ] **Step 3: Extend the menu close selectors**

In `closeTileMenus`, add `.extensions[open]` to the selector and `.extensions` to the pointerdown exception:

```ts
      ".chat-options[open], .collaboration[open], .extensions[open], .custom-quality[open], #grid-switcher[open], #list-order-menu[open]",
```

```ts
        ".chat-options, .collaboration, .extensions, .custom-quality, #grid-switcher, #list-order-menu",
```

- [ ] **Step 4: Add the menu positioning, setup, render and refresh functions**

Place these functions next to the collaboration functions (after `positionCollaborationMenu` and before `updateCollaborationButtons`):

```ts
  function positionExtensionsMenu(t: Tile) {
    const anchor = t.extensions
      .querySelector<HTMLElement>("summary")!
      .getBoundingClientRect();
    const menu = t.extensions.querySelector<HTMLElement>(".extensions-menu")!;
    const width = Math.min(360, innerWidth - 24);
    const below = innerHeight - anchor.bottom - 18;
    const above = below < 220 && anchor.top > below;
    const height = Math.max(0, Math.min(460, above ? anchor.top - 18 : below));
    menu.style.width = width + "px";
    menu.style.left =
      Math.max(12, Math.min(anchor.right - width, innerWidth - width - 12)) +
      "px";
    menu.style.maxHeight = height + "px";
    menu.style.top = above ? "auto" : anchor.bottom + 6 + "px";
    menu.style.bottom = above ? innerHeight - anchor.top + 6 + "px" : "auto";
  }

  function setupExtensions(t: Tile) {
    const menu = t.extensions;
    translateTree(menu);
    menu.onclick = (e) => e.stopPropagation();
    menu.ondragstart = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    menu.ontoggle = () => {
      if (menu.open) {
        closeTileMenus(false, menu);
        positionExtensionsMenu(t);
      }
    };
  }

  function renderExtensions(t: Tile, list: ChannelExtension[]) {
    t.extensionsList = list;
    const available = list.length > 0 && t.channel.online !== false;
    t.extensions.hidden = !available;
    if (!available) t.extensions.open = false;
    t.extensions.querySelector<HTMLElement>(".extensions-count")!.textContent =
      String(list.length);
    const rows = t.extensions.querySelector<HTMLElement>(".extensions-list")!;
    views.render(
      rows,
      <ExtensionsList
        extensions={list}
        popoutUrl={(extension) =>
          extensionPopoutUrl(t.el.dataset.login!, extension)
        }
        onOpen={(extension) => {
          if (
            openExtensionWindow(
              t.el.dataset.login!,
              extension,
              t.el.querySelector<HTMLElement>(".player")!,
            )
          ) {
            t.extensions.open = false;
          } else {
            notice(
              tr(
                "Autorise les fenêtres pop-up pour ouvrir les extensions Twitch.",
              ),
            );
          }
        }}
      />,
    );
    translateTree(rows);
  }

  async function refreshExtensions(t: Tile) {
    const login = t.el.dataset.login!;
    if (t.channel.online === false || t.extensionsLoading) return;
    if (
      t.extensionsCheckedAt &&
      Date.now() - t.extensionsCheckedAt < 60000
    )
      return;
    t.extensionsLoading = true;
    try {
      const list = await channelExtensions(login);
      if (tiles.get(login) === t) renderExtensions(t, list);
    } catch {
      if (tiles.get(login) === t) renderExtensions(t, []);
    } finally {
      if (tiles.get(login) === t) {
        t.extensionsLoading = false;
        t.extensionsCheckedAt = Date.now();
      }
    }
  }
```

- [ ] **Step 5: Create the tile fields and start discovery in `add()`**

In the `const t: Tile = { ... }` literal, add:

```ts
      extensions: el.querySelector<HTMLDetailsElement>(".extensions")!,
      extensionsList: [],
```

After `setupChatResize(t, save);`, add:

```ts
    setupExtensions(t);
    void refreshExtensions(t);
```

- [ ] **Step 6: Refresh or hide on live-status changes**

In `updateTileInfo`, capture the previous status before assigning `t.channel`:

```ts
  function updateTileInfo(t: Tile, s: Channel) {
    const hadPoster = t.channel && showPoster(t);
    const wasOnline = t.channel.online;
    t.channel = s;
```

After the collaboration block (`renderCollaboration(...)`), add:

```ts
    if (s.online === false) {
      renderExtensions(t, []);
      closeExtensionWindows(s.twitch);
    } else if (wasOnline === false && s.online === true) {
      t.extensionsCheckedAt = 0;
      void refreshExtensions(t);
    }
```

- [ ] **Step 7: Close windows and remove the portal on tile removal**

At the start of `remove`, after the guard, add:

```ts
    closeExtensionWindows(login);
```

Before `views.remove(tile.el)`, add:

```ts
    views.remove(
      tile.extensions.querySelector<HTMLElement>(".extensions-list")!,
    );
```

- [ ] **Step 8: Close windows when switching layouts and on cleanup**

At the start of `switchLayout`, before `saveCurrentLayout()`, add:

```ts
    closeExtensionWindows();
```

In the returned cleanup function, after `clearTiles()`, add:

```ts
    closeExtensionWindows();
```

Also close the companion windows when the page is left or restored from the back/forward cache. Add this next to the existing `listenDocument("visibilitychange", ...)` block:

```ts
  lifecycle.addEventListener("pagehide", () => closeExtensionWindows());
```

- [ ] **Step 9: Run the TypeScript check**

Run: `pnpm check`
Expected: PASS with no type errors.

- [ ] **Step 10: Review the diff**

Run: `git diff -- src/types/player.ts src/controllers/workspace.tsx src/components/ExtensionsMenu.tsx`
Expected: discovery starts with each tile, the menu is hidden when empty or offline, windows close with the tile. Do not commit unless the user asks.

---

## Task 5: Browser test for the extension menu

> **Implementation note:** the final suite has six tests prefixed `extensions: ` (happy path, no extensions, 60-second retry, drag guard, blocked popup, tile removal). The focused command is `pnpm exec playwright test tests/grid.spec.js -g "extensions:"`.

**Files:**
- Modify: `tests/grid.spec.js`

- [ ] **Step 1: Add a default extensions mock to the test setup**

Change the `setup` signature to accept a fourth argument and register the route:

```js
async function setup(page, connected = false, landing = false, extensions = []) {
```

After the `/api/search` route, add:

```js
  await page.route('**/api/extensions?**', route =>
    route.fulfill({ json: { channel: 'test', extensions } }),
  );
```

- [ ] **Step 2: Add the extension fixture and the menu test**

Append to `tests/grid.spec.js`:

```js
const extensionFixture = {
  id: 'k6ji189bf7i4ge8il4iczzw7kpgmjt',
  name: '7 Days to Die Integration',
  description: 'Viewers interact with the live game.',
  icon: 'https://cdn.example/7dtd.png',
  version: '3.4.1',
  type: 'overlay',
  slot: 'extension-overlay-1',
  viewerUrl: 'https://k6ji.ext-twitch.tv/video_overlay.html',
  height: null,
  targetHeight: null,
  aspectRatio: null,
};

test('a live tile lists its Twitch extensions and opens the official popout window', async ({ page }) => {
  const errors = await setup(page, false, false, [extensionFixture]);
  await page.addInitScript(() => {
    window.__openedExtensions = [];
    window.open = (url, name, features) => {
      window.__openedExtensions.push({ url, name, features });
      return { closed: false, focus() {}, close() {} };
    };
  });
  await page.goto('/');
  await favorite(page, 'tiranumisu');
  await page.locator('[data-login="tiranumisu"] .channel').click();
  await expect(page.locator('#grid [data-login="tiranumisu"] .extensions')).toBeVisible();
  await page.locator('#grid [data-login="tiranumisu"] .extensions summary').click();
  await expect(page.locator('.extensions-menu .extensions-name')).toHaveText('7 Days to Die Integration');
  await expect(page.locator('.extensions-menu small')).toHaveText('Overlay');
  await page.locator('.extensions-menu button').click();
  const opened = await page.evaluate(() => window.__openedExtensions);
  expect(opened).toHaveLength(1);
  expect(opened[0].url).toBe('https://www.twitch.tv/popout/tiranumisu/extensions/k6ji189bf7i4ge8il4iczzw7kpgmjt/video_overlay');
  expect(opened[0].features).toContain('width=');
  expect(opened[0].features).toContain('height=');
  expect(errors).toEqual([]);
});
```

- [ ] **Step 3: Run the browser test**

Run: `pnpm test -- tests/grid.spec.js -g "extensions:"`
Expected: PASS. The tile shows the puzzle button, the menu lists the extension, and `window.open` receives the popout URL.

- [ ] **Step 4: Run the full browser suite**

Run: `pnpm test`
Expected: PASS. Existing tests are unaffected because the default mock returns an empty extension list.

- [ ] **Step 5: Review the diff**

Run: `git diff -- tests/grid.spec.js`
Expected: one default mock and one focused test. Do not commit unless the user asks.

---

## Task 6: Documentation and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the feature and the limitation**

Add a section after “Chat” and before “Status, previews, and collaborations”:

```markdown
## Twitch extensions

Tiles whose live channel has active Twitch extensions show a puzzle button in
their header. The menu lists the active overlay, component and panel
extensions, and opens each one on Twitch's official popout page in a companion
window sized to the tile.

Twitch does not allow its extension iframes to run on another site: the
supervisor and extension responses restrict `frame-ancestors` to Twitch
domains, the popout pages send `X-Frame-Options: SAMEORIGIN`, and the official
embeds do not load extensions. The companion window is therefore the supported
path, not a workaround that can be replaced by an iframe. Browsers control the
window chrome and may block pop-ups until the viewer allows them.

`GET /api/extensions?channel=…` discovers the active installations through
Twitch's public GraphQL endpoint. It returns only public metadata (name, icon,
type, size and viewer URL), never the extension tokens. Results are cached for
five minutes per channel, concurrent requests are shared, and each client
address is limited per minute. The endpoint needs no additional environment
variables.
```

- [ ] **Step 2: Run the full verification**

Run:

```sh
pnpm check
pnpm test:server
pnpm test
pnpm build
```

Expected: all commands pass. `pnpm build` produces `dist` without errors.

- [ ] **Step 3: Review the complete diff and stop for approval**

Run: `git status --short && git diff --stat`
Expected: only the files listed in this plan. Do not commit, push or merge; wait for the user's approval.

---

## Self-review checklist

- [ ] Every active extension type (overlay, component, panel) is mapped and has a popout URL.
- [ ] Inactive installations and extensions without a matching view are filtered.
- [ ] The server never returns extension JWTs or helix tokens.
- [ ] The client validates the response shape and falls back to an empty list.
- [ ] A channel with no extensions hides the puzzle button.
- [ ] An offline tile hides the button and closes its windows.
- [ ] Removing a tile closes its windows and removes its React portal.
- [ ] Switching account mode or disposing the workspace closes every window.
- [ ] Pop-up blocking shows a translated notice.
- [ ] The menu closes with the other tile menus and is positioned above or below the header.
- [ ] FR, EN and NL strings exist for every new `data-i18n` key.
- [ ] `pnpm check`, `pnpm test:server`, `pnpm test` and `pnpm build` pass.
