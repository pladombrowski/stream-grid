# Stream Grid Rename and GitHub Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the `twitch-grid` checkout to **Stream Grid**, move it to a real GitHub fork at `pladombrowski/stream-grid`, and merge the five new `Moinax/twitch-grid` commits without losing the local Twitch extensions and YouTube work.

**Architecture:** Two phases. Phase A is git-only: create the fork, replace the stale `devalnor` remote, merge `upstream/main` with a merge commit, and prove the combined tree passes the existing suite. Phase B is the rebrand: update package metadata, visible UI copy, translations, HTML metadata, documentation, and deployment notes. Browser storage keys keep the historical `tg.*` prefix, and Twitch API identifiers such as `TWITCH_SEARCH_*` stay unchanged, because they are functional contracts rather than branding. The local folder rename and the push happen last, after every check passes and the user approves the diff.

**Tech Stack:** React 19, strict TypeScript, Vite 8, Tailwind CSS 4, Playwright, Node.js 24, pnpm 11, GitHub CLI (`gh`).

---

## Decisions Locked Before Execution

| Topic | Decision |
| --- | --- |
| GitHub target | Real fork `pladombrowski/stream-grid`, parent `Moinax/twitch-grid` |
| Display name | `Stream Grid` (product name, title case) |
| Repository and package name | `stream-grid` |
| Production URL | `https://stream-grid.caelmai.com` |
| Browser storage keys | Keep `tg.*`; no migration, no data loss |
| Twitch credentials | Create own Twitch apps; commit only the public login client ID |
| Upstream sync | Merge `upstream/main` now, no rebase, no force-push |
| Historical docs | Leave `docs/plans/2026-11-06-*.md` and `2026-11-12-*.md` untouched |
| Local folder | Rename `/mnt/Dev/JS/twitch-grid` to `/mnt/Dev/JS/stream-grid` last |
| Commits and push | Only after diff review and explicit user approval |

**Out of scope:** creating the Vercel project, creating the Twitch applications, changing DNS, deleting branches, rewriting history, and deploying. Those are manual follow-ups listed at the end.

**Files touched:**

| File | Responsibility |
| --- | --- |
| `package.json` | Package name and the new branding regression test |
| `index.html` | Title, descriptions, canonical/OG/Twitter metadata, boot label |
| `src/components/Sidebar.tsx` | Sidebar brand |
| `src/components/Workspace.tsx` | Empty-workspace heading |
| `src/components/Landing.tsx` | Landing brand, headings, FAQ, footer, GitHub links |
| `src/services/translations.ts` | French keys and English/Dutch values mentioning the brand |
| `tests/i18n.test.cjs` | Allow-list entry for the untranslated brand name |
| `tests/branding.test.cjs` | New regression test for package, HTML, and template names |
| `README.md` | Site URL, Twitch configuration, Vercel deployment, fork attribution |
| `api/search.js` | Host-agnostic request parsing base URL |
| `production.cjs` | Comment no longer says only "Twitch" |
| `vite.config.mts` | Dev-server plugin name |
| `public/config.json` | Empty public client ID until the owner creates the Twitch app |
| `public/assets/share-card.png` | Regenerated share image after the landing rename |

---

## Task 0: Preflight and backup

**Files:** none (creates a backup bundle outside the repository).

- [ ] **Step 1: Confirm the working tree state**

Run:
```bash
cd /mnt/Dev/JS/twitch-grid
git status --short
git log --oneline -6
git remote -v
gh auth status
```

Expected: only `?? .idea/` is untracked; the last commits include `5f45d04`, `ff9bd6d`, `c369ee9`, `55e5df9`; `origin` points at `https://github.com/devalnor/twitch-grid.git` and there is no `upstream` remote yet; `gh` is logged in as `pladombrowski` with at least the `repo` scope. If tracked files are modified or the GitHub account is wrong, stop and ask the user before continuing.

- [ ] **Step 2: Record the current branch topology**

Run:
```bash
git fetch origin
git rev-list --left-right --count origin/main...main
git log --oneline main..origin/main
```

Expected: `0	4` and an empty list. This proves the `devalnor` fork has no commits that are missing locally, so it can be replaced safely.

- [ ] **Step 3: Create an offline backup bundle**

Run:
```bash
git bundle create /tmp/opencode/twitch-grid-before-fork.bundle --all
git bundle verify /tmp/opencode/twitch-grid-before-fork.bundle
```

Expected: `The bundle contains ... refs` and `The bundle records a complete history.` Keep the bundle until the fork push is verified.

---

## Task 1: Create the GitHub fork and configure remotes

**Files:** `.git/config` (not tracked).

- [ ] **Step 1: Create the fork with the final name**

Run:
```bash
gh repo fork Moinax/twitch-grid --fork-name stream-grid --clone=false --remote=false
```

Expected: `✓ Created fork pladombrowski/stream-grid`.

- [ ] **Step 2: Wait for GitHub to expose the fork, then verify the parent link**

Run:
```bash
for i in $(seq 1 30); do
  gh repo view pladombrowski/stream-grid --json nameWithOwner >/dev/null 2>&1 && break
  sleep 2
done
gh repo view pladombrowski/stream-grid --json nameWithOwner,isFork,parent,visibility
```

Expected (the parent ID is stable today; the names are what matter):
```json
{"isFork":true,"nameWithOwner":"pladombrowski/stream-grid","parent":{"id":"R_kgDOUQ_LcA","name":"twitch-grid","owner":{"id":"MDQ6VXNlcjY3OTkwNA==","login":"Moinax"}},"visibility":"PUBLIC"}
```

If `parent.name` is not `twitch-grid` or `parent.owner.login` is not `Moinax`, the fork is not attached to the right upstream; stop and ask the user.

If the fork already exists or the name is taken, stop and ask the user; do not delete or rename an existing repository.

- [ ] **Step 3: Replace the stale origin with the fork and add upstream**

Run:
```bash
git remote remove origin
git remote add origin https://github.com/pladombrowski/stream-grid.git
git remote add upstream https://github.com/Moinax/twitch-grid.git
git fetch --all --prune
git remote -v
```

Expected:
```text
origin	https://github.com/pladombrowski/stream-grid.git (fetch)
origin	https://github.com/pladombrowski/stream-grid.git (push)
upstream	https://github.com/Moinax/twitch-grid.git (fetch)
upstream	https://github.com/Moinax/twitch-grid.git (push)
```

- [ ] **Step 4: Confirm which side is ahead before merging**

Run:
```bash
git rev-list --left-right --count upstream/main...main
git log --oneline main..upstream/main
git log --oneline upstream/main..main
```

Expected:
```text
5	4
9b3b2f1 Show stream uptime in the tile header
e1a254d Let the spotlight's tiles dock on any side and resize
bf33de5 Bring Live follows notifications into the spotlight
25641d0 Bring clicked tiles into the spotlight and refine previews
ef9d3ce Fit every small tile beside the spotlight
5f45d04 Keep the collapsed toggle test independent of the GitHub link
ff9bd6d Remove GitHub links
c369ee9 Add YouTube live streams with chat to the grid
55e5df9 Add Twitch extensions discovery and popout windows
```

---

## Task 2: Merge upstream/main with a merge commit

**Files:**
- Modify (conflicts): `src/components/ChannelList.tsx`, `src/components/StreamTile.tsx`, `src/controllers/workspace.tsx`, `src/styles/grid.css`, `src/styles/workspace.css`

This merge was rehearsed in a throwaway worktree at `upstream/main` commit `9b3b2f1`. The resolution steps below cover every conflict hunk; TypeScript and the full suite passed with exactly these edits.

**Pin check:** before Step 1, run `git rev-parse upstream/main`. If it is not `9b3b2f1`, the upstream tip has moved and the hunks below may have shifted. In that case, stop and rehearse the merge in a throwaway worktree (`git worktree add --detach /tmp/opencode/merge-check main`) before touching the real branch.

- [ ] **Step 1: Start a merge without committing**

Run:
```bash
git merge --no-commit --no-ff upstream/main
```

Expected: `Automatic merge failed; fix conflicts and then commit the result.` and these five conflicted files:
```text
src/components/ChannelList.tsx
src/components/StreamTile.tsx
src/controllers/workspace.tsx
src/styles/grid.css
src/styles/workspace.css
```

- [ ] **Step 2: Resolve the ChannelList hover conflict**

In `src/components/ChannelList.tsx`, replace the conflict block with:

```tsx
              // YouTube rows have no Twitch preview: the custom player previews on a plain hover,
              // the embed waits for Shift (upstream behaviour).
              if (e.pointerType !== "touch" && !youtube)
                onHover(e.currentTarget, e.shiftKey);
```

The `onHover` prop is already destructured by the automatic merge. Keep `onPreview` because the keyboard `onFocus` handler still uses it.

- [ ] **Step 3: Resolve the StreamTile import conflict**

At the top of `src/components/StreamTile.tsx`, replace the conflict block with:

```tsx
import type { MouseEvent, PointerEventHandler } from "react";
import type { ChatPosition, Platform } from "../types/domain";
const TILE_POSITIONS: [ChatPosition, string, number[] | null][] = [
  ["top", "Top", [0, 0, 36, 8]],
  ["left", "Left", [0, 0, 11, 24]],
  ["auto", "Auto", null],
  ["right", "Right", [25, 0, 11, 24]],
  ["bottom", "Bottom", [0, 16, 36, 8]],
];
```

This keeps the upstream `TILE_POSITIONS` and `MouseEvent` while preserving the local `Platform` type.

- [ ] **Step 4: Resolve the two menu-selector conflicts in the workspace controller**

In `src/controllers/workspace.tsx`, replace the first conflict block (inside `closeTileMenus`) with:

```tsx
      ".chat-options[open], .tiles-options[open], .collaboration[open], .extensions[open], .custom-quality[open], #grid-switcher[open], #list-order-menu[open]",
```

Then replace the second conflict block (inside the `pointerdown` listener) with:

```tsx
        ".chat-options, .tiles-options, .collaboration, .extensions, .custom-quality, #grid-switcher, #list-order-menu",
```

Both lists must contain both `.tiles-options` (upstream) and `.extensions` (local).

- [ ] **Step 5: Resolve the add() conflict in the workspace controller**

In `src/controllers/workspace.tsx`, replace the conflict block after `el.dataset.login = s.twitch;` with:

```tsx
    el.dataset.platform = s.platform || "twitch";
    el.dataset.playerMode = isYouTubeChannel(s) ? "embed" : preferences.player;
    const resume = () => {
      if (allPaused || tilePaused(t)) {
        resumeTile(t);
        sync(t);
        save();
      }
    };
```

This keeps the YouTube dataset fields and the upstream `resume` helper.

- [ ] **Step 6: Resolve the grid.css conflict by keeping both feature blocks**

In `src/styles/grid.css`, replace the conflict block with:

```css
/* A YouTube tile keeps YouTube's player and its own chat: the badge marks the source. */
.tile .bar .platform-badge {
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
.tile .bar .viewers {
  color: var(--fg);
  --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='7.5' r='4'/%3E%3Cpath d='M4 20.5a8 8 0 0 1 16 0'/%3E%3C/svg%3E");
}
.tile .uptime {
  --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M12 7v5l3 2'/%3E%3C/svg%3E");
}
.tile .viewers:not(:empty),
.tile .uptime {
  flex: none;
  @apply inline-flex items-baseline; /* browsers round the font's metrics apart: the icon follows the text instead of the pill */
  @apply gap-[4px];
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
  line-height: 17px; /* measured: centres the digits in the pill in Chromium and Firefox alike */
  @apply rounded-[4px];
  background: color-mix(in srgb, var(--fg) 8%, transparent);
}
.tile .viewers:not(:empty, .off)::before,
.tile .uptime::before {
  content: "";
  flex: none;
  @apply w-[10px] h-[10px];
  /* centres the icon on the digits rather than resting it on their baseline */
  transform: translateY(1px);
  background: currentColor;
  mask: var(--icon) center / contain no-repeat;
}
/* a small tile keeps its room for the category */
@container (width < 400px) {
  .tile .uptime {
    @apply hidden;
  }
}
```

- [ ] **Step 7: Resolve the workspace.css light-theme selector conflict**

In `src/styles/workspace.css`, replace the conflict block with:

```css
[data-theme="light"] .tiles-options summary:hover,
[data-theme="light"] .tiles-options[open] summary,
[data-theme="light"] .collaboration summary,
[data-theme="light"] .extensions summary {
```

- [ ] **Step 8: Prove no conflict markers remain**

Run:
```bash
grep -rn '^<<<<<<<\|^=======$\|^>>>>>>>' src || echo "no conflict markers"
```

Expected: `no conflict markers`.

- [ ] **Step 9: Reinstall and run every existing check**

Run:
```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:server
pnpm test
```

Expected:
- `pnpm check` exits 0.
- `pnpm test:server` reports `tests 82`, `pass 82`, `fail 0`.
- `pnpm test` reports `159 passed`.

This is the validated baseline: the merge must not change those counts.

- [ ] **Step 10: Review the merge diff and stop for approval**

Run:
```bash
git status --short
git diff --stat HEAD
```

Expected: the five conflicted files plus the automatically merged files are modified as part of the merge; `.idea/` remains untracked. Do **not** commit yet. Report the diff summary to the user and wait for explicit approval.

- [ ] **Step 11: Commit the merge only after approval**

Run:
```bash
git add -u
git commit -m "Merge upstream/main into the fork"
```

Expected: a merge commit with two parents. Confirm with:
```bash
git log --oneline --graph -3
```

---

## Task 3: Add the branding regression test first (TDD)

**Files:**
- Create: `tests/branding.test.cjs`
- Modify: `package.json` (`test:server` script)

- [ ] **Step 1: Write the failing test**

Create `tests/branding.test.cjs` with:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("package and HTML metadata use the Stream Grid name", () => {
  assert.equal(JSON.parse(read("package.json")).name, "stream-grid");
  const html = read("index.html");
  assert.match(html, /<title>Stream Grid<\/title>/);
  assert.doesNotMatch(html, /Twitch grid/);
});

test("user-facing templates use the Stream Grid name", () => {
  for (const file of [
    "src/components/Sidebar.tsx",
    "src/components/Workspace.tsx",
    "src/components/Landing.tsx",
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /Twitch grid/, file);
    assert.match(source, /Stream Grid/, file);
  }
});
```

- [ ] **Step 2: Add the test to the server suite**

In `package.json`, change the end of the `test:server` script from:

```json
tests/production.test.cjs tests/server-cli.test.cjs",
```

to:

```json
tests/production.test.cjs tests/server-cli.test.cjs tests/branding.test.cjs",
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
node --test tests/branding.test.cjs
```

Expected: both tests fail. The first reports `actual: 'twitch-grid'` versus `expected: 'stream-grid'`; the second fails because `Sidebar.tsx` still contains `Twitch grid`.

- [ ] **Step 4: Do not implement yet**

Continue to Task 4. The test stays red until Tasks 4 and 5 finish.

---

## Task 4: Rename the package and HTML metadata

**Files:**
- Modify: `package.json:2`
- Modify: `index.html:7-42`

- [ ] **Step 1: Rename the package**

In `package.json`, change:

```json
  "name": "twitch-grid",
```

to:

```json
  "name": "stream-grid",
```

- [ ] **Step 2: Replace the title and meta description**

In `index.html`, replace the `<title>` and the `<meta name="description">` tag with:

```html
<title>Stream Grid</title>
<meta name="description" content="Watch several Twitch and YouTube live streams on one screen. Bring in the channels you follow or your favorites, arrange your grid and pick the sound.">
```

- [ ] **Step 3: Replace the canonical, Open Graph, and Twitter block**

Replace everything from `<link rel="canonical"` through the last `twitter:image:alt` tag with:

```html
<link rel="canonical" href="https://stream-grid.caelmai.com/">
<meta property="og:type" content="website">
<meta property="og:locale" content="en_US">
<meta property="og:locale:alternate" content="fr_FR">
<meta property="og:locale:alternate" content="nl_NL">
<meta property="og:url" content="https://stream-grid.caelmai.com/">
<meta property="og:site_name" content="Stream Grid">
<meta property="og:title" content="Stream Grid">
<meta property="og:description" content="Watch several Twitch and YouTube live streams on one screen. Bring in the channels you follow or your favorites, arrange your grid and pick the sound.">
<meta property="og:image" content="https://stream-grid.caelmai.com/assets/share-card.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Stream Grid. All your streams. One screen. The list of followed channels beside a grid of players.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Stream Grid">
<meta name="twitter:description" content="Watch several Twitch and YouTube live streams on one screen. Bring in the channels you follow or your favorites, arrange your grid and pick the sound.">
<meta name="twitter:image" content="https://stream-grid.caelmai.com/assets/share-card.png">
<meta name="twitter:image:alt" content="Stream Grid. All your streams. One screen. The list of followed channels beside a grid of players.">
```

- [ ] **Step 4: Update the boot-screen label**

In `index.html`, change the boot div's `aria-label` from:

```html
aria-label="Twitch grid"
```

to:

```html
aria-label="Stream Grid"
```

- [ ] **Step 5: Run the branding test to see partial progress**

Run:
```bash
node --test tests/branding.test.cjs
```

Expected: the first test passes; the second still fails on the first template it checks, `Sidebar.tsx`.

---

## Task 5: Rename the React copy and translations

**Files:**
- Modify: `src/components/Sidebar.tsx:9`
- Modify: `src/components/Workspace.tsx:13`
- Modify: `src/components/Landing.tsx` (brand, labels, legal, GitHub links)
- Modify: `src/services/translations.ts` (five entries)
- Modify: `tests/i18n.test.cjs:15`

- [ ] **Step 1: Rename the sidebar and empty-workspace brand**

In `src/components/Sidebar.tsx`, change:

```tsx
            <b>Twitch grid</b>
```

to:

```tsx
            <b>Stream Grid</b>
```

In `src/components/Workspace.tsx`, change:

```tsx
          <h1 id="empty-title">Twitch grid</h1>
```

to:

```tsx
          <h1 id="empty-title">Stream Grid</h1>
```

- [ ] **Step 2: Rename the landing labels and visible brand**

In `src/components/Landing.tsx`, apply these four replacements:

```tsx
        aria-label="Présentation de Twitch grid"
```
becomes
```tsx
        aria-label="Présentation de Stream Grid"
```

Both `<b>Twitch grid</b>` occurrences become:

```tsx
            <b>Stream Grid</b>
```

The sentence aria-label:

```tsx
            aria-label="Twitch grid en une phrase"
```
becomes
```tsx
            aria-label="Stream Grid en une phrase"
```

- [ ] **Step 3: Rename the landing privacy paragraph and FAQ question**

Replace:

```tsx
            <p className="sub" data-i18n="">
              Twitch grid est une page web. Elle demande le minimum et garde
              tout chez toi.
            </p>
```

with:

```tsx
            <p className="sub" data-i18n="">
              Stream Grid est une page web. Elle demande le minimum et garde
              tout chez toi.
            </p>
```

Replace:

```tsx
                <summary data-i18n="">
                  Que voit Twitch grid de mon compte ?
                </summary>
```

with:

```tsx
                <summary data-i18n="">
                  Que voit Stream Grid de mon compte ?
                </summary>
```

- [ ] **Step 4: Rename the legal line and point the footer links at the fork**

Replace:

```tsx
            <p className="legal" data-i18n="">
              Twitch est une marque de Twitch Interactive, Inc. Twitch grid est
              un projet indépendant, sans lien avec Twitch.
            </p>
```

with:

```tsx
            <p className="legal" data-i18n="">
              Twitch est une marque de Twitch Interactive, Inc. Stream Grid est
              un projet indépendant, sans lien avec Twitch.
            </p>
```

Replace the two footer links:

```tsx
                href="https://github.com/Moinax/twitch-grid"
```
becomes
```tsx
                href="https://github.com/pladombrowski/stream-grid"
```

and:

```tsx
                href="https://github.com/Moinax/twitch-grid/blob/main/LICENSE"
```
becomes
```tsx
                href="https://github.com/pladombrowski/stream-grid/blob/main/LICENSE"
```

- [ ] **Step 5: Update the five translation entries**

In `src/services/translations.ts`, replace:

```ts
  "Présentation de Twitch grid": ["About Twitch grid", "Over Twitch grid"],
```
with:
```ts
  "Présentation de Stream Grid": ["About Stream Grid", "Over Stream Grid"],
```

Replace:

```ts
  "Twitch grid en une phrase": [
    "Twitch grid in one sentence",
    "Twitch grid in één zin",
  ],
```
with:
```ts
  "Stream Grid en une phrase": [
    "Stream Grid in one sentence",
    "Stream Grid in één zin",
  ],
```

Replace:

```ts
  "Twitch grid est une page web. Elle demande le minimum et garde tout chez toi.":
    [
      "Twitch grid is a web page. It asks for the minimum and keeps everything on your side.",
      "Twitch grid is een webpagina. Ze vraagt het minimum en houdt alles bij jou.",
    ],
```
with:
```ts
  "Stream Grid est une page web. Elle demande le minimum et garde tout chez toi.":
    [
      "Stream Grid is a web page. It asks for the minimum and keeps everything on your side.",
      "Stream Grid is een webpagina. Ze vraagt het minimum en houdt alles bij jou.",
    ],
```

Replace:

```ts
  "Que voit Twitch grid de mon compte ?": [
    "What does Twitch grid see of my account?",
    "Wat ziet Twitch grid van mijn account?",
  ],
```
with:
```ts
  "Que voit Stream Grid de mon compte ?": [
    "What does Stream Grid see of my account?",
    "Wat ziet Stream Grid van mijn account?",
  ],
```

Replace:

```ts
  "Twitch est une marque de Twitch Interactive, Inc. Twitch grid est un projet indépendant, sans lien avec Twitch.":
    [
      "Twitch is a trademark of Twitch Interactive, Inc. Twitch grid is an independent project, not affiliated with Twitch.",
      "Twitch is een merk van Twitch Interactive, Inc. Twitch grid is een onafhankelijk project, niet verbonden aan Twitch.",
    ],
```
with:
```ts
  "Twitch est une marque de Twitch Interactive, Inc. Stream Grid est un projet indépendant, sans lien avec Twitch.":
    [
      "Twitch is a trademark of Twitch Interactive, Inc. Stream Grid is an independent project, not affiliated with Twitch.",
      "Twitch is een merk van Twitch Interactive, Inc. Stream Grid is een onafhankelijk project, niet verbonden aan Twitch.",
    ],
```

- [ ] **Step 6: Update the i18n allow-list**

In `tests/i18n.test.cjs`, change:

```js
  const untranslated = new Set(["Twitch grid", "GitHub", "FR", "EN", "NL"]);
```

to:

```js
  const untranslated = new Set(["Stream Grid", "GitHub", "FR", "EN", "NL"]);
```

- [ ] **Step 7: Run both focused tests**

Run:
```bash
node --test tests/branding.test.cjs tests/i18n.test.cjs
```

Expected: all branding and i18n tests pass. The i18n suite must report no missing translation keys.

---

## Task 6: Update documentation, configuration, and internal identifiers

**Files:**
- Modify: `README.md` (title, site URL, Twitch configuration, deployment, origin)
- Modify: `api/search.js:98`
- Modify: `production.cjs:1`
- Modify: `vite.config.mts:39`
- Modify: `public/config.json`

- [ ] **Step 1: Rename the README title and site URL**

In `README.md`, change:

```markdown
# Twitch grid
```

to:

```markdown
# Stream Grid
```

Then change:

```markdown
Site: https://twitch.moinax.com
```

to:

```markdown
Site: https://stream-grid.caelmai.com
```

- [ ] **Step 2: Update the Twitch configuration origin**

In the `## Twitch configuration` section, replace:

```markdown
Register the exact OAuth return addresses, including `http://localhost:8765` for local development and the production origin. The current production origin is `https://twitch.moinax.com`, without a trailing slash. Login uses Twitch's implicit OAuth flow with only `user:read:follows`.
```

with:

```markdown
Register the exact OAuth return addresses, including `http://localhost:8765` for local development and the production origin `https://stream-grid.caelmai.com`, without a trailing slash. Login uses Twitch's implicit OAuth flow with only `user:read:follows`. The login application belongs to the fork owner: an empty `twitchClientId` keeps login disabled while local favorites and search continue to work.
```

- [ ] **Step 3: Replace the private-infrastructure deployment section**

Replace the entire block from `## Deployment and share image` through the last private-infrastructure paragraph, stopping immediately before `Open Graph and Twitter metadata remain in the HTML entry point.`, with:

```markdown
## Deployment and share image

Production is a Vercel project connected to `pladombrowski/stream-grid`, served at `https://stream-grid.caelmai.com`. Vercel runs `pnpm build`, serves `dist`, and exposes the files in `api/` as serverless functions for `/api/search`, `/api/stream`, `/api/extensions` and `/api/youtube`.

Import the repository in the Vercel dashboard, keep the Vite preset and Node.js 24, and set `TWITCH_SEARCH_CLIENT_ID` and `TWITCH_SEARCH_CLIENT_SECRET` for Production and Preview. Add `stream-grid.caelmai.com` as the project domain and create the DNS record Vercel shows, normally a `CNAME` to `cname.vercel-dns.com`. Pushes to `main` deploy automatically; pull requests get preview deployments.

The API uses only Node built-ins. The two Twitch search credentials stay in Vercel environment variables and are never committed. Favorites, grids and Twitch sessions remain in each browser's local storage on the production origin. The browser storage keys keep their historical `tg.` prefix so existing data survives the rename.
```

Keep the `Open Graph and Twitter metadata` paragraph and the `pnpm og:generate` block that follow it. Delete every mention of `apps-host`, Caddy, `dots hosting`, systemd, `/etc/personal-apps/twitch-grid.env`, and the deleted Vercel project.

Also, in the `Development` commands block near the top of the README, change:

```markdown
pnpm start          # Production API only, on 127.0.0.1:8766 (Caddy serves dist)
```

to:

```markdown
pnpm start          # Standalone API only, on 127.0.0.1:8766 (a static host serves dist)
```

- [ ] **Step 4: Update the origin and license section**

Replace:

```markdown
## Origin and license

Adapted from [ZEvent grid](https://github.com/Moinax/zevent-grid), retaining its Git history. Event data and counters have been removed.

[MIT](LICENSE)
```

with:

```markdown
## Origin and license

Adapted from [ZEvent grid](https://github.com/Moinax/zevent-grid), retaining its Git history, and from [Moinax/twitch-grid](https://github.com/Moinax/twitch-grid). Event data and counters have been removed.

This fork is maintained at [pladombrowski/stream-grid](https://github.com/pladombrowski/stream-grid). Upstream changes are merged from `Moinax/twitch-grid`; the fork keeps the original MIT copyright notice.

[MIT](LICENSE)
```

- [ ] **Step 5: Make the search request base URL host-agnostic**

In `api/search.js`, change:

```js
  const params = new URL(req.url, 'https://twitch.moinax.com').searchParams;
```

to:

```js
  const params = new URL(req.url, 'http://localhost').searchParams;
```

The base is only used to parse a relative request URL; it must not name a deployment host.

- [ ] **Step 6: Update the production and Vite comments/names**

In `production.cjs`, change the first line:

```js
// Caddy serves dist; this loopback-only process owns the Twitch API routes.
```

to:

```js
// A static host serves dist; this loopback-only process owns the stream API routes.
```

In `vite.config.mts`, change:

```ts
        name: "twitch-search",
```

to:

```ts
        name: "stream-grid-api",
```

- [ ] **Step 7: Clear the inherited public Twitch client ID**

Replace the contents of `public/config.json` with:

```json
{"twitchClientId": ""}
```

This disables Twitch login until the fork owner creates and registers their own Twitch application. Do not commit any client secret.

- [ ] **Step 8: Scan for stale branding**

Run:
```bash
grep -rnI "Twitch grid\|twitch-grid\|twitch.moinax.com" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=test-results --exclude-dir=.idea --exclude-dir=plans . || true
```

Expected remaining matches, and only these:
- `README.md` — the `Moinax/twitch-grid` attribution link and the fork paragraph that names the upstream repository.
- `tests/branding.test.cjs` — the `/Twitch grid/` negative assertions only.

`docs/plans/` is excluded because every plan, including this one, intentionally quotes the old name while describing the migration.

Any match in `src/`, `index.html`, `package.json`, `api/`, the deployment part of `README.md`, or any other tracked source is a miss and must be fixed before continuing.

---

## Task 7: Run the full verification and regenerate the share card

**Files:**
- Modify: `public/assets/share-card.png` (generated)

- [ ] **Step 1: Run the strict checks and the server suite**

Run:
```bash
pnpm check
pnpm test:server
```

Expected:
- `pnpm check` exits 0.
- `pnpm test:server` reports `tests 84`, `pass 84`, `fail 0` (82 existing tests + 2 branding tests).

- [ ] **Step 2: Run the browser suite**

Run:
```bash
pnpm test
```

Expected: `159 passed`.

- [ ] **Step 3: Build the production bundle**

Run:
```bash
pnpm build
```

Expected: Vite writes `dist/` and exits 0. `pnpm build` also reruns `pnpm check`.

- [ ] **Step 4: Regenerate the Open Graph share image**

Run:
```bash
pnpm og:generate
```

Expected: `public/assets/share-card.png` is written. If the landing brand is not visible in the cropped hero, the file may be byte-identical and `git status` will not list it; that is acceptable.

- [ ] **Step 5: Smoke-check the served HTML and API**

Run:
```bash
pnpm dev >/tmp/opencode/stream-grid-dev.log 2>&1 &
echo $! >/tmp/opencode/stream-grid-dev.pid
for i in $(seq 1 30); do
  curl -fsS http://localhost:8765/ >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://localhost:8765/ | grep -o '<title>[^<]*</title>'
curl -sS -o /tmp/opencode/youtube-smoke.json -w '%{http_code}\n' 'http://localhost:8765/api/youtube?q=dQw4w9WgXcQ'
head -c 200 /tmp/opencode/youtube-smoke.json
kill "$(cat /tmp/opencode/stream-grid-dev.pid)"
```

Expected:
- The first `curl` prints `<title>Stream Grid</title>`.
- The YouTube request prints an HTTP status of `200`, `404`, or `503` and the body is JSON. A non-live or currently unreadable video is acceptable; a connection error or an HTML body is not.

- [ ] **Step 6: Review the complete diff and stop for approval**

Run:
```bash
git status --short
git diff --stat
git diff --check
```

Expected: `package.json`, `index.html`, the three React components, `translations.ts`, `tests/i18n.test.cjs`, new `tests/branding.test.cjs`, `README.md`, `api/search.js`, `production.cjs`, `vite.config.mts`, `public/config.json`, and possibly `public/assets/share-card.png`. No unrelated files, and `git diff --check` prints nothing. Do **not** commit yet.

---

## Task 8: Commit and push only after explicit approval

**Files:** none.

- [ ] **Step 1: Stop and ask the user**

Present the `git diff --stat` and the list of behavior-preserving decisions (storage keys kept, upstream merge included, Twitch credentials left empty). Wait for an explicit “commit and push” answer. Do not commit or push on the plan’s authority alone.

- [ ] **Step 2: Stage tracked changes and the new test**

Run:
```bash
git add -u
git add tests/branding.test.cjs
git status --short
```

Expected: only the files listed in Task 7 Step 6 are staged; `.idea/` stays untracked.

- [ ] **Step 3: Commit the rename**

Run:
```bash
git commit -m "Rename the project to Stream Grid"
```

Expected: one commit on top of the upstream merge commit.

- [ ] **Step 4: Push main to the fork**

Run:
```bash
git push -u origin main
```

Expected: `main -> main` and a new upstream tracking branch `origin/main`. The push must be a fast-forward; never use `--force`. Push only `main`: `feature/twitch-extensions` has no commits that are missing from `main`, and its linked worktree stays local. If Git asks for HTTPS credentials, run `gh auth setup-git` once and retry.

- [ ] **Step 5: Verify the fork and the upstream relationship**

Run:
```bash
gh repo view pladombrowski/stream-grid --json nameWithOwner,isFork,parent,defaultBranchRef,visibility
git rev-list --left-right --count upstream/main...main
git log --oneline --graph -6
```

Expected:
- `nameWithOwner` is `pladombrowski/stream-grid`, `isFork` is `true`, and `parent.name` is `twitch-grid`.
- `git rev-list` prints `0	6`: the fork is not behind upstream and is ahead by the four local commits, the merge commit, and the rename commit.
- The graph shows the merge commit joining `upstream/main` and the four local commits.

- [ ] **Step 6: Confirm the fork retains upstream sync capability**

On GitHub, open `https://github.com/pladombrowski/stream-grid`. The repository header must still show “forked from Moinax/twitch-grid”. Do not use GitHub’s “Leave fork network” action.

---

## Task 9: Rename the local checkout and repair the linked worktree

**Files:** none (filesystem paths only).

The repository currently has a clean linked worktree on `feature/twitch-extensions` at `/home/pedro/.local/share/opencode/worktree/5ff256/twitch-extensions`. That branch has no commits missing from `main`; keep it and repair its link rather than deleting user work.

- [ ] **Step 1: Confirm the linked worktree is clean**

Run:
```bash
git worktree list
git -C /home/pedro/.local/share/opencode/worktree/5ff256/twitch-extensions status --short
```

Expected: the worktree is listed on `feature/twitch-extensions` and its status is empty. If it has uncommitted changes, stop and ask the user before moving the main checkout.

- [ ] **Step 2: Leave the repository before moving it**

Run:
```bash
cd /mnt/Dev/JS
mv twitch-grid stream-grid
```

Expected: `ls -d /mnt/Dev/JS/stream-grid` succeeds and `/mnt/Dev/JS/twitch-grid` no longer exists.

- [ ] **Step 3: Repair the linked worktree**

Run:
```bash
cd /mnt/Dev/JS/stream-grid
git worktree repair /home/pedro/.local/share/opencode/worktree/5ff256/twitch-extensions
git worktree list
```

Expected:
```text
/mnt/Dev/JS/stream-grid                                   <sha> [main]
/home/pedro/.local/share/opencode/worktree/5ff256/twitch-extensions  <sha> [feature/twitch-extensions]
```

Git may print `repair: .git file broken: /home/pedro/.../twitch-extensions` before the list; that line is the repair notice, not a failure.

- [ ] **Step 4: Move the agent session to the new directory**

Use the Code Mode tool from the current session:

```js
await tools.opencode.session_move({ directory: "/mnt/Dev/JS/stream-grid" });
```

Expected: the returned `directory` is `/mnt/Dev/JS/stream-grid`. Subsequent shell calls run there.

- [ ] **Step 5: Verify the moved repository**

Run:
```bash
pwd
git status --short
git remote -v
git log --oneline -3
```

Expected: `pwd` is `/mnt/Dev/JS/stream-grid`; the only untracked entry is `?? .idea/`; `origin` is the fork and `upstream` is `Moinax/twitch-grid`; the last commits are the rename and the upstream merge.

- [ ] **Step 6: Note the expected IDE cleanup**

The `.idea/` directory is untracked and still contains the old module name and path. Do not delete it automatically; JetBrains regenerates or renames the module when the project is reopened at the new path. If the user wants a clean slate, ask before removing it.

---

## Manual follow-ups after this plan

These require accounts, DNS, or secrets and are deliberately not automated.

- [ ] **Create the public Twitch login application.** In the [Twitch developer console](https://dev.twitch.tv/console/apps), create an application named `Stream Grid`, category `Website`, OAuth Redirect URL `https://stream-grid.caelmai.com` and, for local development, `http://localhost:8765`. Copy its Client ID into `public/config.json` as `{"twitchClientId":"..."}` and commit that public value. Login stays disabled while the value is empty.
- [ ] **Create the Confidential Twitch search application.** Put its Client ID and secret in `.env.local` as `TWITCH_SEARCH_CLIENT_ID` and `TWITCH_SEARCH_CLIENT_SECRET` for local development, and in the Vercel project’s Production and Preview environment variables for deployment. Never commit the secret.
- [ ] **Import the fork into Vercel.** Create a project from `pladombrowski/stream-grid`, keep the Vite preset, Node.js 24, build command `pnpm build`, output directory `dist`. Add the two search environment variables.
- [ ] **Attach the domain.** Add `stream-grid.caelmai.com` in Vercel and create the DNS record Vercel displays, normally `CNAME cname.vercel-dns.com`.
- [ ] **Smoke-test production.** Check `https://stream-grid.caelmai.com/` loads, `/api/youtube?q=<live-url>` answers, `/api/search?q=<channel>` answers when the credentials are set, and Twitch login returns to the registered origin.
- [ ] **If the final URL differs from `https://stream-grid.caelmai.com`,** update it in `index.html` (canonical, OG, Twitter), `README.md` (site, OAuth, deployment), and register the same origin in the Twitch console before deploying. Do not leave a dead canonical URL.
- [ ] **Optional repository metadata.** Set the GitHub description and topics, and enable branch protection on `main` if the fork will take external contributions.

---

## Risks and rollback

| Risk | Mitigation |
| --- | --- |
| Upstream merge conflicts differ from the rehearsal | The rehearsal used the exact five files and seven conflict blocks above. If a new hunk appears, stop, run `git merge --abort`, and inspect `git diff upstream/main...main` before retrying. |
| A test fails after the merge | Do not commit the merge. Fix only the semantic integration (both features must survive), then rerun `pnpm check`, `pnpm test:server`, and `pnpm test`. |
| Fork name taken or fork creation fails | Stop. Do not delete or rename an existing repository. The backup bundle at `/tmp/opencode/twitch-grid-before-fork.bundle` still has the full history. |
| Push rejected | Never force-push. Run `git fetch origin`, inspect the divergence, and ask the user. |
| Lost local data after the rename | Avoided by keeping every `tg.*` storage key and every saved-layout format unchanged. |
| Production URL not live yet | The canonical/OG URL is the chosen target. Until DNS and Vercel are configured, the old deployment is unaffected; the fork’s own deployment is the only missing piece. |
| Linked worktree breaks after `mv` | `git worktree repair` updates the pointer; verify with `git worktree list` and a status check in the linked path. |

**Backup and rollback commands:**
```bash
# Full pre-fork history, kept outside the repository
git bundle verify /tmp/opencode/twitch-grid-before-fork.bundle

# Abort an in-progress merge before it is committed
git merge --abort
```

---

## Self-review against the request

| Requirement | Where it is handled |
| --- | --- |
| Rename the project to `stream-grid` | Tasks 3–7: package, HTML, UI, translations, docs, tests |
| Preserve existing YouTube and extensions work | Task 2 merges upstream around both features; the validated suite keeps the YouTube and extensions tests |
| Move the whole project to the user’s GitHub fork | Task 1 creates `pladombrowski/stream-grid`; Task 8 pushes `main` |
| Keep pulling commits from the original | Task 1 adds `upstream`; Task 8 verifies the fork parent and `upstream/main...main` |
| Do not lose existing browser data | `tg.*` keys and layout formats are untouched; README documents the legacy prefix |
| Full control of credentials | `public/config.json` starts empty; the manual follow-ups list the owner’s own Twitch apps and Vercel env vars |
| No automatic commit/push | Tasks 2 and 7 stop for review; Task 8 requires explicit approval |
