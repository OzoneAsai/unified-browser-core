import esbuild from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = await mkdtemp(join(tmpdir(), "ubc-smoke-"));
const outfile = join(dir, "test.mjs");
try {
  await esbuild.build({
    entryPoints: ["tests/core-smoke.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    external: ["obsidian"],
  });
  await import(pathToFileURL(outfile).href);
  const pickerOutfile = join(dir, "folder-picker.mjs");
  await esbuild.build({
    entryPoints: ["tests/bookmark-folder-picker.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: pickerOutfile,
    plugins: [{ name: "obsidian-picker-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "picker-host" }));
      build.onLoad({ filter: /.*/, namespace: "picker-host" }, () => ({ contents: `export class FuzzySuggestModal {
        constructor() { globalThis.lastFolderPicker = this; globalThis.window = globalThis; }
        setPlaceholder() {} open() {} onClose() {}
      }`, loader: "js" }));
    } }],
  });
  await import(pathToFileURL(pickerOutfile).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
