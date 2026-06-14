import { LitElement, html, css, nothing, type PropertyValues, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { extractMediaFromFile } from "../iso/iso-metadata.js";
import { decodePmfNative, type PmfPlayer } from "./pmf-native.js";
import { transcodeAt3 } from "./pmf.js";
import { idbGet, idbSet } from "./lib/idb.js";
import { type GameMeta, getCachedMeta, setCachedMeta, extractIsoMetadata } from "./lib/game-metadata.js";
import { scanDirectory, type ScannedFile } from "./lib/iso-scan.js";

// ── Web Component (Lit) ─────────────────────────────────────────────────────

export class GameLibrary extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background: #0d1117;
      color: var(--text-dim, #c9d1d9);
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
      color: var(--text-dim, #c9d1d9);
    }

    .header__controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .search {
      background: #0b0e14;
      border: 1px solid var(--border, #2a313c);
      color: var(--text, #e6edf3);
      padding: 7px 12px;
      border-radius: 8px;
      font-size: 13px;
      width: 200px;
      max-width: 46vw;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .search::placeholder { color: var(--faint, #6e7681); }
    .search:focus { border-color: var(--accent, #58a6ff); box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.15); }

    .sort {
      background: var(--surface-2, #1c232d);
      border: 1px solid var(--border, #2a313c);
      color: var(--text-dim, #c9d1d9);
      padding: 7px 10px;
      border-radius: 8px;
      font-size: 13px;
      cursor: pointer;
    }
    .sort:hover { border-color: var(--accent, #58a6ff); }

    .change-btn {
      background: transparent;
      border: 1px solid #30363d;
      color: var(--muted, #8b949e);
      padding: 7px 14px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      transition: border-color 0.15s, color 0.15s;
    }
    .change-btn:hover {
      border-color: var(--accent, #58a6ff);
      color: var(--accent, #58a6ff);
    }

    .empty-filter {
      padding: 60px 20px;
      text-align: center;
      color: var(--muted, #8b949e);
      font-size: 14px;
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


    .empty__label {
      font-size: 16px;
      color: var(--muted, #8b949e);
    }

    .select-btn {
      background: var(--accent, #58a6ff);
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
      background: var(--surface, #161b22);
      border: 1px solid var(--border-soft, #21262d);
      border-radius: 10px;
      overflow: hidden;
      cursor: pointer;
      transition: border-color 0.15s, transform 0.15s;
    }
    .card:hover {
      border-color: var(--accent, #58a6ff);
      transform: scale(1.03);
    }


    .card__body {
      padding: 8px 10px 10px;
    }

    .card__title {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-dim, #c9d1d9);
      line-height: 1.3;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin-bottom: 2px;
    }

    .card__disc-id {
      font-size: 11px;
      color: var(--muted, #8b949e);
      font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    }

    .card__media {
      position: relative;
      width: 100%;
      aspect-ratio: 144 / 80;
      overflow: hidden;
      background: linear-gradient(135deg, #1a1f2b 0%, var(--surface, #161b22) 100%);
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

    /* Play affordance — appears over the art on hover */
    .card__play {
      position: absolute;
      inset: 0;
      margin: auto;
      width: 46px;
      height: 46px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 50%;
      background: rgba(88, 166, 255, 0.92);
      color: #07101f;
      opacity: 0;
      transform: scale(0.8);
      transition: opacity 0.15s, transform 0.15s;
      pointer-events: none;
      z-index: 2;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
    }
    /* Play triangle drawn in CSS (no emoji glyph) */
    .card__play::before {
      content: "";
      width: 0;
      height: 0;
      border-style: solid;
      border-width: 8px 0 8px 13px;
      border-color: transparent transparent transparent currentColor;
      margin-left: 3px;
    }
    .card:hover .card__play { opacity: 1; transform: scale(1); }

    /* Gear — opens boot options without booting */
    .card__gear {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 7px;
      background: rgba(13, 17, 23, 0.72);
      backdrop-filter: blur(4px);
      color: var(--text-dim, #c9d1d9);
      font-size: 14px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s, background 0.15s, color 0.15s, border-color 0.15s;
      z-index: 3;
    }
    .card:hover .card__gear { opacity: 1; }
    .card__gear:hover { background: var(--surface-2, #1c232d); color: var(--accent, #58a6ff); border-color: var(--accent, #58a6ff); }

    .card__loading {
      position: absolute;
      bottom: 4px;
      right: 4px;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border-soft, #21262d);
      border-top-color: var(--accent, #58a6ff);
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
      border: 3px solid var(--border-soft, #21262d);
      border-top-color: var(--accent, #58a6ff);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .spinner__text {
      font-size: 13px;
      color: var(--muted, #8b949e);
    }

    .fallback-label {
      display: inline-block;
      background: transparent;
      border: 1px solid #30363d;
      color: var(--text-dim, #c9d1d9);
      padding: 8px 18px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      transition: border-color 0.15s;
    }
    .fallback-label:hover {
      border-color: var(--accent, #58a6ff);
    }
  `;

  // Reactive view state. Declared (not initialized as class fields) so the field
  // initializers don't shadow Lit's reactive accessors under useDefineForClassFields.
  static override properties = {
    view: { state: true },
    spinnerText: { state: true },
    games: { state: true },
    _filter: { state: true },
    _sort: { state: true },
  };
  declare view: "empty" | "spinner" | "grid";
  declare spinnerText: string;
  declare games: GameMeta[];
  declare _filter: string;
  declare _sort: "title" | "size";

  // Non-reactive internal state.
  private dirHandle: FileSystemDirectoryHandle | null = null;
  private fileMap = new Map<string, File>();
  private fileHandleMap = new Map<string, FileSystemFileHandle>();
  private parentDirMap = new Map<string, FileSystemDirectoryHandle>();
  #inited = false;

  // Hover preview state
  private _hoverAbort: AbortController | null = null;
  private _hoverPmf: PmfPlayer | null = null;
  private _hoverAudio: HTMLAudioElement | null = null;
  /** Cache: fileKey → { pmfData, at3Url } so we don't re-extract on re-hover */
  private _mediaCache = new Map<string, { pmfData: Uint8Array | null; at3Url: string | null }>();

  constructor() {
    super();
    this.view = "empty";
    this.spinnerText = "";
    this.games = [];
    this._filter = "";
    this._sort = "title";
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.#inited) {
      this.#inited = true;
      void this.init();
    }
  }

  // Any change to the card list tears down a running hover preview first, so the
  // imperatively-inserted canvas/audio never outlives the card it sat on.
  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("_filter") || changed.has("_sort") || changed.has("games") || changed.has("view")) {
      this._stopHoverPreview();
    }
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
    this.view = "empty";
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

  // ── Rendering ───────────────────────────────────────────────────────────────

  override render(): TemplateResult {
    switch (this.view) {
      case "spinner": return this.#spinnerTpl();
      case "grid":    return this.#gridTpl();
      default:        return this.#emptyTpl();
    }
  }

  #emptyTpl(): TemplateResult {
    const hasApi = typeof window.showDirectoryPicker === "function";
    return html`<div class="container">
      <div class="empty">
        <p class="empty__label">Select a folder containing PSP games</p>
        ${hasApi
          ? html`<button class="select-btn" @click=${(): void => void this.pickDirectory()}>Select Games Folder</button>`
          : html`<label class="fallback-label">
              Open ISO / PBP file
              <input type="file" accept=".iso,.ISO,.pbp,.PBP" multiple hidden
                @change=${(e: Event): void => { const i = e.target as HTMLInputElement; if (i.files) this.handleFallbackFiles(i.files); }} />
            </label>`}
      </div>
    </div>`;
  }

  #spinnerTpl(): TemplateResult {
    return html`<div class="container">
      <div class="spinner">
        <div class="spinner__ring"></div>
        <div class="spinner__text">${this.spinnerText}</div>
      </div>
    </div>`;
  }

  #gridTpl(): TemplateResult {
    const hasApi = typeof window.showDirectoryPicker === "function";
    const games = this._visibleGames();
    return html`<div class="container">
      <div class="header">
        <h2>Games (<span class="game-count">${this.games.length}</span>)</h2>
        <div class="header__controls">
          ${this.games.length > 0 ? html`
            <input class="search" type="search" placeholder="Search games…" aria-label="Search games"
              .value=${this._filter}
              @input=${(e: Event): void => { this._filter = (e.target as HTMLInputElement).value; }} />
            <select class="sort" aria-label="Sort games" .value=${this._sort}
              @change=${(e: Event): void => { this._sort = (e.target as HTMLSelectElement).value === "size" ? "size" : "title"; }}>
              <option value="title">Sort: Title</option>
              <option value="size">Sort: Size</option>
            </select>` : nothing}
          <button class="change-btn" @click=${(): void => void this.refresh()}>Refresh</button>
          ${hasApi ? html`<button class="change-btn" @click=${(): void => void this.pickDirectory()}>Change Folder</button>` : nothing}
        </div>
      </div>
      ${this.games.length === 0
        ? html`<div class="empty">
            <p class="empty__label">No ISO or PBP files found in this folder</p>
            ${hasApi ? html`<button class="select-btn" @click=${(): void => void this.pickDirectory()}>Choose Another Folder</button>` : nothing}
          </div>`
        : html`
          <div class="grid">
            ${repeat(games, g => `${g.fileName}:${g.fileSize}`, g => this.#cardTpl(g))}
          </div>
          <div class="empty-filter" ?hidden=${games.length > 0}>No games match your search.</div>`}
    </div>`;
  }

  #cardTpl(game: GameMeta): TemplateResult {
    return html`
      <div class="card" title=${`Click to boot ${game.title}`}
        @click=${(): void => this._selectGame(game, "boot")}
        @mouseenter=${(e: Event): void => void this._startHoverPreview(e.currentTarget as HTMLElement, game)}
        @mouseleave=${(): void => this._stopHoverPreview()}>
        <div class="card__media">
          ${game.iconDataUrl
            ? html`<img class="card__thumb" src=${game.iconDataUrl} alt="" />`
            : html`<div class="card__fallback"></div>`}
          <span class="card__play" aria-hidden="true"></span>
          <button class="card__gear" title="Boot options" aria-label="Boot options"
            @click=${(e: Event): void => { e.stopPropagation(); this._selectGame(game, "options"); }}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>
          </button>
        </div>
        <div class="card__body">
          <div class="card__title">${game.title}</div>
          <div class="card__disc-id">${game.discId || " "}</div>
        </div>
      </div>`;
  }

  private _visibleGames(): GameMeta[] {
    const q = this._filter.trim().toLowerCase();
    let list = this.games;
    if (q) {
      list = list.filter(g =>
        g.title.toLowerCase().includes(q) || g.discId.toLowerCase().includes(q));
    }
    return [...list].sort(this._sort === "size"
      ? (a, b) => b.fileSize - a.fileSize
      : (a, b) => a.title.localeCompare(b.title));
  }

  private _selectGame(game: GameMeta, mode: "boot" | "options"): void {
    this._stopHoverPreview();
    const fileKey = `${game.fileName}:${game.fileSize}`;
    void this._getFile(fileKey).then(file => {
      if (!file) return;
      this.dispatchEvent(new CustomEvent("game-select", {
        bubbles: true,
        composed: true,
        detail: { file, parentDir: this.parentDirMap.get(fileKey) ?? null, mode },
      }));
    });
  }

  private async pickDirectory(): Promise<void> {
    try {
      this.dirHandle = await window.showDirectoryPicker({ mode: "read" });
      await idbSet("dirHandle", this.dirHandle);
      await this.scanAndDisplay();
    } catch {
      // User cancelled the picker — if we have no games, show empty state
      if (this.games.length === 0) this.view = "empty";
    }
  }

  private async scanAndDisplay(): Promise<void> {
    if (!this.dirHandle) return;
    this.spinner("Scanning for games...");

    let scanned: ScannedFile[];
    try {
      scanned = await scanDirectory(this.dirHandle);
    } catch {
      this.view = "empty";
      return;
    }

    scanned.sort((a, b) => a.file.name.localeCompare(b.file.name));

    const games: GameMeta[] = [];
    this.fileMap.clear();
    this.fileHandleMap.clear();
    this.parentDirMap.clear();

    for (let i = 0; i < scanned.length; i++) {
      const { file, handle, parentDir } = scanned[i]!;
      this.spinner(`Scanning ${i + 1} / ${scanned.length}: ${file.name}`);
      const key = `${file.name}:${file.size}`;
      this.fileMap.set(key, file);
      this.fileHandleMap.set(key, handle);
      this.parentDirMap.set(key, parentDir);

      const cached = getCachedMeta(file.name, file.size);
      if (cached) {
        games.push(cached);
        continue;
      }

      const meta = await extractIsoMetadata(file);
      setCachedMeta(meta);
      games.push(meta);
    }

    this.games = games;
    this.view = "grid";

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
    for (const f of files) this.fileMap.set(`${f.name}:${f.size}`, f);

    void (async () => {
      const games: GameMeta[] = [];
      this.spinner("Reading game metadata...");
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        this.spinner(`Scanning ${i + 1} / ${files.length}: ${file.name}`);
        const cached = getCachedMeta(file.name, file.size);
        if (cached) { games.push(cached); continue; }
        const meta = await extractIsoMetadata(file);
        setCachedMeta(meta);
        games.push(meta);
      }
      this.games = games;
      this.view = "grid";
    })();
  }

  private spinner(text: string): void {
    this.spinnerText = text;
    this.view = "spinner";
  }

  // ── Hover preview ──────────────────────────────────────────────────────────

  private async _startHoverPreview(card: HTMLElement, game: GameMeta): Promise<void> {
    // Stop any existing preview
    this._stopHoverPreview();

    const fileKey = `${game.fileName}:${game.fileSize}`;
    const file = await this._getFile(fileKey);
    if (!file) return;

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
