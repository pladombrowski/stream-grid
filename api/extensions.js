// Twitch extensions cannot be embedded outside twitch.tv (CSP frame-ancestors).
// This endpoint only discovers the public metadata needed to offer the official popout page.
const cache = new Map(), pending = new Map(), clients = new Map();
const ttl = 300000; // extensions change rarely; five minutes keeps GraphQL traffic low
const clientId = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // public web client, already used by api/stream.js
const clientsLimit = 1000, requestsPerMinute = 300, cacheLimit = 200, pendingLimit = 500;

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
  const key = 'channel:' + login;
  // cached channels are served before the limiter: reloads and large grids must not spend the upstream budget
  if (cache.get(key)?.expiresAt > now) return res.status(200).json(cache.get(key).data);
  // Caddy owns X-Forwarded-For; X-Real-IP passes through untouched and would let a client rotate identities
  const ip = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
  for (const [client, entry] of clients) if (entry.until <= now) clients.delete(client);
  const entry = clients.get(ip) || { count: 0, until: now + 60000 };
  if (entry.count >= requestsPerMinute) {
    res.setHeader('Retry-After', '60');
    return fail(429, 'EXTENSIONS_BUSY');
  }
  if (!clients.has(ip) && clients.size >= clientsLimit) clients.delete(clients.keys().next().value);
  entry.count++;
  clients.set(ip, entry);
  try {
    if (!pending.has(key)) {
      if (pending.size >= pendingLimit) {
        res.setHeader('Retry-After', '10');
        return fail(429, 'EXTENSIONS_BUSY');
      }
      pending.set(key, lookup(login).finally(() => pending.delete(key)));
    }
    const data = await pending.get(key);
    if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
    cache.set(key, { data, expiresAt: Date.now() + ttl });
    return res.status(200).json(data);
  } catch {
    return fail(502, 'EXTENSIONS_UNAVAILABLE');
  }
};

const query = `query ChannelExtensionsByLogin($login: String!) {
  user(login: $login) {
    channel {
      selfInstalledExtensions {
        installation {
          extension {
            clientID
            name
            description
            version
            iconURLs { square24 square100 }
            views {
              panel { viewerURL height }
              component { viewerURL targetHeight aspectRatioX aspectRatioY }
              videoOverlay { viewerURL }
            }
          }
          activationConfig { anchor slot state }
        }
      }
    }
  }
}`;

const anchors = new Map([['VIDEO_OVERLAY', 'overlay'], ['COMPONENT', 'component'], ['PANEL', 'panel']]);

function mapExtensions(login, payload) {
  const edges = payload?.data?.user?.channel?.selfInstalledExtensions;
  if (!Array.isArray(edges)) return { channel: login, extensions: [] };
  const byId = new Map();
  for (const edge of edges) {
    const installation = edge?.installation;
    const extension = installation?.extension;
    const activation = installation?.activationConfig;
    const type = anchors.get(activation?.anchor);
    if (!extension?.clientID || !type || activation?.state !== 'ACTIVE') continue;
    const view = type === 'overlay' ? extension.views?.videoOverlay
      : type === 'component' ? extension.views?.component
      : extension.views?.panel;
    if (!view?.viewerURL) continue;
    const icon = extension.iconURLs?.square100 || extension.iconURLs?.square24 || '';
    byId.set(extension.clientID, {
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
  return { channel: login, extensions: [...byId.values()] };
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
