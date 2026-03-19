import { extractFromFile, extractMediaFromFile } from "../iso/iso-metadata.js";
import { decodePmfNative, type PmfPlayer } from "./pmf-native.js";
import { transcodeAt3 } from "./pmf.js";

// ── IndexedDB helpers (idb-keyval pattern) ──────────────────────────────────

const DB_NAME = "pspjs-library";
const STORE = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Types ───────────────────────────────────────────────────────────────────

interface GameMeta {
  title: string;
  discId: string;
  iconDataUrl: string | null;
  fileName: string;
  fileSize: number;
}

// ── Metadata cache (localStorage) ───────────────────────────────────────────

function cacheKey(name: string, size: number): string {
  return `pspjs:lib:${name}:${size}`;
}

function getCached(name: string, size: number): GameMeta | null {
  try {
    const raw = localStorage.getItem(cacheKey(name, size));
    if (!raw) return null;
    const meta = JSON.parse(raw) as GameMeta;
    // Invalidate cache entries from old version that lack icons/titles
    if (!meta.iconDataUrl && meta.title === name.replace(/\.[^.]+$/, "")) return null;
    return meta;
  } catch {
    return null;
  }
}

function setCache(meta: GameMeta): void {
  try {
    localStorage.setItem(cacheKey(meta.fileName, meta.fileSize), JSON.stringify(meta));
  } catch { /* quota exceeded — non-fatal */ }
}

// ── ISO metadata extraction (delegates to shared iso-metadata module) ───────

async function extractIsoMetadata(file: File): Promise<GameMeta> {
  const partial = await extractFromFile(file);
  return {
    title: partial.title,
    discId: partial.discId,
    iconDataUrl: partial.iconDataUrl,
    fileName: file.name,
    fileSize: file.size,
  };
}

// ── Recursive directory scan ────────────────────────────────────────────────

const ISO_EXTENSIONS = new Set([".iso", ".pbp"]);

interface ScannedFile {
  file: File;
  handle: FileSystemFileHandle;
  parentDir: FileSystemDirectoryHandle;
}

async function scanDirectory(dirHandle: FileSystemDirectoryHandle): Promise<ScannedFile[]> {
  const results: ScannedFile[] = [];

  async function walk(handle: FileSystemDirectoryHandle): Promise<void> {
    for await (const entry of handle.values()) {
      if (entry.kind === "file") {
        const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
        if (ISO_EXTENSIONS.has(ext)) {
          try {
            const file = await (entry as FileSystemFileHandle).getFile();
            results.push({ file, handle: entry as FileSystemFileHandle, parentDir: handle });
          } catch { /* permission denied — skip */ }
        }
      } else if (entry.kind === "directory") {
        try {
          await walk(entry);
        } catch { /* permission denied — skip */ }
      }
    }
  }

  await walk(dirHandle);
  return results;
}

// ── Shadow DOM styles ───────────────────────────────────────────────────────

const STYLES = `
:host {
  display: block;
  width: 100%;
  height: 100%;
  background: #0d1117;
  color: #c9d1d9;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
}

.container {
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.header h2 {
  font-size: 18px;
  font-weight: 600;
  color: #c9d1d9;
}

.change-btn {
  background: transparent;
  border: 1px solid #30363d;
  color: #8b949e;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: border-color 0.15s, color 0.15s;
}
.change-btn:hover {
  border-color: #58a6ff;
  color: #58a6ff;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 80px 20px;
  text-align: center;
}

.empty__icon {
  font-size: 48px;
  opacity: 0.6;
}

.empty__label {
  font-size: 16px;
  color: #8b949e;
}

.select-btn {
  background: #58a6ff;
  border: none;
  color: #0d1117;
  padding: 10px 24px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.select-btn:hover {
  background: #79b8ff;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 20px;
}

.card {
  background: #161b22;
  border: 1px solid #21262d;
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s;
}
.card:hover {
  border-color: #58a6ff;
  transform: scale(1.03);
}


.card__body {
  padding: 8px 10px 10px;
}

.card__title {
  font-size: 13px;
  font-weight: 500;
  color: #c9d1d9;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 2px;
}

.card__disc-id {
  font-size: 11px;
  color: #8b949e;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
}

.card__media {
  position: relative;
  width: 100%;
  aspect-ratio: 144 / 80;
  overflow: hidden;
  background: linear-gradient(135deg, #1a1f2b 0%, #161b22 100%);
}

.card__media canvas,
.card__media video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.card__media .card__thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.card__media .card__fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #30363d;
  font-size: 32px;
}

.card__loading {
  position: absolute;
  bottom: 4px;
  right: 4px;
  width: 14px;
  height: 14px;
  border: 2px solid #21262d;
  border-top-color: #58a6ff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.spinner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 60px 20px;
}

.spinner__ring {
  width: 32px;
  height: 32px;
  border: 3px solid #21262d;
  border-top-color: #58a6ff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.spinner__text {
  font-size: 13px;
  color: #8b949e;
}

.fallback-input {
  margin-top: 8px;
}

.fallback-label {
  display: inline-block;
  background: transparent;
  border: 1px solid #30363d;
  color: #c9d1d9;
  padding: 8px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  transition: border-color 0.15s;
}
.fallback-label:hover {
  border-color: #58a6ff;
}
`;

// ── Web Component ───────────────────────────────────────────────────────────

export class GameLibrary extends HTMLElement {
  private root: ShadowRoot;
  private dirHandle: FileSystemDirectoryHandle | null = null;
  private games: GameMeta[] = [];
  private fileMap = new Map<string, File>();
  private fileHandleMap = new Map<string, FileSystemFileHandle>();
  private parentDirMap = new Map<string, FileSystemDirectoryHandle>();

  // Hover preview state
  private _hoverAbort: AbortController | null = null;
  private _hoverPmf: PmfPlayer | null = null;
  private _hoverAudio: HTMLAudioElement | null = null;
  private _hoverCard: HTMLElement | null = null;
  /** Cache: fileKey → { pmfData, at3Url } so we don't re-extract on re-hover */
  private _mediaCache = new Map<string, { pmfData: Uint8Array | null; at3Url: string | null }>();

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  connectedCallback(): void {
    this.render();
    void this.init();
  }

  private async init(): Promise<void> {
    // Try to restore saved directory handle
    const saved = await idbGet<FileSystemDirectoryHandle>("dirHandle");
    if (saved) {
      try {
        // Verify we still have permission
        const perm = await saved.requestPermission({ mode: "read" });
        if (perm === "granted") {
          this.dirHandle = saved;
          await this.scanAndDisplay();
          return;
        }
      } catch {
        // Permission lost or handle invalid
      }
    }
    this.renderEmpty();
  }

  async refresh(): Promise<void> {
    if (this.dirHandle) {
      await this.scanAndDisplay();
    }
  }

  /** Try to auto-select a game matching the given slug (discId or filename). */
  autoSelectBySlug(slug: string): boolean {
    if (!slug) return false;
    const slugLower = slug.toLowerCase();
    for (const game of this.games) {
      const discSlug = game.discId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const nameSlug = game.fileName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
      if (discSlug.toLowerCase() === slugLower || nameSlug.toLowerCase() === slugLower) {
        const fileKey = `${game.fileName}:${game.fileSize}`;
        void this._getFile(fileKey).then(file => {
          if (file) {
            this.dispatchEvent(new CustomEvent("game-select", {
              bubbles: true, composed: true, detail: { file },
            }));
          }
        });
        return true;
      }
    }
    return false;
  }

  private render(): void {
    this.root.innerHTML = `<style>${STYLES}</style><div class="container"></div>`;
  }

  private get container(): HTMLElement {
    return this.root.querySelector(".container")!;
  }

  private renderEmpty(): void {
    const hasApi = typeof window.showDirectoryPicker === "function";
    this.container.innerHTML = `
      <div class="empty">
        <div class="empty__icon">🎮</div>
        <p class="empty__label">Select a folder containing PSP games</p>
        ${hasApi ? `<button class="select-btn" data-action="pick">Select Games Folder</button>` : `
          <label class="fallback-label">
            Open ISO / PBP file
            <input type="file" accept=".iso,.ISO,.pbp,.PBP" multiple hidden />
          </label>
        `}
      </div>
    `;

    if (hasApi) {
      this.container.querySelector('[data-action="pick"]')!
        .addEventListener("click", () => void this.pickDirectory());
    } else {
      const input = this.container.querySelector('input[type="file"]') as HTMLInputElement;
      input.addEventListener("change", () => {
        if (input.files) this.handleFallbackFiles(input.files);
      });
    }
  }

  private renderSpinner(text: string): void {
    this.container.innerHTML = `
      <div class="spinner">
        <div class="spinner__ring"></div>
        <div class="spinner__text">${text}</div>
      </div>
    `;
  }

  private renderGrid(): void {
    const hasApi = typeof window.showDirectoryPicker === "function";
    let html = `<div class="header">
      <h2>Games (${this.games.length})</h2>
      <div>
        <button class="change-btn" data-action="refresh" style="margin-right:6px">Refresh</button>
        ${hasApi ? `<button class="change-btn" data-action="change">Change Folder</button>` : ""}
      </div>
    </div>`;

    if (this.games.length === 0) {
      html += `<div class="empty">
        <p class="empty__label">No ISO or PBP files found in this folder</p>
        ${hasApi ? `<button class="select-btn" data-action="change">Choose Another Folder</button>` : ""}
      </div>`;
    } else {
      html += `<div class="grid">`;
      for (const game of this.games) {
        const thumb = game.iconDataUrl
          ? `<img class="card__thumb" src="${game.iconDataUrl}" alt="" />`
          : `<div class="card__fallback">💿</div>`;
        html += `
          <div class="card" data-file="${this.escAttr(game.fileName)}" data-size="${game.fileSize}">
            <div class="card__media">${thumb}</div>
            <div class="card__body">
              <div class="card__title">${this.escHtml(game.title)}</div>
              <div class="card__disc-id">${this.escHtml(game.discId || "\u00a0")}</div>
            </div>
          </div>
        `;
      }
      html += `</div>`;
    }

    this.container.innerHTML = html;

    // Bind events
    for (const card of this.container.querySelectorAll(".card")) {
      card.addEventListener("click", () => {
        this._stopHoverPreview();

        const fileName = (card as HTMLElement).dataset.file!;
        const fileSize = Number((card as HTMLElement).dataset.size!);
        const fileKey = `${fileName}:${fileSize}`;
        void this._getFile(fileKey).then(file => {
          if (file) {
            this.dispatchEvent(new CustomEvent("game-select", {
              bubbles: true,
              composed: true,
              detail: { file, parentDir: this.parentDirMap.get(fileKey) ?? null },
            }));
          }
        });
      });
    }

    // Hover preview: mouseenter → start, mouseleave → stop
    for (const card of this.container.querySelectorAll(".card")) {
      card.addEventListener("mouseenter", () => void this._startHoverPreview(card as HTMLElement));
      card.addEventListener("mouseleave", () => this._stopHoverPreview());
    }

    this.container.querySelector('[data-action="change"]')
      ?.addEventListener("click", () => void this.pickDirectory());
    this.container.querySelector('[data-action="refresh"]')
      ?.addEventListener("click", () => void this.refresh());
  }

  private async pickDirectory(): Promise<void> {
    try {
      this.dirHandle = await window.showDirectoryPicker({ mode: "read" });
      await idbSet("dirHandle", this.dirHandle);
      await this.scanAndDisplay();
    } catch (err) {
      // User cancelled the picker — if we have no games, show empty state
      if (this.games.length === 0) this.renderEmpty();
    }
  }

  private async scanAndDisplay(): Promise<void> {
    if (!this.dirHandle) return;
    this.renderSpinner("Scanning for games...");

    let scanned: ScannedFile[];
    try {
      scanned = await scanDirectory(this.dirHandle);
    } catch {
      this.renderEmpty();
      return;
    }

    scanned.sort((a, b) => a.file.name.localeCompare(b.file.name));

    this.games = [];
    this.fileMap.clear();
    this.fileHandleMap.clear();
    this.parentDirMap.clear();

    for (let i = 0; i < scanned.length; i++) {
      const { file, handle, parentDir } = scanned[i]!;
      this.renderSpinner(`Scanning ${i + 1} / ${scanned.length}: ${file.name}`);
      const key = `${file.name}:${file.size}`;
      this.fileMap.set(key, file);
      this.fileHandleMap.set(key, handle);
      this.parentDirMap.set(key, parentDir);

      const cached = getCached(file.name, file.size);
      if (cached) {
        this.games.push(cached);
        continue;
      }

      const meta = await extractIsoMetadata(file);
      setCache(meta);
      this.games.push(meta);
    }

    this.renderGrid();

    // If the URL hash references a specific game, auto-select it
    const hash = location.hash.replace(/^#/, "");
    const match = hash.match(/^(?:game|play)\/(.+)$/);
    if (match) {
      this.autoSelectBySlug(match[1]!);
    }
  }

  private handleFallbackFiles(fileList: FileList): void {
    // For browsers without showDirectoryPicker, treat selected files directly
    const files = Array.from(fileList);
    if (files.length === 1) {
      // Single file: emit directly
      this.dispatchEvent(new CustomEvent("game-select", {
        bubbles: true,
        composed: true,
        detail: { file: files[0] },
      }));
      return;
    }

    // Multiple files: scan metadata and show grid
    this.fileMap.clear();
    this.games = [];
    for (const f of files) this.fileMap.set(`${f.name}:${f.size}`, f);

    void (async () => {
      this.renderSpinner("Reading game metadata...");
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        this.renderSpinner(`Scanning ${i + 1} / ${files.length}: ${file.name}`);
        const cached = getCached(file.name, file.size);
        if (cached) { this.games.push(cached); continue; }
        const meta = await extractIsoMetadata(file);
        setCache(meta);
        this.games.push(meta);
      }
      this.renderGrid();
    })();
  }

  // ── Hover preview ──────────────────────────────────────────────────────────

  private async _startHoverPreview(card: HTMLElement): Promise<void> {
    // Stop any existing preview
    this._stopHoverPreview();

    const fileName = card.dataset.file!;
    const fileSize = Number(card.dataset.size!);
    const fileKey = `${fileName}:${fileSize}`;
    const file = await this._getFile(fileKey);
    if (!file) return;

    this._hoverCard = card;
    const abort = new AbortController();
    this._hoverAbort = abort;

    const mediaEl = card.querySelector(".card__media")!;

    // Check cache first
    let cached = this._mediaCache.get(fileKey);
    if (!cached) {
      // Show loading indicator
      const spinner = document.createElement("div");
      spinner.className = "card__loading";
      mediaEl.appendChild(spinner);

      try {
        const media = await extractMediaFromFile(file);
        if (abort.signal.aborted) return;

        // Transcode AT3 to playable URL
        let at3Url: string | null = null;
        if (media.at3) {
          try {
            at3Url = await transcodeAt3(media.at3);
          } catch { /* non-fatal */ }
        }
        if (abort.signal.aborted) { if (at3Url) URL.revokeObjectURL(at3Url); return; }

        cached = { pmfData: media.pmf, at3Url };
        this._mediaCache.set(fileKey, cached);
      } catch {
        return;
      } finally {
        spinner.remove();
      }
    }

    if (abort.signal.aborted) return;

    // Play PMF video
    if (cached.pmfData) {
      try {
        const player = await decodePmfNative(cached.pmfData);
        if (abort.signal.aborted) { player.stop(); return; }
        this._hoverPmf = player;
        // Insert canvas into card media area
        player.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1";
        mediaEl.appendChild(player.canvas);
        player.play();
      } catch { /* non-fatal */ }
    }

    // Play SND0 audio
    if (cached.at3Url) {
      const audio = new Audio(cached.at3Url);
      audio.loop = true;
      audio.volume = 0.5;
      this._hoverAudio = audio;
      audio.play().catch(() => {}); // may fail without user gesture
    }
  }

  private _stopHoverPreview(): void {
    this._hoverAbort?.abort();
    this._hoverAbort = null;

    if (this._hoverPmf) {
      this._hoverPmf.stop();
      this._hoverPmf.canvas.remove();
      this._hoverPmf = null;
    }

    if (this._hoverAudio) {
      this._hoverAudio.pause();
      this._hoverAudio.currentTime = 0;
      this._hoverAudio = null;
    }

    this._hoverCard = null;
  }

  /** Get a fresh File — prefer re-acquiring from FileSystemFileHandle (survives page lifecycle). */
  private async _getFile(fileKey: string): Promise<File | null> {
    const handle = this.fileHandleMap.get(fileKey);
    if (handle) {
      try {
        return await handle.getFile();
      } catch { /* permission lost */ }
    }
    return this.fileMap.get(fileKey) ?? null;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  private escAttr(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

customElements.define("game-library", GameLibrary);

// ── Type augmentation for File System Access API ────────────────────────────

declare global {
  interface Window {
    showDirectoryPicker(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
    requestPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  }
}
