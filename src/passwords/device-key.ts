import { compileMainProcessModule } from "../adapters/electron-compat";

export type DevicePlatform = "darwin" | "linux";
export interface DeviceWrapping { platform: DevicePlatform; data: string }

interface DeviceRuntime {
  available(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

// The OS-protected key is used only to wrap UBC's random AES vault key.
// On Linux, Electron may fall back to an unprotected, fixed "basic_text" key;
// never create or unlock a device wrapper using that backend.
const source = String.raw`
const { app, safeStorage } = require("electron");
const supported = () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return false;
  if (!app.isReady() || !safeStorage?.isEncryptionAvailable?.()) return false;
  if (process.platform === "linux") {
    const backend = safeStorage.getSelectedStorageBackend?.();
    if (!backend || backend === "basic_text" || backend === "unknown") return false;
  }
  return true;
};
module.exports = {
  available: supported,
  encrypt(value) {
    if (!supported()) throw new Error("A protected OS keyring is unavailable");
    return safeStorage.encryptString(value).toString("base64");
  },
  decrypt(value) {
    if (!supported()) throw new Error("A protected OS keyring is unavailable");
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  }
};
`;

export class DeviceKey {
  private runtime?: DeviceRuntime;
  private resolve(): DeviceRuntime | undefined {
    this.runtime ??= compileMainProcessModule<DeviceRuntime>("ubc-password-device-key.cjs", source);
    return this.runtime;
  }
  get platform(): DevicePlatform | undefined {
    return process.platform === "darwin" || process.platform === "linux" ? process.platform : undefined;
  }
  available(): boolean {
    try { return Boolean(this.platform && this.resolve()?.available()); } catch { return false; }
  }
  wrap(key: Buffer): DeviceWrapping {
    if (!this.platform || !this.available() || key.length !== 32) throw new Error("OS-protected password unlock is unavailable");
    const data = this.resolve()!.encrypt(key.toString("base64"));
    if (!data || !/^[a-z\d+/]+={0,2}$/i.test(data)) throw new Error("Invalid OS-protected key");
    return { platform: this.platform, data };
  }
  unwrap(value: DeviceWrapping): Buffer {
    if (value.platform !== this.platform || !this.available()) throw new Error("The original device keyring is unavailable");
    const text = this.resolve()!.decrypt(value.data);
    const key = Buffer.from(text, "base64");
    if (key.length !== 32 || key.toString("base64") !== text) {
      key.fill(0);
      throw new Error("Invalid OS-protected vault key");
    }
    return key;
  }
}
