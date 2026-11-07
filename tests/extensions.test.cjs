const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const originalFetch = global.fetch;
let handler;
beforeEach(() => {
  delete require.cache[require.resolve('../api/extensions.js')];
  handler = require('../api/extensions.js');
});
afterEach(() => { global.fetch = originalFetch; });

function request(url = '/api/extensions?channel=example', method = 'GET', ip = 'test-extensions', headers = {}) {
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

test('rejects invalid channels and methods before contacting Twitch', async () => {
  global.fetch = () => { throw new Error('Unexpected request'); };
  const traversal = await request('/api/extensions?channel=../private');
  assert.equal(traversal.statusCode, 400);
  assert.deepEqual(traversal.body, { error: 'INVALID_CHANNEL' });
  const empty = await request('/api/extensions?channel=');
  assert.equal(empty.statusCode, 400);
  assert.deepEqual(empty.body, { error: 'INVALID_CHANNEL' });
  const post = await request('/api/extensions?channel=example', 'POST');
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.deepEqual(post.body, { error: 'METHOD_NOT_ALLOWED' });
});

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
  assert.deepEqual(Object.keys(res.body.extensions[0]).sort(), [
    'aspectRatio', 'description', 'height', 'icon', 'id', 'name',
    'slot', 'targetHeight', 'type', 'version', 'viewerUrl',
  ]);
});

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
  const normalized = await request('/api/extensions?channel=%20CacheTest%20', 'GET', 'test-extensions-cache');
  assert.equal(normalized.statusCode, 200);
  assert.equal(normalized.body.channel, 'cachetest');
  assert.equal(calls, 1);
});

test('only cache misses consume the rate limit', async () => {
  global.fetch = async () => Response.json({ data: { user: null } });
  for (let i = 0; i < 300; i++)
    assert.equal((await request(`/api/extensions?channel=channel${i}`, 'GET', 'test-extensions-limit')).statusCode, 200);
  const blocked = await request('/api/extensions?channel=channel300', 'GET', 'test-extensions-limit');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '60');
  assert.deepEqual(blocked.body, { error: 'EXTENSIONS_BUSY' });
  // warm the cache from another client so the repeated reads below cannot spend this client's budget
  assert.equal((await request('/api/extensions?channel=cachetest', 'GET', 'test-extensions-warm')).statusCode, 200);
  for (let i = 0; i < 5; i++)
    assert.equal((await request('/api/extensions?channel=cachetest', 'GET', 'test-extensions-cached')).statusCode, 200);
  for (let i = 0; i < 300; i++)
    assert.equal((await request(`/api/extensions?channel=cached${i}`, 'GET', 'test-extensions-cached')).statusCode, 200);
});

test('rotating X-Real-IP does not bypass the per-client limiter', async () => {
  global.fetch = async () => Response.json({ data: { user: null } });
  for (let i = 0; i < 300; i++) {
    const res = await request(`/api/extensions?channel=spoof${i}`, 'GET', '203.0.113.7', { 'x-real-ip': `198.51.100.${i % 250}` });
    assert.equal(res.statusCode, 200);
  }
  const blocked = await request('/api/extensions?channel=spoof300', 'GET', '203.0.113.7', { 'x-real-ip': '198.51.100.50' });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '60');
  assert.deepEqual(blocked.body, { error: 'EXTENSIONS_BUSY' });
});

test('a full client map evicts the oldest client instead of locking out new ones', async () => {
  global.fetch = async () => Response.json({ data: { user: null } });
  const xff = i => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  for (let i = 0; i < 1000; i++)
    assert.equal((await request(`/api/extensions?channel=ip${i}`, 'GET', xff(i))).statusCode, 200);
  assert.equal((await request('/api/extensions?channel=ip1000', 'GET', xff(1000))).statusCode, 200);
  assert.equal((await request('/api/extensions?channel=recent', 'GET', xff(999))).statusCode, 200);
});

test('bounds concurrent upstream fetches', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  global.fetch = async () => { await gate; return Response.json({ data: { user: null } }); };
  const xff = i => `172.16.${(i >> 8) & 255}.${i & 255}`;
  const inflight = [];
  for (let i = 0; i < 500; i++) inflight.push(request(`/api/extensions?channel=pending${i}`, 'GET', xff(i)));
  const blocked = await request('/api/extensions?channel=pending500', 'GET', '172.16.255.255');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '10');
  assert.deepEqual(blocked.body, { error: 'EXTENSIONS_BUSY' });
  release();
  const finished = await Promise.all(inflight);
  assert.equal(finished.filter(res => res.statusCode === 200).length, 500);
});

test('an unknown channel returns an empty list', async () => {
  global.fetch = async () => Response.json({ data: { user: null } });
  const res = await request('/api/extensions?channel=nobody', 'GET', 'test-extensions-unknown');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { channel: 'nobody', extensions: [] });
});

test('upstream failures become a recoverable error without leaking details', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return Response.json({ errors: [{ message: 'private detail' }] });
  };
  const failed = await request('/api/extensions?channel=example', 'GET', 'test-extensions-failure');
  assert.equal(failed.statusCode, 502);
  assert.deepEqual(failed.body, { error: 'EXTENSIONS_UNAVAILABLE' });
  global.fetch = async () => {
    calls++;
    return Response.json(fixture);
  };
  const recovered = await request('/api/extensions?channel=example', 'GET', 'test-extensions-failure');
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.body.extensions.length, 3);
  assert.equal(calls, 2);
});
