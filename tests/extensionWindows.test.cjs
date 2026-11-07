const { registerHooks } = require("node:module");
const { test } = require("node:test");
const assert = require("node:assert/strict");

// Node ESM requires explicit extensions; the app relies on Vite's extensionless
// resolution, so teach the test loader to resolve relative imports to .ts files.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const [path, query] = specifier.split("?");
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/i.test(path))
      return nextResolve(path + ".ts" + (query ? "?" + query : ""), context);
    return nextResolve(specifier, context);
  },
});

const overlay = {
  id: "k6ji189bf7i4ge8il4iczzw7kpgmjt",
  name: "7DTD",
  description: "",
  icon: "",
  version: "3.4.1",
  type: "overlay",
  slot: "",
  viewerUrl: "https://example.test/overlay",
  height: null,
  targetHeight: null,
  aspectRatio: null,
};

const anchor = {
  getBoundingClientRect: () => ({
    width: 1280,
    height: 720,
    left: 100,
    top: 50,
    bottom: 770,
  }),
};

function installBrowser({ popup } = {}) {
  const opened = [];
  globalThis.screen = {
    availLeft: 0,
    availTop: 0,
    availWidth: 1920,
    availHeight: 1080,
  };
  globalThis.window = {
    screenX: 0,
    screenY: 0,
    outerHeight: 800,
    innerHeight: 720,
    open(url, name, features) {
      const win = popup
        ? popup()
        : {
            closed: false,
            focus() {
              this.focused = true;
            },
            close() {
              this.closed = true;
            },
          };
      opened.push({ url, name, features, win });
      return win;
    },
  };
  return opened;
}

async function load() {
  return import(`../src/services/extensionWindows.ts?test=${Math.random()}`);
}

test("opens a normalized Twitch popout in a sized window", async () => {
  const opened = installBrowser();
  const { openExtensionWindow } = await load();
  assert.equal(openExtensionWindow("Foo", overlay, anchor), true);
  assert.equal(opened.length, 1);
  const { url, name, features, win } = opened[0];
  assert.equal(
    url,
    "https://www.twitch.tv/popout/foo/extensions/" +
      overlay.id +
      "/video_overlay",
  );
  assert.ok(name.startsWith("tg-ext-"));
  assert.ok(name.endsWith("-foo-" + overlay.id));
  const tabSuffix = name.slice("tg-ext-".length, name.indexOf("-foo-"));
  assert.ok(tabSuffix.length > 0);
  assert.ok(features.includes("width=420"));
  assert.ok(features.includes("height=720"));
  assert.ok(features.includes("left=100"));
  assert.ok(features.includes("top=130"));
  assert.equal(win.opener, null);
  assert.equal(win.focused, true);
});

test("reuses and focuses an already open window", async () => {
  const opened = installBrowser();
  const { openExtensionWindow } = await load();
  assert.equal(openExtensionWindow("Foo", overlay, anchor), true);
  opened[0].win.focused = false;
  assert.equal(openExtensionWindow("FOO", overlay, anchor), true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].win.focused, true);
});

test("returns false when the browser blocks the popup", async () => {
  const opened = installBrowser({ popup: () => null });
  const { openExtensionWindow } = await load();
  assert.equal(openExtensionWindow("foo", overlay, anchor), false);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].win, null);
});

test("closes a popup that refuses a null opener", async () => {
  const popup = {
    closed: false,
    focus() {},
    close() {
      this.closed = true;
    },
    set opener(value) {
      throw new Error("refused");
    },
  };
  const opened = installBrowser({ popup: () => popup });
  const { openExtensionWindow } = await load();
  assert.equal(openExtensionWindow("foo", overlay, anchor), false);
  assert.equal(opened.length, 1);
  assert.equal(popup.closed, true);
});

test("closes one channel or all windows", async () => {
  const opened = installBrowser();
  const { openExtensionWindow, closeExtensionWindows } = await load();
  assert.equal(openExtensionWindow("foo", overlay, anchor), true);
  assert.equal(openExtensionWindow("bar", overlay, anchor), true);
  closeExtensionWindows("foo");
  assert.equal(opened[0].win.closed, true);
  assert.equal(opened[1].win.closed, false);
  closeExtensionWindows();
  assert.equal(opened[1].win.closed, true);
});

test("an empty login closes no windows", async () => {
  const opened = installBrowser();
  const { openExtensionWindow, closeExtensionWindows } = await load();
  assert.equal(openExtensionWindow("foo", overlay, anchor), true);
  assert.equal(openExtensionWindow("bar", overlay, anchor), true);
  closeExtensionWindows("");
  assert.equal(opened[0].win.closed, false);
  assert.equal(opened[1].win.closed, false);
});
