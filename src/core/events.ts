import type { BookmarkEntry, BookmarkFolder, BrowserLeafRecord, NavigationNode } from "./model";

export type BookmarkChangeEvent =
  | { action: "added" | "updated" | "moved" | "deleted"; kind: "bookmark"; id: string; entry?: BookmarkEntry }
  | { action: "added" | "updated" | "moved" | "deleted" | "sorted"; kind: "folder"; id: string; entry?: BookmarkFolder };

export interface BrowserCoreEventMap {
  "leaf-opened": BrowserLeafRecord;
  "leaf-closed": BrowserLeafRecord;
  "navigation-committed": NavigationNode;
  "bookmark-changed": BookmarkChangeEvent;
}

export class BrowserEventBus {
  private readonly listeners = new Map<keyof BrowserCoreEventMap, Set<(payload: unknown) => void>>();

  on<K extends keyof BrowserCoreEventMap>(event: K, callback: (payload: BrowserCoreEventMap[K]) => void): () => void {
    const bucket = this.listeners.get(event) ?? new Set<(payload: unknown) => void>();
    bucket.add(callback as (payload: unknown) => void);
    this.listeners.set(event, bucket);
    return () => {
      bucket.delete(callback as (payload: unknown) => void);
      if (bucket.size === 0) this.listeners.delete(event);
    };
  }

  emit<K extends keyof BrowserCoreEventMap>(event: K, payload: BrowserCoreEventMap[K]): void {
    for (const callback of this.listeners.get(event) ?? []) callback(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}
