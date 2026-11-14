# Twitch Login + Stream Grid Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve Stream Grid at `https://twitchso.com/grid/` with Twitch login using the existing Twitch SO Bot application, without changing the bot's registered OAuth callback or breaking `twitch-so-bot`.

**Architecture:** The FastAPI bot stays at the domain root and remains the only holder of the Twitch client secret. A new `/grid/auth/start` route runs the authorization-code flow with the existing `https://twitchso.com/auth/callback`, requests only `user:read:follows`, and returns the user token to the static Stream Grid SPA in the URL fragment. Stream Grid is built with Vite base `/grid/`, served by FastAPI `StaticFiles`, and its `/api/*` calls are proxied to a loopback-only Node process on port 8766. The bot's own OAuth state and database flow are untouched.

**Tech Stack:** FastAPI, aiohttp, Starlette sessions, Python 3.12, React 19, strict TypeScript, Vite 8, Node.js 18 on the server, systemd, Cloudflare, Oracle Cloud Ubuntu 24.04.

---

## Decisions Locked Before Execution

| Topic | Decision |
| --- | --- |
| Twitch application | Reuse the bot's existing confidential app; no new app and no Twitch Console change |
| OAuth flow | Authorization code with the existing registered callback `/auth/callback` |
| Grid scope | `user:read:follows` only |
| Bot OAuth | Untouched; callback branches to grid only when the session contains `grid_oauth` |
| Grid URL | `https://twitchso.com/grid/` |
| Grid API | `https://twitchso.com/api/*` proxied to `127.0.0.1:8766` |
| Search credentials | Reuse `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` as fallback for `TWITCH_SEARCH_*` |
| `.env` changes | Add only `GRID_API_URL=http://127.0.0.1:8766`; existing bot values stay identical |
| Build | Local Node 26 + pnpm; server runs only the built static files and Node 18 API |
| Secrets | Never committed; `public/config.json` gets only the public client ID |
| Commits and push | User explicitly requested commit + push after verification |

**Out of scope:** Creating a second Twitch app, changing DNS, moving the bot off the root path, rewriting the bot OAuth flow, or changing the PostgreSQL schema.

---

## File Structure

### `stream-grid` repository

| File | Responsibility |
| --- | --- |
| `public/config.json` | Public client ID and the grid auth endpoint |
| `src/services/library.ts` | Start login through the backend bridge when `twitchAuthUrl` is configured |
| `src/controllers/workspace.tsx` | Load `config.json` from the Vite base and pass `twitchAuthUrl` |
| `src/types/domain.ts` | Type for the public site configuration |
| `vite.config.mts` | Optional `VITE_BASE` so the same source builds for `/` or `/grid/` |
| `package.json` | `build:grid` script |
| `index.html` | Canonical, Open Graph, and Twitter URLs for `/grid/` |
| `README.md` | Document the integrated login and deployment |
| `.gitignore` | Ignore `.idea/` |
| `docs/plans/2026-11-13-twitch-login-integration.md` | This plan |

### `twitch-so-bot-site` repository

| File | Responsibility |
| --- | --- |
| `backend/routers/grid_oauth.py` | `/grid/auth/start` and the grid callback helper |
| `backend/routers/grid_api.py` | `/api/search`, `/api/stream`, `/api/extensions`, `/api/youtube` proxy to Node |
| `backend/routers/twitch_oauth.py` | Branch to the grid callback before the bot flow; clear grid state on bot login |
| `backend/main.py` | Register the grid routes and mount the built SPA at `/grid` |
| `backend/config.py` | `grid_api_url` setting |
| `api/search.js` | Fallback from `TWITCH_SEARCH_*` to the bot's `TWITCH_CLIENT_*` |
| `.env.example` | Document `GRID_API_URL` |
| `.gitignore` | Ignore generated `grid/` build output |
| `README.md` | Operator notes for the `/grid` deployment |
| `GUIA_POS_DEPLOY.md` | Server steps for the Node API service and static files |

### Server layout

| Path | Content |
| --- | --- |
| `/home/ubuntu/twitch-so-bot-site/` | Existing FastAPI app and `.venv` |
| `/home/ubuntu/twitch-so-bot-site/grid/` | Built `stream-grid/dist` files |
| `/home/ubuntu/stream-grid-api/` | `production.cjs` and `api/` from `stream-grid` |
| `/etc/systemd/system/stream-grid-api.service` | Loopback Node API service |

---

## Task 1: Preflight and backups

**Files:** none (server backups only).

- [ ] **Step 1: Confirm both checkouts are clean enough to work**

Run:
```bash
git -C /mnt/Dev/JS/stream-grid status --short
git -C /mnt/Dev/PYTHON/Twitch-So-Bot/twitch-so-bot-site status --short
```

Expected: stream-grid shows only `?? .idea/` and the plan file; the bot repo is clean. If tracked files are modified, inspect them before continuing.

- [ ] **Step 2: Record the current production state**

Run:
```bash
ssh -i ~/.ssh/nova_chave_oracle ubuntu@163.176.129.143 \
  'systemctl is-active twitch-so-bot.service; curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5000/auth/login'
```

Expected: `active` and `200`.

- [ ] **Step 3: Back up the bot code and environment**

Run:
```bash
ssh -i ~/.ssh/nova_chave_oracle ubuntu@163.176.129.143 '
  set -e
  mkdir -p /home/ubuntu/backups
  tar -czf /home/ubuntu/backups/twitch-so-bot-site-20261113.tar.gz \
    --exclude=.venv --exclude=__pycache__ --exclude=grid \
    -C /home/ubuntu twitch-so-bot-site
  cp -a /home/ubuntu/twitch-so-bot-site/backend/.env \
    /home/ubuntu/backups/twitch-so-bot-backend.env.20261113
  chmod 600 /home/ubuntu/backups/twitch-so-bot-backend.env.20261113
  ls -lh /home/ubuntu/backups/twitch-so-bot-site-20261113.tar.gz
'
```

Expected: a non-empty tarball. Keep it until verification passes.

---

## Task 2: Stream Grid auth client

**Files:**
- Modify: `src/services/library.ts:63-133`
- Modify: `src/controllers/workspace.tsx:3692-3708`
- Modify: `src/types/domain.ts`
- Modify: `public/config.json`

- [ ] **Step 1: Add the public site configuration type**

In `src/types/domain.ts`, after `TwitchSession`, add:

```ts
export interface SiteConfig {
  twitchClientId?: string;
  twitchAuthUrl?: string;
}
```

- [ ] **Step 2: Teach `TwitchLibrary` about the backend auth endpoint**

Replace the class fields and constructor in `src/services/library.ts` with:

```ts
class TwitchLibrary {
  clientId: string;
  authUrl: string;
  token: string;
  user: TwitchSession | null;
  profiles: Map<string, Channel>;
  generation: number;
  constructor(clientId: string, authUrl = "") {
    this.clientId = clientId;
    this.authUrl = authUrl;
    this.token = "";
    this.user = null;
    this.profiles = new Map();
    this.generation = 0;
  }
```

- [ ] **Step 3: Start login through the bridge when configured**

Replace the beginning of `connect()` in `src/services/library.ts` with:

```ts
  async connect() {
    const state = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (!writeStored("tg.oauth", { state, at: Date.now() }, sessionStorage))
      throw new Error(
        tr(
          "Autorise le stockage de session dans ton navigateur pour connecter Twitch.",
        ),
      );
    if (this.authUrl) {
      const target = new URL(this.authUrl, location.origin);
      target.searchParams.set("state", state);
      location.assign(target.toString());
      return;
    }
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "token",
      redirect_uri: location.origin,
      scope: "user:read:follows",
      state,
    });
    location.assign("https://id.twitch.tv/oauth2/authorize?" + params);
  }
```

- [ ] **Step 4: Load the config from the Vite base and pass the auth URL**

In `src/controllers/workspace.tsx`, change the config fetch and constructor:

```ts
      const response = await fetch(`${import.meta.env.BASE_URL}config.json`, {
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      });
```

and:

```ts
    library = new TwitchLibrary(
      config?.twitchClientId || "",
      config?.twitchAuthUrl || "",
    );
```

- [ ] **Step 5: Write the production public config**

Run this on the workstation, replacing the client ID with the value from the server `.env` without printing the secret:

```bash
CID=$(cat /tmp/opencode/twitch_client_id)
printf '{"twitchClientId":"%s","twitchAuthUrl":"/grid/auth/start"}\n' "$CID" \
  > /mnt/Dev/JS/stream-grid/public/config.json
```

Expected: `public/config.json` contains the public client ID and `/grid/auth/start`.

---

## Task 3: Stream Grid base path, build, and metadata

**Files:**
- Modify: `vite.config.mts`
- Modify: `package.json`
- Modify: `index.html`
- Modify: `.gitignore`

- [ ] **Step 1: Make the Vite base configurable**

Add `base` to the returned config in `vite.config.mts`:

```ts
  return {
    base: process.env.VITE_BASE || "/",
    plugins: [
```

Expected: the default build stays at `/`; `VITE_BASE=/grid/` builds for the subpath.

- [ ] **Step 2: Add the subpath build script**

In `package.json`, add after `"build"`:

```json
    "build:grid": "pnpm check && VITE_BASE=/grid/ vite build",
```

- [ ] **Step 3: Update canonical and social URLs**

In `index.html`, replace the `stream-grid.caelmai.com` URLs with:

```html
<link rel="canonical" href="https://twitchso.com/grid/">
```

and use `https://twitchso.com/grid/` for `og:url`, and `https://twitchso.com/grid/assets/share-card.png` for both share images.

- [ ] **Step 4: Ignore the IDE directory**

Append to `.gitignore`:

```text
.idea/
```

- [ ] **Step 5: Build for the subpath**

Run:
```bash
cd /mnt/Dev/JS/stream-grid
VITE_BASE=/grid/ pnpm build
```

Expected: `dist/index.html` references `/grid/assets/...` and `/grid/favicon.svg`, and `dist/config.json` exists.

---

## Task 4: Bot OAuth bridge

**Files:**
- Create: `backend/routers/grid_oauth.py`
- Modify: `backend/routers/twitch_oauth.py`
- Modify: `backend/main.py`

- [ ] **Step 1: Create the grid OAuth router**

Create `backend/routers/grid_oauth.py` with:

```python
"""Authorization-code bridge for Stream Grid's Twitch login."""
import logging
import secrets
import time
from urllib.parse import urlencode

import aiohttp
from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse

from config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter()
settings = get_settings()

GRID_SCOPE = "user:read:follows"
STATE_TTL = 600


def _redirect_uri() -> str:
    return (
        settings.twitch_redirect_uri
        or f"{settings.base_url.rstrip('/')}/auth/callback"
    ).strip()


def _grid_url() -> str:
    return f"{settings.base_url.rstrip('/')}/grid/"


def _error_redirect(code: str, client_state: str) -> RedirectResponse:
    fragment = urlencode({"error": code, "state": client_state})
    return RedirectResponse(url=f"{_grid_url()}#{fragment}", status_code=303)


@router.get("/start")
async def grid_login(request: Request, state: str | None = None):
    """Start Twitch login for Stream Grid using the site's existing app."""
    client_state = (state or "").strip()
    if not client_state or len(client_state) > 256:
        return _error_redirect("invalid_state", "")
    server_state = secrets.token_urlsafe(24)
    request.session.pop("twitch_oauth_state", None)
    request.session["grid_oauth"] = {
        "state": server_state,
        "client_state": client_state,
        "at": time.time(),
    }
    params = {
        "client_id": settings.twitch_client_id,
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "scope": GRID_SCOPE,
        "state": server_state,
    }
    return RedirectResponse(
        url="https://id.twitch.tv/oauth2/authorize?" + urlencode(params),
        status_code=303,
    )
```

- [ ] **Step 2: Add the callback helper**

Append to `backend/routers/grid_oauth.py`:

```python
async def handle_grid_callback(
    request: Request,
    code: str | None,
    state: str | None,
    error: str | None,
) -> RedirectResponse | None:
    """Finish a Stream Grid login, or return None for the bot's own flow."""
    pending = request.session.get("grid_oauth")
    if not pending:
        return None
    request.session.pop("grid_oauth", None)
    client_state = str(pending.get("client_state", ""))
    if error:
        return _error_redirect("access_denied", client_state)
    if (
        not state
        or state != pending.get("state")
        or time.time() - float(pending.get("at", 0)) > STATE_TTL
    ):
        return _error_redirect("invalid_state", client_state)
    if not code:
        return _error_redirect("no_code", client_state)

    timeout = aiohttp.ClientTimeout(total=12)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            "https://id.twitch.tv/oauth2/token",
            data={
                "client_id": settings.twitch_client_id,
                "client_secret": settings.twitch_client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": _redirect_uri(),
            },
            headers={"Accept": "application/json"},
        ) as response:
            if response.status != 200:
                logger.warning(
                    "Stream Grid token exchange failed with status %s",
                    response.status,
                )
                return _error_redirect("token_failed", client_state)
            data = await response.json()

    token = data.get("access_token")
    if not token:
        return _error_redirect("token_failed", client_state)
    scope = data.get("scope")
    fragment = urlencode(
        {
            "access_token": token,
            "state": client_state,
            "token_type": data.get("token_type", "bearer"),
            "scope": " ".join(scope) if isinstance(scope, list) else GRID_SCOPE,
        }
    )
    return RedirectResponse(url=f"{_grid_url()}#{fragment}", status_code=303)
```

- [ ] **Step 3: Branch the existing callback before the bot flow**

In `backend/routers/twitch_oauth.py`, import the helper:

```python
from routers.grid_oauth import handle_grid_callback
```

At the top of `twitch_callback`, before `if error:` and before `user_id = ...`, add:

```python
    grid_response = await handle_grid_callback(request, code, state, error)
    if grid_response is not None:
        return grid_response
```

- [ ] **Step 4: Prevent stale grid state from affecting bot login**

At the start of `twitch_login`, after the `user_id` check, add:

```python
    request.session.pop("grid_oauth", None)
```

- [ ] **Step 5: Register the router before the static mount**

In `backend/main.py`, import and include the router:

```python
from routers import auth, twitch_oauth, dashboard, overlay, grid_oauth
```

and:

```python
    app.include_router(grid_oauth.router, prefix="/grid/auth", tags=["grid"])
```

Place this before any `/grid` static mount.

---

## Task 5: Bot static hosting and API proxy

**Files:**
- Create: `backend/routers/grid_api.py`
- Modify: `backend/main.py`
- Modify: `backend/config.py`
- Modify: `api/search.js`
- Modify: `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Add the grid API setting**

In `backend/config.py`, after `embed_parent`, add:

```python
    # Loopback Node service that serves Stream Grid's /api/* routes
    grid_api_url: str = "http://127.0.0.1:8766"
```

- [ ] **Step 2: Create the API proxy router**

Create `backend/routers/grid_api.py` with:

```python
"""Proxy Stream Grid's four API routes to the loopback Node service."""
import logging

import aiohttp
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter()
settings = get_settings()

ALLOWED = {"search", "stream", "extensions", "youtube"}
PASS_HEADERS = {
    "content-type",
    "cache-control",
    "retry-after",
    "allow",
    "x-content-type-options",
}


@router.get("/{name}")
async def grid_api(name: str, request: Request):
    if name not in ALLOWED:
        return JSONResponse({"error": "NOT_FOUND"}, status_code=404)

    client_ip = (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else "")
    )
    headers = {
        "x-forwarded-for": client_ip,
        "x-real-ip": client_ip,
        "accept": request.headers.get("accept", "*/*"),
    }
    target = f"{settings.grid_api_url.rstrip('/')}/api/{name}"
    if request.url.query:
        target += "?" + request.url.query

    try:
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(target, headers=headers) as upstream:
                body = await upstream.read()
                response_headers = {
                    key: value
                    for key, value in upstream.headers.items()
                    if key.lower() in PASS_HEADERS
                }
                return Response(
                    content=body,
                    status_code=upstream.status,
                    headers=response_headers,
                )
    except (aiohttp.ClientError, TimeoutError):
        logger.warning("Stream Grid API is unavailable", exc_info=True)
        return JSONResponse(
            {"error": "GRID_API_UNAVAILABLE"},
            status_code=503,
        )
```

- [ ] **Step 3: Mount the SPA and register the API router**

In `backend/main.py`, import `grid_api` and add before the static mount:

```python
    app.include_router(grid_api.router, prefix="/api", tags=["grid"])
```

Then, after the existing `/static` mount and after all routers, add:

```python
    grid_dir = BASE_DIR.parent / "grid"
    if grid_dir.exists():
        app.mount("/grid", StaticFiles(directory=str(grid_dir), html=True), name="grid")
```

- [ ] **Step 4: Fall back to the bot's Twitch credentials for search**

In `api/search.js`, add at the top:

```js
const searchClientId = process.env.TWITCH_SEARCH_CLIENT_ID || process.env.TWITCH_CLIENT_ID;
const searchClientSecret = process.env.TWITCH_SEARCH_CLIENT_SECRET || process.env.TWITCH_CLIENT_SECRET;
```

Replace the two `process.env.TWITCH_SEARCH_CLIENT_ID`/`SECRET` uses in the token request and the `Client-Id` header with `searchClientId`/`searchClientSecret`, and replace the availability check with:

```js
  if (!searchClientId || !searchClientSecret) return res.status(503).json({ error: 'SEARCH_UNAVAILABLE' });
```

- [ ] **Step 5: Document the new environment variable**

Add to `.env.example`:

```env
# Stream Grid (static SPA at /grid); Node API bound to loopback
GRID_API_URL=http://127.0.0.1:8766
```

Add to `.gitignore`:

```text
grid/
```

- [ ] **Step 6: Run the local syntax checks**

Run:
```bash
cd /mnt/Dev/PYTHON/Twitch-So-Bot/twitch-so-bot-site
.venv/bin/python -m compileall -q backend
cd /mnt/Dev/JS/stream-grid
pnpm check
```

Expected: no errors.

---

## Task 6: Deploy to the Oracle server

**Files:** server-only changes; no secrets in the repository.

- [ ] **Step 1: Upload the built SPA**

Run:
```bash
cd /mnt/Dev/JS/stream-grid
tar -czf /tmp/opencode/stream-grid-dist.tar.gz -C dist .
ssh -i ~/.ssh/nova_chave_oracle ubuntu@163.176.129.143 '
  set -e
  rm -rf /home/ubuntu/twitch-so-bot-site/grid
  mkdir -p /home/ubuntu/twitch-so-bot-site/grid
  tar -xzf - -C /home/ubuntu/twitch-so-bot-site/grid
' < /tmp/opencode/stream-grid-dist.tar.gz
```

Expected: `/home/ubuntu/twitch-so-bot-site/grid/index.html` exists.

- [ ] **Step 2: Upload the Node API**

Run:
```bash
cd /mnt/Dev/JS/stream-grid
tar -czf /tmp/opencode/stream-grid-api.tar.gz production.cjs api
ssh -i ~/.ssh/nova_chave_oracle ubuntu@163.176.129.143 '
  set -e
  rm -rf /home/ubuntu/stream-grid-api
  mkdir -p /home/ubuntu/stream-grid-api
  tar -xzf - -C /home/ubuntu/stream-grid-api
' < /tmp/opencode/stream-grid-api.tar.gz
```

- [ ] **Step 3: Deploy the Python changes**

Run:
```bash
cd /mnt/Dev/PYTHON/Twitch-So-Bot/twitch-so-bot-site
tar -czf /tmp/opencode/twitch-so-bot-code.tar.gz \
  backend/main.py backend/config.py backend/routers
ssh -i ~/.ssh/nova_chave_oracle ubuntu@163.176.129.143 '
  set -e
  tar -xzf - -C /home/ubuntu/twitch-so-bot-site
' < /tmp/opencode/twitch-so-bot-code.tar.gz
```

- [ ] **Step 4: Add `GRID_API_URL` without touching bot values**

Run:
```bash
ssh -i ~/.ssh/nova_chave_oracle ubuntu@163.176.129.143 '
  set -e
  ENV=/home/ubuntu/twitch-so-bot-site/backend/.env
  grep -q "^GRID_API_URL=" "$ENV" || printf "\n# Stream Grid loopback API\nGRID_API_URL=http://127.0.0.1:8766\n" >> "$ENV"
  grep -E "^(BASE_URL|TWITCH_REDIRECT_URI|EMBED_PARENT|GRID_API_URL)=" "$ENV"
'
```

Expected: the three existing values are unchanged and `GRID_API_URL` is present.

- [ ] **Step 5: Create and start the Node API service**

Run:
```bash
ssh -i ~/.ssh/nova_chave_oracle ubuntu@163.176.129.143 '
  set -e
  sudo tee /etc/systemd/system/stream-grid-api.service >/dev/null <<"EOF"
[Unit]
Description=Stream Grid API
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/stream-grid-api
EnvironmentFile=/home/ubuntu/twitch-so-bot-site/backend/.env
Environment=PORT=8766
ExecStart=/usr/bin/node /home/ubuntu/stream-grid-api/production.cjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now stream-grid-api.service
  sleep 2
  systemctl is-active stream-grid-api.service
  curl -sS http://127.0.0.1:8766/healthz
'
```

Expected: `active` and `{"ok":true}`.

- [ ] **Step 6: Restart the bot and verify it stays healthy**

Run:
```bash
ssh -i ~/.ssh/nova_chave_oracle ubuntu@163.176.129.143 '
  sudo systemctl restart twitch-so-bot.service
  sleep 3
  systemctl is-active twitch-so-bot.service
  curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5000/auth/login
'
```

Expected: `active` and `200`. If it fails, restore the Task 1 backup and restart.

---

## Task 7: Verification

**Files:** none.

- [ ] **Step 1: Verify the public grid page**

Run:
```bash
curl -sS -o /tmp/opencode/grid.html -w "%{http_code}\n" https://twitchso.com/grid/
grep -oE '<title>[^<]*|/grid/assets/[^"]+' /tmp/opencode/grid.html | head
```

Expected: `200`, `<title>Stream Grid</title>`, and `/grid/assets/...` paths.

- [ ] **Step 2: Verify the API proxy**

Run:
```bash
curl -sS 'https://twitchso.com/api/search?q=twitch' | head -c 300
```

Expected: JSON with a `data` array. If it returns `SEARCH_UNAVAILABLE`, check that the Node service loaded the bot `.env` and that `search.js` uses the fallback.

- [ ] **Step 3: Verify the custom-player stream endpoint**

Run:
```bash
curl -sS 'https://twitchso.com/api/stream?channel=twitch' | head -c 300
```

Expected: an `#EXTM3U` playlist or a JSON error if the channel is offline. A `STREAM_OFFLINE` response still proves the proxy reaches Node.

- [ ] **Step 4: Verify the grid OAuth start redirect**

Run:
```bash
curl -sS -D - -o /dev/null 'https://twitchso.com/grid/auth/start?state=smoke-test'
```

Expected: `303` with `location: https://id.twitch.tv/oauth2/authorize?...redirect_uri=https%3A%2F%2Ftwitchso.com%2Fauth%2Fcallback...scope=user%3Aread%3Afollows...`.

- [ ] **Step 5: Verify the grid callback branch without a real Twitch login**

Run:
```bash
COOKIE=/tmp/opencode/grid-cookie.txt
LOC=$(curl -sS -c "$COOKIE" -D - -o /dev/null 'https://twitchso.com/grid/auth/start?state=smoke-test' | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r')
STATE=$(python3 -c 'import sys,urllib.parse as u; print(u.parse_qs(u.urlparse(sys.argv[1]).query)["state"][0])' "$LOC")
curl -sS -b "$COOKIE" -D - -o /dev/null "https://twitchso.com/auth/callback?state=${STATE}&code=fake"
```

Expected: `303` to `https://twitchso.com/grid/#error=token_failed&state=smoke-test`, not to `/dashboard?twitch_error=...`. This proves the grid branch runs before the bot flow.

- [ ] **Step 6: Verify the bot login route is unchanged**

Run:
```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://twitchso.com/auth/login
curl -sS -o /dev/null -w "%{http_code}\n" https://twitchso.com/auth/twitch/login
```

Expected: `200` for the login page and `401` for the bot Twitch route without a bot session, exactly as before.

- [ ] **Step 7: Run the repository tests**

Run:
```bash
cd /mnt/Dev/JS/stream-grid
pnpm test:server
pnpm exec playwright test
```

Expected: all server and browser tests pass. If Playwright browsers are unavailable, run at least `pnpm check` and `pnpm test:server` and record the limitation.

---

## Task 8: Documentation, commit, and push

**Files:**
- Modify: `README.md` (both repositories)
- Modify: `GUIA_POS_DEPLOY.md`
- Modify: `docs/plans/2026-11-13-twitch-login-integration.md`

- [ ] **Step 1: Document the integrated deployment**

In `stream-grid/README.md`, add a section stating that `https://twitchso.com/grid/` is served by the Twitch SO Bot FastAPI app, that login uses `/grid/auth/start`, that `twitchAuthUrl` must stay in `public/config.json`, and that `pnpm build:grid` builds for the subpath.

In `twitch-so-bot-site/README.md` and `GUIA_POS_DEPLOY.md`, add the `/grid` static mount, the `stream-grid-api` systemd unit, the `GRID_API_URL` variable, and the fact that the existing Twitch callback is reused unchanged.

- [ ] **Step 2: Review the diffs**

Run:
```bash
git -C /mnt/Dev/JS/stream-grid diff --stat
git -C /mnt/Dev/PYTHON/Twitch-So-Bot/twitch-so-bot-site diff --stat
git -C /mnt/Dev/JS/stream-grid diff
git -C /mnt/Dev/PYTHON/Twitch-So-Bot/twitch-so-bot-site diff
```

Expected: no secret appears in either diff. `public/config.json` contains only the public client ID.

- [ ] **Step 3: Commit and push `stream-grid`**

Run:
```bash
cd /mnt/Dev/JS/stream-grid
git add .gitignore index.html package.json public/config.json README.md \
  src/controllers/workspace.tsx src/services/library.ts src/types/domain.ts \
  vite.config.mts docs/plans/2026-11-13-twitch-login-integration.md
git commit -m "feat: serve Stream Grid under twitchso.com with shared Twitch login"
git push origin main
```

- [ ] **Step 4: Commit and push `twitch-so-bot-site`**

Run:
```bash
cd /mnt/Dev/PYTHON/Twitch-So-Bot/twitch-so-bot-site
git add .env.example .gitignore README.md GUIA_POS_DEPLOY.md \
  backend/config.py backend/main.py backend/routers/grid_oauth.py \
  backend/routers/grid_api.py backend/routers/twitch_oauth.py api/search.js
git commit -m "feat: host Stream Grid and bridge its Twitch login"
git push origin main
```

- [ ] **Step 5: Record the final production state**

Run:
```bash
ssh -i ~/.ssh/nova_chave_oracle ubuntu@163.176.129.143 '
  systemctl is-active twitch-so-bot.service stream-grid-api.service
  curl -sS -o /dev/null -w "bot:%{http_code}\n" http://127.0.0.1:5000/auth/login
  curl -sS -o /dev/null -w "grid:%{http_code}\n" http://127.0.0.1:5000/grid/
  curl -sS -o /dev/null -w "api:%{http_code}\n" http://127.0.0.1:8766/healthz
'
```

Expected: both services `active`, `bot:200`, `grid:200`, `api:200`.

---

## Self-Review

**Spec coverage:** The plan answers the login question with a concrete reuse path, provides the Oracle SSH-key command separately, reads and minimally extends the `.env`, keeps the bot's callback and database flow intact, and deploys a working grid at `twitchso.com/grid/`.

**Placeholder scan:** No `TBD`, `TODO`, or “similar to Task N” remains. Every code change has a concrete snippet or exact command.

**Type consistency:** `TwitchLibrary(clientId, authUrl)` is used consistently in `workspace.tsx`; `grid_oauth.handle_grid_callback` returns `RedirectResponse | None` and is awaited in `twitch_callback`; `GRID_API_URL` matches `grid_api_url`; `VITE_BASE` matches `build:grid`.

**Security:** The client secret stays server-side; the grid scope is minimal; the server state is session-bound; the client state is echoed for the SPA's existing CSRF check; the token is returned in a fragment that the SPA clears; the Node API binds to loopback; the proxy forwards the Cloudflare client IP for rate limiting.

---

## Execution Status (2026-11-13)

- [x] `stream-grid`: `pnpm check`, `pnpm test:server` (84 tests), `pnpm exec playwright test` (160 tests including the new auth-bridge test), and `VITE_BASE=/grid/ pnpm build` all pass.
- [x] `twitch-so-bot-site`: Python compile and FastAPI import pass; the deployed app exposes `/grid`, `/grid/auth/start`, and `/api/{name}`.
- [x] Server: `twitch-so-bot.service` and `stream-grid-api.service` are active; the bot login page returns `200`, the bot Twitch route returns `401` without a session, `/grid/` returns `200`, and `/api/search` returns live Twitch data.
- [x] Public chain verified in headless Chromium: Connect → `/grid/auth/start` → `id.twitch.tv/oauth2/authorize` with `redirect_uri=https://twitchso.com/auth/callback`, `response_type=code`, and `scope=user:read:follows` → Twitch login page.
- [x] Callback branch verified with a fake code: it redirects to `https://twitchso.com/grid/#error=token_failed&state=...` instead of the bot dashboard. The success redirect was verified with a mocked token exchange.
- [x] Live HLS proxy verified through Cloudflare with a real live channel; the master playlist and a variant playlist both return `200`.
- [x] `.env.example` sanitized so the previously committed Twitch secret is replaced by placeholders. Rotating that exposed secret in the Twitch developer console remains a manual security follow-up.

The only step that cannot be automated from this workstation is the final Twitch account authorization click on `www.twitch.tv`; the redirect chain up to that page is verified.

---

## Follow-up: Session Persistence (2026-11-14)

**Reported symptom:** login works, but the visitor has to connect Twitch again after reopening the page, unlike the old implicit flow that stayed logged in.

**Root cause:** Twitch's authorization-code access token expires in a few hours (the token response shows `expires_in` around 14,000 seconds). The old implicit flow's token lasted much longer. The bridge was discarding the refresh token, so once the access token expired the SPA had no way to renew it and `validate()` correctly sent the visitor back to guest mode.

**Fix:**
- The callback stores the refresh token in the new `grid_sessions` PostgreSQL table and sets an HttpOnly `grid_session` cookie scoped to `/grid`.
- `GET /grid/auth/session` rotates the refresh token with Twitch and returns a fresh access token; `DELETE /grid/auth/session` removes the server session on disconnect.
- The SPA reads `twitchSessionUrl` from `public/config.json`, tries the stored access token first, and falls back to the server session when it is missing or expired.
- The hourly check refreshes through the server session before validating, and a 401 from the Twitch API triggers one refresh-and-retry before disconnecting.

**Verification:**
- 161 Playwright tests pass, including `an expired Twitch token is renewed from the server session`.
- The server-side refresh was exercised with a mocked Twitch token endpoint: the response returned a new access token, rotated the DB row, and set the `grid_session` cookie; logout deleted the row.
- The callback was exercised with a mocked authorization-code exchange: it stored the refresh token in `grid_sessions`, set the cookie, and redirected to `/grid/` with the access token in the fragment.
- `grid_sessions` exists in the production PostgreSQL database and `/grid/auth/session` returns `204 No Content` without a cookie, so guests do not see a failed request in the console. An expired server session returns `401 SESSION_EXPIRED`.

**Remaining real-account step:** existing sessions created before this fix have no refresh token, so the user must complete one final Twitch authorization in a supported browser. That login creates the `grid_sessions` row and the HttpOnly cookie; subsequent opens renew the access token automatically. The chat iframe is owned by Twitch and uses Twitch's own cookies, so third-party-cookie blocking can still require a separate chat login.
