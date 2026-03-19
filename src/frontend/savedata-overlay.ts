/**
 * <savedata-overlay> — Web Component for save/load notification overlay.
 *
 * Usage:
 *   const overlay = document.querySelector("savedata-overlay")!;
 *   overlay.show("Saving", "GAME01", "DATA01");
 *   overlay.complete(false); // false = success, true = error
 */

const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
<style>
  :host {
    position: absolute;
    bottom: 12px;
    right: 12px;
    z-index: 15;
    pointer-events: none;
  }
  .card {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(0, 0, 0, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    padding: 8px 14px;
    animation: slide-in 0.2s ease-out;
    transition: opacity 0.3s ease;
  }
  .card.fade-out {
    opacity: 0;
  }
  .icon {
    font-size: 18px;
    line-height: 1;
  }
  .icon.spin {
    animation: spin 1s linear infinite;
  }
  .text {
    font: 12px/1.3 monospace;
    color: #e0e0e0;
    white-space: nowrap;
  }
  .action { color: #4a9eff; font-weight: 600; }
  .detail { color: #888; margin-left: 2px; }
  .done   { color: #4aef7a; }
  .err    { color: #ef4a4a; }
  @keyframes slide-in {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
<div class="card" part="card">
  <span class="icon spin" id="icon">💾</span>
  <span class="text">
    <span class="action" id="action"></span>
    <span class="detail" id="detail"></span>
  </span>
</div>
`;

export class SavedataOverlay extends HTMLElement {
  private _hideTimer = 0;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot!.appendChild(TEMPLATE.content.cloneNode(true));
    this.hidden = true;
  }

  /** Show the overlay with an in-progress message */
  show(action: string, gameName: string, saveName: string): void {
    clearTimeout(this._hideTimer);
    const iconEl = this.shadowRoot!.getElementById("icon")!;
    const actionEl = this.shadowRoot!.getElementById("action")!;
    const detailEl = this.shadowRoot!.getElementById("detail")!;
    const card = this.shadowRoot!.querySelector(".card")!;

    iconEl.textContent = action === "Deleting" ? "🗑️" : "💾";
    iconEl.classList.add("spin");
    actionEl.textContent = `${action}…`;
    detailEl.textContent = saveName ? `(${saveName})` : "";
    card.classList.remove("fade-out");
    this.hidden = false;
  }

  /** Mark as complete — shows success/error briefly then fades out */
  complete(error: boolean): void {
    const iconEl = this.shadowRoot!.getElementById("icon")!;
    const actionEl = this.shadowRoot!.getElementById("action")!;
    const card = this.shadowRoot!.querySelector(".card")!;

    iconEl.classList.remove("spin");
    if (error) {
      iconEl.textContent = "❌";
      actionEl.textContent = "No data";
      actionEl.className = "action err";
    } else {
      iconEl.textContent = "✅";
      actionEl.textContent = "Done";
      actionEl.className = "action done";
    }

    this._hideTimer = window.setTimeout(() => {
      card.classList.add("fade-out");
      this._hideTimer = window.setTimeout(() => {
        this.hidden = true;
        actionEl.className = "action";
      }, 300);
    }, 1200);
  }
}

customElements.define("savedata-overlay", SavedataOverlay);
