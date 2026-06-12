/**
 * Persistent storage for raw file IO (sceIoWrite to ms0:/PSP/SAVEDATA/...).
 *
 * Separate from SavedataStore (which holds whole-save blobs keyed by
 * gameName/saveName for the sceUtilitySavedata dialog). This one is keyed by
 * full file path and backs games that manage their own save files via the
 * plain sceIoOpen/Write API. Kept in its own IndexedDB database so raw files
 * don't show up in the dialog-save list UI.
 */

export interface FileStore {
  /** Load every persisted file as path → bytes. Called once at boot. */
  loadAll(): Promise<Map<string, Uint8Array>>;
  /** Write (or overwrite) a file. */
  put(path: string, data: Uint8Array): Promise<void>;
  /** Delete a file. Resolves true if it existed. */
  remove(path: string): Promise<boolean>;
}

/** In-memory fallback (Node.js / tests / private browsing). */
export class MemoryFileStore implements FileStore {
  private map = new Map<string, Uint8Array>();
  async loadAll() { return new Map(this.map); }
  async put(path: string, data: Uint8Array) { this.map.set(path, data.slice()); }
  async remove(path: string) { return this.map.delete(path); }
}

/** IndexedDB-backed store for browser persistence. */
export class IdbFileStore implements FileStore {
  private db: IDBDatabase | null = null;
  private static readonly DB_NAME = "psp-js-files";
  private static readonly STORE_NAME = "files";

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IdbFileStore.DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IdbFileStore.STORE_NAME, { keyPath: "path" });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db!.transaction(IdbFileStore.STORE_NAME, mode)
      .objectStore(IdbFileStore.STORE_NAME);
  }

  async loadAll(): Promise<Map<string, Uint8Array>> {
    return new Promise((resolve, reject) => {
      const out = new Map<string, Uint8Array>();
      const req = this.tx("readonly").openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const rec = cursor.value as { path: string; data: Uint8Array };
          out.set(rec.path, rec.data);
          cursor.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async put(path: string, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      // Copy so a later in-place grow of the live buffer can't corrupt the stored record.
      const req = this.tx("readwrite").put({ path, data: data.slice() });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async remove(path: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const store = this.tx("readwrite");
      const getReq = store.get(path);
      getReq.onsuccess = () => {
        if (!getReq.result) { resolve(false); return; }
        const delReq = store.delete(path);
        delReq.onsuccess = () => resolve(true);
        delReq.onerror = () => reject(delReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }
}

/** Create the appropriate store for the current environment. */
export async function createFileStore(): Promise<FileStore> {
  if (typeof indexedDB !== "undefined") {
    try {
      const store = new IdbFileStore();
      await store.open();
      return store;
    } catch {
      return new MemoryFileStore();
    }
  }
  return new MemoryFileStore();
}
