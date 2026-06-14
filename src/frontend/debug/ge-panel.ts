import { html, nothing, type TemplateResult } from "lit";
import { SubPanel } from "./sub-panel.js";
import type { PSPEmulator } from "../../emulator.js";

const WINDOW_MS = 500;

/** GE section: list/prim/clear/skip counters plus framebuffer + VFB fields. */
export class GePanel extends SubPanel {
  static override properties = { tpl: { state: true } };
  declare tpl: TemplateResult | typeof nothing;

  #last = 0;

  constructor() {
    super();
    this.tpl = nothing;
  }

  override render(): TemplateResult {
    return html`<section class="section"><h4>GE</h4><div class="ge">${this.tpl}</div></section>`;
  }

  reset(): void { this.#last = 0; this.tpl = nothing; }

  tick(emu: PSPEmulator, now: number): void {
    if (now - this.#last < WINDOW_MS) return;
    this.#last = now;
    const h = emu.hle;
    const ge = h.geProcessor?.webglRenderer ?? null;
    const sep = html`<span class="sep">·</span>`;
    const count = (label: string, val: string | number): TemplateResult =>
      html`<div class="ge__count"><span>${label}</span><b>${val}</b></div>`;
    const field = (label: string, body: TemplateResult): TemplateResult =>
      html`<dt>${label}</dt><dd>${body}</dd>`;

    const fields: TemplateResult[] = [
      field("GE FB",   html`<b>0x${h.geFbAddr.toString(16)}</b>${sep}W <b>${h.geFbWidth}</b>${sep}fmt <b>${h.geFbFormat}</b>`),
      field("Display", html`<b>0x${h.framebufAddr.toString(16)}</b>${sep}W <b>${h.framebufWidth}</b>${sep}fmt <b>${h.framebufFormat}</b>`),
    ];
    if (ge) {
      fields.push(field("VFBs", html`<b>${ge.dbgVFBCount}</b>${sep}${String(ge.dbgVFBKeys)}`));
      const path = String(ge._dbgDisplayPath ?? "");
      if (path) fields.push(field("Path", html`${path}`));
      fields.push(field("Blits", html`<b>${ge._dbgBlitCount}</b>${sep}RB <b>${ge._dbgReadbackCount}</b>`));
    }

    this.tpl = html`
      <div class="ge__counters">${count("Lists", h.geListCount)}${count("Prims", h.gePrimCount)}${count("Clears", h.geClearCount)}${count("Skips", h.geSkipCount)}</div>
      <dl class="ge__fields">${fields}</dl>`;
  }
}

customElements.define("ge-panel", GePanel);
