# Stream Grid

Watch several Twitch and YouTube live streams on one screen, arrange their tiles, put one in spotlight, and choose the sound for each stream.

Site: https://twitchso.com/grid/

## Development

Use Node.js 24 or newer and pnpm.

```sh
pnpm install
pnpm dev
```

Open http://localhost:8765. Vite serves the React app and the local API endpoints. Twitch embeds require an HTTP hostname; opening the HTML as a local file does not work.

To test on an iPad or another device on the same local network, run `pnpm dev:lan` and open the Network URL printed by Vite. You can choose a port with `pnpm dev:lan 8766`.

```sh
pnpm check          # Strict TypeScript and server syntax checks
pnpm build          # Validates and builds the app into dist
pnpm preview        # Serves the production build and local API endpoints
pnpm start          # Standalone API only, on 127.0.0.1:8766 (a static host serves dist)
pnpm test:server    # API behavior and translation coverage
pnpm test           # Browser behavior tests
pnpm format         # Formats frontend source and Vite configuration
```

Install Chromium once with `pnpm exec playwright install chromium`. Browser tests run headlessly in separate profiles. They simulate Twitch's API and player SDK; real playback and account authorization still require Twitch.

## Code structure

The frontend uses React, strict TypeScript, and Tailwind CSS, built with Vite.

- `src/components` contains the landing page, sidebar, tile controls, previews, grid lists, collaboration participants, notifications, and dialogs. Views receive typed commands and channel data.
- `src/controllers/workspace.tsx` coordinates the grid, account, playback, persistence, and browser events. Preview playback, video sizing, resource cleanup, tooltips, and deployment checks have separate controllers.
- `src/services` contains Twitch API access, named-grid storage, preferences, and translations.
- `src/types` defines channels, saved layouts, commands, and the Twitch player interface.
- `src/styles` groups Tailwind styles by application area. The original reset, colors, dimensions, animations, and responsive rules are retained. Tailwind Preflight is intentionally omitted because it changes native buttons, dialogs, and typography.
- `public` contains the public Twitch client configuration, favicon, and share image.
- `api/search.js`, `api/stream.js`, `api/extensions.js` and `api/youtube.js` are shared by local development, the Vercel functions, and the standalone Node server.
- `production.cjs` serves the four API routes and `/healthz` using Node's built-in HTTP server; it needs no installed runtime dependencies.

One React root owns the interface. A small external view store uses React portals to render into stable tile and list containers. Twitch owns its iframe mount nodes. Reordering changes CSS order without moving those nodes, and expanding a tile leaves its player in place. The workspace disposes timers, observers, subscriptions, and players when its mount is released.

The browser tests can inspect player state through an adapter enabled only by `VITE_TEST_API=true`. Production builds omit that adapter. Existing local-storage keys and saved-layout formats remain compatible.

## Channels and accounts

Without an account, search by Twitch username or URL in the sidebar. Results show an avatar, category, and live status. The star saves a favorite in this browser. If search is unavailable, direct addition by username remains available.

Connecting Twitch replaces favorites with the visitor's follows. All follows pages are loaded, live channels appear first, and search remains available. Disconnecting restores the local favorites. Favorites and follows stay separate.

Guest and connected modes each retain their own grid collection and active grid. Switching account mode saves the current layout and restores the other mode's layout. Tiles retain their order, pause, volume, mute, spotlight audio intent, and chat settings.

The Twitch session stays in the browser's local storage until the visitor signs out. OAuth state is checked before accepting a token. Sessions are validated at startup and hourly; expired sessions return to guest mode with a reconnect message. Each visitor reads their own follows, which are never published to other visitors.

## Landing and empty workspace

Visitors with no session, favorites, or open tiles see the full-window introduction. Its primary action connects Twitch. Continuing without an account opens the sidebar and focuses search; that choice lasts for the current tab only. The language selector shares the app's preference.

An empty grid shows the three-step introduction to searching, adding a stream, and using spotlight. Search opens the sidebar and focuses its input. Visitors can reopen the landing page from this panel even when they already have favorites.

## Grids and preferences

The sidebar footer offers French, English, and Dutch, plus system, light, and dark themes. Preferences apply immediately and persist across account modes. Changing them does not recreate video players. Twitch controls and chat keep Twitch's own localization.

The grid selector opens saved layouts. Save as creates a named copy without interrupting playback; a blank grid starts empty. Grids can be opened, renamed, or deleted with confirmation. Removing the last grid creates an empty default grid. Existing installations migrate their earlier single layout into the default grid automatically.

The connected mode also has a locked Live follows grid. New live follows join automatically and start playing unless the viewer has saved an explicit pause choice. A channel that ends leaves after a minute. Order, sound, volume, and pause settings survive reloads.

Locking a grid prevents additions and keeps offline tiles in place. A clear button empties the current grid; it stays disabled while the grid is locked, on Live follows, and on an empty grid. The collapsed sidebar retains grid, clear and lock controls, playback and sound controls, the avatar rail, and account links. A highlighted avatar identifies a channel already in the grid; offline avatars are dimmed.

## Custom player

The sidebar includes Video player, Global latency and Spotlight latency settings. The custom player is the default and renders both tiles and sidebar previews as HTML5 video with HLS.js; Twitch embed stays selectable. Stable latency preserves the current safety margin, while Low latency stays closer to the live edge and gently speeds up to catch up. The global latency applies to grid tiles and defaults to stable; the spotlight latency applies to the stream in front, or to a lone tile, and defaults to low. A tile can pick its own latency from the player's resolution menu until either setting changes. Twitch's embed does not expose this choice, so the latency settings are disabled for it. These choices persist in this browser. Switching the player recreates active players while retaining tile order, volume, mute, pause, spotlight, and chat preferences; a latency change retunes the running players in place, so a stream keeps its video and sound when it takes or leaves the spotlight.

The custom player draws its own bar in the site's theme instead of the browser's video controls, at the bottom right of the video. At rest it is a small badge with the rendered resolution and an icon telling whether the level is automatic or fixed by hand; a moving pointer over the video grows it into the bar with play and pause, sound with its volume slider, and fullscreen, which takes the whole tile so its header stays reachable. A pointer left still for three seconds lets it shrink back. The tile header drops its own play, sound, spotlight and in-window expand buttons for custom players, leaving the chat, the collaboration menu and the close button. The resolution opens a menu listing the HLS levels, the latency for that tile and the switch to Twitch's embed, placed above or below the badge wherever there is room, with the latency at the far end. Under the global mute the bar's sound button and volume slider are disabled. The bar drives the video element, and the tile header reads the change back. Controls can change on resize without replacing the video. A tile on Twitch's embed keeps a header shortcut back to the custom player; a custom tile switches from its resolution menu. Pausing a custom player keeps its last frame and video element, including global pause. The usual dimmed overlay displays a centered Play button to resume the tile. Hovering a paused tile does not resume it. Tiles restored in a paused state keep a poster until first playback. HLS.js selects quality automatically until a level is chosen, caps automatic selection to the rendered video size, and reapplies a manually selected level once the levels are known. Failed playback offers a retry and a switch to the Twitch embed; the setting also allows it at any time.

With no iframe to cover, styled tooltips come back on every action, the player's own controls included. Under the Twitch embed they stay suppressed: that player pauses as soon as anything covers it.

`GET /api/stream?channel=…` obtains an anonymous playback token from Twitch GraphQL and retrieves the HLS master playlist from Usher. Twitch's playlist hosts answer 403 to any Origin outside their own list, which a deployed page cannot satisfy, so the master playlist comes back with its variant URLs rewritten to `GET /api/stream?playlist=…`. That form only accepts an HTTPS URL on `*.playlist.ttvnw.net` and sends no Origin upstream. Media segments carry an open CORS policy and keep loading straight from Twitch's CDN. No login token or application secret is sent to this endpoint. Responses are not cached, upstream calls have timeouts, and each client address is limited per minute and per server instance to 120 token requests and 3000 playlist requests. No additional environment variables are required.

This uses an undocumented playback mechanism, also used by [Streamlink](https://github.com/streamlink/streamlink/blob/master/src/streamlink/plugins/twitch.py). [Helix Get Streams](https://dev.twitch.tv/docs/api/reference/#get-streams) only provides stream metadata. Twitch can refuse playback or change its query, require client integrity, or change CDN CORS behavior. Anonymous playback does not inherit subscriptions or other account entitlements. Ads remain part of the supplied stream. Browser autoplay rules and codec support still apply; chat remains an iframe. The custom player does not remove all Twitch or browser constraints.

Validated with real Twitch playback in headless Chromium against the production build, including playlist proxying and direct CDN media playback. Safari native HLS still needs verification. Browser tests use a small generated HLS media fixture to check playback and switching without depending on live channels.

## Playback, spotlight, and dragging

One tile uses the complete Twitch player and fills the grid. With multiple tiles, the spotlight button enlarges one stream and enables its sound. Leaving spotlight restores its previous audio intent. Each tile has playback and sound controls; its horizontal volume slider appears while hovering the sound control or slider. Global pause and mute remain separate from each tile's saved choices.

The spotlight takes the whole width of the grid, the other tiles in a strip under it, or the whole height, the other tiles in a column beside it, whichever renders the wider video. Those tiles then fill the room the spotlight cannot use, in as many columns as fit while staying 290 pixels wide, the width a player's bar needs; a column shrinks its tiles, down to that width, until they all fit in the height, and the spotlight gives up to a quarter of its width when that brings all of them on screen. A chat open on the spotlight is served from that same room before the small tiles take it, and settles on the side that costs the video the least.

That is the Auto layout. The button in the spotlight's bar, or Spotlight tiles position in the settings, pins the small tiles to the top, bottom, left or right of it instead, for every grid. Dragging the divider between them sizes the tiles and pins the side they are on, so Auto can never move them away from that size: the column count then gives the largest tile that shows them all, or the most columns at 290 pixels and a scroll. The divider snaps where the tiles exactly fill their area, and stops where one more pixel would cost the spotlight its full player or only add black bars. Double-clicking it, or Auto size in the menu, gives the size back and keeps the side; arrow keys, Home and End move it too. Choosing Auto hands back the side and the size together. A pinned side that no longer fits the window falls back to Auto until the room returns.

Other tiles gain the full player controls, Twitch's own or the custom player's bar, when their rendered video reaches 640 pixels wide. They retain them down to 560 pixels. Size-driven changes wait 300 milliseconds after resizing stops. Twitch accepts the controls option only at construction, so only players whose control mode changes are recreated, preserving their settings and quality.

Paused tiles release their embed and show a stream image. Hovering a small paused tile can start a muted preview, which is released on leaving. Single, spotlight, and expanded tiles stay paused until explicitly resumed. The header button pauses or resumes a player; clicking a paused player surface or the centered Play button resumes it. Clicking a playing small tile brings it into the spotlight, a quarter second later so that a double click can still fullscreen it; Shift+click works on any player, the embed's included. The spotlight's close button only sends it back to the grid, even in a locked grid. A double click fullscreens the tile and turns its sound on. Leaving fullscreen restores the tile's previous sound state.

Video frames and placeholders remain centered at 16:9 without CSS scaling. Loading and offline placeholders sit below the embed. Offline channels show their configured banner and avatar without mounting a player; playback buttons do not start them. A stalled player exposes its status in the header and still accepts clicks in the native player.

Dragging a header reorders tiles without moving iframe nodes. Only the destination has a drop overlay. A compact still follows the pointer, avoiding spotlight when space allows; Escape cancels. Dropping onto spotlight exchanges the tiles' roles. Small tiles can still fall below Twitch's documented minimum embed dimensions.

The expand button fills the browser window without browser fullscreen, player recreation, or audio changes. Press it again or use Escape to restore the previous arrangement.

When a restored grid requests sound, an activation screen waits for a click or keypress before playback starts. It restores the saved sound, volume, and pause choices and appears only once per visit. Sound icons reflect the actual player's mute state, including a refused unmute. A browser-blocked pause is not saved as a deliberate user pause.

## Chat

Chat is available on a single tile, spotlight, and tiles wide enough to fit it. A tile qualifies at 640 pixels wide or with 420 pixels below its video, with lower thresholds to avoid flickering during resizing.

Choose Auto, Top, Bottom, Left, or Right. Selecting a position opens chat immediately. Auto uses space below the video when at least 420 pixels remain; otherwise it chooses the placement with the larger video. Side chat can expand from 320 to 480 pixels into unused vertical letterboxing.

Chat settings persist per tile and account mode. Repositioning an open chat keeps its iframe and video player mounted. The menu can also open chat on Twitch, which handles authorization to write messages.

## YouTube lives

Paste a YouTube live URL, a `youtu.be` link, a channel `/live` URL, an `@handle`, a channel ID, or an unambiguous 11-character video ID into the search field. The result row carries a YouTube badge; clicking it adds the tile to the grid beside Twitch channels. The tile keeps the usual pause, sound, volume, spotlight, fullscreen, chat, drag and saved-grid behaviour.

YouTube tiles use YouTube's official iframe player and its native controls. The custom HLS player, the Twitch embed switch, the resolution menu and the latency settings remain Twitch-only. YouTube lives are not part of Twitch follows or favorites and have no Twitch collaborations or extensions. A live added by a video URL stays tied to that video; a channel `/live` URL resolves to the video that is live at that moment.

Chat uses YouTube's official `youtube.com/live_chat` embed with `embed_domain` set to the page hostname. The page's `strict-origin-when-cross-origin` referrer policy supplies the matching origin. YouTube may disable embedding or chat for a particular broadcast; the tile then shows YouTube's own message or the app's unavailable state.

`GET /api/youtube?q=…` reads the public watch page, or the channel's `/live` page, and extracts the live metadata from the embedded player response. It returns only public data (video ID, title, author, channel ID, thumbnail, watching count and start time), caches results for 30 seconds, and shares concurrent lookups. Each client (IPv6 clients grouped by /48) may make up to 60 cache-missing upstream lookups per minute, with at most 16 lookups in flight per client and 500 across the server; cached answers do not count. Page bodies over 4 MiB are rejected, and after YouTube throttles the server, cache misses observe a short cooldown while cached answers stay available. No API key or credentials are required. YouTube's page shape is undocumented: if a watch page can no longer be read, the endpoint answers `YOUTUBE_UNAVAILABLE`; a channel `/live` page that cannot be read is reported as not live.

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
five minutes per channel, concurrent requests are shared, and cache misses are
limited per client address. The endpoint uses the public web client ID already
used for playback and needs no additional environment variables.

## Status, previews, and collaborations

Visible pages refresh live status every 30 seconds and follows about every minute. Loading follows and searches show skeleton rows. Unknown favorite status pulses until resolved.

With the custom player, hovering a live channel opens a still preview after a short delay, then a muted video preview; holding Shift gives the card its sound, and releasing it mutes the card again while it stays under the pointer. With Twitch's embed the card opens only while Shift is held. The card follows movement between rows and fades on leaving. Playback failures and slow previews show status outside the iframe.

A favorite or follow transitioning from offline to live triggers an in-page notification. Clicking it adds the stream with the grid's pause state, muted and without spotlight. On the Live follows grid, which takes the stream on its own, the notification says so and clicking it brings the stream into the spotlight. Initial live channels do not trigger notifications. Notifications disappear when dismissed, after 30 seconds untouched, when the channel goes offline or leaves the list, when another grid opens, or when the account disconnects.

A playing channel that ends is removed after one minute unless it is spotlighted or the grid is locked. Returning live during that minute cancels removal. Channels initially added offline stay in place and wait for their stream.

Collaboration indicators use Twitch shared-chat sessions in both account modes. The menu lists participants and can add one or all live participants absent from the grid. Existing players and audio choices remain intact. A separate action creates a named, locked grid with all live participants at equal size and only the source channel audible. Collaborations without shared chat cannot be detected. Results are cached for one minute; failed lookups hide indicators until a later successful refresh.

## Twitch configuration

The current production deployment is integrated into the Twitch SO Bot site at `https://twitchso.com/grid/`. It reuses the bot's existing Confidential Twitch application and its already-registered callback `https://twitchso.com/auth/callback`, so no Twitch developer-console change is needed.

`public/config.json` contains only the public client ID and the backend bridge:

```json
{
  "twitchClientId": "your-public-client-id",
  "twitchAuthUrl": "/grid/auth/start",
  "twitchSessionUrl": "/grid/auth/session"
}
```

When `twitchAuthUrl` is set, the Connect button sends the visitor to the FastAPI bridge. The bridge runs the authorization-code flow server-side with `user:read:follows chat:read chat:edit`, then returns the user token to the SPA in the URL fragment. The Twitch client secret never reaches the browser. The SPA still validates the token with Twitch and keeps the existing state check before accepting it. An empty `twitchClientId` disables login while keeping local favorites available; an empty `twitchAuthUrl` falls back to Twitch's implicit flow for a standalone public-client deployment.

Authorization-code access tokens last only a few hours, so the bridge also stores the refresh token in the bot's `grid_sessions` table and sets an HttpOnly `grid_session` cookie. `GET /grid/auth/session` rotates that refresh token and returns a fresh access token; the SPA calls it at startup when its stored token is missing or expired, and hourly while the page stays open. `DELETE /grid/auth/session` drops the server session when the visitor disconnects.

A logged-in viewer reads and sends chat through Twitch's IRC gateway with the same Stream Grid token. This avoids Twitch's chat iframe login, which keeps a separate Twitch cookie and can report success while the iframe still reloads logged out when the browser blocks or partitions third-party cookies. Guests, and sessions created before the chat scopes were added, keep Twitch's official chat iframe for reading and see a button above it to connect or reconnect Twitch; that one extra authorization grants `chat:read` and `chat:edit` and switches the tile to the native chat.

The guest search endpoint uses `TWITCH_SEARCH_CLIENT_ID` and `TWITCH_SEARCH_CLIENT_SECRET` when they are set. On the integrated server the bot's `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` are used as a fallback, so the same Twitch application serves login, search, and the bot. The secret and app token stay on the server. Restart local development after changing environment variables, and redeploy after changing the server environment.

`GET /api/search?q=…` accepts 2 to 100 characters. It checks exact usernames with Get Users so channels omitted by Search Channels remain discoverable, then verifies live status with Get Streams. Repeated `login` parameters refresh up to 100 channels in one request. A `collaboration` parameter retrieves shared-chat participants.

The server caches successful results for one minute, shares concurrent requests, reuses its app token until expiration, and applies request limits. Errors are not cached and never expose credentials. The guest status cache can delay a live notification by one minute.

## Deployment and share image

Production currently runs on the Oracle server behind `https://twitchso.com/grid/`. Build the subpath bundle with:

```sh
pnpm build:grid
```

Copy the contents of `dist/` to `/home/ubuntu/twitch-so-bot-site/grid/` on the server. The FastAPI app serves that directory at `/grid` and proxies `/api/search`, `/api/stream`, `/api/extensions` and `/api/youtube` to the loopback Node process on `127.0.0.1:8766`. That process runs `production.cjs` from `api/`, uses only Node built-ins, and is managed by `stream-grid-api.service`. The bot's existing `twitch-so-bot.service` stays on port 5000 and is not replaced.

The Vercel setup remains a valid standalone alternative: connect `pladombrowski/stream-grid`, run `pnpm build`, serve `dist`, and expose `api/` as serverless functions. Set `TWITCH_SEARCH_CLIENT_ID` and `TWITCH_SEARCH_CLIENT_SECRET` for Production and Preview. On the Oracle deployment those values are optional because the API falls back to the bot's Twitch credentials.

Favorites, grids and Twitch sessions remain in each browser's local storage on the production origin. The browser storage keys keep their historical `tg.` prefix, so this version and earlier versions on the same origin keep reading the same saved data. A different origin starts with empty browser storage; nothing is migrated.

Open Graph and Twitter metadata remain in the HTML entry point. They reference the committed 1200 × 630 image at `public/assets/share-card.png`. Regenerate it after changing the landing hero:

```sh
pnpm og:generate
```

The command starts a local server, captures the English landing hero in headless Chromium, and writes the image into `public/assets`.

## Origin and license

Adapted from [ZEvent grid](https://github.com/Moinax/zevent-grid), retaining its Git history, and from [Moinax/twitch-grid](https://github.com/Moinax/twitch-grid). Event data and counters have been removed.

This fork is maintained at [pladombrowski/stream-grid](https://github.com/pladombrowski/stream-grid). Upstream changes are merged from `Moinax/twitch-grid`; the fork keeps the original MIT copyright notice.

[MIT](LICENSE)
