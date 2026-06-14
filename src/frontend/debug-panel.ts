import type { PSPEmulator } from "../emulator.js";
import { ThreadState, WaitType } from "../kernel/hle-kernel.js";
import { Logger, type LogLevel } from "../utils/logger.js";
import { getPoolStats } from "../audio/atrac-decoder.js";
import { MemoryRegion, toPhysical } from "../memory/memory-map.js";

const MAX_LOG_LINES = 50;
const PSP_RAM_BYTES = 64 * 1024 * 1024; // 64 MB (PSP-2000/3000)
const PERF_WINDOW_MS = 250;

// Heap hex viewer: 8 bytes per row keeps the row inside the 390px panel without
// horizontal scroll; 64 rows = a 512-byte window per page, scrolled in the box.
const HEAP_BYTES_PER_ROW = 8;
const HEAP_ROWS = 64;
const HEAP_WINDOW = HEAP_BYTES_PER_ROW * HEAP_ROWS;
// The hex dump refreshes at ~10Hz (faster than the 2Hz whole-panel cadence) so
// changing memory looks live, but not every frame — 60 reflows/sec would be waste.
const HEAP_REFRESH_MS = 100;

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

// Like fmtSize but with full B/KB/MB suffixes, used in the GE draw stats where
// the bytes sit next to a count so the unit needs to be unambiguous.
function fmtBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// MIPS O32 register names, indexed by GPR number.
const GPR_NAMES = [
  "zero", "at", "v0", "v1", "a0", "a1", "a2", "a3",
  "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7",
  "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7",
  "t8", "t9", "k0", "k1", "gp", "sp", "fp", "ra",
];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Constructable stylesheet shared by every instance (latest-Chrome only).
// Inherited CSS custom properties (the --tokens from :root) cross the shadow
// boundary, so we can reuse the app's design tokens in here. CSS nesting used
// throughout.
const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  :host {
    display: none;
    flex: 0 0 390px;
    align-self: stretch;
    position: sticky;
    top: 64px;
    max-height: calc(100vh - 56px - 30px - 40px);
    overflow-y: auto;
    box-sizing: border-box;
    background: var(--bg-elev, #11161f);
    border: 1px solid var(--border, #2a313c);
    border-radius: var(--radius, 12px);
    padding: 16px;
    font-family: var(--mono, monospace);
    font-size: 11px;
    color: var(--text-dim, #c9d1d9);
    scrollbar-width: thin;
    scrollbar-color: var(--border, #2a313c) transparent;

    &::-webkit-scrollbar { width: 5px; }
    &::-webkit-scrollbar-thumb { background: var(--border, #2a313c); border-radius: 3px; }
  }
  :host(.debug-sidebar--open) { display: flex; flex-direction: column; gap: 2px; }

  @media (max-width: 900px) {
    :host {
      position: static;
      flex-basis: auto;
      width: 100%;
      max-width: 540px;
      max-height: 340px;
    }
  }

  .title {
    display: flex;
    align-items: center;
    gap: 9px;
    flex-shrink: 0;
    position: sticky;
    top: 0;
    /* Above the section sticky headers (.threads th is z-index 1) so they don't
       paint over the title when their section scrolls up under it. */
    z-index: 5;
    background: var(--bg-elev, #11161f);
    font-size: 12px;
    font-weight: 700;
    color: var(--text-dim, #c9d1d9);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    /* Bottom spacing matches the section rhythm (6px margin + the :host 2px flex
       gap = 8px, same as the gap between sections) instead of the old stacked
       12px padding + 12px margin + 2px gap. */
    margin: 0 0 6px;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border-soft, #21262d);
  }
  .close {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--muted, #8b949e);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 2px 5px;
    border-radius: 5px;

    &:hover { color: var(--text, #e6edf3); background: var(--surface-2, #1c232d); }
  }

  .section {
    padding: 10px 12px;
    background: var(--surface, #161b22);
    border: 1px solid var(--border-soft, #21262d);
    border-radius: var(--radius-sm, 8px);
    margin-bottom: 6px;

    & > h4 {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--faint, #6e7681);
      margin: 0 0 8px;
    }
    & .note { color: var(--muted, #8b949e); font-weight: 400; }
  }

  /* Info icon + hover tooltip. position:fixed + anchor positioning so the popup
     escapes the panel's overflow clipping (latest Chrome). */
  /* The wrapper has no box of its own; <info-popover> assigns each instance a
     unique anchor-name at runtime (see the InfoPopover element). */
  info-popover { display: contents; }
  .info {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 13px;
    height: 13px;
    margin-left: 6px;
    border-radius: 50%;
    border: 1px solid var(--border, #2a313c);
    color: var(--muted, #8b949e);
    font-size: 8px;
    font-weight: 700;
    font-style: normal;
    text-transform: none;
    letter-spacing: 0;
    cursor: help;
    vertical-align: middle;

    &:hover, &:focus-visible { color: var(--accent, #58a6ff); border-color: var(--accent, #58a6ff); outline: none; }
  }
  .info-pop {
    /* position-anchor is set per-instance by <info-popover> so each popover
       tracks its own trigger (including on scroll), not a shared anchor. */
    position: fixed;
    top: anchor(top);
    right: anchor(left);
    margin-right: 8px;
    width: 280px;
    max-width: 78vw;
    z-index: 100;
    display: none;
    padding: 10px 12px;
    background: var(--bg-elev, #11161f);
    border: 1px solid var(--border, #2a313c);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    font-size: 10px;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--text-dim, #c9d1d9);
    white-space: normal;

    & strong { display: block; color: var(--text, #e6edf3); font-size: 11px; margin-bottom: 4px; }
    & > div { color: var(--muted, #8b949e); margin-bottom: 8px; }
    & dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0; }
    & dt { color: var(--accent, #58a6ff); }
    & dd { color: var(--text-dim, #c9d1d9); margin: 0; }
  }
  .info:hover .info-pop, .info:focus-within .info-pop { display: block; }

  /* Performance stat tiles */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .stat {
    background: var(--bg, #0b0e14);
    border: 1px solid var(--border-soft, #21262d);
    border-radius: 8px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 3px;

    &.wide { grid-column: 1 / -1; gap: 6px; }
    & .top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    & .label { color: var(--faint, #6e7681); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
    & .val { color: var(--text, #e6edf3); font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
    &.wide .val { font-size: 13px; }
    & .detail { color: var(--muted, #8b949e); font-size: 10px; }
  }
  .bar {
    display: block;
    height: 5px;
    border-radius: 3px;
    background: var(--surface-2, #1c232d);
    position: relative;
    overflow: hidden;

    &::after {
      content: "";
      position: absolute;
      inset: 0;
      right: calc(100% - var(--pct));
      background: var(--clr);
      border-radius: inherit;
      transition: right 0.45s ease, background 0.45s ease;
    }
  }

  /* Threads — dense debugger table with a colored status dot */
  .threads {
    max-height: 224px;        /* ~10 rows + header, then scroll */
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border, #2a313c) transparent;

    &::-webkit-scrollbar { width: 4px; }
    &::-webkit-scrollbar-thumb { background: var(--border, #2a313c); border-radius: 2px; }
  }
  .threads table { width: 100%; border-collapse: collapse; font-size: 10.5px; font-variant-numeric: tabular-nums; }
  .threads th {
    position: sticky;
    top: 0;
    z-index: 1;
    text-align: left;
    padding: 2px 6px;
    background: var(--surface, #161b22);
    color: var(--faint, #6e7681);
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border-soft, #21262d);
  }
  .threads th:nth-child(1) { width: 54px; }
  .threads th:nth-child(3) { width: 30px; }
  .threads th:nth-child(4) { width: 82px; }
  .threads td { padding: 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .threads tr.active td { color: var(--accent, #58a6ff); font-weight: 600; }
  .threads .t-id { display: flex; align-items: center; gap: 6px; color: var(--text-dim, #c9d1d9); }
  .threads .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint, #6e7681); flex-shrink: 0; }
  .threads .wait { color: var(--muted, #8b949e); }
  .threads .t-prio { color: var(--muted, #8b949e); }
  .threads .t-pc { color: var(--muted, #8b949e); }
  .threads tbody tr { cursor: pointer; }
  .threads tr.selected td { background: color-mix(in srgb, var(--accent, #58a6ff) 16%, transparent); }
  .threads tr.selected .t-id { box-shadow: inset 2px 0 var(--accent, #58a6ff); }
  .threads tr[data-state="RUNNING"] .dot { background: var(--ok, #3fb950); box-shadow: 0 0 5px var(--ok, #3fb950); }
  .threads tr[data-state="READY"]   .dot { background: var(--accent, #58a6ff); }
  .threads tr[data-state="WAITING"] .dot { background: var(--warn, #d29922); }
  .threads tr[data-state="DEAD"]    .dot { background: var(--danger, #f85149); }

  /* Thread inspector (read-only) */
  .thread-detail {
    margin-top: 8px;
    padding: 9px 10px;
    background: var(--bg, #0b0e14);
    border: 1px solid var(--border-soft, #21262d);
    border-left: 2px solid var(--accent, #58a6ff);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .thread-detail[hidden] { display: none; }
  .td-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .td-title { color: var(--accent, #58a6ff); font-weight: 700; font-size: 11px; }
  .td-meta { color: var(--muted, #8b949e); font-size: 10px; }
  .td-rows { display: flex; flex-direction: column; gap: 2px; }
  .td-row, .td-wait { display: flex; gap: 8px; font-size: 10px; align-items: baseline; }
  .td-k { flex-shrink: 0; min-width: 42px; color: var(--faint, #6e7681); text-transform: uppercase; letter-spacing: 0.04em; font-size: 9px; }
  .td-v { color: var(--text-dim, #c9d1d9); font-variant-numeric: tabular-nums; }
  .td-wait .td-k { color: var(--warn, #d29922); }
  .td-wait span:last-child { color: var(--text-dim, #c9d1d9); }
  .td-wait.idle .td-k { color: var(--faint, #6e7681); }
  .td-wait.idle span:last-child { color: var(--muted, #8b949e); }
  .td-regs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 2px 8px;
    padding-top: 6px;
    border-top: 1px solid var(--border-soft, #21262d);
  }
  .td-reg { display: flex; justify-content: space-between; gap: 4px; font-size: 9px; font-variant-numeric: tabular-nums; }
  .td-rn { color: var(--faint, #6e7681); }
  .td-rv { color: var(--text-dim, #c9d1d9); }
  .td-reg.hot .td-rn, .td-reg.hot .td-rv { color: var(--accent, #58a6ff); }

  /* Heap — allocation picker + hex/ASCII dump */
  .heap { display: flex; flex-direction: column; gap: 8px; }
  .heap-ctl { display: flex; gap: 6px; align-items: center; }
  .heap-ctl select, .heap-ctl input {
    font: inherit;
    font-size: 10px;
    background: var(--bg, #0b0e14);
    color: var(--text-dim, #c9d1d9);
    border: 1px solid var(--border-soft, #21262d);
    border-radius: 5px;
    padding: 3px 5px;
  }
  .heap-ctl select { flex: 1; min-width: 0; }
  .heap-ctl input { width: 86px; font-variant-numeric: tabular-nums; }
  .heap-ctl select:focus, .heap-ctl input:focus { outline: none; border-color: var(--accent, #58a6ff); }
  .heap-ctl button {
    flex-shrink: 0;
    background: var(--surface-2, #1c232d);
    color: var(--muted, #8b949e);
    border: 1px solid var(--border-soft, #21262d);
    border-radius: 5px;
    padding: 3px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    line-height: 1;

    &:hover { color: var(--text, #e6edf3); border-color: var(--border, #2a313c); }
  }
  .heap-toggle { font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; min-width: 34px; }
  .heap-toggle[aria-pressed="true"] { color: var(--ok, #3fb950); border-color: color-mix(in srgb, var(--ok, #3fb950) 45%, transparent); }
  .heap-skip-lbl {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 9.5px;
    color: var(--muted, #8b949e);
    cursor: pointer;
    user-select: none;
  }
  .heap-skip-lbl input { accent-color: var(--accent, #58a6ff); width: 12px; height: 12px; margin: 0; cursor: pointer; }
  .heap-sum { color: var(--muted, #8b949e); font-size: 9.5px; }
  .heap-sum b { color: var(--text-dim, #c9d1d9); font-variant-numeric: tabular-nums; }
  .hexdump {
    max-height: 360px;
    overflow-y: auto;
    background: var(--bg, #0b0e14);
    border: 1px solid var(--border-soft, #21262d);
    border-radius: 6px;
    padding: 5px 7px;
    scrollbar-width: thin;
    scrollbar-color: var(--border, #2a313c) transparent;

    &::-webkit-scrollbar { width: 4px; }
    &::-webkit-scrollbar-thumb { background: var(--border, #2a313c); border-radius: 2px; }
  }
  .hexrow { display: flex; gap: 12px; font-size: 10px; line-height: 1.55; white-space: pre; font-variant-numeric: tabular-nums; }
  .hx-off { color: var(--faint, #6e7681); }
  .hx-hex { color: var(--text-dim, #c9d1d9); }
  .hx-asc { color: var(--accent, #58a6ff); }

  /* GE draw stats (profiler) — headline draw count + dense key/value table */
  .gldraw { display: flex; flex-direction: column; gap: 8px; }
  .gldraw__head {
    /* 1fr auto 1fr keeps the number centered in the box no matter how wide the
       label or v/draw sub get, so changing digit counts never shift the layout.
       The two equal side columns pin the label left and the sub right. */
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: baseline;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--bg, #0b0e14);
    border: 1px solid var(--border-soft, #21262d);

    & .lbl { justify-self: start; color: var(--faint, #6e7681); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
    & .num { justify-self: center; color: var(--text, #e6edf3); font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
    & .sub { justify-self: end; text-align: right; color: var(--muted, #8b949e); font-size: 10px; font-variant-numeric: tabular-nums; }
  }
  .gldraw__grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    font-size: 10px;
    align-items: baseline;
  }
  .gldraw__grid dt { color: var(--faint, #6e7681); text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
  .gldraw__grid dd {
    color: var(--text-dim, #c9d1d9);
    margin: 0;
    font-variant-numeric: tabular-nums;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .gldraw__grid dd b { color: var(--text, #e6edf3); font-weight: 600; }
  .gldraw__grid dd .mut { color: var(--muted, #8b949e); }
  .gldraw__grid dt.sync { color: var(--warn, #d29922); }

  /* GE — 4 counter cells + aligned label/value rows */
  .ge { display: flex; flex-direction: column; gap: 8px; }
  .ge__counters { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
  .ge__count {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 5px 6px;
    border-radius: 6px;
    background: var(--bg, #0b0e14);
    border: 1px solid var(--border-soft, #21262d);

    & span { color: var(--faint, #6e7681); font-size: 8px; text-transform: uppercase; letter-spacing: 0.04em; }
    & b { color: var(--text, #e6edf3); font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
  }
  .ge__fields { display: grid; grid-template-columns: 56px 1fr; gap: 3px 8px; font-size: 10px; align-items: baseline; }
  .ge__fields dt { color: var(--faint, #6e7681); text-transform: uppercase; letter-spacing: 0.04em; }
  .ge__fields dd {
    color: var(--text-dim, #c9d1d9);
    margin: 0;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ge__fields dd b { color: var(--text, #e6edf3); font-weight: 600; }
  .ge__fields dd .sep { color: var(--faint, #6e7681); margin: 0 4px; }

  .scrollbox {
    max-height: 120px;
    overflow-y: auto;
    background: var(--bg, #0b0e14);
    border: 1px solid var(--border-soft, #21262d);
    border-radius: 6px;
    padding: 4px;
    font-size: 10px;
    scrollbar-width: thin;
    scrollbar-color: var(--border, #2a313c) transparent;

    &::-webkit-scrollbar { width: 4px; }
    &::-webkit-scrollbar-thumb { background: var(--border, #2a313c); border-radius: 2px; }
  }

  /* Stubs — ranked rows */
  .stub {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 4px 7px;
    border-radius: 5px;

    & .stub__name  { color: var(--text-dim, #c9d1d9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    & .stub__count { color: var(--warn, #d29922); font-weight: 700; font-variant-numeric: tabular-nums; }
  }

  /* Save data */
  .save { display: flex; justify-content: space-between; gap: 8px; padding: 4px 7px; }
  .save__title { color: var(--text-dim, #c9d1d9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .save__meta  { color: var(--muted, #8b949e); white-space: nowrap; font-variant-numeric: tabular-nums; }

  /* Log — the namespace itself is a level-colored pill */
  .log { display: flex; flex-direction: column; gap: 2px; max-height: 160px; }
  .logline {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding: 4px;
    border-radius: 4px;
    line-height: 1.4;
  }
  .logline + .logline { border-top: 1px solid var(--border-soft, #21262d); }
  .logline__head { display: flex; align-items: center; gap: 6px; }
  .logline__time { color: var(--faint, #6e7681); font-size: 9px; font-variant-numeric: tabular-nums; }
  .logline__ns {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.02em;
    padding: 1px 5px;
    border-radius: 4px;
  }
  .logline__ns::before { content: "["; }
  .logline__ns::after  { content: "]"; }
  .logline__msg { color: var(--text-dim, #c9d1d9); word-break: break-word; }
  .logline.warn  .logline__ns { background: color-mix(in srgb, var(--warn, #d29922) 22%, transparent); color: var(--warn, #d29922); }
  .logline.error .logline__ns { background: color-mix(in srgb, var(--danger, #f85149) 22%, transparent); color: var(--danger, #f85149); }
  .logline.error .logline__msg { color: var(--danger, #f85149); }

  .dim { color: var(--muted, #8b949e); padding: 4px 2px; }
`);

const TEMPLATE = `
  <h3 class="title">Debug <button class="close" aria-label="Close debug panel">✕</button></h3>
  <section class="section">
    <h4>Performance</h4>
    <div class="perf"></div>
  </section>
  <section class="section gldraw-section" hidden>
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
    <div class="gldraw"></div>
  </section>
  <section class="section">
    <h4>Threads
      <info-popover label="What the wait types mean">
        <strong>Thread wait types</strong>
        <div>Why a thread is blocked. A running or ready thread shows none.</div>
        <dl>
          <dt>DELAY</dt><dd>a fixed time to pass</dd>
          <dt>SLEEP</dt><dd>another thread to wake it</dd>
          <dt>VBLANK</dt><dd>the next vertical blank</dd>
          <dt>CTRL</dt><dd>the next controller read</dd>
          <dt>AUDIO</dt><dd>an audio channel to drain</dd>
          <dt>SEMA</dt><dd>a free permit (another thread must release a permit)</dd>
          <dt>MUTEX / LWMUTEX</dt><dd>a lock held by another thread</dd>
          <dt>EVENT_FLAG</dt><dd>certain status bits to be set</dd>
          <dt>FPL / VPL</dt><dd>a memory-pool block to free</dd>
          <dt>THREAD_END</dt><dd>another thread to exit</dd>
          <dt>GE_LIST / DRAW_SYNC</dt><dd>the GPU to finish</dd>
          <dt>ASYNC_IO</dt><dd>async file IO to finish</dd>
          <dt>ATRAC_DECODE</dt><dd>background audio decode</dd>
        </dl>
      </info-popover>
    </h4>
    <div class="threads threads-body"></div>
    <div class="thread-detail" hidden></div>
  </section>
  <section class="section">
    <h4>Memory
      <info-popover label="About the memory viewer">
        <strong>Memory viewer</strong>
        <div>The loaded ELF and the game's heap allocations. Pick one, or type any address (stacks, modules, etc. aren't listed but you can still jump to them), to dump its bytes as hex and ASCII.</div>
      </info-popover>
    </h4>
    <div class="heap">
      <div class="heap-ctl">
        <select class="heap-select" aria-label="Memory block"></select>
        <input class="heap-addr" type="text" spellcheck="false" aria-label="Address (hex)" placeholder="0x08800000">
        <button class="heap-prev" aria-label="Previous page" title="Previous">&minus;</button>
        <button class="heap-next" aria-label="Next page" title="Next">+</button>
        <button class="heap-toggle" aria-pressed="true" title="Pause / resume the live dump">live</button>
      </div>
      <label class="heap-skip-lbl" title="Jump past leading empty (00 / FF) bytes when picking a block">
        <input type="checkbox" class="heap-skip" checked> skip empty
      </label>
      <div class="heap-sum"></div>
      <div class="hexdump"></div>
    </div>
  </section>
  <section class="section">
    <h4>GE</h4>
    <div class="ge"></div>
  </section>
  <section class="section">
    <h4>Save Data</h4>
    <div class="savedata scrollbox"></div>
  </section>
  <section class="section">
    <h4>Stubs Called</h4>
    <div class="stubs scrollbox"></div>
  </section>
  <section class="section">
    <h4>Log <span class="note">(warn / error)</span></h4>
    <div class="log scrollbox"></div>
  </section>
`;

export class DebugPanel extends HTMLElement {
  #perfBody!: HTMLElement;
  #glDrawSection!: HTMLElement;
  #glDrawBody!: HTMLElement;
  #threadsBody!: HTMLElement;
  #geBody!: HTMLElement;
  #savedataBody!: HTMLElement;
  #stubsBody!: HTMLElement;
  #logBody!: HTMLElement;

  #logLines: Array<{ level: LogLevel; ns: string; msg: string; time: string }> = [];
  #savedataCache: Array<{ key: string; title: string; size: number; time: string }> = [];
  #lastSavedataRefresh = 0;
  #emulationStarted = false;

  // Perf window accumulators
  #perfWindowStart = 0;
  #cpuMsAcc = 0;
  #presentMsAcc = 0;
  #frameAcc = 0;
  #cpuPct = 0;
  #gpuPct = 0;
  #lastGeTimeMs = 0;
  /** When true, the perf section shows live frame-timing tiles (CPU ms / present
   *  ms / FPS), fed by the per-frame profiler. Set from the Profiler boot option. */
  profilerEnabled = false;
  #lastGePrims = 0;
  #lastGeLists = 0;
  #gePrimsPerSec = 0;
  #lastIoOps = 0;
  #geListsPerSec = 0;
  #ioOpsPerSec = 0;
  #lastPanelUpdate = 0;

  // Persistent perf-tile refs so the CSS bar transition can animate between
  // updates instead of being thrown away on every innerHTML rebuild.
  #perfRefs: {
    cpuVal: HTMLElement; cpuBar: HTMLElement;
    gpuVal: HTMLElement; gpuBar: HTMLElement;
    ramVal: HTMLElement; ramBar: HTMLElement;
    prims: HTMLElement; lists: HTMLElement; io: HTMLElement;
    cpuMs?: HTMLElement; geMs?: HTMLElement; present?: HTMLElement; fps?: HTMLElement;
  } | null = null;

  // Persistent GE-draw-stats tile refs, built once and updated in place each
  // window so we don't rebuild innerHTML on a section that updates often.
  #glDrawRefs: {
    draws: HTMLElement; vpd: HTMLElement; verts: HTMLElement;
    targets: HTMLElement; tex: HTMLElement; sub: HTMLElement;
    readback: HTMLElement; present: HTMLElement;
  } | null = null;

  // Thread inspector
  #threadDetail!: HTMLElement;
  #emu: PSPEmulator | null = null;
  #selectedTid: number | null = null;

  // Heap viewer
  #heapSelect!: HTMLSelectElement;
  #heapInput!: HTMLInputElement;
  #heapToggle!: HTMLButtonElement;
  #heapSkip!: HTMLInputElement;
  #heapSum!: HTMLElement;
  #heapDump!: HTMLElement;
  #heapAddr: number | null = null;
  #heapBlockSig = "";
  #heapEnabled = true;
  #heapSkipEmpty = true;
  #lastHeapDump = 0;

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      root.adoptedStyleSheets = [sheet];
      root.innerHTML = TEMPLATE;
    }
    const root = this.shadowRoot!;
    this.#perfBody      = root.querySelector(".perf")!;
    this.#glDrawSection = root.querySelector(".gldraw-section")!;
    this.#glDrawBody    = root.querySelector(".gldraw")!;
    this.#threadsBody  = root.querySelector(".threads-body")!;
    this.#threadDetail = root.querySelector(".thread-detail")!;
    this.#heapSelect   = root.querySelector(".heap-select")!;
    this.#heapInput    = root.querySelector(".heap-addr")!;
    this.#heapToggle   = root.querySelector(".heap-toggle")!;
    this.#heapSkip     = root.querySelector(".heap-skip")!;
    this.#heapSum      = root.querySelector(".heap-sum")!;
    this.#heapDump     = root.querySelector(".hexdump")!;
    this.#geBody       = root.querySelector(".ge")!;
    this.#savedataBody = root.querySelector(".savedata")!;
    this.#stubsBody    = root.querySelector(".stubs")!;
    this.#logBody      = root.querySelector(".log")!;

    root.querySelector(".close")?.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("close-debug", { bubbles: true, composed: true }));
    });

    // Click a thread row to select it for inspection (read-only). The container
    // persists across re-renders, so one delegated listener is enough.
    this.#threadsBody.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest("tr[data-tid]");
      if (!row) return;
      const tid = Number(row.getAttribute("data-tid"));
      this.#selectedTid = this.#selectedTid === tid ? null : tid;
      if (this.#emu) {
        this.#updateThreads(this.#emu);
        this.#renderThreadDetail();
      }
    });

    // Heap viewer controls. The select/input persist across re-renders, so one
    // listener each is enough; re-render the dump from the live memory each time.
    this.#heapSelect.addEventListener("change", () => {
      const start = Number(this.#heapSelect.value);
      if (Number.isFinite(start)) { this.#heapAddr = this.#viewAddrForBlock(start); this.#renderHeap(); }
    });
    this.#heapInput.addEventListener("change", () => {
      const v = parseInt(this.#heapInput.value.trim().replace(/^0x/i, ""), 16);
      if (Number.isFinite(v)) { this.#heapAddr = v >>> 0; this.#renderHeap(); }
    });
    root.querySelector(".heap-prev")?.addEventListener("click", () => {
      if (this.#heapAddr == null) return;
      this.#heapAddr = Math.max(0, this.#heapAddr - HEAP_WINDOW);
      this.#renderHeap();
    });
    root.querySelector(".heap-next")?.addEventListener("click", () => {
      if (this.#heapAddr == null) return;
      this.#heapAddr += HEAP_WINDOW;
      this.#renderHeap();
    });
    this.#heapToggle.addEventListener("click", () => {
      this.#heapEnabled = !this.#heapEnabled;
      this.#heapToggle.setAttribute("aria-pressed", String(this.#heapEnabled));
      this.#heapToggle.textContent = this.#heapEnabled ? "live" : "off";
      this.#refreshHeapDump();
    });
    this.#heapSkip.addEventListener("change", () => {
      this.#heapSkipEmpty = this.#heapSkip.checked;
      // Re-apply to whatever block we're currently inside.
      if (this.#emu && this.#heapAddr != null) {
        const a = this.#heapAddr;
        const block = this.#emu.hle.userMemory.listBlocks().find(b => a >= b.start && a < b.start + b.size);
        if (block) this.#heapAddr = this.#viewAddrForBlock(block.start);
      }
      this.#renderHeap();
    });

    Logger.setWarnHook((level, ns, msg) => {
      const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
      this.#logLines.push({ level, ns, msg, time });
      if (this.#logLines.length > MAX_LOG_LINES) this.#logLines.shift();
    });
  }

  disconnectedCallback(): void {
    Logger.setWarnHook(null);
  }

  /** Reset per-game state. Call when (re)booting a game. */
  reset(): void {
    this.#logLines = [];
    this.#savedataCache = [];
    this.#lastSavedataRefresh = 0;
    this.#emulationStarted = false;
    this.#perfWindowStart = 0;
    this.#cpuMsAcc = 0;
    this.#presentMsAcc = 0;
    this.#frameAcc = 0;
    this.#cpuPct = 0;
    this.#gpuPct = 0;
    this.#lastGeTimeMs = 0;
    this.#lastGePrims = 0;
    this.#lastGeLists = 0;
    this.#lastIoOps = 0;
    this.#gePrimsPerSec = 0;
    this.#geListsPerSec = 0;
    this.#ioOpsPerSec = 0;
    this.#lastPanelUpdate = 0;
    this.#perfRefs = null;
    this.#glDrawRefs = null;
    this.#selectedTid = null;
    this.#heapAddr = null;
    this.#heapBlockSig = "";
    this.#lastHeapDump = 0;
    if (this.#perfBody) this.#perfBody.innerHTML = "";
    if (this.#glDrawSection) this.#glDrawSection.hidden = true;
    if (this.#glDrawBody) this.#glDrawBody.innerHTML = "";
    if (this.#threadDetail) { this.#threadDetail.hidden = true; this.#threadDetail.innerHTML = ""; }
    if (this.#heapSelect) this.#heapSelect.innerHTML = "";
    if (this.#heapSum) this.#heapSum.innerHTML = "";
    if (this.#heapDump) this.#heapDump.innerHTML = "";
  }

  update(emu: PSPEmulator, cpuMs: number, presentMs = 0): void {
    this.#emu = emu;
    // Nothing in here is visible while the panel is closed, so don't spend the
    // per-frame work building snapshots and dumps no one is looking at.
    if (!this.classList.contains("debug-sidebar--open")) return;

    const now = performance.now();
    this.#cpuMsAcc += cpuMs;
    this.#presentMsAcc += presentMs;
    this.#frameAcc++;

    // Live hex dump runs faster than the rest of the panel so changing memory
    // looks alive; the heavier sections stay at the 2Hz window below.
    if (this.#heapEnabled && now - this.#lastHeapDump >= HEAP_REFRESH_MS) {
      this.#lastHeapDump = now;
      this.#refreshHeapDump();
    }

    if (now - this.#lastPanelUpdate < PERF_WINDOW_MS) return;
    this.#lastPanelUpdate = now;

    this.#updatePerf(emu, now);
    this.#updateGlDraw(emu);
    this.#updateThreads(emu);
    this.#renderThreadDetail();
    this.#renderHeap();
    this.#updateGe(emu);
    this.#updateSavedata(emu, now);
    this.#updateStubs(emu);
    this.#updateLog();
  }

  /** Hide the AT3 decode row once emulation starts. */
  markEmulationStarted(): void {
    this.#emulationStarted = true;
  }

  /** Pre-boot view: show only the AT3 decode progress. */
  updatePreBoot(): void {
    if (this.#emulationStarted || !this.#perfBody) return;
    const now = performance.now();
    if (now - this.#lastPanelUpdate < PERF_WINDOW_MS) return;
    this.#lastPanelUpdate = now;
    const ps = getPoolStats();
    if (ps.size > 0) this.#perfBody.innerHTML = `<div class="stats">${this.#at3Tile(ps)}</div>`;
  }

  dumpStubsToConsole(emu: PSPEmulator): void {
    const calls = emu.hle.stubCalls;
    if (calls.size === 0) return;
    const sorted = [...calls.entries()].sort((a, b) => b[1] - a[1]);
    console.info("[HLE] Stub calls at crash:");
    for (const [name, count] of sorted) console.info(`  ${name}: ${count}`);
  }

  // ── Render helpers ──────────────────────────────────────────────────────────

  #at3Tile(ps: { busy: number; size: number; waiting: number; cached: number }): string {
    return `<div class="stat wide">
      <div class="top"><span class="label">AT3 decode</span><span class="val">${ps.busy} / ${ps.size}</span></div>
      <span class="detail">${ps.waiting} queued &middot; ${ps.cached} cached</span>
    </div>`;
  }

  #updatePerf(emu: PSPEmulator, now: number): void {
    const elapsed = now - this.#perfWindowStart;
    // Normalize the deltas to a true per-second rate so the "/ s" tiles stay
    // meaningful regardless of the refresh window.
    const perSec = (delta: number): number => (elapsed > 0 ? Math.round((delta * 1000) / elapsed) : 0);
    // GE (emulated GPU) time this window, split out of the runFrame total so CPU%
    // is the interpreter (game code) and GPU% is the GE (vertex + raster/submit).
    const geMsWindow    = emu.hle.geTimeMs - this.#lastGeTimeMs;
    const interpMsAcc   = Math.max(0, this.#cpuMsAcc - geMsWindow);
    this.#cpuPct        = elapsed > 0 ? Math.min(100, Math.round((interpMsAcc / elapsed) * 100)) : 0;
    this.#gpuPct        = elapsed > 0 ? Math.min(100, Math.round((geMsWindow / elapsed) * 100)) : 0;
    this.#gePrimsPerSec = perSec(emu.hle.gePrimCount - this.#lastGePrims);
    this.#geListsPerSec = perSec(emu.hle.geListCount - this.#lastGeLists);
    this.#ioOpsPerSec   = perSec(emu.hle.ioOpsCount  - this.#lastIoOps);
    // Per-frame profiler stats over this window (frames counted in update()).
    const frames          = this.#frameAcc;
    const interpPerFrame  = frames > 0 ? interpMsAcc / frames : 0;
    const gePerFrame      = frames > 0 ? geMsWindow / frames : 0;
    const presentPerFrame = frames > 0 ? this.#presentMsAcc / frames : 0;
    const fps             = elapsed > 0 ? Math.round((frames * 1000) / elapsed) : 0;
    this.#cpuMsAcc      = 0;
    this.#presentMsAcc  = 0;
    this.#frameAcc      = 0;
    this.#perfWindowStart = now;
    this.#lastGeTimeMs  = emu.hle.geTimeMs;
    this.#lastGePrims   = emu.hle.gePrimCount;
    this.#lastGeLists   = emu.hle.geListCount;
    this.#lastIoOps     = emu.hle.ioOpsCount;

    let ramUsed = 0;
    for (const blk of emu.hle.memBlocks.values()) ramUsed += blk.size;
    const ramTotal = emu.hle.ramSize || PSP_RAM_BYTES;
    const ramPct   = Math.min(100, Math.round((ramUsed / ramTotal) * 100));
    const cpuColor = this.#cpuPct < 70 ? "var(--ok)" : this.#cpuPct < 90 ? "var(--warn)" : "var(--danger)";
    const gpuColor = "#a371f7"; // emulated-GE bar: a fixed hue, distinct from CPU (load colors) and RAM (blue)
    const ramUsedMB  = (ramUsed / 1048576).toFixed(1);
    const ramTotalMB = Math.round(ramTotal / 1048576);

    // Build the tiles once, then update text + bar fill in place so the bars
    // animate via their CSS transition instead of snapping on each rebuild.
    if (!this.#perfRefs) this.#buildPerfTiles();
    const r = this.#perfRefs!;
    r.cpuVal.textContent = `${this.#cpuPct}%`;
    r.cpuBar.style.setProperty("--pct", `${this.#cpuPct}%`);
    r.cpuBar.style.setProperty("--clr", cpuColor);
    r.gpuVal.textContent = `${this.#gpuPct}%`;
    r.gpuBar.style.setProperty("--pct", `${this.#gpuPct}%`);
    r.gpuBar.style.setProperty("--clr", gpuColor);
    r.ramVal.textContent = `${ramUsedMB} / ${ramTotalMB} MB`;
    r.ramBar.style.setProperty("--pct", `${ramPct}%`);
    r.ramBar.style.setProperty("--clr", "#4a9eff");
    r.prims.textContent = this.#gePrimsPerSec.toLocaleString();
    r.lists.textContent = this.#geListsPerSec.toLocaleString();
    r.io.textContent    = this.#ioOpsPerSec.toLocaleString();
    if (r.cpuMs)   r.cpuMs.textContent   = `${interpPerFrame.toFixed(1)} ms`;
    if (r.geMs)    r.geMs.textContent    = `${gePerFrame.toFixed(1)} ms`;
    if (r.present) r.present.textContent = `${presentPerFrame.toFixed(1)} ms`;
    if (r.fps)     r.fps.textContent     = String(fps);
  }

  #buildPerfTiles(): void {
    // Profiler tiles (per-frame interpreter ms, emulated GE ms, present ms, FPS)
    // only appear when the Profiler boot option is on.
    const profilerTiles = this.profilerEnabled ? `
      <div class="stat"><span class="label">Frame CPU</span><span class="val js-cpums">0 ms</span></div>
      <div class="stat"><span class="label">Frame GE</span><span class="val js-gems">0 ms</span></div>
      <div class="stat"><span class="label">Present</span><span class="val js-present">0 ms</span></div>
      <div class="stat"><span class="label">FPS</span><span class="val js-fps">0</span></div>` : "";
    this.#perfBody.innerHTML = `<div class="stats">
      <div class="stat wide">
        <div class="top"><span class="label">CPU</span><span class="val js-cpu">0%</span></div>
        <span class="bar js-cpu-bar" style="--pct:0%;--clr:var(--ok)"></span>
      </div>
      <div class="stat wide">
        <div class="top"><span class="label">GPU (GE)</span><span class="val js-gpu">0%</span></div>
        <span class="bar js-gpu-bar" style="--pct:0%;--clr:#a371f7"></span>
      </div>
      <div class="stat wide">
        <div class="top"><span class="label">RAM</span><span class="val js-ram">0 MB</span></div>
        <span class="bar js-ram-bar" style="--pct:0%;--clr:#4a9eff"></span>
      </div>
      <div class="stat"><span class="label">Prims / s</span><span class="val js-prims">0</span></div>
      <div class="stat"><span class="label">Lists / s</span><span class="val js-lists">0</span></div>
      <div class="stat"><span class="label">IO ops / s</span><span class="val js-io">0</span></div>
      ${profilerTiles}
    </div>`;
    const q = (s: string): HTMLElement => this.#perfBody.querySelector(s)!;
    this.#perfRefs = {
      cpuVal: q(".js-cpu"), cpuBar: q(".js-cpu-bar"),
      gpuVal: q(".js-gpu"), gpuBar: q(".js-gpu-bar"),
      ramVal: q(".js-ram"), ramBar: q(".js-ram-bar"),
      prims: q(".js-prims"), lists: q(".js-lists"), io: q(".js-io"),
    };
    if (this.profilerEnabled) {
      this.#perfRefs.cpuMs   = q(".js-cpums");
      this.#perfRefs.geMs    = q(".js-gems");
      this.#perfRefs.present = q(".js-present");
      this.#perfRefs.fps     = q(".js-fps");
    }
  }

  /**
   * Per-frame WebGL GPU-cost counters (geGlStatsFrame). Only shown when the
   * profiler is on AND the WebGL renderer is live — the software renderer has
   * no such stats, so the whole section hides rather than show zeros.
   */
  #updateGlDraw(emu: PSPEmulator): void {
    const ge = emu.hle.geProcessor?.webglRenderer ?? null;
    const f = ge?.geGlStatsFrame ?? null;
    if (!this.profilerEnabled || !f) {
      this.#glDrawSection.hidden = true;
      return;
    }
    this.#glDrawSection.hidden = false;
    if (!this.#glDrawRefs) this.#buildGlDrawTiles();
    const r = this.#glDrawRefs!;
    const vpd = f.drawCalls > 0 ? (f.drawVerts / f.drawCalls).toFixed(1) : "0";
    r.draws.textContent    = f.drawCalls.toLocaleString();
    r.vpd.textContent      = `${vpd} v/draw`;
    r.verts.textContent    = f.drawVerts.toLocaleString();
    r.targets.textContent  = f.fboBinds.toLocaleString();
    r.tex.innerHTML =
      `<b>${f.texUploads.toLocaleString()}</b> <span class="mut">up &middot; ${fmtBytes(f.texUploadBytes)} &middot; ` +
      `${f.texHits.toLocaleString()} hit &middot; ${f.texMiss.toLocaleString()} miss &middot; ${f.texFromVFB.toLocaleString()} vfb</span>`;
    r.sub.innerHTML =
      `<b>${f.subUploads.toLocaleString()}</b> <span class="mut">&middot; ${fmtBytes(f.subUploadBytes)}</span>`;
    r.readback.innerHTML =
      `<b>${f.readbacks.toLocaleString()}</b> <span class="mut">&middot; ${fmtBytes(f.readbackBytes)}</span>`;
    r.present.innerHTML =
      `<b>${f.presentCalls.toLocaleString()}</b> <span class="mut">present &middot; ${f.blitCalls.toLocaleString()} blit</span>`;
  }

  #buildGlDrawTiles(): void {
    this.#glDrawBody.innerHTML = `<div class="gldraw">
      <div class="gldraw__head">
        <span class="lbl">Draw calls</span>
        <span class="num js-gl-draws">0</span>
        <span class="sub js-gl-vpd">0 v/draw</span>
      </div>
      <dl class="gldraw__grid">
        <dt>Verts</dt><dd class="js-gl-verts">0</dd>
        <dt>Targets</dt><dd class="js-gl-targets">0</dd>
        <dt>Tex</dt><dd class="js-gl-tex">0</dd>
        <dt>Sub-rect</dt><dd class="js-gl-sub">0</dd>
        <dt class="sync">Readback</dt><dd class="js-gl-readback">0</dd>
        <dt>Present</dt><dd class="js-gl-present">0</dd>
      </dl>
    </div>`;
    const q = (s: string): HTMLElement => this.#glDrawBody.querySelector(s)!;
    this.#glDrawRefs = {
      draws: q(".js-gl-draws"), vpd: q(".js-gl-vpd"), verts: q(".js-gl-verts"),
      targets: q(".js-gl-targets"), tex: q(".js-gl-tex"), sub: q(".js-gl-sub"),
      readback: q(".js-gl-readback"), present: q(".js-gl-present"),
    };
  }

  #updateThreads(emu: PSPEmulator): void {
    const threads = emu.hle.getThreadsSnapshot();
    const curId = emu.hle.currentThreadId;
    if (threads.length === 0) {
      this.#threadsBody.innerHTML = `<div class="dim">No threads</div>`;
      return;
    }
    const rows = threads.map(t => {
      const active = t.id === curId;
      const selected = t.id === this.#selectedTid;
      const stateStr = ThreadState[t.state] ?? String(t.state);
      const waitStr  = t.waitType !== WaitType.NONE ? `<span class="wait">/${esc(WaitType[t.waitType] ?? "")}</span>` : "";
      const pcStr    = `0x${t.pc.toString(16).padStart(8, "0")}`;
      const cls = [active ? "active" : "", selected ? "selected" : ""].filter(Boolean).join(" ");
      return `<tr class="${cls}" data-state="${esc(stateStr)}" data-tid="${t.id}">
        <td class="t-id"><span class="dot"></span>#${t.id}</td>
        <td>${stateStr}${waitStr}</td>
        <td class="t-prio">${t.priority}</td>
        <td class="t-pc">${pcStr}</td>
      </tr>`;
    }).join("");
    this.#threadsBody.innerHTML =
      `<table><thead><tr><th>TID</th><th>State</th><th>Pri</th><th>PC</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  #waitDesc(d: NonNullable<ReturnType<PSPEmulator["hle"]["getThreadDetail"]>>): string {
    const w = d.wait;
    const hx = (v: number): string => `0x${(v >>> 0).toString(16)}`;
    switch (d.waitType) {
      case WaitType.SEMA:        return `sema #${w.semaId} · need ${w.semaCount}`;
      case WaitType.EVENT_FLAG:  return `event #${w.evfId} · bits ${hx(w.evfBits)} · mode ${w.evfMode}`;
      case WaitType.MUTEX:       return `mutex #${w.mutexId} ×${w.mutexCount}`;
      case WaitType.LWMUTEX:     return `lwmutex #${w.mutexId} ×${w.mutexCount}`;
      case WaitType.THREAD_END:  return `thread #${w.threadEndId} to end`;
      case WaitType.GE_LIST_SYNC:
      case WaitType.GE_DRAW_SYNC: return `GE list #${w.geListId}`;
      case WaitType.FPL:         return `fpl #${w.fplId}`;
      case WaitType.VPL:         return `vpl #${w.vplId}`;
      default:                   return (WaitType[d.waitType] ?? String(d.waitType)).toLowerCase();
    }
  }

  #renderThreadDetail(): void {
    const el = this.#threadDetail;
    if (this.#selectedTid == null || !this.#emu) { el.hidden = true; el.innerHTML = ""; return; }
    const d = this.#emu.hle.getThreadDetail(this.#selectedTid);
    if (!d) { el.hidden = true; el.innerHTML = ""; this.#selectedTid = null; return; }

    const hx = (v: number): string => `0x${(v >>> 0).toString(16).padStart(8, "0")}`;
    const stateStr = ThreadState[d.state] ?? String(d.state);
    const sp = d.gpr[29] ?? 0;
    const used = d.stackTop > sp ? d.stackTop - sp : 0; // stack grows down from stackTop

    // Always render this row (even when not waiting) so the layout never shifts as
    // the thread flips between waiting and runnable on live updates.
    const waiting = d.waitType !== WaitType.NONE;
    const statusText = waiting ? `${stateStr} · ${this.#waitDesc(d)}` : stateStr;
    const waitLine = `<div class="td-wait${waiting ? "" : " idle"}"><span class="td-k">status</span><span>${esc(statusText)}</span></div>`;

    const regs = GPR_NAMES.map((name, i) => {
      const hot = i === 29 || i === 31; // sp, ra
      return `<div class="td-reg${hot ? " hot" : ""}"><span class="td-rn">${name}</span><span class="td-rv">${hx(d.gpr[i] ?? 0)}</span></div>`;
    }).join("");

    el.hidden = false;
    el.innerHTML = `
      <div class="td-head">
        <span class="td-title">Thread #${d.id}</span>
        <span class="td-meta">${stateStr} · prio ${d.priority}</span>
      </div>
      <div class="td-rows">
        <div class="td-row"><span class="td-k">entry</span><span class="td-v">${hx(d.entry)}</span></div>
        <div class="td-row"><span class="td-k">pc</span><span class="td-v">${hx(d.pc)}</span></div>
        <div class="td-row"><span class="td-k">hi:lo</span><span class="td-v">${hx(d.hi)} : ${hx(d.lo)}</span></div>
        <div class="td-row"><span class="td-k">stack</span><span class="td-v">${hx(d.stackBase)}–${hx(d.stackTop)} · ${(d.stackSize / 1024).toFixed(0)}K · used ${(used / 1024).toFixed(1)}K</span></div>
      </div>
      ${waitLine}
      <div class="td-regs">${regs}</div>
    `;
  }

  /**
   * Address to start the dump at for a chosen allocation. With "skip empty" on,
   * jump past the leading run of untouched bytes (00 from a fresh heap, FF from
   * stack fill) to the first window with real data. Otherwise use the base.
   */
  #viewAddrForBlock(start: number): number {
    if (!this.#emu || !this.#heapSkipEmpty) return start;
    const block = this.#emu.hle.userMemory.listBlocks().find(b => b.start === start);
    if (!block) return start;
    return this.#firstNonEmpty(block.start, block.size) ?? start;
  }

  /**
   * First row-aligned address in [start, start+size) holding a byte that isn't
   * 0x00 or 0xFF, or null if the whole block is empty. Scans the raw RAM array
   * directly so even a 20MB block is a few ms — and it only runs on selection,
   * never on the live refresh.
   */
  #firstNonEmpty(start: number, size: number): number | null {
    const ram = this.#emu!.bus.ramBuffer;
    const baseIdx = toPhysical(start) - MemoryRegion.RAM_START;
    if (baseIdx < 0) return null;
    const end = Math.min(baseIdx + size, ram.length);
    for (let i = baseIdx; i < end; i++) {
      const b = ram[i]!;
      if (b !== 0x00 && b !== 0xff) {
        return (start + (i - baseIdx)) & ~(HEAP_BYTES_PER_ROW - 1);
      }
    }
    return null;
  }

  /** Picker + summary, at the 2Hz panel cadence. The byte dump is separate. */
  #renderHeap(): void {
    if (!this.#emu) return;
    const alloc = this.#emu.hle.userMemory;
    const blocks = alloc.isInitialized() ? alloc.listBlocks() : [];
    // Only show the high-value regions: the loaded ELF and the game's heap blocks.
    // Hide thread stacks (a niche forensic view, better caught programmatically),
    // loaded modules (mostly static library code), and the usersystemlib stub area.
    const hidden = (tag: string): boolean =>
      tag.startsWith("stack/") || tag.startsWith("module/") || tag === "usersystemlib";
    const taken = blocks.filter(b => b.taken && !hidden(b.tag));

    if (taken.length === 0) {
      this.#heapBlockSig = "";
      this.#heapSelect.innerHTML = "";
      this.#heapSum.innerHTML = "";
      this.#heapDump.innerHTML = `<div class="dim">No memory blocks yet</div>`;
      return;
    }

    // Rebuild the picker when the block layout changes, and keep the current
    // selection across the rebuild so it isn't dropped.
    const sr = this.shadowRoot;
    const sig = taken.map(b => `${b.start}:${b.size}`).join(",");
    if (sig !== this.#heapBlockSig) {
      this.#heapBlockSig = sig;
      const prev = this.#heapSelect.value;
      this.#heapSelect.innerHTML = taken.map(b =>
        `<option value="${b.start}">${esc(b.tag || "(untagged)")} · 0x${b.start.toString(16)} · ${fmtSize(b.size)}</option>`
      ).join("");
      if (prev) this.#heapSelect.value = prev; // restore if that block still exists
    }

    // Default to the largest allocation — usually the game's heap/data.
    if (this.#heapAddr == null) {
      const biggest = taken.reduce((a, b) => (b.size > a.size ? b : a));
      this.#heapAddr = this.#viewAddrForBlock(biggest.start);
    }
    const base = this.#heapAddr & ~(HEAP_BYTES_PER_ROW - 1); // align to a row

    // Keep the picker in sync with the address; skip while it's focused/open.
    const block = blocks.find(b => base >= b.start && base < b.start + b.size);
    if (sr?.activeElement !== this.#heapSelect) {
      this.#heapSelect.value = block?.taken ? String(block.start) : "";
    }
    if (sr?.activeElement !== this.#heapInput) {
      this.#heapInput.value = `0x${base.toString(16)}`;
    }

    const free = alloc.getTotalFreeBytes();
    const largest = alloc.getLargestFreeBlockSize();
    const where = block
      ? `${block.taken ? "in" : "free near"} <b>${esc(block.tag || "(untagged)")}</b> · +${fmtSize(base - block.start)}`
      : `<b>unmapped</b>`;
    this.#heapSum.innerHTML = `${where} &middot; free <b>${fmtSize(free)}</b> &middot; largest <b>${fmtSize(largest)}</b>`;

    this.#refreshHeapDump();
  }

  /** Just the hex/ASCII rows — cheap enough to run at the faster heap cadence. */
  #refreshHeapDump(): void {
    if (!this.#emu || this.#heapAddr == null) return;
    if (!this.#heapEnabled) {
      this.#heapDump.innerHTML = `<div class="dim">paused</div>`;
      return;
    }
    const base = this.#heapAddr & ~(HEAP_BYTES_PER_ROW - 1); // align to a row
    const bus = this.#emu.bus;
    const rows: string[] = [];
    for (let r = 0; r < HEAP_ROWS; r++) {
      const off = base + r * HEAP_BYTES_PER_ROW;
      let hex = "", asc = "";
      for (let c = 0; c < HEAP_BYTES_PER_ROW; c++) {
        const byte = bus.readU8(off + c);
        hex += byte.toString(16).padStart(2, "0") + (c < HEAP_BYTES_PER_ROW - 1 ? " " : "");
        asc += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
      }
      rows.push(
        `<div class="hexrow"><span class="hx-off">0x${(off >>> 0).toString(16).padStart(8, "0")}</span>` +
        `<span class="hx-hex">${hex}</span><span class="hx-asc">${esc(asc)}</span></div>`
      );
    }
    // The row count is fixed, so the box height is stable — save and restore the
    // scroll position across the rebuild so the live refresh doesn't yank the
    // user back to the top while they're scrolled down inspecting bytes.
    const scroll = this.#heapDump.scrollTop;
    this.#heapDump.innerHTML = rows.join("");
    this.#heapDump.scrollTop = scroll;
  }

  #updateGe(emu: PSPEmulator): void {
    const h = emu.hle;
    const ge = h.geProcessor?.webglRenderer ?? null;
    const sep = `<span class="sep">·</span>`;
    const count = (label: string, val: string | number): string =>
      `<div class="ge__count"><span>${label}</span><b>${val}</b></div>`;
    const field = (label: string, body: string): string =>
      `<dt>${label}</dt><dd>${body}</dd>`;

    let fields =
      field("GE FB",   `<b>0x${h.geFbAddr.toString(16)}</b>${sep}W <b>${h.geFbWidth}</b>${sep}fmt <b>${h.geFbFormat}</b>`) +
      field("Display", `<b>0x${h.framebufAddr.toString(16)}</b>${sep}W <b>${h.framebufWidth}</b>${sep}fmt <b>${h.framebufFormat}</b>`);
    if (ge) {
      fields += field("VFBs", `<b>${ge.dbgVFBCount}</b>${sep}${esc(String(ge.dbgVFBKeys))}`);
      const path = String(ge._dbgDisplayPath ?? "");
      if (path) fields += field("Path", esc(path));
      fields += field("Blits", `<b>${ge._dbgBlitCount}</b>${sep}RB <b>${ge._dbgReadbackCount}</b>`);
    }

    this.#geBody.innerHTML =
      `<div class="ge__counters">${count("Lists", h.geListCount)}${count("Prims", h.gePrimCount)}${count("Clears", h.geClearCount)}${count("Skips", h.geSkipCount)}</div>` +
      `<dl class="ge__fields">${fields}</dl>`;
  }

  #updateSavedata(emu: PSPEmulator, now: number): void {
    const store = emu.hle.savedataStore;
    if (!store) {
      this.#savedataBody.innerHTML = `<div class="dim">No store</div>`;
      return;
    }
    if (now - this.#lastSavedataRefresh > 3000) {
      this.#lastSavedataRefresh = now;
      store.list("").then(entries => {
        this.#savedataCache = entries.map(e => ({
          key: e.key,
          title: e.title || e.key,
          size: e.data.byteLength,
          time: new Date(e.timestamp).toLocaleTimeString(),
        }));
      }).catch(() => { /* ignore */ });
    }
    if (this.#savedataCache.length === 0) {
      this.#savedataBody.innerHTML = `<div class="dim">No saves</div>`;
      return;
    }
    this.#savedataBody.innerHTML = this.#savedataCache.map(s =>
      `<div class="save"><span class="save__title">${esc(s.title)}</span><span class="save__meta">${(s.size / 1024).toFixed(1)} KB &middot; ${s.time}</span></div>`
    ).join("");
  }

  #updateStubs(emu: PSPEmulator): void {
    const calls = emu.hle.stubCalls;
    if (calls.size === 0) {
      this.#stubsBody.innerHTML = `<div class="dim">No stubs called</div>`;
      return;
    }
    const sorted = [...calls.entries()].sort((a, b) => b[1] - a[1]);
    this.#stubsBody.innerHTML = sorted.map(([name, count]) =>
      `<div class="stub"><span class="stub__name">${esc(name)}</span><span class="stub__count">&times;${count}</span></div>`
    ).join("");
  }

  #updateLog(): void {
    if (this.#logLines.length === 0) {
      this.#logBody.innerHTML = `<div class="dim">No warnings yet</div>`;
      return;
    }
    // Newest first. Keep the view pinned to the top so the latest line stays visible.
    const wasAtTop = this.#logBody.scrollTop <= 4;
    this.#logBody.innerHTML = this.#logLines.slice().reverse().map(({ level, ns, msg, time }) => {
      const cls = level === "error" ? "error" : "warn";
      return `<div class="logline ${cls}"><div class="logline__head"><span class="logline__time">${time}</span><span class="logline__ns">${esc(ns)}</span></div><span class="logline__msg">${esc(msg)}</span></div>`;
    }).join("");
    if (wasAtTop) this.#logBody.scrollTop = 0;
  }
}

/** A small "i" info trigger with a hover/focus popover. Wraps its children as the
 *  popover body and gives each instance its own CSS anchor-name, so multiple
 *  popovers don't all anchor to the last `.info` in the DOM (a shared anchor-name
 *  resolves to one element). The popover is position:fixed and anchor()-positioned,
 *  so it escapes the panel's scroll container and tracks its own trigger on scroll.
 *  Usage: <info-popover label="...">...popover content...</info-popover>. */
let infoPopSeq = 0;
class InfoPopover extends HTMLElement {
  #wired = false;
  connectedCallback(): void {
    if (this.#wired) return;
    this.#wired = true;
    const name = `--info-pop-${++infoPopSeq}`;

    const pop = document.createElement("span");
    pop.className = "info-pop";
    pop.setAttribute("role", "tooltip");
    pop.style.setProperty("position-anchor", name);
    while (this.firstChild) pop.appendChild(this.firstChild);

    const trigger = document.createElement("span");
    trigger.className = "info";
    trigger.tabIndex = 0;
    trigger.setAttribute("role", "note");
    trigger.setAttribute("aria-label", this.getAttribute("label") ?? "More information");
    trigger.textContent = "i";
    trigger.style.setProperty("anchor-name", name);
    trigger.appendChild(pop);

    this.appendChild(trigger);
  }
}
customElements.define("info-popover", InfoPopover);

customElements.define("debug-panel", DebugPanel);
