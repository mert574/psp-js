import { html, type TemplateResult } from "lit";
import { SubPanel } from "./sub-panel.js";
import type { PSPEmulator } from "../../emulator.js";

const WINDOW_MS = 500;
const STORE_REFRESH_MS = 3000;

/** Save Data section: lists persisted save entries (re-queried every few sec). */
export class SavedataPanel extends SubPanel {
  static override properties = { tpl: { state: true } };
  declare tpl: TemplateResult;

  #cache: Array<{ key: string; title: string; size: number; time: string }> = [];
  #lastStoreRefresh = 0;
  #last = 0;

  constructor() {
    super();
    this.tpl = html`<div class="dim">No store</div>`;
  }

  override render(): TemplateResult {
    return html`<section class="section"><h4>Save Data</h4><div class="savedata scrollbox">${this.tpl}</div></section>`;
  }

  reset(): void {
    this.#cache = [];
    this.#lastStoreRefresh = 0;
    this.#last = 0;
    this.tpl = html`<div class="dim">No store</div>`;
  }

  tick(emu: PSPEmulator, now: number): void {
    if (now - this.#last < WINDOW_MS) return;
    this.#last = now;
    const store = emu.hle.savedataStore;
    if (!store) { this.tpl = html`<div class="dim">No store</div>`; return; }
    if (now - this.#lastStoreRefresh > STORE_REFRESH_MS) {
      this.#lastStoreRefresh = now;
      store.list("").then(entries => {
        this.#cache = entries.map(e => ({
          key: e.key,
          title: e.title || e.key,
          size: e.data.byteLength,
          time: new Date(e.timestamp).toLocaleTimeString(),
        }));
        // The next tick (≤0.5s) rebuilds the list from the refreshed cache.
      }).catch(() => { /* ignore */ });
    }
    if (this.#cache.length === 0) { this.tpl = html`<div class="dim">No saves</div>`; return; }
    this.tpl = html`${this.#cache.map(s =>
      html`<div class="save"><span class="save__title">${s.title}</span><span class="save__meta">${(s.size / 1024).toFixed(1)} KB &middot; ${s.time}</span></div>`
    )}`;
  }
}

customElements.define("savedata-panel", SavedataPanel);
