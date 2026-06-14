/**
 * <savedata-list> — save slot selection dialog.
 *
 * Shows a list of save slots for LISTLOAD/LISTSAVE modes and resolves with the
 * selected slot name (or null if cancelled).
 */
import { LitElement, html, css, type TemplateResult } from "lit";

export interface SaveSlot {
  name: string;
  hasData: boolean;
  sizeKB: number;
  title: string;
}

export class SavedataList extends LitElement {
  static override styles = css`
    :host {
      position: absolute;
      inset: 0;
      z-index: 25;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.75);
      animation: fade-in 0.15s ease-out;
    }
    :host([hidden]) { display: none; }
    .dialog {
      background: #1a1a2e;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      padding: 16px;
      min-width: 280px;
      max-width: 360px;
      max-height: 80%;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    }
    .title { font: 600 15px/1.3 sans-serif; color: var(--text, #e0e0e0); margin: 0; }
    .subtitle { font: 12px/1.3 sans-serif; color: var(--muted, #888); margin: 0 0 4px; }
    .slots {
      display: flex;
      flex-direction: column;
      gap: 4px;
      overflow-y: auto;
      max-height: 200px;
    }
    .slot {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s, border-color 0.1s;
      font: 13px/1.3 var(--mono, monospace);
      color: var(--text-dim, #ccc);
    }
    .slot:hover, .slot:focus {
      background: rgba(74, 158, 255, 0.15);
      border-color: rgba(74, 158, 255, 0.4);
      outline: none;
    }
    .slot.disabled { opacity: 0.4; cursor: default; }
    .slot-name { flex: 1; color: var(--text, #e0e0e0); font-weight: 600; }
    .slot-info { color: var(--muted, #888); font-size: 11px; }
    .slot-empty { color: var(--faint, #555); font-style: italic; }
    .cancel-btn {
      align-self: flex-end;
      background: none;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      color: var(--muted, #888);
      padding: 4px 12px;
      font: 12px sans-serif;
      cursor: pointer;
      margin-top: 4px;
    }
    .cancel-btn:hover { color: var(--text-dim, #ccc); border-color: rgba(255, 255, 255, 0.3); }
    @keyframes fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
  `;

  static override properties = {
    gameTitle: { state: true },
    action: { state: true },
    slots: { state: true },
  };
  declare gameTitle: string;
  declare action: "Load" | "Save";
  declare slots: SaveSlot[];

  #resolve: ((name: string | null) => void) | null = null;

  constructor() {
    super();
    this.gameTitle = "";
    this.action = "Load";
    this.slots = [];
    this.hidden = true;
  }

  override render(): TemplateResult {
    return html`
      <div class="dialog">
        <div class="title">${this.gameTitle || (this.action === "Load" ? "Load Game" : "Save Game")}</div>
        <div class="subtitle">Save Data &middot; ${this.action === "Load" ? "choose a save to load" : "choose a slot to save"}</div>
        <div class="slots">
          ${this.slots.map(slot => {
            const disabled = this.action === "Load" && !slot.hasData;
            return html`<button class="slot ${disabled ? "disabled" : ""}" tabindex="0"
              @click=${() => { if (!disabled) this.#select(slot.name); }}>
              <span class="slot-name">${slot.name}</span>
              ${slot.hasData
                ? html`<span class="slot-info">${slot.title || slot.name} &middot; ${slot.sizeKB.toFixed(1)} KB</span>`
                : html`<span class="slot-empty">${this.action === "Save" ? "Empty" : "No Data"}</span>`}
            </button>`;
          })}
        </div>
        <button class="cancel-btn" @click=${() => this.#select(null)}>Cancel</button>
      </div>`;
  }

  /** Show the dialog. Resolves to the selected slot name, or null if cancelled. */
  show(action: "Load" | "Save", gameTitle: string, slots: SaveSlot[]): Promise<string | null> {
    this.action = action;
    this.gameTitle = gameTitle;
    this.slots = slots;
    this.hidden = false;
    // Focus the first slot once it's rendered.
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLButtonElement>(".slot")?.focus();
    });
    return new Promise(resolve => { this.#resolve = resolve; });
  }

  #select(name: string | null): void {
    this.hidden = true;
    if (this.#resolve) {
      this.#resolve(name);
      this.#resolve = null;
    }
  }
}

customElements.define("savedata-list", SavedataList);
