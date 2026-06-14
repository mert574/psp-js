import { html, nothing, type TemplateResult } from "lit";
import { SubPanel } from "./sub-panel.js";
import type { PSPEmulator } from "../../emulator.js";
import { ThreadState, WaitType } from "../../kernel/hle-kernel.js";
import { hex8 } from "../lib/format.js";

const WINDOW_MS = 500;

// MIPS O32 register names, indexed by GPR number.
const GPR_NAMES = [
  "zero", "at", "v0", "v1", "a0", "a1", "a2", "a3",
  "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7",
  "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7",
  "t8", "t9", "k0", "k1", "gp", "sp", "fp", "ra",
];

/** Threads section: the thread table plus a read-only inspector for the row you
 *  click. Owns the selected thread id. */
export class ThreadsPanel extends SubPanel {
  static override properties = {
    listTpl: { state: true },
    detailTpl: { state: true },
  };
  declare listTpl: TemplateResult;
  declare detailTpl: TemplateResult | typeof nothing;

  #emu: PSPEmulator | null = null;
  #selectedTid: number | null = null;
  #last = 0;

  constructor() {
    super();
    this.listTpl = html`<div class="dim">No threads</div>`;
    this.detailTpl = nothing;
  }

  override render(): TemplateResult {
    return html`<section class="section">
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
      <div class="threads threads-body">${this.listTpl}</div>
      ${this.detailTpl}
    </section>`;
  }

  reset(): void {
    this.#selectedTid = null;
    this.#last = 0;
    this.listTpl = html`<div class="dim">No threads</div>`;
    this.detailTpl = nothing;
  }

  tick(emu: PSPEmulator, now: number): void {
    this.#emu = emu;
    if (now - this.#last < WINDOW_MS) return;
    this.#last = now;
    this.#renderList(emu);
    this.#renderDetail();
  }

  #select(tid: number): void {
    this.#selectedTid = this.#selectedTid === tid ? null : tid;
    if (this.#emu) {
      this.#renderList(this.#emu);
      this.#renderDetail();
    }
  }

  #renderList(emu: PSPEmulator): void {
    const threads = emu.hle.getThreadsSnapshot();
    const curId = emu.hle.currentThreadId;
    if (threads.length === 0) {
      this.listTpl = html`<div class="dim">No threads</div>`;
      return;
    }
    const rows = threads.map(t => {
      const active = t.id === curId;
      const selected = t.id === this.#selectedTid;
      const stateStr = ThreadState[t.state] ?? String(t.state);
      const waitStr  = t.waitType !== WaitType.NONE ? html`<span class="wait">/${WaitType[t.waitType] ?? ""}</span>` : nothing;
      const cls = [active ? "active" : "", selected ? "selected" : ""].filter(Boolean).join(" ");
      return html`<tr class=${cls} data-state=${stateStr} @click=${() => this.#select(t.id)}>
        <td class="t-id"><span class="dot"></span>#${t.id}</td>
        <td>${stateStr}${waitStr}</td>
        <td class="t-prio">${t.priority}</td>
        <td class="t-pc">${hex8(t.pc)}</td>
      </tr>`;
    });
    this.listTpl = html`<table><thead><tr><th>TID</th><th>State</th><th>Pri</th><th>PC</th></tr></thead><tbody>${rows}</tbody></table>`;
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

  #renderDetail(): void {
    if (this.#selectedTid == null || !this.#emu) { this.detailTpl = nothing; return; }
    const d = this.#emu.hle.getThreadDetail(this.#selectedTid);
    if (!d) { this.detailTpl = nothing; this.#selectedTid = null; return; }

    const stateStr = ThreadState[d.state] ?? String(d.state);
    const sp = d.gpr[29] ?? 0;
    const used = d.stackTop > sp ? d.stackTop - sp : 0; // stack grows down from stackTop
    const waiting = d.waitType !== WaitType.NONE;
    const statusText = waiting ? `${stateStr} · ${this.#waitDesc(d)}` : stateStr;

    this.detailTpl = html`
      <div class="thread-detail">
        <div class="td-head">
          <span class="td-title">Thread #${d.id}</span>
          <span class="td-meta">${stateStr} · prio ${d.priority}</span>
        </div>
        <div class="td-rows">
          <div class="td-row"><span class="td-k">entry</span><span class="td-v">${hex8(d.entry)}</span></div>
          <div class="td-row"><span class="td-k">pc</span><span class="td-v">${hex8(d.pc)}</span></div>
          <div class="td-row"><span class="td-k">hi:lo</span><span class="td-v">${hex8(d.hi)} : ${hex8(d.lo)}</span></div>
          <div class="td-row"><span class="td-k">stack</span><span class="td-v">${hex8(d.stackBase)}–${hex8(d.stackTop)} · ${(d.stackSize / 1024).toFixed(0)}K · used ${(used / 1024).toFixed(1)}K</span></div>
        </div>
        <div class="td-wait ${waiting ? "" : "idle"}"><span class="td-k">status</span><span>${statusText}</span></div>
        <div class="td-regs">${GPR_NAMES.map((name, i) => html`<div class="td-reg ${i === 29 || i === 31 ? "hot" : ""}"><span class="td-rn">${name}</span><span class="td-rv">${hex8(d.gpr[i] ?? 0)}</span></div>`)}</div>
      </div>`;
  }
}

customElements.define("threads-panel", ThreadsPanel);
