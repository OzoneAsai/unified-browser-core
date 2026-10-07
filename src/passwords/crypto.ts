import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface Sealed { nonce: string; data: string; tag: string }
const label = "UBC password vault v1";
export function secretBytes(): Buffer { return randomBytes(32); }
export function seal(key: Buffer, plaintext: Buffer, context: string): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(label + ":" + context));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce: nonce.toString("base64"), data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
export function unseal(key: Buffer, value: Sealed, context: string): Buffer {
  const nonce = Buffer.from(value.nonce, "base64"), tag = Buffer.from(value.tag, "base64");
  if (nonce.length !== 12 || tag.length !== 16 || key.length !== 32) throw new Error("Invalid encrypted vault");
  const cipher = createDecipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(label + ":" + context)); cipher.setAuthTag(tag);
  const first = cipher.update(Buffer.from(value.data, "base64"));
  try { return Buffer.concat([first, cipher.final()]); } finally { first.fill(0); }
}
export function wrappingKey(secret: Buffer, vaultId: string, kind: "hello" | "recovery"): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.from(vaultId), Buffer.from(label + ":" + kind), 32));
}
export function recoveryText(value: Buffer): string { return value.toString("hex").toUpperCase().match(/.{1,8}/g)!.join("-"); }
export function parseRecovery(value: string): Buffer {
  const normalized = value.replace(/[\s-]/g, "");
  if (!/^[a-f0-9]{64}$/i.test(normalized)) throw new Error("Invalid recovery key");
  return Buffer.from(normalized, "hex");
}
export function passwordOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) throw new Error("Passwords require HTTPS");
  if (parsed.username || parsed.password) throw new Error("Invalid site address");
  return parsed.origin;
}
export function generatePassword(length = 24): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_";
  const limit = 256 - 256 % alphabet.length;
  let result = "";
  while (result.length < length) { const bytes = randomBytes(length * 2); for (const b of bytes) if (b < limit && result.length < length) result += alphabet[b % alphabet.length]; }
  return result;
}
