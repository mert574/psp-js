import { LitElement, html, css, type PropertyValues, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { extractMediaFromFile } from "../iso/iso-metadata.js";
import { decodePmfNative, type PmfPlayer } from "./pmf-native.js";
import { transcodeAt3 } from "./pmf.js";
import { idbGet, idbSet } from "./lib/idb.js";
import { type GameMeta, getCachedMeta, setCachedMeta, extractIsoMetadata } from "./lib/game-metadata.js";
import { scanDirectory, type ScannedFile } from "./lib/iso-scan.js";
import { ratingLabel } from "./ui.js";
import { setWaveColor, getStoredWaveColor } from "./wave-background.js";

// ── XMB category icons (inline SVG, no emoji per project rule) ────────────────

const ICON_GAMES = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
  <path d="M8 8h8a4 4 0 0 1 3.9 4.9l-.7 3A2.6 2.6 0 0 1 15 17.1l-1.2-1.6h-3.6L9 17.1A2.6 2.6 0 0 1 4.8 15.9l-.7-3A4 4 0 0 1 8 8Z"/>
  <path d="M6.6 11.4v2.2M5.5 12.5h2.2" stroke-linecap="round"/>
  <circle cx="16" cy="12" r=".8" fill="currentColor" stroke="none"/>
  <circle cx="17.6" cy="13.6" r=".8" fill="currentColor" stroke="none"/>
</svg>`;

const ICON_SETTINGS = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <circle cx="12" cy="12" r="3.1"/>
  <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.1 5.1l2.1 2.1M16.8 16.8l2.1 2.1M18.9 5.1 16.8 7.2M7.2 16.8 5.1 18.9" stroke-linecap="round"/>
</svg>`;

const ICON_FOLDER = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.3A1.5 1.5 0 0 1 19 18.5H4.5A1.5 1.5 0 0 1 3 17V6.5Z"/>
</svg>`;

const ICON_REFRESH = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M20 7a8 8 0 1 0 1.5 6"/>
  <path d="M20 3.5V8h-4.5"/>
</svg>`;

const ICON_SORT = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M7 5v14M7 19l-3-3M7 19l3-3M17 19V5M17 5l-3 3M17 5l3 3"/>
</svg>`;

const ICON_ABOUT = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <circle cx="12" cy="12" r="9"/>
  <path d="M12 11v5" stroke-linecap="round"/>
  <circle cx="12" cy="7.8" r="1.05" fill="currentColor" stroke="none"/>
</svg>`;

const ICON_PALETTE = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3a9 9 0 0 0 0 18c1 0 1.7-.8 1.7-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H16a5 5 0 0 0 5-5c0-3.9-4-7-9-7Z"/>
  <circle cx="7.5" cy="11.5" r="1" fill="currentColor" stroke="none"/>
  <circle cx="11" cy="7.5" r="1" fill="currentColor" stroke="none"/>
  <circle cx="15.5" cy="8.5" r="1" fill="currentColor" stroke="none"/>
</svg>`;

// Preset wave colors offered in Settings. Names are plain so the card sub-label
// reads nicely; the first one is the original white default.
const WAVE_COLOR_PRESETS: Array<{ label: string; value: string }> = [
  { label: "White", value: "#ffffff" },
  { label: "Blue", value: "#58a6ff" },
  { label: "Teal", value: "#2dd4bf" },
  { label: "Green", value: "#56d364" },
  { label: "Purple", value: "#a371f7" },
  { label: "Pink", value: "#f778ba" },
  { label: "Orange", value: "#f0883e" },
];

const ICON_DOCS = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
  <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H17a2 2 0 0 1 2 2v14a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 19V4.5Z"/>
  <path d="M8.5 7.5h7M8.5 11h7M8.5 14.5h4.5" stroke-linecap="round"/>
</svg>`;

const ICON_GITHUB = html`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48l-.01-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85l-.01 2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/>
</svg>`;

// ── Cross model ───────────────────────────────────────────────────────────────

type XmbItem =
  | { kind: "game"; game: GameMeta }
  | { kind: "action"; label: string; sub: string; icon: TemplateResult; run: () => void }
  | { kind: "color"; label: string; sub: string; icon: TemplateResult }
  | { kind: "info"; label: string; sub: string; icon: TemplateResult; body: TemplateResult }
  | { kind: "empty"; label: string; sub: string };

interface XmbCategory {
  id: string;
  label: string;
  icon: TemplateResult;
  items: XmbItem[];
}

// ── Web Component (Lit) ─────────────────────────────────────────────────────

export class GameLibrary extends LitElement {
  static override styles = css`
    :host {
      /* Flex column so the cross fills the host's height purely through
         flex-grow — no percentage-height chain that can collapse to 0. */
      display: flex;
      flex-direction: column;
      width: 100%;
      min-height: 0;
      /* Transparent so the XMB wave background (see wave-background.ts) shows
         through behind the content. */
      background: transparent;
      color: var(--text-dim, #c9d1d9);
      font-family: var(--ui);
      font-size: 14px;
    }

    /* Empty / spinner states keep a simple centered container. */
    .container {
      padding: 24px;
      max-width: 1200px;
      margin: 0 auto;
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
      font-weight: var(--fw-bold);
      cursor: pointer;
      transition: background 0.15s;
      font-family: var(--ui);
    }
    .select-btn:hover { background: #79b8ff; }
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
      font-family: var(--ui);
    }
    .fallback-label:hover { border-color: var(--accent, #58a6ff); }

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
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner__text { font-size: 13px; color: var(--muted, #8b949e); }

    /* ── XMB cross ────────────────────────────────────────────────────────── */
    .xmb {
      position: relative;
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    /* Horizontal category axis. The bar slides so the active category sits at a
       fixed focus point (transform set from updated()). */
    .xmb-bar-wrap {
      position: relative;
      z-index: 1;
      overflow: hidden;
      padding: 18px 0 26px;
    }
    .xmb-bar {
      display: inline-flex;
      gap: 90px;
      padding: 0 60px;
      position: relative;
      transition: transform 0.14s ease-out;
      will-change: transform;
    }
    .xmb-cat {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 9px;
      background: none;
      border: 0;
      padding: 0;
      cursor: pointer;
      color: var(--text-dim, #c9d1d9);
      opacity: 0.4;
      transform: scale(0.6);
      transform-origin: center top;
      transition: opacity 0.14s ease-out, transform 0.14s ease-out, color 0.14s ease-out;
    }
    .xmb-cat.active {
      opacity: 1;
      transform: scale(1);
      color: #fff;
    }
    .xmb-cat__icon {
      width: 64px;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .xmb-cat__icon svg {
      width: 100%;
      height: 100%;
      filter: drop-shadow(0 2px 9px rgba(0, 0, 0, 0.55));
    }
    .xmb-cat__label {
      font-family: var(--ui);
      font-stretch: var(--ui-condensed);
      font-size: 15px;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      white-space: nowrap;
      opacity: 0;
      transition: opacity 0.14s ease-out;
      text-shadow: 0 1px 8px rgba(0, 0, 0, 0.6);
    }
    .xmb-cat.active .xmb-cat__label { opacity: 1; }

    /* Vertical item column. Slides so the selected item sits at the focus line. */
    .xmb-col-wrap {
      position: relative;
      z-index: 1;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .xmb-col {
      position: absolute;
      left: 0;
      top: 0;
      right: 0;
      padding-left: 8%;
      z-index: 1;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      transition: transform 0.14s ease-out;
      will-change: transform;
    }

    /* Compact icon-only rows in the scrolling column (the unselected items). */
    .xmb-compact {
      display: flex;
      align-items: center;
      padding: 9px 0;
      cursor: pointer;
      opacity: 0.6;
    }
    .xmb-compact__icon {
      flex: 0 0 auto;
      width: 88px;
      aspect-ratio: 144 / 80;
      border-radius: 8px;
      overflow: hidden;
      background: linear-gradient(135deg, #1a1f2b 0%, var(--surface, #161b22) 100%);
      box-shadow: 0 2px 9px rgba(0, 0, 0, 0.45);
    }
    .xmb-compact__glyph {
      width: 88px;
      aspect-ratio: 144 / 80;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-dim, #c9d1d9);
    }
    .xmb-compact__glyph svg { width: 34%; height: 34%; }

    /* Reserved gap where the fixed card sits; height set in updated(). */
    .xmb-slot { width: 100%; }

    /* The selected card — a fixed overlay centered on the focus line. It does
       not move; only the compact column scrolls behind/around it. */
    .xmb-card {
      position: absolute;
      left: 8%;
      top: 45%;
      transform: translateY(-50%);
      z-index: 2;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .xmb-card--game {
      width: min(504px, 52vw);
      /* Same aspect ratio as the PSP screen / PIC1 background art. */
      aspect-ratio: 480 / 272;
      padding: 22px 24px;
      border-radius: 16px;
      overflow: hidden;
      background-color: rgba(16, 21, 30, 0.55);
      backdrop-filter: blur(2px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
    }
    .xmb-card--action,
    .xmb-card--empty { padding: 8px 0; }

    /* About info card: a description, controls list, and a docs link below the
       icon/title row. Wider than a plain action card. */
    .xmb-card--info { width: min(560px, 60vw); }
    .xmb-about__desc {
      font-size: 14px;
      color: var(--text-dim, #c9d1d9);
      line-height: 1.5;
      margin: 14px 0 0;
      max-width: 500px;
      font-stretch: var(--ui-condensed);
      text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
    }
    .xmb-about__controls { margin-top: 14px; gap: 4px 26px; }
    .xmb-about__link {
      display: inline-block;
      margin-top: 16px;
      color: var(--accent, #58a6ff);
      font-size: 14px;
      text-decoration: none;
      border-bottom: 1px solid transparent;
      transition: border-color 0.12s;
    }
    .xmb-about__link:hover { border-bottom-color: var(--accent, #58a6ff); }

    /* Wave-color swatches in the Settings card. A small row of preset colors;
       the active one gets an outline ring. */
    .wave-swatches {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 12px;
    }
    .wave-swatch {
      width: 24px;
      height: 24px;
      padding: 0;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.25);
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
      transition: transform 0.12s ease-out, box-shadow 0.12s ease-out;
    }
    .wave-swatch:hover { transform: scale(1.12); }
    .wave-swatch.active {
      outline: 2px solid var(--accent, #58a6ff);
      outline-offset: 2px;
    }

    /* PIC1 background on its own layer so opacity can fade in/out. */
    .xmb-card__bg {
      position: absolute;
      inset: 0;
      z-index: 0;
      background-size: cover;
      background-position: center;
      opacity: 0;
      transition: opacity 0.4s ease-in-out;
      pointer-events: none;
    }

    /* Stylized logo (PIC0), absolutely positioned top-right like the game-card. */
    .xmb-card__logo {
      position: absolute;
      top: 22px;
      right: 24px;
      z-index: 1;
      max-width: 38%;
      max-height: 30%;
      object-fit: contain;
      pointer-events: none;
      filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.6));
    }
    /* Icon + details row inside the card. */
    .xmb-card__row {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 22px;
      width: 100%;
    }

    /* Card game icon (also the preview surface the preview code looks for). */
    .card__media {
      position: relative;
      flex: 0 0 auto;
      width: 132px;
      aspect-ratio: 144 / 80;
      border-radius: 8px;
      overflow: hidden;
      background: linear-gradient(135deg, #1a1f2b 0%, var(--surface, #161b22) 100%);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }
    .card__media canvas,
    .card__media video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .card__thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .card__fallback {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #30363d;
    }

    /* Action/info glyph box in the card. */
    .xmb-item__glyph {
      flex: 0 0 auto;
      width: 110px;
      aspect-ratio: 144 / 80;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
      color: #fff;
    }
    .xmb-item__glyph svg { width: 38%; height: 38%; }

    /* Details block inside the card (always shown — the card only renders for
       the selected item). */
    .xmb-item__text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .xmb-item__title {
      font-size: 22px;
      font-weight: var(--fw-regular);
      letter-spacing: 0.01em;
      color: #fff;
      line-height: 1.25;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-shadow: 0 1px 10px rgba(0, 0, 0, 0.6);
    }
    /* Game card title: a full-width header above the icon/details row. */
    .xmb-card__title {
      position: relative;
      z-index: 1;
      width: 100%;
      font-size: 23px;
      font-weight: var(--fw-heavy);
      letter-spacing: 0.01em;
      color: #fff;
      line-height: 1.2;
      margin-bottom: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-shadow: 0 1px 10px rgba(0, 0, 0, 0.6);
    }
    .xmb-item__sub {
      font-size: 14px;
      color: var(--text-dim, #c9d1d9);
      margin-top: 3px;
      font-stretch: var(--ui-condensed);
    }

    /* Full game details, shown only on the selected/hovered game. */
    .xmb-item__meta {
      display: flex;
      flex-wrap: wrap;
      gap: 2px 22px;
      margin-top: 7px;
    }
    .xmb-item__meta .meta-pair {
      display: flex;
      gap: 7px;
      font-size: 13px;
      font-stretch: var(--ui-condensed);
    }
    .xmb-item__meta dt { color: var(--muted, #8b949e); }
    .xmb-item__meta dd { color: var(--text-dim, #c9d1d9); }

    /* Gear — opens boot options without booting. Corner of the game icon. */
    .card__gear {
      position: absolute;
      top: 5px;
      right: 5px;
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 7px;
      background: rgba(13, 17, 23, 0.72);
      backdrop-filter: blur(4px);
      color: var(--text-dim, #c9d1d9);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.12s, background 0.12s, color 0.12s, border-color 0.12s;
      z-index: 3;
    }
    .card__media:hover .card__gear { opacity: 1; }
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
  `;

  // Reactive view state. Declared (not initialized as class fields) so the field
  // initializers don't shadow Lit's reactive accessors under useDefineForClassFields.
  static override properties = {
    view: { state: true },
    spinnerText: { state: true },
    games: { state: true },
    _sort: { state: true },
    _catIndex: { state: true },
    _itemIndex: { state: true },
    _selMedia: { state: true },
    _waveColor: { state: true },
  };
  declare view: "empty" | "spinner" | "grid";
  declare spinnerText: string;
  declare games: GameMeta[];
  declare _sort: "title" | "size";
  declare _catIndex: number;
  declare _itemIndex: number;
  /** Current XMB wave background color (hex). Drives which swatch is marked
   *  active; changing it calls setWaveColor (live update + persist). */
  declare _waveColor: string;
  /** Logo (PIC0) + background (PIC1) of the selected game, loaded lazily; null
   *  until the selection's media finishes loading (the card "fills in"). */
  declare _selMedia: { pic0Url: string | null; pic1Url: string | null } | null;

  // Non-reactive internal state.
  private dirHandle: FileSystemDirectoryHandle | null = null;
  private fileMap = new Map<string, File>();
  private fileHandleMap = new Map<string, FileSystemFileHandle>();
  private parentDirMap = new Map<string, FileSystemDirectoryHandle>();
  #inited = false;

  // Hover/selection preview state
  private _hoverAbort: AbortController | null = null;
  private _hoverPmf: PmfPlayer | null = null;
  private _hoverAudio: HTMLAudioElement | null = null;
  /** Cache: fileKey → preview media so we don't re-extract on re-select */
  private _mediaCache = new Map<string, { pmfData: Uint8Array | null; at3Url: string | null; pic1Url: string | null; pic0Url: string | null }>();
  /** Debounce + de-dupe so fast navigation doesn't thrash the preview decoder. */
  private _previewKey: string | null = null;
  private _previewTimer = 0;

  constructor() {
    super();
    this.view = "empty";
    this.spinnerText = "";
    this.games = [];
    this._sort = "title";
    this._catIndex = 0;
    this._itemIndex = 0;
    this._selMedia = null;
    this._waveColor = getStoredWaveColor();
  }

  /** Pick a wave color: update the background live, persist it, and re-render so
   *  the active swatch follows. */
  private _setWaveColor(value: string): void {
    setWaveColor(value);
    this._waveColor = value;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.#inited) {
      this.#inited = true;
      void this.init();
    }
    // Listen at the document so arrow keys anywhere in the library drive the
    // cross, even when nothing inside is focused.
    document.addEventListener("keydown", this._onKeydown);
    // Stop preview audio/video whenever we leave the page: tab hidden, or the
    // library host gets hidden (e.g. booting into gameplay).
    document.addEventListener("visibilitychange", this._onVisibility);
    this._hiddenObserver = new MutationObserver(() => { if (this.hidden) this._resetPreview(); });
    this._hiddenObserver.observe(this, { attributes: true, attributeFilter: ["hidden"] });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this._onKeydown);
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._hiddenObserver?.disconnect();
    this._hiddenObserver = null;
    this._resetPreview();
  }

  private _onVisibility = (): void => { if (document.hidden) this._resetPreview(); };
  private _hiddenObserver: MutationObserver | null = null;

  // Bound so it can be added/removed as a document listener.
  private _onKeydown = (e: KeyboardEvent): void => {
    if (this.view !== "grid" || this.hidden) return;
    const tag = (e.composedPath()[0] as HTMLElement | undefined)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    this._handleNavKey(e);
  };

  // Tear down a running preview before any re-render that changes the item DOM,
  // so the imperatively-inserted canvas/audio never outlives its host element.
  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("view") || changed.has("games") || changed.has("_sort")) {
      this._resetPreview();
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

  /** Try to auto-select a game matching the given slug (discId or filename).
   *  `mode` decides whether the selection boots or just opens the details view
   *  (the #details route deep-links to details without booting). */
  autoSelectBySlug(slug: string, mode: "boot" | "options" | "details" = "boot"): boolean {
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
              bubbles: true, composed: true, detail: { file, mode },
            }));
          }
        });
        return true;
      }
    }
    return false;
  }

  // ── Cross model ─────────────────────────────────────────────────────────────

  private _sortedGames(): GameMeta[] {
    return [...this.games].sort(this._sort === "size"
      ? (a, b) => b.fileSize - a.fileSize
      : (a, b) => a.title.localeCompare(b.title));
  }

  private _categories(): XmbCategory[] {
    const games = this._sortedGames();
    const gameItems: XmbItem[] = games.length
      ? games.map((g): XmbItem => ({ kind: "game", game: g }))
      : [{ kind: "empty", label: "No games found", sub: "Open Settings to change folder" }];

    const hasApi = typeof window.showDirectoryPicker === "function";
    const settingsItems: XmbItem[] = [];
    if (hasApi) {
      settingsItems.push({
        kind: "action", label: "Change Folder", sub: "Pick a different games folder",
        icon: ICON_FOLDER, run: (): void => void this.pickDirectory(),
      });
    }
    settingsItems.push({
      kind: "action", label: "Refresh", sub: "Re-scan the current folder",
      icon: ICON_REFRESH, run: (): void => void this.refresh(),
    });
    settingsItems.push({
      kind: "action",
      label: this._sort === "title" ? "Sort: Title" : "Sort: Size",
      sub: "Toggle game ordering", icon: ICON_SORT,
      run: (): void => { this._sort = this._sort === "title" ? "size" : "title"; },
    });
    settingsItems.push({
      kind: "color",
      label: "Wave Color",
      sub: "Color of the background waves",
      icon: ICON_PALETTE,
    });

    // Docs deploy to /psp-js/docs/ in production (BASE_URL is /psp-js/ in CI). In
    // /docs/ is the docs site: a real static dir in production, and in dev the
    // Vite app server proxies /docs to the VitePress dev server (vite.config.ts),
    // so run `npm run docs:dev` alongside `npm run dev` for local docs. Opened in
    // a new tab below so the SPA router never intercepts it.
    const docsUrl = `${import.meta.env.BASE_URL}docs/`;
    const aboutItems: XmbItem[] = [
      {
        kind: "info", label: "psp-js", sub: "A PSP HLE emulator in TypeScript",
        icon: ICON_ABOUT, body: this.#aboutBody(docsUrl),
      },
      {
        kind: "action", label: "Documentation", sub: "Open the full docs site",
        icon: ICON_DOCS,
        run: (): void => { window.open(docsUrl, "_blank", "noopener"); },
      },
      {
        kind: "action", label: "GitHub", sub: "github.com/mert574/psp-js",
        icon: ICON_GITHUB,
        run: (): void => { window.open("https://github.com/mert574/psp-js", "_blank", "noopener"); },
      },
    ];

    // The cross is data-driven: add a category here and it shows up with full
    // keyboard/mouse navigation. Nothing about it is hardcoded in the markup.
    return [
      { id: "games", label: "Games", icon: ICON_GAMES, items: gameItems },
      { id: "settings", label: "Settings", icon: ICON_SETTINGS, items: settingsItems },
      { id: "about", label: "About", icon: ICON_ABOUT, items: aboutItems },
    ];
  }

  private _activeCategory(cats = this._categories()): XmbCategory {
    return cats[Math.min(this._catIndex, cats.length - 1)]!;
  }

  private _selectedItem(): XmbItem | undefined {
    const items = this._activeCategory().items;
    return items[Math.min(this._itemIndex, items.length - 1)];
  }

  // ── Navigation primitives (input-agnostic; keyboard and gamepad share them) ──

  /** Move the horizontal category axis. dir is -1 (left) or +1 (right). */
  moveCategory(dir: number): boolean {
    const n = this._categories().length;
    const next = Math.min(Math.max(this._catIndex + dir, 0), n - 1);
    if (next === this._catIndex) return false;
    this._catIndex = next;
    this._itemIndex = 0;
    return true;
  }

  /** Move the vertical item axis. dir is -1 (up) or +1 (down). */
  moveItem(dir: number): boolean {
    const len = this._activeCategory().items.length;
    const next = Math.min(Math.max(this._itemIndex + dir, 0), len - 1);
    if (next === this._itemIndex) return false;
    this._itemIndex = next;
    return true;
  }

  /** Activate the selected item (boot a game / run a settings action). */
  activateSelected(): boolean {
    const item = this._selectedItem();
    if (!item) return false;
    if (item.kind === "game") { this._selectGame(item.game, "details"); return true; }
    if (item.kind === "action") { item.run(); return true; }
    if (item.kind === "color") {
      // No left/right within an item (those switch categories), so Enter cycles
      // through the presets. Mouse users click a swatch directly.
      const cur = WAVE_COLOR_PRESETS.findIndex(p => p.value.toLowerCase() === this._waveColor.toLowerCase());
      const next = WAVE_COLOR_PRESETS[(cur + 1) % WAVE_COLOR_PRESETS.length]!;
      this._setWaveColor(next.value);
      return true;
    }
    return false;
  }

  private _handleNavKey(e: KeyboardEvent): void {
    let moved = false;
    switch (e.key) {
      case "ArrowLeft":  moved = this.moveCategory(-1); break;
      case "ArrowRight": moved = this.moveCategory(1); break;
      case "ArrowUp":    moved = this.moveItem(-1); break;
      case "ArrowDown":  moved = this.moveItem(1); break;
      case "Enter":
      case " ":
        if (this.activateSelected()) e.preventDefault();
        return;
      default: return;
    }
    if (moved) e.preventDefault();
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  override render(): TemplateResult {
    switch (this.view) {
      case "spinner": return this.#spinnerTpl();
      case "grid":    return this.#crossTpl();
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

  #crossTpl(): TemplateResult {
    const cats = this._categories();
    const catIndex = Math.min(this._catIndex, cats.length - 1);
    const active = cats[catIndex]!;
    const itemIndex = Math.min(this._itemIndex, Math.max(0, active.items.length - 1));
    const selectedItem = active.items[itemIndex];
    return html`
      <div class="xmb">
        <div class="xmb-bar-wrap">
          <div class="xmb-bar">
            ${cats.map((c, ci) => html`
              <button class="xmb-cat ${ci === catIndex ? "active" : ""}"
                @click=${(): void => this._selectCategory(ci)}>
                <span class="xmb-cat__icon">${c.icon}</span>
                <span class="xmb-cat__label">${c.label}</span>
              </button>`)}
          </div>
        </div>
        <div class="xmb-col-wrap">
          <!-- Selected card: a fixed overlay at the focus line. It stays put;
               only the compact column below scrolls. -->
          ${selectedItem ? this.#cardTpl(selectedItem) : ""}
          <div class="xmb-col">
            ${repeat(active.items, it => this.#itemKey(it), (it, ii) => ii === itemIndex
              ? html`<div class="xmb-slot"></div>`
              : this.#compactTpl(it, ii))}
          </div>
        </div>
      </div>`;
  }

  #itemKey(item: XmbItem): string {
    if (item.kind === "game") return `game:${item.game.fileName}:${item.game.fileSize}`;
    if (item.kind === "action") return `action:${item.label}`;
    if (item.kind === "color") return `color:${item.label}`;
    if (item.kind === "info") return `info:${item.label}`;
    return "empty";
  }

  /** Body of the About info card: a short description, the controls, and a link
   *  to the full docs site. */
  #aboutBody(docsUrl: string): TemplateResult {
    const controls: Array<[string, string]> = [
      ["D-pad", "Arrow keys"],
      ["Cross / Circle", "Z / X"],
      ["Square / Triangle", "J / K"],
      ["L / R", "Q / E"],
      ["Analog", "W A S D"],
      ["Gamepad", "Supported"],
    ];
    return html`
      <p class="xmb-about__desc">
        A PSP high-level-emulation core in TypeScript that runs real games in the
        browser, no BIOS needed. System calls are implemented directly in TS, and
        the MIPS CPU and the GE render through WebGL or a software rasterizer.
      </p>
      <dl class="xmb-item__meta xmb-about__controls" aria-label="Controls">
        ${controls.map(([k, v]) => html`<div class="meta-pair"><dt>${k}</dt><dd>${v}</dd></div>`)}
      </dl>
      <a class="xmb-about__link" href=${docsUrl} target="_blank" rel="noopener">Open the full documentation</a>`;
  }

  /** Compact icon-only row shown in the scrolling column (unselected items). */
  #compactTpl(item: XmbItem, index: number): TemplateResult {
    const glyph = item.kind === "action" || item.kind === "color" || item.kind === "info" ? item.icon : ICON_GAMES;
    const icon = item.kind === "game"
      ? (item.game.iconDataUrl
          ? html`<img class="card__thumb" src=${item.game.iconDataUrl} alt="" />`
          : html`<div class="card__fallback"></div>`)
      : html`<div class="xmb-compact__glyph">${glyph}</div>`;
    const label = item.kind === "game" ? item.game.title : item.label;
    return html`
      <div class="xmb-compact" role="button" aria-label=${label}
        @click=${(): void => this._selectItem(index)}>
        <div class="xmb-compact__icon">${icon}</div>
      </div>`;
  }

  /** Expanded card for the selected item — the fixed overlay at the focus line. */
  #cardTpl(item: XmbItem): TemplateResult {
    if (item.kind === "game") {
      const game = item.game;
      const rows: Array<[string, string]> = [];
      if (game.discId) rows.push(["Disc ID", game.discId]);
      if (game.region) rows.push(["Region", game.region]);
      if (game.version) rows.push(["Version", game.version]);
      const rating = ratingLabel(game.parentalLevel);
      if (rating) rows.push(["Rating", rating]);
      if (game.saveTitle) {
        rows.push(["Save", game.saveDetail ? `${game.saveTitle} (${game.saveDetail})` : game.saveTitle]);
      }
      const size = this._fmtSize(game.fileSize);
      if (size) rows.push(["Size", size]);
      if (game.fileName) rows.push(["File", game.fileName]);
      const media = this._selMedia;
      // PIC1 lives on its own layer so its opacity (not background-image, which
      // can't transition) fades in/out smoothly.
      const bgStyle = media?.pic1Url
        ? `background-image: linear-gradient(rgba(7,16,31,0.55), rgba(7,16,31,0.84)), url(${media.pic1Url}); opacity: 1`
        : "opacity: 0";
      return html`
        <div class="xmb-card xmb-card--game" role="button"
          aria-label=${game.title}
          @click=${(): void => this._selectGame(game, "details")}>
          <div class="xmb-card__bg" style=${bgStyle}></div>
          ${media?.pic0Url ? html`<img class="xmb-card__logo" src=${media.pic0Url} alt="" />` : ""}
          <div class="xmb-card__title">${game.title}</div>
          <div class="xmb-card__row">
            <div class="card__media">
              ${game.iconDataUrl
                ? html`<img class="card__thumb" src=${game.iconDataUrl} alt="" />`
                : html`<div class="card__fallback"></div>`}
              <button class="card__gear" title="Boot options" aria-label="Boot options" tabindex="-1"
                @click=${(e: Event): void => { e.stopPropagation(); this._selectGame(game, "options"); }}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>
              </button>
            </div>
            <div class="xmb-item__text">
              <dl class="xmb-item__meta">
                ${rows.map(([k, v]) => html`<div class="meta-pair"><dt>${k}</dt><dd>${v}</dd></div>`)}
              </dl>
            </div>
          </div>
        </div>`;
    }
    if (item.kind === "action") {
      return html`
        <div class="xmb-card xmb-card--action" role="button" aria-label=${item.label}
          @click=${(): void => item.run()}>
          <div class="xmb-card__row">
            <div class="xmb-item__glyph">${item.icon}</div>
            <div class="xmb-item__text">
              <div class="xmb-item__title">${item.label}</div>
              <div class="xmb-item__sub">${item.sub}</div>
            </div>
          </div>
        </div>`;
    }
    if (item.kind === "color") {
      const active = this._waveColor.toLowerCase();
      return html`
        <div class="xmb-card xmb-card--action" aria-label=${item.label}>
          <div class="xmb-card__row">
            <div class="xmb-item__glyph">${item.icon}</div>
            <div class="xmb-item__text">
              <div class="xmb-item__title">${item.label}</div>
              <div class="xmb-item__sub">${item.sub}</div>
              <div class="wave-swatches" role="group" aria-label="Wave color">
                ${WAVE_COLOR_PRESETS.map(p => html`
                  <button
                    class="wave-swatch ${p.value.toLowerCase() === active ? "active" : ""}"
                    style="background:${p.value}"
                    title=${p.label} aria-label=${p.label}
                    aria-pressed=${p.value.toLowerCase() === active}
                    @click=${(): void => this._setWaveColor(p.value)}></button>`)}
              </div>
            </div>
          </div>
        </div>`;
    }
    if (item.kind === "info") {
      return html`
        <div class="xmb-card xmb-card--action xmb-card--info" aria-label=${item.label}>
          <div class="xmb-card__row">
            <div class="xmb-item__glyph">${item.icon}</div>
            <div class="xmb-item__text">
              <div class="xmb-item__title">${item.label}</div>
              <div class="xmb-item__sub">${item.sub}</div>
            </div>
          </div>
          ${item.body}
        </div>`;
    }
    return html`
      <div class="xmb-card xmb-card--empty">
        <div class="xmb-card__row">
          <div class="xmb-item__glyph">${ICON_GAMES}</div>
          <div class="xmb-item__text">
            <div class="xmb-item__title">${item.label}</div>
            <div class="xmb-item__sub">${item.sub}</div>
          </div>
        </div>
      </div>`;
  }

  private _fmtSize(bytes: number): string {
    if (!bytes) return "";
    const gb = bytes / 1e9;
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${Math.round(bytes / 1e6)} MB`;
  }

  private _selectCategory(ci: number): void {
    if (ci === this._catIndex) return;
    this._catIndex = ci;
    this._itemIndex = 0;
  }

  private _selectItem(index: number): void {
    this._itemIndex = index;
  }

  // After each render: slide the category bar to its focus point, size the
  // reserved column gap to the (fixed) card, then slide the compact column so
  // that gap sits under the card. The card itself never moves — only the small
  // items scroll past it.
  protected override updated(): void {
    if (this.view !== "grid") return;

    const barWrap = this.renderRoot.querySelector<HTMLElement>(".xmb-bar-wrap");
    const bar = this.renderRoot.querySelector<HTMLElement>(".xmb-bar");
    const activeCat = this.renderRoot.querySelector<HTMLElement>(".xmb-cat.active");
    if (barWrap && bar && activeCat) {
      const focusX = barWrap.clientWidth * 0.18;
      const center = activeCat.offsetLeft + activeCat.offsetWidth / 2;
      bar.style.transform = `translateX(${Math.round(focusX - center)}px)`;
    }

    const colWrap = this.renderRoot.querySelector<HTMLElement>(".xmb-col-wrap");
    const col = this.renderRoot.querySelector<HTMLElement>(".xmb-col");
    const card = this.renderRoot.querySelector<HTMLElement>(".xmb-card");
    const slot = this.renderRoot.querySelector<HTMLElement>(".xmb-slot");
    if (colWrap && col && card && slot) {
      // Reserve the card's height (plus breathing room) so neighbours clear it.
      slot.style.height = `${card.offsetHeight + 28}px`;
      // The card is centered at this focus line via CSS; line the gap up to it.
      const focusY = colWrap.clientHeight * 0.45;
      const center = slot.offsetTop + slot.offsetHeight / 2;
      col.style.transform = `translateY(${Math.round(focusY - center)}px)`;
    }

    this._syncSelectionPreview();
  }

  /** Start (debounced) the preview for the selected game; stop it otherwise. */
  private _syncSelectionPreview(): void {
    const item = this._selectedItem();
    const game = item?.kind === "game" ? item.game : null;
    const key = game ? `${game.fileName}:${game.fileSize}` : null;
    if (key === this._previewKey) return;

    this._previewKey = key;
    clearTimeout(this._previewTimer);
    this._stopHoverPreview();
    if (!game) return;

    this._previewTimer = window.setTimeout(() => {
      const el = this.renderRoot.querySelector<HTMLElement>(".xmb-card");
      if (el) void this._startHoverPreview(el, game);
    }, 220);
  }

  private _resetPreview(): void {
    clearTimeout(this._previewTimer);
    this._stopHoverPreview();
    this._previewKey = null;
  }

  private _selectGame(game: GameMeta, mode: "boot" | "options" | "details"): void {
    this._resetPreview();
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
    this._catIndex = 0;
    this._itemIndex = 0;
    this.view = "grid";

    // If the URL hash references a specific game, auto-select it
    const hash = location.hash.replace(/^#/, "");
    const match = hash.match(/^(game|play|details)\/(.+)$/);
    if (match) {
      // #details deep-links to the details view without booting.
      this.autoSelectBySlug(match[2]!, match[1] === "details" ? "details" : "boot");
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

    // Multiple files: scan metadata and show the cross
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
      this._catIndex = 0;
      this._itemIndex = 0;
      this.view = "grid";
    })();
  }

  private spinner(text: string): void {
    this.spinnerText = text;
    this.view = "spinner";
  }

  // ── Selection preview (PMF video + SND0 audio for the focused game) ──────────

  private async _startHoverPreview(card: HTMLElement, game: GameMeta): Promise<void> {
    // Stop any existing preview
    this._stopHoverPreview();

    const fileKey = `${game.fileName}:${game.fileSize}`;
    const file = await this._getFile(fileKey);
    if (!file) return;

    const abort = new AbortController();
    this._hoverAbort = abort;

    const mediaEl = card.querySelector(".card__media");
    if (!mediaEl) return;

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

        // PIC1 (card background) and PIC0 (logo), like the game-card view.
        const toUrl = (d: Uint8Array | null): string | null =>
          d ? URL.createObjectURL(new Blob([d.slice()], { type: "image/png" })) : null;
        const pic1Url = toUrl(media.pic1);
        const pic0Url = toUrl(media.pic0);

        cached = { pmfData: media.pmf, at3Url, pic1Url, pic0Url };
        this._mediaCache.set(fileKey, cached);
        // Cap the cache so browsing a large library doesn't accumulate AT3 audio
        // and image blob URLs forever; evict the oldest entry and revoke its URLs.
        if (this._mediaCache.size > 16) {
          const oldestKey = this._mediaCache.keys().next().value;
          if (oldestKey !== undefined && oldestKey !== fileKey) {
            const old = this._mediaCache.get(oldestKey)!;
            if (old.at3Url) URL.revokeObjectURL(old.at3Url);
            if (old.pic1Url) URL.revokeObjectURL(old.pic1Url);
            if (old.pic0Url) URL.revokeObjectURL(old.pic0Url);
            this._mediaCache.delete(oldestKey);
          }
        }
      } catch {
        return;
      } finally {
        spinner.remove();
      }
    }

    if (abort.signal.aborted) return;

    // Fill in the selected card: logo + background image fade in.
    this._selMedia = { pic0Url: cached.pic0Url, pic1Url: cached.pic1Url };

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
    this._selMedia = null;
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
