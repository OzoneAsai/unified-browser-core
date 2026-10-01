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
} finally {
  await rm(dir, { recursive: true, force: true });
}
