import type { PSPEmulator } from "../emulator.js";
import { ThreadState, WaitType } from "../kernel/hle-kernel.js";
import { Logger, type LogLevel } from "../utils/logger.js";
import { getPoolStats } from "../audio/atrac-decoder.js";

const MAX_LOG_LINES = 50;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PSP_RAM_BYTES = 64 * 1024 * 1024; // 64 MB (PSP-2000/3000)
const PERF_WINDOW_MS = 500;

export class DebugPanel {
  private readonly panel: HTMLElement;
  private readonly perfBody: HTMLElement;
  private readonly threadsBody: HTMLElement;
  private readonly geBody: HTMLElement;
  private readonly savedataBody: HTMLElement;
  private readonly stubsBody: HTMLElement;
  private readonly logBody: HTMLElement;
  private logLines: Array<{ level: LogLevel; ns: string; msg: string }> = [];

  // Savedata tracking
  private _savedataCache: Array<{ key: string; title: string; size: number; time: string }> = [];
  private _lastSavedataRefresh = 0;

  // Audio decode tracking — hidden once emulation starts
  private _emulationStarted = false;

  // Perf tracking
  private _perfWindowStart = 0;
  private _cpuMsAcc = 0;
  private _cpuPct = 0;
  private _lastGePrims = 0;
  private _lastGeLists = 0;
  private _gePrimsPerSec = 0;
  private _geListsPerSec = 0;
  private _lastIoOps = 0;
  private _ioOpsPerSec = 0;

  constructor() {
    this.panel       = document.getElementById("debug-panel")!;
    this.perfBody    = document.getElementById("debug-perf-body")!     as HTMLElement;
    this.threadsBody = document.getElementById("debug-threads-body")!  as HTMLElement;
    this.geBody      = document.getElementById("debug-ge-body")!       as HTMLElement;
    this.savedataBody = document.getElementById("debug-savedata-body")! as HTMLElement;
    this.stubsBody   = document.getElementById("debug-stubs-body")!    as HTMLElement;
    this.logBody     = document.getElementById("debug-log-body")!      as HTMLElement;

    Logger.setWarnHook((level, ns, msg) => {
      this.logLines.push({ level, ns, msg });
      if (this.logLines.length > MAX_LOG_LINES) this.logLines.shift();
    });
  }

  private _lastPanelUpdate = 0;

  update(emu: PSPEmulator, cpuMs: number): void {
    const now = performance.now();
    this._cpuMsAcc += cpuMs;

    if (now - this._lastPanelUpdate < PERF_WINDOW_MS) return;
    this._lastPanelUpdate = now;

    this._updatePerf(emu, now);
    this._updateThreads(emu);
    this._updateGe(emu);
    this._updateSavedata(emu, now);
    this._updateStubs(emu);
    this._updateLog();
  }

  destroy(): void {
    Logger.setWarnHook(null);
  }

  private _updatePerf(emu: PSPEmulator, now: number): void {
    const elapsed = now - this._perfWindowStart;
    this._cpuPct        = elapsed > 0 ? Math.min(100, Math.round((this._cpuMsAcc / elapsed) * 100)) : 0;
    this._gePrimsPerSec = emu.hle.gePrimCount - this._lastGePrims;
    this._geListsPerSec = emu.hle.geListCount  - this._lastGeLists;
    this._ioOpsPerSec   = emu.hle.ioOpsCount   - this._lastIoOps;
    this._cpuMsAcc      = 0;
    this._perfWindowStart = now;
    this._lastGePrims   = emu.hle.gePrimCount;
    this._lastGeLists   = emu.hle.geListCount;
    this._lastIoOps     = emu.hle.ioOpsCount;

    // RAM: sum allocated memBlocks
    let ramUsed = 0;
    for (const blk of emu.hle.memBlocks.values()) ramUsed += blk.size;
    const ramUsedKB  = Math.round(ramUsed / 1024);
    const ramTotalKB = PSP_RAM_BYTES / 1024;
    const ramPct     = Math.min(100, Math.round((ramUsed / PSP_RAM_BYTES) * 100));

    const bar = (pct: number, color: string): string =>
      `<span class="dbg-bar" style="--pct:${pct}%;--clr:${color}"></span>`;

    let html =
      `<div class="dbg-perf-row"><span>CPU</span>${bar(this._cpuPct, "var(--highlight)")}<span>${this._cpuPct}%</span></div>` +
      `<div class="dbg-perf-row"><span>RAM</span>${bar(ramPct, "#4a9eff")}<span>${ramUsedKB} / ${ramTotalKB} KB</span></div>` +
      `<div class="dbg-perf-row"><span>GPU</span><span class="dbg-perf-detail">${this._geListsPerSec} lists/s &nbsp; ${this._gePrimsPerSec} prims/s</span></div>` +
      `<div class="dbg-perf-row"><span>IO</span><span class="dbg-perf-detail">${this._ioOpsPerSec} ops/s</span></div>`;

    if (!this._emulationStarted) {
      const ps = getPoolStats();
      if (ps.size > 0) {
        html += `<div class="dbg-perf-row"><span>AT3</span><span class="dbg-perf-detail">${ps.busy}/${ps.size} busy &nbsp; ${ps.waiting} queued &nbsp; ${ps.cached} cached</span></div>`;
      }
    }

    this.perfBody.innerHTML = html;
  }

  /** Call when emulation starts to hide the decode stats row. */
  markEmulationStarted(): void {
    this._emulationStarted = true;
  }

  /** Lightweight update for pre-boot phase (no emulator needed). Shows decode stats only. */
  updatePreBoot(): void {
    if (this._emulationStarted) return;
    const now = performance.now();
    if (now - this._lastPanelUpdate < PERF_WINDOW_MS) return;
    this._lastPanelUpdate = now;
    const ps = getPoolStats();
    if (ps.size > 0) {
      this.perfBody.innerHTML =
        `<div class="dbg-perf-row"><span>AT3</span><span class="dbg-perf-detail">${ps.busy}/${ps.size} busy &nbsp; ${ps.waiting} queued &nbsp; ${ps.cached} cached</span></div>`;
    }
  }

  private _updateThreads(emu: PSPEmulator): void {
    const threads = emu.hle.getThreadsSnapshot();
    const curId = emu.hle.currentThreadId;

    if (threads.length === 0) {
      this.threadsBody.innerHTML = `<tr><td colspan="4" style="color:var(--muted)">No threads</td></tr>`;
      return;
    }

    this.threadsBody.innerHTML = threads.map(t => {
      const active = t.id === curId;
      const stateStr = ThreadState[t.state] ?? String(t.state);
      const waitStr  = t.waitType !== WaitType.NONE ? `<span style="color:var(--muted)">/${WaitType[t.waitType]}</span>` : "";
      const pcStr    = `0x${t.pc.toString(16).padStart(8, "0")}`;
      return `<tr class="${active ? "dbg-row--active" : ""}">
        <td><span style="display:inline-block;width:10px;font-size:9px">${active ? "▶" : ""}</span>${t.id}</td>
        <td>${stateStr}${waitStr}</td>
        <td>${t.priority}</td>
        <td>${pcStr}</td>
      </tr>`;
    }).join("");
  }

  private _updateGe(emu: PSPEmulator): void {
    const h = emu.hle;
    this.geBody.innerHTML =
      `<div>Lists: <b>${h.geListCount}</b> &nbsp; Prims: <b>${h.gePrimCount}</b> &nbsp; Clears: <b>${h.geClearCount}</b> &nbsp; Skips: <b>${h.geSkipCount}</b></div>` +
      `<div>GE FB: <b>0x${h.geFbAddr.toString(16)}</b> &nbsp; W: <b>${h.geFbWidth}</b> &nbsp; Fmt: <b>${h.geFbFormat}</b></div>` +
      `<div>Display FB: <b>0x${h.framebufAddr.toString(16)}</b> &nbsp; W: <b>${h.framebufWidth}</b> &nbsp; Fmt: <b>${h.framebufFormat}</b></div>`;
  }

  private _updateSavedata(emu: PSPEmulator, now: number): void {
    const store = emu.hle.savedataStore;
    if (!store) {
      this.savedataBody.innerHTML = `<div style="color:var(--muted)">No store</div>`;
      return;
    }
    // Refresh from IndexedDB every 3 seconds (async, non-blocking)
    if (now - this._lastSavedataRefresh > 3000) {
      this._lastSavedataRefresh = now;
      store.list("").then(entries => {
        this._savedataCache = entries.map(e => ({
          key: e.key,
          title: e.title || e.key,
          size: e.data.byteLength,
          time: new Date(e.timestamp).toLocaleTimeString(),
        }));
      }).catch(() => { /* ignore */ });
    }
    if (this._savedataCache.length === 0) {
      this.savedataBody.innerHTML = `<div style="color:var(--muted)">No saves</div>`;
      return;
    }
    this.savedataBody.innerHTML = this._savedataCache.map(s =>
      `<div><span class="dbg-stub-name">${esc(s.title)}</span> <span class="dbg-stub-count">${(s.size / 1024).toFixed(1)} KB &middot; ${s.time}</span></div>`
    ).join("");
  }

  private _updateStubs(emu: PSPEmulator): void {
    const calls = emu.hle.stubCalls;
    if (calls.size === 0) {
      this.stubsBody.innerHTML = `<div style="color:var(--muted)">No stubs called</div>`;
      return;
    }
    const sorted = [...calls.entries()].sort((a, b) => b[1] - a[1]);
    this.stubsBody.innerHTML = sorted.map(([name, count]) =>
      `<div><span class="dbg-stub-name">${esc(name)}</span> <span class="dbg-stub-count">&times;${count}</span></div>`
    ).join("");
  }

  /** Dump stub call stats to console (call on crash). */
  dumpStubsToConsole(emu: PSPEmulator): void {
    const calls = emu.hle.stubCalls;
    if (calls.size === 0) return;
    const sorted = [...calls.entries()].sort((a, b) => b[1] - a[1]);
    console.info("[HLE] Stub calls at crash:");
    for (const [name, count] of sorted) {
      console.info(`  ${name}: ${count}`);
    }
  }

  private _updateLog(): void {
    if (this.logLines.length === 0) {
      this.logBody.innerHTML = `<div style="color:var(--muted)">No warnings yet</div>`;
      return;
    }
    const wasAtBottom = this.logBody.scrollTop + this.logBody.clientHeight >= this.logBody.scrollHeight - 4;
    this.logBody.innerHTML = this.logLines.map(({ level, ns, msg }) => {
      const cls = level === "error" ? "dbg-log--error" : "dbg-log--warn";
      const pfx = level === "error" ? "ERR " : "WARN";
      return `<div class="${cls}">${pfx} [${esc(ns)}] ${esc(msg)}</div>`;
    }).join("");
    if (wasAtBottom) this.logBody.scrollTop = this.logBody.scrollHeight;
  }
}
