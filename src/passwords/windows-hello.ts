import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveElectronRemote } from "../adapters/electron-compat";
import { helloBinary, helloDigest } from "./native.generated";

interface Reply { Ok: boolean; Error?: string; Credential?: string; Secret?: string; Api?: number }
export class WindowsHello {
  private children = new Set<ReturnType<typeof spawn>>();
  private async executable(): Promise<string> {
    if (process.platform !== "win32" || !helloBinary) throw new Error("Windows Hello is unavailable on this device");
    const remote = resolveElectronRemote();
    const root = remote?.app?.getPath("userData");
    if (!root) throw new Error("Windows Hello bridge is unavailable");
    const dir = join(root, "ubc-native", helloDigest);
    const path = join(dir, "UbcHello.exe");
    await mkdir(dir, { recursive: true });
    let bytes: Buffer | undefined;
    try { bytes = await readFile(path); } catch { /* first use */ }
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== helloDigest) {
      bytes = Buffer.from(helloBinary, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== helloDigest) throw new Error("Windows Hello bridge integrity check failed");
      await writeFile(path, bytes);
    }
    return path;
  }
  async request(Command: "capabilities" | "create" | "unlock" | "delete", input: { Credential?: string; Salt?: string; User?: string } = {}): Promise<Reply> {
    const path = await this.executable();
    const remote = resolveElectronRemote();
    const handle: Buffer | undefined = remote?.getCurrentWindow?.()?.getNativeWindowHandle?.();
    const Window = handle && handle.length >= 8 ? Number(handle.readBigUInt64LE()) : handle && handle.length >= 4 ? handle.readUInt32LE() : 0;
    return new Promise((resolve, reject) => {
      const child = spawn(path, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.children.add(child);
      let output = "", settled = false;
      const finish = (error?: Error, reply?: Reply) => {
        if (settled) return; settled = true; clearTimeout(timer); this.children.delete(child);
        if (error) reject(error); else resolve(reply!);
      };
      const timer = setTimeout(() => { child.kill(); finish(new Error("Windows Hello request timed out")); }, 90000);
      child.on("error", () => finish(new Error("Windows Hello bridge could not start")));
      child.stdout!.on("data", (data: Buffer) => { output += data.toString(); if (output.length > 16384) { child.kill(); finish(new Error("Invalid Windows Hello response")); } });
      child.stderr!.resume();
      child.on("close", () => {
        try { const reply = JSON.parse(output) as Reply; output = ""; if (!reply.Ok) throw new Error(reply.Error || "Windows Hello was cancelled or unavailable"); finish(undefined, reply); }
        catch (error) { finish(error instanceof Error ? error : new Error("Windows Hello failed")); }
      });
      child.stdin!.on("error", () => finish(new Error("Windows Hello bridge input failed")));
      child.stdin!.end(JSON.stringify({ Command, ...input, Window }) + "\n");
    });
  }
  dispose(): void { for (const child of this.children) child.kill(); this.children.clear(); }
}
