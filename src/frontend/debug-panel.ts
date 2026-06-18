import { LitElement, html, type TemplateResult } from "lit";
import type { PSPEmulator } from "../emulator.js";
import "./info-popover.js"; // registers <info-popover>
// Side-effect imports register the custom elements; the type imports are elided
// at build, so without the bare imports the panels would never define.
import "./debug/perf-panel.js";
import "./debug/gldraw-panel.js";
import "./debug/threads-panel.js";
import "./debug/memory-panel.js";
import "./debug/ge-panel.js";
import "./debug/savedata-panel.js";
import "./debug/savestate-panel.js";
import "./debug/stubs-panel.js";
import "./debug/log-panel.js";
import type { PerfPanel } from "./debug/perf-panel.js";
import type { GlDrawPanel } from "./debug/gldraw-panel.js";
import type { ThreadsPanel } from "./debug/threads-panel.js";
import type { MemoryPanel } from "./debug/memory-panel.js";
import type { GePanel } from "./debug/ge-panel.js";
import type { SavedataPanel } from "./debug/savedata-panel.js";
import type { SavestatePanel } from "./debug/savestate-panel.js";
import type { StubsPanel } from "./debug/stubs-panel.js";
import type { LogPanel } from "./debug/log-panel.js";

// Constructable stylesheet shared by every instance (latest-Chrome only).
// Inherited CSS custom properties (the --tokens from :root) cross the shadow
// boundary, so we can reuse the app's design tokens in here. CSS nesting used
// throughout.
const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  :host {
    display: none;
    flex: 0 0 350px;
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
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-dim, #c9d1d9);
    scrollbar-width: thin;
    scrollbar-color: var(--border, #2a313c) transparent;

    &::-webkit-scrollbar { width: 5px; }
    &::-webkit-scrollbar-thumb { background: var(--border, #2a313c); border-radius: 3px; }
  }
  :host(.debug-sidebar--open) { display: flex; flex-direction: column; gap: 2px; }

  /* The section sub-components render in light DOM; contents makes their tag
     transparent so each <section> lays out directly in the panel's flex column. */
  perf-panel, gldraw-panel, threads-panel, memory-panel,
  ge-panel, savedata-panel, savestate-panel, stubs-panel, log-panel { display: contents; }

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
    font-size: 14px;
    font-weight: var(--fw-bold);
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
    font-size: 15px;
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
      font-size: 12px;
      font-weight: var(--fw-bold);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--faint, #6e7681);
      margin: 0 0 8px;
    }
    & .note { color: var(--muted, #8b949e); font-weight: var(--fw-regular); }
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
    font-size: 10px;
    font-weight: var(--fw-bold);
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
    font-size: 12px;
    font-weight: var(--fw-regular);
    text-transform: none;
    letter-spacing: 0;
    color: var(--text-dim, #c9d1d9);
    white-space: normal;

    & strong { display: block; color: var(--text, #e6edf3); font-size: 13px; margin-bottom: 4px; }
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
    & .label { color: var(--faint, #6e7681); font-size: 11px; font-weight: var(--fw-bold); text-transform: uppercase; letter-spacing: 0.06em; }
    & .val { color: var(--text, #e6edf3); font-size: 17px; font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    &.wide .val { font-size: 15px; }
    & .detail { color: var(--muted, #8b949e); font-size: 12px; }
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
  .threads table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .threads th {
    position: sticky;
    top: 0;
    z-index: 1;
    text-align: left;
    padding: 2px 6px;
    background: var(--surface, #161b22);
    color: var(--faint, #6e7681);
    font-size: 11px;
    font-weight: var(--fw-bold);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border-soft, #21262d);
  }
  .threads th:nth-child(1) { width: 54px; }
  .threads th:nth-child(3) { width: 30px; }
  .threads th:nth-child(4) { width: 82px; }
  .threads td { padding: 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .threads tr.active td { color: var(--accent, #58a6ff); font-weight: var(--fw-medium); }
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
  .td-title { color: var(--accent, #58a6ff); font-weight: var(--fw-bold); font-size: 13px; }
  .td-meta { color: var(--muted, #8b949e); font-size: 12px; }
  .td-rows { display: flex; flex-direction: column; gap: 2px; }
  .td-row, .td-wait { display: flex; gap: 8px; font-size: 12px; align-items: baseline; }
  .td-k { flex-shrink: 0; min-width: 42px; color: var(--faint, #6e7681); text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px; }
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
  .td-reg { display: flex; justify-content: space-between; gap: 4px; font-size: 11px; font-variant-numeric: tabular-nums; }
  .td-rn { color: var(--faint, #6e7681); }
  .td-rv { color: var(--text-dim, #c9d1d9); }
  .td-reg.hot .td-rn, .td-reg.hot .td-rv { color: var(--accent, #58a6ff); }

  /* Heap — allocation picker + hex/ASCII dump */
  .heap { display: flex; flex-direction: column; gap: 8px; }
  .heap-ctl { display: flex; gap: 6px; align-items: center; }
  .heap-ctl select, .heap-ctl input {
    font: inherit;
    font-size: 12px;
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
    font-size: 13px;
    line-height: 1;

    &:hover { color: var(--text, #e6edf3); border-color: var(--border, #2a313c); }
  }
  .heap-toggle { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; min-width: 34px; }
  .heap-toggle[aria-pressed="true"] { color: var(--ok, #3fb950); border-color: color-mix(in srgb, var(--ok, #3fb950) 45%, transparent); }
  .heap-skip-lbl {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    color: var(--muted, #8b949e);
    cursor: pointer;
    user-select: none;
  }
  .heap-skip-lbl input { accent-color: var(--accent, #58a6ff); width: 12px; height: 12px; margin: 0; cursor: pointer; }
  .heap-sum { color: var(--muted, #8b949e); font-size: 11.5px; }
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
  .hexrow { display: flex; gap: 12px; font-size: 12px; line-height: 1.55; white-space: pre; font-variant-numeric: tabular-nums; }
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

    & .lbl { justify-self: start; color: var(--faint, #6e7681); font-size: 11px; font-weight: var(--fw-bold); text-transform: uppercase; letter-spacing: 0.06em; }
    & .num { justify-self: center; color: var(--text, #e6edf3); font-size: 20px; font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    & .sub { justify-self: end; text-align: right; color: var(--muted, #8b949e); font-size: 12px; font-variant-numeric: tabular-nums; }
  }
  .gldraw__grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    font-size: 12px;
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
  .gldraw__grid dd b { color: var(--text, #e6edf3); font-weight: var(--fw-medium); }
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

    & span { color: var(--faint, #6e7681); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
    & b { color: var(--text, #e6edf3); font-size: 15px; font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
  }
  .ge__fields { display: grid; grid-template-columns: 56px 1fr; gap: 3px 8px; font-size: 12px; align-items: baseline; }
  .ge__fields dt { color: var(--faint, #6e7681); text-transform: uppercase; letter-spacing: 0.04em; }
  .ge__fields dd {
    color: var(--text-dim, #c9d1d9);
    margin: 0;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ge__fields dd b { color: var(--text, #e6edf3); font-weight: var(--fw-medium); }
  .ge__fields dd .sep { color: var(--faint, #6e7681); margin: 0 4px; }

  .scrollbox {
    max-height: 120px;
    overflow-y: auto;
    background: var(--bg, #0b0e14);
    border: 1px solid var(--border-soft, #21262d);
    border-radius: 6px;
    padding: 4px;
    font-size: 12px;
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
    & .stub__count { color: var(--warn, #d29922); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
  }

  /* Save data */
  .save { display: flex; justify-content: space-between; gap: 8px; padding: 4px 7px; }
  .save__title { color: var(--text-dim, #c9d1d9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .save__meta  { color: var(--muted, #8b949e); white-space: nowrap; font-variant-numeric: tabular-nums; }

  /* Log — the namespace itself is a level-colored pill */
  .log { display: flex; flex-direction: column; gap: 2px; max-height: 320px; }
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
  .logline__time { color: var(--faint, #6e7681); font-size: 11px; font-variant-numeric: tabular-nums; }
  .logline__ns {
    font-size: 11px;
    font-weight: var(--fw-bold);
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

/**
 * <debug-panel> — the in-flow debug sidebar. It's a thin shell: it owns the
 * shadow root + stylesheet and the title bar, and hosts one light-DOM
 * sub-component per section. Each section owns its own state and update cadence
 * (0.5s for all of them except Memory, which refreshes its hex dump at ~10Hz);
 * this just forwards tick()/reset() to the children every frame while open.
 */
export class DebugPanel extends LitElement {
  static override styles = sheet;

  #perf: PerfPanel | null = null;
  #gldraw: GlDrawPanel | null = null;
  #threads: ThreadsPanel | null = null;
  #memory: MemoryPanel | null = null;
  #ge: GePanel | null = null;
  #savedata: SavedataPanel | null = null;
  #savestate: SavestatePanel | null = null;
  #stubs: StubsPanel | null = null;
  #log: LogPanel | null = null;

  #profilerEnabled = false;

  /** Show the per-frame profiler tiles (perf + GE draw stats). Set from the boot
   *  option; propagated to the panels that use it. */
  get profilerEnabled(): boolean { return this.#profilerEnabled; }
  set profilerEnabled(v: boolean) {
    this.#profilerEnabled = v;
    if (this.#perf) this.#perf.profilerEnabled = v;
    if (this.#gldraw) this.#gldraw.profilerEnabled = v;
  }

  override render(): TemplateResult {
    return html`
      <h3 class="title">Debug <button class="close" aria-label="Close debug panel" @click=${this.#onClose}>✕</button></h3>
      <perf-panel></perf-panel>
      <gldraw-panel></gldraw-panel>
      <threads-panel></threads-panel>
      <memory-panel></memory-panel>
      <ge-panel></ge-panel>
      <savedata-panel></savedata-panel>
      <savestate-panel></savestate-panel>
      <stubs-panel></stubs-panel>
      <log-panel></log-panel>
    `;
  }

  protected override firstUpdated(): void {
    const r = this.renderRoot;
    this.#perf     = r.querySelector("perf-panel");
    this.#gldraw   = r.querySelector("gldraw-panel");
    this.#threads  = r.querySelector("threads-panel");
    this.#memory   = r.querySelector("memory-panel");
    this.#ge       = r.querySelector("ge-panel");
    this.#savedata = r.querySelector("savedata-panel");
    this.#savestate = r.querySelector("savestate-panel");
    this.#stubs    = r.querySelector("stubs-panel");
    this.#log      = r.querySelector("log-panel");
    // Apply the profiler flag now that the children exist.
    this.profilerEnabled = this.#profilerEnabled;
  }

  #onClose = (): void => {
    this.dispatchEvent(new CustomEvent("close-debug", { bubbles: true, composed: true }));
  };

  /** Per-frame driver from the rAF loop (named `tick`, not `update`, to avoid
   *  clobbering LitElement's reactive `update()` lifecycle). Forwards to each
   *  section; the sections throttle themselves. */
  tick(emu: PSPEmulator, cpuMs: number, presentMs = 0): void {
    // Nothing here is visible while the panel is closed.
    if (!this.classList.contains("debug-sidebar--open")) return;
    const now = performance.now();
    this.#perf?.tick(emu, cpuMs, presentMs, now);
    this.#gldraw?.tick(emu, now);
    this.#threads?.tick(emu, now);
    this.#memory?.tick(emu, now);
    this.#ge?.tick(emu, now);
    this.#savedata?.tick(emu, now);
    this.#savestate?.tick(emu, now);
    this.#stubs?.tick(emu, now);
    this.#log?.tick(now);
  }

  /** Pre-boot view: only the AT3 decode progress (in the perf section). */
  updatePreBoot(): void {
    this.#perf?.preBoot(performance.now());
  }

  markEmulationStarted(): void {
    this.#perf?.markStarted();
  }

  /** Reset per-game state. Call when (re)booting a game. */
  reset(): void {
    this.#perf?.reset();
    this.#gldraw?.reset();
    this.#threads?.reset();
    this.#memory?.reset();
    this.#ge?.reset();
    this.#savedata?.reset();
    this.#savestate?.reset();
    this.#stubs?.reset();
    this.#log?.reset();
  }

  dumpStubsToConsole(emu: PSPEmulator): void {
    const calls = emu.hle.stubCalls;
    if (calls.size === 0) return;
    const sorted = [...calls.entries()].sort((a, b) => b[1] - a[1]);
    console.info("[HLE] Stub calls at crash:");
    for (const [name, count] of sorted) console.info(`  ${name}: ${count}`);
  }
}

customElements.define("debug-panel", DebugPanel);

