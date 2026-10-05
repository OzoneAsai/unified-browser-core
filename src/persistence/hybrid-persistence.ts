import type { BrowserCoreState, HistoryGraphState } from "../core/model";

type HeavyState = Pick<BrowserCoreState, "history" | "restoreCapsules" | "formRecovery">;
type HeavyEnvelope = { revision: number; state: HeavyState };
type HistorySnapshotEnvelope = {
  capturedAt: number;
  sourceRevision: number;
  history: HistoryGraphState;
};
type PersistedLightState = Partial<BrowserCoreState> & {
  __hybridRevision?: number;
  __hybridHeavyFallback?: boolean;
};

type DataPort = {
  load(): Promise<PersistedLightState | null>;
  save(value: PersistedLightState): Promise<void>;
};

export interface HistoryVersionSummary {
  id: string;
  capturedAt: number;
  sourceRevision: number;
  navigationCount: number;
  leafCount: number;
  source: "snapshot" | "generation" | "legacy";
  current: boolean;
}

export class HybridBrowserPersistence {
  private revision = 0;
  private saveQueue: Promise<void> = Promise.resolve();
  private lastHistorySnapshotAt = 0;

  constructor(
    private readonly scope: string,
    private readonly dataPort: DataPort,
  ) {}

  async load(): Promise<Partial<BrowserCoreState> | null> {
    const lightweight = await this.dataPort.load();
    const lightRevision = lightweight?.__hybridRevision;
    const heavy = lightweight?.__hybridHeavyFallback
      ? null
      : await this.loadHeavy(lightRevision);
    if (!lightweight && !heavy) return null;
    if (typeof lightRevision === "number") this.revision = Math.max(this.revision, lightRevision);
    if (heavy) this.revision = Math.max(this.revision, heavy.revision);
    const cleanLightweight = stripHybridMetadata(lightweight);
    if (lightweight?.__hybridHeavyFallback) return cleanLightweight;
    if (!heavy) return cleanLightweight;
    if (typeof lightRevision === "number" && heavy.revision !== lightRevision) {
      console.warn(
        "Unified Browser Core: recovering heavy browser state from revision",
        heavy.revision,
        "instead of missing revision",
        lightRevision,
      );
    }
    return {
      ...(cleanLightweight ?? {}),
      ...heavy.state,
    };
  }

  save(state: BrowserCoreState): Promise<void> {
    const next = this.saveQueue.then(() => this.saveNow(state));
    this.saveQueue = next.catch(() => undefined);
    return next;
  }

  async archiveExistingHistoryVersions(): Promise<number> {
    if (typeof indexedDB === "undefined") return 0;
    let db: IDBDatabase | undefined;
    try {
      const database = await openDb();
      db = database;
      const generations = await new Promise<HeavyEnvelope[]>((resolve, reject) => {
        const tx = database.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).openCursor();
        const found: HeavyEnvelope[] = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(found);
            return;
          }
          const key = String(cursor.key);
          if (key === this.scope || this.isGenerationKey(key)) {
            const heavy = normalizeHeavyEnvelope(cursor.value as unknown);
            if (heavy && Object.values(heavy.state.history.nodes).some((node) => node.kind === "navigation")) {
              found.push(heavy);
            }
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      if (!generations.length) return 0;

      let syntheticCapturedAt = Math.max(Date.now(), this.lastHistorySnapshotAt + 1);
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const generation of generations) {
          const timestamp = revisionTimestamp(generation.revision);
          const capturedAt = timestamp || syntheticCapturedAt++;
          const envelope: HistorySnapshotEnvelope = {
            capturedAt,
            sourceRevision: generation.revision,
            history: generation.state.history,
          };
          store.put(envelope, this.historySnapshotKey(capturedAt));
          this.lastHistorySnapshotAt = Math.max(this.lastHistorySnapshotAt, capturedAt);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      await this.pruneHistorySnapshots();
      return generations.length;
    } catch {
      return 0;
    } finally {
      db?.close();
    }
  }

  async captureHistoryVersion(history: HistoryGraphState): Promise<boolean> {
    if (typeof indexedDB === "undefined" || Object.keys(history.nodes).length === 0) return false;

    // Clone before the first await so shutdown-time mutations cannot change
    // the snapshot while IndexedDB is opening.
    const snapshot = structuredClone(history);
    const capturedAt = Math.max(Date.now(), this.lastHistorySnapshotAt + 1);
    const envelope: HistorySnapshotEnvelope = {
      capturedAt,
      sourceRevision: this.revision,
      history: snapshot,
    };
    let db: IDBDatabase | undefined;
    try {
      const database = await openDb();
      db = database;
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(envelope, this.historySnapshotKey(capturedAt));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      this.lastHistorySnapshotAt = capturedAt;
      await this.pruneHistorySnapshots();
      return true;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }

  async listHistoryVersions(): Promise<HistoryVersionSummary[]> {
    if (typeof indexedDB === "undefined") return [];
    const versions: HistoryVersionSummary[] = [];
    let db: IDBDatabase | undefined;
    try {
      const database = await openDb();
      db = database;
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const key = String(cursor.key);
          const value = cursor.value as unknown;

          if (this.isHistorySnapshotKey(key) && isHistorySnapshotEnvelope(value)) {
            versions.push(summarizeHistoryVersion(
              "snapshot:" + value.capturedAt,
              value.capturedAt,
              value.sourceRevision,
              value.history,
              "snapshot",
              false,
            ));
            this.lastHistorySnapshotAt = Math.max(this.lastHistorySnapshotAt, value.capturedAt);
          } else if (this.isGenerationKey(key)) {
            const heavy = normalizeHeavyEnvelope(value);
            if (heavy) {
              versions.push(summarizeHistoryVersion(
                "generation:" + heavy.revision,
                revisionTimestamp(heavy.revision),
                heavy.revision,
                heavy.state.history,
                "generation",
                heavy.revision === this.revision,
              ));
            }
          } else if (key === this.scope) {
            const heavy = normalizeHeavyEnvelope(value);
            if (heavy) {
              versions.push(summarizeHistoryVersion(
                "legacy",
                revisionTimestamp(heavy.revision),
                heavy.revision,
                heavy.state.history,
                "legacy",
                heavy.revision === this.revision,
              ));
            }
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      return versions
        .filter((version) => version.navigationCount > 0)
        .sort((a, b) => b.capturedAt - a.capturedAt || b.sourceRevision - a.sourceRevision);
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  async loadHistoryVersion(id: string): Promise<HistoryGraphState | null> {
    if (typeof indexedDB === "undefined") return null;
    let key: string;
    let kind: "snapshot" | "generation" | "legacy";
    if (id === "legacy") {
      key = this.scope;
      kind = "legacy";
    } else if (id.startsWith("snapshot:")) {
      const capturedAt = Number(id.slice("snapshot:".length));
      if (!Number.isFinite(capturedAt) || capturedAt <= 0) return null;
      key = this.historySnapshotKey(capturedAt);
      kind = "snapshot";
    } else if (id.startsWith("generation:")) {
      const revision = Number(id.slice("generation:".length));
      if (!Number.isFinite(revision) || revision < 0) return null;
      key = this.generationKey(revision);
      kind = "generation";
    } else {
      return null;
    }

    let db: IDBDatabase | undefined;
    try {
      const database = await openDb();
      db = database;
      const value = await new Promise<unknown>((resolve, reject) => {
        const tx = database.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (kind === "snapshot") {
        return isHistorySnapshotEnvelope(value) ? value.history : null;
      }
      const heavy = normalizeHeavyEnvelope(value);
      return heavy?.state.history ?? null;
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }

  private async saveNow(state: BrowserCoreState): Promise<void> {
    const previousRevision = this.revision;
    const revision = Math.max(Date.now(), this.revision + 1);
    const heavy: HeavyState = {
      history: state.history,
      restoreCapsules: state.restoreCapsules,
      formRecovery: state.formRecovery,
    };
    const lightweight: PersistedLightState = {
      version: state.version,
      settings: state.settings,
      siteZoom: state.siteZoom,
      containers: state.containers,
      siteContainerRules: state.siteContainerRules,
      bookmarks: state.bookmarks,
      permissions: state.permissions,
      formRecoveryPolicies: state.formRecoveryPolicies,
      sessionCheckpoint: state.sessionCheckpoint,
      surfingMigration: state.surfingMigration,
      __hybridRevision: revision,
      __hybridHeavyFallback: false,
    };

    if (await this.saveHeavy({ revision, state: heavy })) {
      try {
        await this.dataPort.save(lightweight);
        this.revision = revision;
        await this.pruneHeavy(revision);
        return;
      } catch (error) {
        await this.deleteHeavy(revision);
        this.revision = previousRevision;
        throw error;
      }
    }

    // IndexedDB can be unavailable in unusual host contexts. Preserve data
    // rather than silently dropping it, even though this fallback is heavier.
    await this.dataPort.save({
      ...state,
      __hybridRevision: revision,
      __hybridHeavyFallback: true,
    });
    this.revision = revision;
  }

  private async loadHeavy(revision?: number): Promise<HeavyEnvelope | null> {
    if (typeof indexedDB === "undefined") return null;
    let db: IDBDatabase | undefined;
    try {
      const database = await openDb();
      db = database;
      const read = (key: string): Promise<unknown> => new Promise((resolve, reject) => {
        const tx = database.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).get(key);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
      const readLatestGeneration = (): Promise<HeavyEnvelope | null> => new Promise((resolve, reject) => {
        const tx = database.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).openCursor();
        let latest: HeavyEnvelope | null = null;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(latest);
            return;
          }
          const key = String(cursor.key);
          const candidate = this.isGenerationKey(key)
            ? normalizeHeavyEnvelope(cursor.value as unknown)
            : null;
          if (candidate && (!latest || candidate.revision > latest.revision)) latest = candidate;
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });

      if (typeof revision === "number") {
        const exact = normalizeHeavyEnvelope(await read(this.generationKey(revision)));
        if (exact) return exact;
      }

      const legacy = normalizeHeavyEnvelope(await read(this.scope));
      if (legacy && (typeof revision !== "number" || legacy.revision === revision)) return legacy;

      // The lightweight commit and IndexedDB generation can diverge if an
      // older build was interrupted or overlapping saves completed out of
      // order. Heavy browser data is independently valid, so recover the
      // newest surviving generation instead of normalizing history to empty.
      return await readLatestGeneration() ?? legacy;
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }

  private async saveHeavy(envelope: HeavyEnvelope): Promise<boolean> {
    if (typeof indexedDB === "undefined") return false;
    let db: IDBDatabase | undefined;
    try {
      const database = await openDb();
      db = database;
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(envelope, this.generationKey(envelope.revision));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return true;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }

  private async deleteHeavy(revision: number): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    let db: IDBDatabase | undefined;
    try {
      const database = await openDb();
      db = database;
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(this.generationKey(revision));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      // Orphaned generations are harmless and can be pruned by a later save.
    } finally {
      db?.close();
    }
  }

  private async pruneHeavy(keepRevision: number): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    let db: IDBDatabase | undefined;
    try {
      const database = await openDb();
      db = database;
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const key = String(cursor.key);
          if (
            key === this.scope ||
            (
              this.isGenerationKey(key) &&
              key !== this.generationKey(keepRevision)
            )
          ) {
            cursor.delete();
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      // Cleanup failure must not invalidate an already committed generation.
    } finally {
      db?.close();
    }
  }

  private async pruneHistorySnapshots(): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    let db: IDBDatabase | undefined;
    try {
      const database = await openDb();
      db = database;
      const keys = await new Promise<Array<{ key: string; capturedAt: number }>>((resolve, reject) => {
        const tx = database.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).openCursor();
        const found: Array<{ key: string; capturedAt: number }> = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(found);
            return;
          }
          const key = String(cursor.key);
          if (this.isHistorySnapshotKey(key) && isHistorySnapshotEnvelope(cursor.value as unknown)) {
            found.push({ key, capturedAt: cursor.value.capturedAt });
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      const remove = keys
        .sort((a, b) => b.capturedAt - a.capturedAt)
        .slice(HISTORY_SNAPSHOT_LIMIT);
      if (!remove.length) return;
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const entry of remove) store.delete(entry.key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      // Snapshot cleanup is best-effort; recovery data is safer left behind.
    } finally {
      db?.close();
    }
  }

  private generationKey(revision: number): string {
    return this.scope + ":" + revision;
  }

  private isGenerationKey(key: string): boolean {
    const prefix = this.scope + ":";
    if (!key.startsWith(prefix)) return false;
    const suffix = key.slice(prefix.length);
    return /^\d+$/.test(suffix);
  }

  private historySnapshotKey(capturedAt: number): string {
    return this.scope + ":history:" + capturedAt;
  }

  private isHistorySnapshotKey(key: string): boolean {
    const prefix = this.scope + ":history:";
    if (!key.startsWith(prefix)) return false;
    return /^\d+$/.test(key.slice(prefix.length));
  }
}

function normalizeHeavyEnvelope(value: unknown): HeavyEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<HeavyEnvelope> & Partial<HeavyState>;
  if (typeof raw.revision === "number" && raw.state && typeof raw.state === "object") {
    return raw as HeavyEnvelope;
  }
  if (raw.history && raw.restoreCapsules && raw.formRecovery) {
    return { revision: 0, state: raw as HeavyState };
  }
  return null;
}

function isHistorySnapshotEnvelope(value: unknown): value is HistorySnapshotEnvelope {
  if (!value || typeof value !== "object") return false;
  const raw = value as Partial<HistorySnapshotEnvelope>;
  return typeof raw.capturedAt === "number"
    && typeof raw.sourceRevision === "number"
    && Boolean(raw.history && typeof raw.history === "object");
}

function summarizeHistoryVersion(
  id: string,
  capturedAt: number,
  sourceRevision: number,
  history: HistoryGraphState,
  source: HistoryVersionSummary["source"],
  current: boolean,
): HistoryVersionSummary {
  return {
    id,
    capturedAt,
    sourceRevision,
    navigationCount: Object.values(history.nodes).filter((node) => node.kind === "navigation").length,
    leafCount: Object.keys(history.leaves).length,
    source,
    current,
  };
}

function revisionTimestamp(revision: number): number {
  return revision >= 1_000_000_000_000 ? revision : 0;
}

function stripHybridMetadata(value: PersistedLightState | null): Partial<BrowserCoreState> | null {
  if (!value) return null;
  const { __hybridRevision: _revision, __hybridHeavyFallback: _fallback, ...state } = value;
  return state;
}

const DB_NAME = "unified-browser-core";
const STORE = "heavy-state";
const HISTORY_SNAPSHOT_LIMIT = 16;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
