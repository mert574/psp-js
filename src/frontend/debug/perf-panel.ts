import { html, nothing, type TemplateResult } from "lit";
import { SubPanel } from "./sub-panel.js";
import type { PSPEmulator } from "../../emulator.js";
import { getPoolStats } from "../../audio/atrac-decoder.js";

const PSP_RAM_BYTES = 64 * 1024 * 1024; // 64 MB (PSP-2000/3000)
const WINDOW_MS = 500;

/** Performance section: CPU / GPU(GE) / RAM bars, prims/lists/io rates, and the
 *  optional per-frame profiler tiles. Owns its own window accumulators. */
export class PerfPanel extends SubPanel {
  static override properties = { tpl: { state: true } };
  declare tpl: TemplateResult | typeof nothing;

  /** Show per-frame timing tiles (set from the Profiler boot option). */
  profilerEnabled = false;

  #emulationStarted = false;
  #last = 0;
  #windowStart = 0;
  #cpuMsAcc = 0;
  #presentMsAcc = 0;
  #frameAcc = 0;
  #lastGeTimeMs = 0;
  #lastGePrims = 0;
  #lastGeLists = 0;
  #lastIoOps = 0;

  constructor() {
    super();
    this.tpl = nothing;
  }

  override render(): TemplateResult {
    return html`<section class="section"><h4>Performance</h4><div class="perf">${this.tpl}</div></section>`;
  }

  markStarted(): void { this.#emulationStarted = true; }

  reset(): void {
    this.#emulationStarted = false;
    this.#last = 0;
    this.#windowStart = 0;
    this.#cpuMsAcc = 0;
    this.#presentMsAcc = 0;
    this.#frameAcc = 0;
    this.#lastGeTimeMs = 0;
    this.#lastGePrims = 0;
    this.#lastGeLists = 0;
    this.#lastIoOps = 0;
    this.tpl = nothing;
  }

  /** Pre-boot view: only the AT3 decode progress tile. */
  preBoot(now: number): void {
    if (this.#emulationStarted) return;
    if (now - this.#last < WINDOW_MS) return;
    this.#last = now;
    const ps = getPoolStats();
    if (ps.size > 0) {
      this.tpl = html`<div class="stats"><div class="stat wide">
        <div class="top"><span class="label">AT3 decode</span><span class="val">${ps.busy} / ${ps.size}</span></div>
        <span class="detail">${ps.waiting} queued &middot; ${ps.cached} cached</span>
      </div></div>`;
    }
  }

  tick(emu: PSPEmulator, cpuMs: number, presentMs: number, now: number): void {
    // Accumulate every frame; render at the 0.5s window.
    this.#cpuMsAcc += cpuMs;
    this.#presentMsAcc += presentMs;
    this.#frameAcc++;
    if (now - this.#last < WINDOW_MS) return;
    this.#last = now;

    const elapsed = now - this.#windowStart;
    const perSec = (delta: number): number => (elapsed > 0 ? Math.round((delta * 1000) / elapsed) : 0);
    // GE (emulated GPU) time this window, split out of the runFrame total so CPU%
    // is the interpreter (game code) and GPU% is the GE (vertex + raster/submit).
    const geMsWindow  = emu.hle.geTimeMs - this.#lastGeTimeMs;
    const interpMsAcc = Math.max(0, this.#cpuMsAcc - geMsWindow);
    const cpuPct = elapsed > 0 ? Math.min(100, Math.round((interpMsAcc / elapsed) * 100)) : 0;
    const gpuPct = elapsed > 0 ? Math.min(100, Math.round((geMsWindow / elapsed) * 100)) : 0;
    const primsPerSec = perSec(emu.hle.gePrimCount - this.#lastGePrims);
    const listsPerSec = perSec(emu.hle.geListCount - this.#lastGeLists);
    const ioPerSec    = perSec(emu.hle.ioOpsCount  - this.#lastIoOps);

    const frames          = this.#frameAcc;
    const interpPerFrame  = frames > 0 ? interpMsAcc / frames : 0;
    const gePerFrame      = frames > 0 ? geMsWindow / frames : 0;
    const presentPerFrame = frames > 0 ? this.#presentMsAcc / frames : 0;
    const fps             = elapsed > 0 ? Math.round((frames * 1000) / elapsed) : 0;

    this.#cpuMsAcc = 0;
    this.#presentMsAcc = 0;
    this.#frameAcc = 0;
    this.#windowStart = now;
    this.#lastGeTimeMs = emu.hle.geTimeMs;
    this.#lastGePrims = emu.hle.gePrimCount;
    this.#lastGeLists = emu.hle.geListCount;
    this.#lastIoOps = emu.hle.ioOpsCount;

    let ramUsed = 0;
    for (const blk of emu.hle.memBlocks.values()) ramUsed += blk.size;
    const ramTotal = emu.hle.ramSize || PSP_RAM_BYTES;
    const ramPct   = Math.min(100, Math.round((ramUsed / ramTotal) * 100));
    const cpuColor = cpuPct < 70 ? "var(--ok)" : cpuPct < 90 ? "var(--warn)" : "var(--danger)";
    const gpuColor = "#a371f7"; // emulated-GE bar: a fixed hue, distinct from CPU and RAM
    const ramUsedMB  = (ramUsed / 1048576).toFixed(1);
    const ramTotalMB = Math.round(ramTotal / 1048576);

    const profilerTiles = this.profilerEnabled ? html`
      <div class="stat"><span class="label">Frame CPU</span><span class="val">${interpPerFrame.toFixed(1)} ms</span></div>
      <div class="stat"><span class="label">Frame GE</span><span class="val">${gePerFrame.toFixed(1)} ms</span></div>
      <div class="stat"><span class="label">Present</span><span class="val">${presentPerFrame.toFixed(1)} ms</span></div>
      <div class="stat"><span class="label">FPS</span><span class="val">${fps}</span></div>` : nothing;
    this.tpl = html`<div class="stats">
      <div class="stat wide">
        <div class="top"><span class="label">CPU</span><span class="val">${cpuPct}%</span></div>
        <span class="bar" style="--pct:${cpuPct}%;--clr:${cpuColor}"></span>
      </div>
      <div class="stat wide">
        <div class="top"><span class="label">GPU (GE)</span><span class="val">${gpuPct}%</span></div>
        <span class="bar" style="--pct:${gpuPct}%;--clr:${gpuColor}"></span>
      </div>
      <div class="stat wide">
        <div class="top"><span class="label">RAM</span><span class="val">${ramUsedMB} / ${ramTotalMB} MB</span></div>
        <span class="bar" style="--pct:${ramPct}%;--clr:#4a9eff"></span>
      </div>
      <div class="stat"><span class="label">Prims / s</span><span class="val">${primsPerSec.toLocaleString()}</span></div>
      <div class="stat"><span class="label">Lists / s</span><span class="val">${listsPerSec.toLocaleString()}</span></div>
      <div class="stat"><span class="label">IO ops / s</span><span class="val">${ioPerSec.toLocaleString()}</span></div>
      ${profilerTiles}
    </div>`;
  }
}

customElements.define("perf-panel", PerfPanel);
