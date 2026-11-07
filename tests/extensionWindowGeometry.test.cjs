const test = require("node:test");
const assert = require("node:assert/strict");

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
const component = {
  ...overlay,
  type: "component",
  targetHeight: 9200,
  aspectRatio: 40000 / 58500,
};
const panel = { ...overlay, type: "panel", height: 150 };
const bigPanel = { ...panel, height: 496 };
const defaultPanel = { ...panel, height: null };
const defaultComponent = {
  ...component,
  targetHeight: null,
  aspectRatio: null,
};
const rect = { width: 1280, height: 720, left: 100, top: 50, bottom: 770 };
const bounds = { left: 0, top: 0, right: 1920, bottom: 1080 };
const viewport = { screenX: 0, screenY: 0, chrome: 80 };

test("overlay box sits at the left edge of the video", async () => {
  const { extensionWindowBox } =
    await import("../src/services/extensionWindowGeometry.ts");
  assert.deepEqual(extensionWindowBox(overlay, rect, bounds, viewport), {
    width: 420,
    height: 720,
    left: 100,
    top: 130,
  });
});

test("component box follows target height and aspect ratio", async () => {
  const { extensionWindowBox } =
    await import("../src/services/extensionWindowGeometry.ts");
  assert.deepEqual(extensionWindowBox(component, rect, bounds, viewport), {
    width: 424,
    height: 620,
    left: 116,
    top: 146,
  });
  assert.deepEqual(
    extensionWindowBox(defaultComponent, rect, bounds, viewport),
    { width: 620, height: 504, left: 116, top: 146 },
  );
});

test("panel box stays compact and bottom-aligned", async () => {
  const { extensionWindowBox } =
    await import("../src/services/extensionWindowGeometry.ts");
  assert.deepEqual(extensionWindowBox(panel, rect, bounds, viewport), {
    width: 520,
    height: 150,
    left: 100,
    top: 700,
  });
  assert.equal(
    extensionWindowBox(bigPanel, rect, bounds, viewport).height,
    300,
  );
  assert.equal(
    extensionWindowBox(defaultPanel, rect, bounds, viewport).height,
    150,
  );
});

test("tiny and huge tiles stay inside the screen bounds", async () => {
  const { extensionWindowBox } =
    await import("../src/services/extensionWindowGeometry.ts");
  const tiny = extensionWindowBox(
    overlay,
    { width: 200, height: 100, left: 1800, top: 900, bottom: 1000 },
    bounds,
    viewport,
  );
  assert.deepEqual(tiny, { width: 300, height: 300, left: 1620, top: 780 });
  const huge = extensionWindowBox(
    overlay,
    { width: 4000, height: 3000, left: 0, top: 0, bottom: 3000 },
    bounds,
    viewport,
  );
  assert.deepEqual(huge, { width: 420, height: 820, left: 0, top: 80 });
});

test("negative origins clamp to the screen bounds", async () => {
  const { extensionWindowBox } =
    await import("../src/services/extensionWindowGeometry.ts");
  const negative = extensionWindowBox(
    overlay,
    { width: 1280, height: 720, left: -100, top: -50, bottom: 670 },
    { left: 0, top: 0, right: 1920, bottom: 1080 },
    { screenX: 0, screenY: 0, chrome: 80 },
  );
  assert.deepEqual(negative, { width: 420, height: 720, left: 0, top: 30 });
  const leftMonitor = extensionWindowBox(
    overlay,
    { width: 1280, height: 720, left: 1700, top: 900, bottom: 1620 },
    { left: -1920, top: -200, right: 0, bottom: 880 },
    { screenX: -1920, screenY: -200, chrome: 80 },
  );
  assert.deepEqual(leftMonitor, {
    width: 420,
    height: 720,
    left: -420,
    top: 160,
  });
});
