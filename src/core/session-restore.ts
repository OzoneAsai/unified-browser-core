import type { BrowserSessionCheckpoint, BrowserSessionLeaf } from "./model";

export interface LiveSessionRepresentation {
  lifecycleId: string;
  restoredFromLeafId?: string;
}

export function cloneSessionCheckpoint(checkpoint: BrowserSessionCheckpoint): BrowserSessionCheckpoint {
  return {
    capturedAt: checkpoint.capturedAt,
    leaves: checkpoint.leaves.map((leaf) => ({
      ...leaf,
      transientHistory: leaf.transientHistory?.map((entry) => ({ ...entry })),
    })),
  };
}

export function pendingSessionLeaves(
  checkpoint: BrowserSessionCheckpoint,
  live: LiveSessionRepresentation[],
): BrowserSessionLeaf[] {
  const represented = new Set<string>();
  for (const item of live) {
    represented.add(item.lifecycleId);
    if (item.restoredFromLeafId) represented.add(item.restoredFromLeafId);
  }

  const seen = new Set<string>();
  const pending: BrowserSessionLeaf[] = [];
  for (const leaf of checkpoint.leaves) {
    if (represented.has(leaf.sourceLifecycleId) || seen.has(leaf.sourceLifecycleId)) continue;
    seen.add(leaf.sourceLifecycleId);
    pending.push(leaf);
  }
  return pending;
}
