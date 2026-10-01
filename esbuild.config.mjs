import esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  target: "es2022",
  platform: "node",
  outfile: "dist/main.js",
  sourcemap: watch ? "inline" : false,
  treeShaking: true,
  logLevel: "info"
});

await Promise.all([
  cp("manifest.json", "dist/manifest.json"),
  cp("styles.css", "dist/styles.css")
]);

if (watch) {
  await ctx.watch();
  console.log("Unified Browser Core: watching…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
