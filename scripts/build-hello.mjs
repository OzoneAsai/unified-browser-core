import { spawnSync } from "node:child_process";
if (process.platform !== "win32") throw new Error("Build Windows Hello bridge on Windows, or download the generated bridge artifact from the release workflow.");
const result = spawnSync("dotnet", ["publish", "native/windows-hello/UbcHello.csproj", "-c", "Release", "-r", "win-x64", "-o", "native/windows-hello/publish/win-x64"], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status || 1);
await import("./embed-hello.mjs");
