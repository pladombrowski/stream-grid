const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

async function load() {
  return import(`../src/services/extensions.ts?test=${Math.random()}`);
}

const valid = {
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

test("normalizes the login, caches and shares an in-flight request", async () => {
  const mod = await load();
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    assert.match(String(url), /channel=foo/);
    return Response.json({ channel: "foo", extensions: [valid] });
  };
  const [first, second] = await Promise.all([
    mod.channelExtensions("Foo"),
    mod.channelExtensions("foo"),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal((await mod.channelExtensions("FOO")).length, 1);
  assert.equal(calls, 1);
});

test("keeps the popout URL on twitch.tv for hostile inputs", async () => {
  const mod = await load();
  const hostile = ["foo/../bar?x=1#y", "..", "foo@evil.com", "foo\\bar"];
  const views = {
    overlay: "video_overlay",
    component: "component",
    panel: "panel",
  };
  for (const login of hostile)
    for (const id of hostile)
      for (const type of ["overlay", "component", "panel"]) {
        const url = new URL(
          mod.extensionPopoutUrl(login, { ...valid, id, type }),
        );
        assert.equal(url.origin, "https://www.twitch.tv");
        assert.ok(url.pathname.endsWith("/" + views[type]));
      }
});

test("filters invalid entries and rejects a null payload", async () => {
  const mod = await load();
  global.fetch = async () =>
    Response.json({
      channel: "one",
      extensions: [
        valid,
        { ...valid, height: "150" },
        { ...valid, aspectRatio: {} },
        { ...valid, icon: "javascript:alert(1)" },
        { id: "bad" },
      ],
    });
  const filtered = await mod.channelExtensions("one");
  assert.deepEqual(
    filtered.map((entry) => entry.id),
    [valid.id, valid.id],
  );
  assert.equal(filtered[1].icon, "");
  global.fetch = async () => Response.json(null);
  await assert.rejects(mod.channelExtensions("two"), /EXTENSIONS_UNAVAILABLE/);
});

test("rejects a response for another channel without caching it", async () => {
  const mod = await load();
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return Response.json({ channel: "other", extensions: [valid] });
  };
  await assert.rejects(
    mod.channelExtensions("expected"),
    /EXTENSIONS_UNAVAILABLE/,
  );
  global.fetch = async () => {
    calls++;
    return Response.json({ channel: "expected", extensions: [valid] });
  };
  const retried = await mod.channelExtensions("expected");
  assert.equal(calls, 2);
  assert.deepEqual(
    retried.map((entry) => entry.id),
    [valid.id],
  );
});

test("a failed request is not cached", async () => {
  const mod = await load();
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response("", { status: 502 });
  };
  await assert.rejects(
    mod.channelExtensions("retry"),
    /EXTENSIONS_UNAVAILABLE/,
  );
  global.fetch = async () => {
    calls++;
    return Response.json({ channel: "retry", extensions: [valid] });
  };
  assert.equal((await mod.channelExtensions("retry")).length, 1);
  assert.equal(calls, 2);
});
