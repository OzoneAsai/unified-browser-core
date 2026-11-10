import "./check-ux-ui-contract.mjs";
import "./check-home-block-namespace.mjs";
import esbuild from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = await mkdtemp(join(tmpdir(), "ubc-smoke-"));
const outfile = join(dir, "test.mjs");
try {
  const linkPolicyBundle = join(dir, "obsidian-link-policy.mjs");
  await esbuild.build({
    entryPoints: ["tests/obsidian-link-policy-smoke.ts"],
    bundle: true, platform: "node", format: "esm", target: "node22", outfile: linkPolicyBundle,
  });
  await import(pathToFileURL(linkPolicyBundle).href);
  const linkRouterBundle = join(dir, "obsidian-link-router.mjs");
  await esbuild.build({
    entryPoints: ["tests/obsidian-link-router-smoke.ts"],
    bundle: true, platform: "node", format: "esm", target: "node22", outfile: linkRouterBundle,
  });
  await import(pathToFileURL(linkRouterBundle).href);
  const transferBundle = join(dir, "obsidian-web-transfer.mjs");
  await esbuild.build({
    entryPoints: ["tests/obsidian-web-transfer-smoke.ts"],
    bundle: true, platform: "node", format: "esm", target: "node22", outfile: transferBundle,
  });
  await import(pathToFileURL(transferBundle).href);
  const vaultMirrorBundle = join(dir, "obsidian-vault-bookmark-mirror.mjs");
  await esbuild.build({
    entryPoints: ["tests/obsidian-vault-bookmark-mirror-smoke.ts"],
    bundle: true, platform: "node", format: "esm", target: "node22", outfile: vaultMirrorBundle,
    plugins: [{ name: "obsidian-vault-mirror-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mirror-host" }));
      build.onLoad({ filter: /.*/, namespace: "mirror-host" }, () => ({
        contents: `export class Notice { constructor(_text) {} }
          export class TFile { constructor(path,parent) { this.path = path; this.parent = parent; this.extension = 'md'; } }
          export class TFolder { constructor(path) { this.path = path; this.children = []; } }
          export function parseYaml(s) {
            const result = {};
            for (const line of s.split(/\\r?\\n/)) {
              const m = /^([\\w_-]+): (.*)$/.exec(line);
              if (!m) continue;
              try { result[m[1]] = JSON.parse(m[2]); } catch { result[m[1]] = m[2]; }
            }
            return result;
          }`, loader: "js",
      }));
    } }],
  });
  await import(pathToFileURL(vaultMirrorBundle).href);
  const browserTreeBundle = join(dir, "obsidian-browser-tree-model.mjs");
  await esbuild.build({
    entryPoints: ["tests/obsidian-browser-tree-model-smoke.ts"],
    bundle: true, platform: "node", format: "esm", target: "node22", outfile: browserTreeBundle,
  });
  await import(pathToFileURL(browserTreeBundle).href);
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
  const uxOutfile = join(dir, "ux-model.mjs");
  await esbuild.build({
    entryPoints: ["tests/ux-model-smoke.ts"],
    bundle: true, platform: "node", format: "esm", target: "node22", outfile: uxOutfile,
  });
  await import(pathToFileURL(uxOutfile).href);
  const homeOutfile = join(dir, "home-adapter.mjs");
  await esbuild.build({
    entryPoints: ["tests/home-adapter-smoke.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: homeOutfile,
    plugins: [{ name: "home-search-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "home-host" }));
      build.onLoad({ filter: /.*/, namespace: "home-host" }, () => ({
        contents: `
export class TFile {}
export const parseFrontMatterAliases = (frontmatter) => frontmatter?.aliases || [];
export const prepareFuzzySearch = (query) => (value) => value.toLowerCase().includes(query.toLowerCase()) ? { score: 0 } : null;
export const sortSearchResults = (items) => items.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
export const normalizePath = (path) => path.replaceAll("//", "/");
`, loader: "js",
      }));
    } }],
  });
  await import(pathToFileURL(homeOutfile).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
