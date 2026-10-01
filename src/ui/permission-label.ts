import type { PermissionDecision } from "../core/model";

const PERMISSION_LABELS: Record<string, string> = {
  camera: "Camera",
  microphone: "Microphone",
  media: "Camera and microphone",
  geolocation: "Location",
  notifications: "Notifications",
  midi: "MIDI devices",
  midiSysex: "MIDI system exclusive",
  pointerLock: "Pointer lock",
  fullscreen: "Full screen",
  openExternal: "Open external links",
  "clipboard-read": "Read clipboard",
  "clipboard-sanitized-write": "Write clipboard",
  "display-capture": "Screen capture",
  mediaKeySystem: "Protected media",
  "idle-detection": "Idle detection",
  serial: "Serial devices",
  hid: "HID devices",
  usb: "USB devices",
  bluetooth: "Bluetooth devices",
  keyboardLock: "Keyboard lock",
  "storage-access": "Site storage access",
  "top-level-storage-access": "Top-level storage access",
  "speaker-selection": "Audio output devices",
  "captured-surface-control": "Captured surface control",
};

export function permissionLabel(permission: string): string {
  const known = PERMISSION_LABELS[permission];
  if (known) return known;
  const words = permission
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!words) return "Site permission";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function permissionDecisionLabel(decision: PermissionDecision): string {
  if (decision === "allow") return "Allow";
  if (decision === "block") return "Block";
  return "Ask next time";
}
