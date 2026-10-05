import type { BrowserCoreState } from "../core/model";

type HeavyState = Pick<BrowserCoreState, "history" | "restoreCapsules" | "formRecovery">;
type HeavyEnvelope = { revision: number; state: HeavyState };
type PersistedLightState = Partial<BrowserCoreState> & {
  __hybridRevision?: number;
  __hybridHeavyFallback?: boolean;
};

type DataPort = {
  load(): Promise<PersistedLightState | null>;
  save(value: PersistedLightState): Promise<void>;
};

export class HybridBrowserPersistence {
  private revision = 0;
  private saveQueue: Promise<void> = Promise.resolve();

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
      const read = (key: string): Promise<HeavyEnvelope | HeavyState | null> => new Promise((resolve, reject) => {
        const tx = database.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).get(key);
        request.onsuccess = () => resolve((request.result as HeavyEnvelope | HeavyState | undefined) ?? null);
        request.onerror = () => reject(request.error);
      });
      const normalize = (raw: HeavyEnvelope | HeavyState | null): HeavyEnvelope | null => {
        if (!raw) return null;
        if ("revision" in raw && "state" in raw) return raw as HeavyEnvelope;
        return { revision: 0, state: raw as HeavyState };
      };
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
          const value = cursor.value as HeavyEnvelope | HeavyState | undefined;
          if (key.startsWith(this.scope + ":") && value && "revision" in value && "state" in value) {
            const candidate = value as HeavyEnvelope;
            if (!latest || candidate.revision > latest.revision) latest = candidate;
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });

      if (typeof revision === "number") {
        const exact = normalize(await read(this.generationKey(revision)));
        if (exact) return exact;
      }

      const legacy = normalize(await read(this.scope));
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
              key.startsWith(this.scope + ":") &&
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

  private generationKey(revision: number): string {
    return this.scope + ":" + revision;
  }
}

function stripHybridMetadata(value: PersistedLightState | null): Partial<BrowserCoreState> | null {
  if (!value) return null;
  const { __hybridRevision: _revision, __hybridHeavyFallback: _fallback, ...state } = value;
  return state;
}

const DB_NAME = "unified-browser-core";
const STORE = "heavy-state";

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
