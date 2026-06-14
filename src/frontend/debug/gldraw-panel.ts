import { html, nothing, type TemplateResult } from "lit";
import { SubPanel } from "./sub-panel.js";
import type { PSPEmulator } from "../../emulator.js";
import { fmtBytes } from "../lib/format.js";

const WINDOW_MS = 500;

/** Per-frame WebGL GPU-cost counters (geGlStatsFrame). Only renders when the
 *  profiler is on AND the WebGL renderer is live; otherwise the whole section
 *  collapses (renders nothing) rather than showing zeros. */
export class GlDrawPanel extends SubPanel {
  static override properties = { tpl: { state: true } };
  declare tpl: TemplateResult | typeof nothing;

  profilerEnabled = false;
  #last = 0;

  constructor() {
    super();
    this.tpl = nothing;
  }

  override render(): TemplateResult | typeof nothing {
    return this.tpl;
  }

  reset(): void {
    this.#last = 0;
    this.tpl = nothing;
  }

  tick(emu: PSPEmulator, now: number): void {
    if (now - this.#last < WINDOW_MS) return;
    this.#last = now;
    const ge = emu.hle.geProcessor?.webglRenderer ?? null;
    const f = ge?.geGlStatsFrame ?? null;
    if (!this.profilerEnabled || !f) {
      this.tpl = nothing;
      return;
    }
    const vpd = f.drawCalls > 0 ? (f.drawVerts / f.drawCalls).toFixed(1) : "0";
    this.tpl = html`<section class="section gldraw-section">
      <h4>GE Draw Stats
        <info-popover label="About the GE draw stats">
          <strong>GE draw stats (this frame)</strong>
          <div>What the host GPU actually did for the just-finished frame on the WebGL path. Only shown with the profiler on and the WebGL renderer active.</div>
          <dl>
            <dt>Draws</dt><dd>drawArrays calls (one per PSP prim)</dd>
            <dt>Targets</dt><dd>render-target switches (each is a tiled load/store)</dd>
            <dt>Tex</dt><dd>texture uploads, cache hits/misses, from-VFB reuse</dd>
            <dt>Sub-rect</dt><dd>texSubImage2D from block transfers / present</dd>
            <dt>Readback</dt><dd>readPixels FBO to RAM, a hard GPU sync each</dd>
            <dt>Present</dt><dd>present + blit calls</dd>
          </dl>
        </info-popover>
      </h4>
      <div class="gldraw">
        <div class="gldraw__head">
          <span class="lbl">Draw calls</span>
          <span class="num">${f.drawCalls.toLocaleString()}</span>
          <span class="sub">${vpd} v/draw</span>
        </div>
        <dl class="gldraw__grid">
          <dt>Verts</dt><dd>${f.drawVerts.toLocaleString()}</dd>
          <dt>Targets</dt><dd>${f.fboBinds.toLocaleString()}</dd>
          <dt>Tex</dt><dd><b>${f.texUploads.toLocaleString()}</b> <span class="mut">up &middot; ${fmtBytes(f.texUploadBytes)} &middot; ${f.texHits.toLocaleString()} hit &middot; ${f.texMiss.toLocaleString()} miss &middot; ${f.texFromVFB.toLocaleString()} vfb</span></dd>
          <dt>Sub-rect</dt><dd><b>${f.subUploads.toLocaleString()}</b> <span class="mut">&middot; ${fmtBytes(f.subUploadBytes)}</span></dd>
          <dt class="sync">Readback</dt><dd><b>${f.readbacks.toLocaleString()}</b> <span class="mut">&middot; ${fmtBytes(f.readbackBytes)}</span></dd>
          <dt>Present</dt><dd><b>${f.presentCalls.toLocaleString()}</b> <span class="mut">present &middot; ${f.blitCalls.toLocaleString()} blit</span></dd>
        </dl>
      </div>
    </section>`;
  }
}

customElements.define("gldraw-panel", GlDrawPanel);
