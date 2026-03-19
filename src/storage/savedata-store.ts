/**
 * Persistent save data storage backed by IndexedDB (browser) or in-memory Map (Node.js).
 */

export interface SaveEntry {
  key: string;
  data: Uint8Array;
  dataSize: number;
  title: string;
  detail: string;
  timestamp: number;
}

export interface SavedataStore {
  save(key: string, entry: SaveEntry): Promise<void>;
  load(key: string): Promise<SaveEntry | null>;
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<SaveEntry[]>;
  exists(key: string): Promise<boolean>;
  /** Synchronous variants for use in HLE handlers (avoids microtask delay). */
  saveSync?(key: string, entry: SaveEntry): void;
  loadSync?(key: string): SaveEntry | null;
  deleteSync?(key: string): boolean;
  listSync?(prefix: string): SaveEntry[];
  existsSync?(key: string): boolean;
}

/** In-memory fallback (Node.js / tests / private browsing) */
export class MemorySavedataStore implements SavedataStore {
  private map = new Map<string, SaveEntry>();
  async save(key: string, entry: SaveEntry) { this.map.set(key, entry); }
  async load(key: string) { return this.map.get(key) ?? null; }
  async delete(key: string) { return this.map.delete(key); }
  async list(prefix: string) {
    const results: SaveEntry[] = [];
    for (const [k, v] of this.map) { if (k.startsWith(prefix)) results.push(v); }
    return results;
  }
  async exists(key: string) { return this.map.has(key); }
  // Synchronous variants (identical logic, no Promise wrapper)
  saveSync(key: string, entry: SaveEntry) { this.map.set(key, entry); }
  loadSync(key: string) { return this.map.get(key) ?? null; }
  deleteSync(key: string) { return this.map.delete(key); }
  listSync(prefix: string) {
    const results: SaveEntry[] = [];
    for (const [k, v] of this.map) { if (k.startsWith(prefix)) results.push(v); }
    return results;
  }
  existsSync(key: string) { return this.map.has(key); }
}

/** IndexedDB-backed store for browser persistence */
export class IdbSavedataStore implements SavedataStore {
  private db: IDBDatabase | null = null;
  private static readonly DB_NAME = "psp-js-savedata";
  private static readonly STORE_NAME = "saves";

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IdbSavedataStore.DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IdbSavedataStore.STORE_NAME, { keyPath: "key" });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db!.transaction(IdbSavedataStore.STORE_NAME, mode)
      .objectStore(IdbSavedataStore.STORE_NAME);
  }

  async save(key: string, entry: SaveEntry): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = this.tx("readwrite").put({ ...entry, key });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async load(key: string): Promise<SaveEntry | null> {
    return new Promise((resolve, reject) => {
      const req = this.tx("readonly").get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(key: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const store = this.tx("readwrite");
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        if (!getReq.result) { resolve(false); return; }
        const delReq = store.delete(key);
        delReq.onsuccess = () => resolve(true);
        delReq.onerror = () => reject(delReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async list(prefix: string): Promise<SaveEntry[]> {
    return new Promise((resolve, reject) => {
      const results: SaveEntry[] = [];
      const req = this.tx("readonly").openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          if ((cursor.value as SaveEntry).key.startsWith(prefix)) results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async exists(key: string): Promise<boolean> {
    return (await this.load(key)) !== null;
  }
}

/** Create the appropriate store for the current environment */
export async function createSavedataStore(): Promise<SavedataStore> {
  if (typeof indexedDB !== "undefined") {
    try {
      const store = new IdbSavedataStore();
      await store.open();
      return store;
    } catch {
      return new MemorySavedataStore();
    }
  }
  return new MemorySavedataStore();
}
