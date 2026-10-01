import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";

const expected = ["main.js", "manifest.json", "styles.css"];
const actual = (await readdir("dist", { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();

assert.deepEqual(actual, expected, "dist must contain exactly the Obsidian three-file release set");

const [manifest, pkg] = await Promise.all([
  readJson("dist/manifest.json"),
  readJson("package.json"),
]);
assert.equal(manifest.id, "unified-browser-core");
assert.equal(manifest.version, pkg.version, "manifest and package versions must match");
assert.equal(manifest.isDesktopOnly, true, "the managed Electron runtime requires desktop-only packaging");

for (const file of ["dist/main.js", "dist/styles.css"]) {
  const info = await stat(file);
  assert.ok(info.size > 0, `${file} must not be empty`);
}

console.log("release artifact verification passed");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
