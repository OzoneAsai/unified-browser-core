import type { BrowserCoreState, BrowserSettings, LeafId, RestoreCapsule } from "./model";

export class RestoreStore {
  constructor(private readonly state: BrowserCoreState) {}

  get(leafId: LeafId): RestoreCapsule | undefined {
    return this.state.restoreCapsules[leafId];
  }

  put(capsule: RestoreCapsule): void {
    this.state.restoreCapsules[capsule.leafId] = capsule;
  }

  remove(leafId: LeafId): void {
    delete this.state.restoreCapsules[leafId];
    this.markLeafStale(leafId);
  }

  clearAll(): number {
    const leafIds = Object.keys(this.state.restoreCapsules);
    for (const leafId of leafIds) this.remove(leafId);
    return leafIds.length;
  }

  sweep(settings: BrowserSettings, now = Date.now()): boolean {
    let changed = false;
    const maxAgeMs = Math.max(0, settings.restoreRetentionDays) * 86_400_000;

    for (const capsule of Object.values(this.state.restoreCapsules)) {
      if (this.isProtected(capsule.leafId)) continue;
      if (maxAgeMs === 0 || now - capsule.capturedAt > maxAgeMs) {
        this.remove(capsule.leafId);
        changed = true;
      }
    }

    const limitBytes = Math.max(16, settings.restoreStorageLimitMb) * 1024 * 1024;
    let capsules = Object.values(this.state.restoreCapsules).sort((a, b) => a.capturedAt - b.capturedAt);
    let total = capsules.reduce((sum, capsule) => sum + this.sizeOf(capsule), 0);
    for (const capsule of capsules) {
      if (total <= limitBytes) break;
      if (this.isProtected(capsule.leafId)) continue;
      total -= this.sizeOf(capsule);
      this.remove(capsule.leafId);
      changed = true;
    }
    return changed;
  }

  private isProtected(leafId: LeafId): boolean {
    const leaf = this.state.history.leaves[leafId];
    if (leaf?.pinned || leaf?.manualRetention === "preserve") return true;
    return Object.values(this.state.history.nodes).some(
      (node) =>
        node.kind === "navigation" &&
        node.leafId === leafId &&
        node.manualRetention === "preserve",
    );
  }

  private markLeafStale(leafId: LeafId): void {
    for (const node of Object.values(this.state.history.nodes)) {
      if (node.kind === "navigation" && node.leafId === leafId) node.stale = true;
    }
  }

  private sizeOf(capsule: RestoreCapsule): number {
    try {
      return new TextEncoder().encode(JSON.stringify(capsule)).byteLength;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }
}
