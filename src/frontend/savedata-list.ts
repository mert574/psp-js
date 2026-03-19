/**
 * <savedata-list> — Web Component for save slot selection dialog.
 *
 * Shows a list of save slots for LISTLOAD/LISTSAVE modes.
 * Calls back with the selected slot name.
 */

const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
<style>
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
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  }
  .title {
    font: 600 14px/1.3 sans-serif;
    color: #e0e0e0;
    margin: 0 0 4px;
  }
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
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s;
    font: 13px/1.3 monospace;
    color: #ccc;
  }
  .slot:hover, .slot:focus {
    background: rgba(74, 158, 255, 0.15);
    border-color: rgba(74, 158, 255, 0.4);
    outline: none;
  }
  .slot-name { flex: 1; color: #e0e0e0; font-weight: 600; }
  .slot-info { color: #888; font-size: 11px; }
  .slot-empty { color: #555; font-style: italic; }
  .cancel-btn {
    align-self: flex-end;
    background: none;
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 4px;
    color: #888;
    padding: 4px 12px;
    font: 12px sans-serif;
    cursor: pointer;
    margin-top: 4px;
  }
  .cancel-btn:hover { color: #ccc; border-color: rgba(255,255,255,0.3); }
  @keyframes fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
</style>
<div class="dialog">
  <div class="title" id="title">Select Save Slot</div>
  <div class="slots" id="slots"></div>
  <button class="cancel-btn" id="cancel">Cancel</button>
</div>
`;

export interface SaveSlot {
  name: string;
  hasData: boolean;
  sizeKB: number;
  title: string;
}

export class SavedataList extends HTMLElement {
  private _resolve: ((name: string | null) => void) | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot!.appendChild(TEMPLATE.content.cloneNode(true));
    this.hidden = true;

    this.shadowRoot!.getElementById("cancel")!.addEventListener("click", () => {
      this._select(null);
    });
  }

  /**
   * Show the slot selection dialog.
   * Returns a Promise that resolves to the selected slot name, or null if cancelled.
   */
  show(action: "Load" | "Save", slots: SaveSlot[]): Promise<string | null> {
    const titleEl = this.shadowRoot!.getElementById("title")!;
    const slotsEl = this.shadowRoot!.getElementById("slots")!;

    titleEl.textContent = action === "Load" ? "Load Game" : "Save Game";

    slotsEl.innerHTML = "";
    for (const slot of slots) {
      const btn = document.createElement("button");
      btn.className = "slot";
      btn.tabIndex = 0;

      if (slot.hasData) {
        btn.innerHTML =
          `<span class="slot-name">${esc(slot.name)}</span>` +
          `<span class="slot-info">${esc(slot.title || slot.name)} — ${slot.sizeKB.toFixed(1)} KB</span>`;
      } else {
        btn.innerHTML =
          `<span class="slot-name">${esc(slot.name)}</span>` +
          `<span class="slot-empty">${action === "Save" ? "Empty" : "No Data"}</span>`;
        // For load mode, disable empty slots
        if (action === "Load") {
          btn.style.opacity = "0.4";
          btn.style.cursor = "default";
        }
      }

      btn.addEventListener("click", () => {
        if (action === "Load" && !slot.hasData) return;
        this._select(slot.name);
      });

      slotsEl.appendChild(btn);
    }

    this.hidden = false;
    // Focus first available slot
    const first = slotsEl.querySelector<HTMLButtonElement>(".slot");
    first?.focus();

    return new Promise(resolve => { this._resolve = resolve; });
  }

  private _select(name: string | null): void {
    this.hidden = true;
    if (this._resolve) {
      this._resolve(name);
      this._resolve = null;
    }
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

customElements.define("savedata-list", SavedataList);
