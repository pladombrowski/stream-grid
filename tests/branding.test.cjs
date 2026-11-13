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
  assert.match(html, /href="https:\/\/stream-grid\.caelmai\.com\/"/);
  assert.doesNotMatch(html, /Twitch grid|twitch\.moinax\.com/);
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
  const translations = read("src/services/translations.ts");
  assert.doesNotMatch(translations, /Twitch grid/);
  assert.match(translations, /Stream Grid/);
});
