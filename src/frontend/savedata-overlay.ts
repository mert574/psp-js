/**
 * <savedata-overlay> — a small toast shown while the game reads or writes save
 * data, so the player knows what the flash of activity was.
 *
 * Usage:
 *   const overlay = document.querySelector("savedata-overlay")!;
 *   overlay.show("Saving", "GAME01", "DATA01");
 *   overlay.complete(false); // false = success, true = error
 */
import { LitElement, html, css, nothing, type TemplateResult } from "lit";

export class SavedataOverlay extends LitElement {
  static override styles = css`
    :host {
      position: absolute;
      bottom: 12px;
      right: 12px;
      z-index: 15;
      pointer-events: none;
    }
    :host([hidden]) { display: none; }
    .card {
      display: flex;
      flex-direction: column;
      gap: 3px;
      background: rgba(0, 0, 0, 0.82);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 7px 13px;
      animation: slide-in 0.2s ease-out;
      transition: opacity 0.3s ease;
    }
    .card.fade-out { opacity: 0; }
    .label {
      font: 700 9px/1 var(--mono, monospace);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--faint, #6e7681);
    }
    .status { display: flex; align-items: center; gap: 7px; }
    .spinner {
      width: 11px;
      height: 11px;
      border: 2px solid rgba(255, 255, 255, 0.18);
      border-top-color: var(--accent, #4a9eff);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      flex-shrink: 0;
    }
    .text { font: 12px/1.3 var(--mono, monospace); color: var(--text, #e0e0e0); white-space: nowrap; }
    .action { color: var(--accent, #4a9eff); font-weight: 600; }
    .action.done { color: var(--ok, #4aef7a); }
    .action.err  { color: var(--danger, #ef4a4a); }
    .detail { color: var(--muted, #888); margin-left: 4px; }
    @keyframes slide-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  static override properties = {
    spin: { state: true },
    actionText: { state: true },
    actionKind: { state: true },
    detail: { state: true },
    fadeOut: { state: true },
  };
  declare spin: boolean;
  declare actionText: string;
  declare actionKind: "" | "done" | "err";
  declare detail: string;
  declare fadeOut: boolean;

  #hideTimer = 0;
  #action = ""; // what we're doing now, so complete() can word the result ("Saved" not "Done")

  constructor() {
    super();
    this.spin = true;
    this.actionText = "";
    this.actionKind = "";
    this.detail = "";
    this.fadeOut = false;
    this.hidden = true;
  }

  override render(): TemplateResult {
    return html`
      <div class="card ${this.fadeOut ? "fade-out" : ""}" part="card">
        <span class="label">Save Data</span>
        <div class="status">
          ${this.spin ? html`<span class="spinner"></span>` : nothing}
          <span class="text"><span class="action ${this.actionKind}">${this.actionText}</span><span class="detail">${this.detail}</span></span>
        </div>
      </div>`;
  }

  /** Show the toast with an in-progress message ("Saving..." / "Loading..."). */
  show(action: string, _gameName: string, saveName: string): void {
    clearTimeout(this.#hideTimer);
    this.#action = action;
    this.spin = true;
    this.actionText = `${action}...`;
    this.actionKind = "";
    this.detail = saveName ? `(${saveName})` : "";
    this.fadeOut = false;
    this.hidden = false;
  }

  /** Mark as complete — word the result from the action, then fade out. */
  complete(error: boolean): void {
    this.spin = false;
    const a = this.#action.toLowerCase();
    const verb = a.includes("sav") ? "save" : a.includes("load") ? "load" : a.includes("delet") ? "delete" : "";
    if (error) {
      this.actionText = verb === "load" ? "No saved data" : verb === "save" ? "Save failed" : verb === "delete" ? "Delete failed" : "Failed";
      this.actionKind = "err";
    } else {
      this.actionText = verb === "load" ? "Loaded" : verb === "save" ? "Saved" : verb === "delete" ? "Deleted" : "Done";
      this.actionKind = "done";
    }
    this.#hideTimer = window.setTimeout(() => {
      this.fadeOut = true;
      this.#hideTimer = window.setTimeout(() => {
        this.hidden = true;
        this.actionKind = "";
      }, 300);
    }, 1200);
  }
}

customElements.define("savedata-overlay", SavedataOverlay);
