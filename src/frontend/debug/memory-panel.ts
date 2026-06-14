import { html, type TemplateResult } from "lit";
import { SubPanel } from "./sub-panel.js";
import type { PSPEmulator } from "../../emulator.js";
import { MemoryRegion, toPhysical } from "../../memory/memory-map.js";
import { fmtSize, hex8, esc } from "../lib/format.js";

// 8 bytes/row keeps the row inside the panel without horizontal scroll; 64 rows
// = a 512-byte window per page. The dump refreshes at ~10Hz (faster than the
// 0.5s panel cadence) so changing memory looks live; the picker/summary at 0.5s.
const BYTES_PER_ROW = 8;
const ROWS = 64;
const WINDOW = BYTES_PER_ROW * ROWS;
const DUMP_MS = 100;
const SUMMARY_MS = 500;

/** Memory viewer: pick the loaded ELF or a heap allocation (stacks/modules are
 *  hidden but reachable by typing an address) and dump its bytes as hex + ASCII.
 *  The select/input/sum/dump are filled imperatively to preserve focus / scroll
 *  / value-sync, which declarative rendering would fight. */
export class MemoryPanel extends SubPanel {
  #emu: PSPEmulator | null = null;
  #select: HTMLSelectElement | null = null;
  #input: HTMLInputElement | null = null;
  #toggle: HTMLButtonElement | null = null;
  #skip: HTMLInputElement | null = null;
  #sum: HTMLElement | null = null;
  #dump: HTMLElement | null = null;

  #addr: number | null = null;
  #blockSig = "";
  #enabled = true;
  #skipEmpty = true;
  #lastDump = 0;
  #lastSummary = 0;

  override render(): TemplateResult {
    return html`<section class="section">
      <h4>Memory
        <info-popover label="About the memory viewer">
          <strong>Memory viewer</strong>
          <div>The loaded ELF and the game's heap allocations. Pick one, or type any address (stacks, modules, etc. aren't listed but you can still jump to them), to dump its bytes as hex and ASCII.</div>
        </info-popover>
      </h4>
      <div class="heap">
        <div class="heap-ctl">
          <select class="heap-select" aria-label="Memory block" @change=${this.#onSelect}></select>
          <input class="heap-addr" type="text" spellcheck="false" aria-label="Address (hex)" placeholder="0x08800000" @change=${this.#onInput}>
          <button class="heap-prev" aria-label="Previous page" title="Previous" @click=${this.#onPrev}>&minus;</button>
          <button class="heap-next" aria-label="Next page" title="Next" @click=${this.#onNext}>+</button>
          <button class="heap-toggle" aria-pressed="true" title="Pause / resume the live dump" @click=${this.#onToggle}>live</button>
        </div>
        <label class="heap-skip-lbl" title="Jump past leading empty (00 / FF) bytes when picking a block">
          <input type="checkbox" class="heap-skip" checked @change=${this.#onSkip}> skip empty
        </label>
        <div class="heap-sum"></div>
        <div class="hexdump"></div>
      </div>
    </section>`;
  }

  protected override firstUpdated(): void {
    this.#select = this.querySelector(".heap-select");
    this.#input  = this.querySelector(".heap-addr");
    this.#toggle = this.querySelector(".heap-toggle");
    this.#skip   = this.querySelector(".heap-skip");
    this.#sum    = this.querySelector(".heap-sum");
    this.#dump   = this.querySelector(".hexdump");
  }

  reset(): void {
    this.#addr = null;
    this.#blockSig = "";
    this.#lastDump = 0;
    this.#lastSummary = 0;
    if (this.#select) this.#select.innerHTML = "";
    if (this.#sum) this.#sum.innerHTML = "";
    if (this.#dump) this.#dump.innerHTML = "";
  }

  tick(emu: PSPEmulator, now: number): void {
    this.#emu = emu;
    if (this.#enabled && now - this.#lastDump >= DUMP_MS) {
      this.#lastDump = now;
      this.#refreshDump();
    }
    if (now - this.#lastSummary >= SUMMARY_MS) {
      this.#lastSummary = now;
      this.#renderPicker();
    }
  }

  // ── Controls ────────────────────────────────────────────────────────────────
  #onSelect = (): void => {
    const start = Number(this.#select!.value);
    if (Number.isFinite(start)) { this.#addr = this.#viewAddrForBlock(start); this.#renderPicker(); }
  };
  #onInput = (): void => {
    const v = parseInt(this.#input!.value.trim().replace(/^0x/i, ""), 16);
    if (Number.isFinite(v)) { this.#addr = v >>> 0; this.#renderPicker(); }
  };
  #onPrev = (): void => {
    if (this.#addr == null) return;
    this.#addr = Math.max(0, this.#addr - WINDOW);
    this.#renderPicker();
  };
  #onNext = (): void => {
    if (this.#addr == null) return;
    this.#addr += WINDOW;
    this.#renderPicker();
  };
  #onToggle = (): void => {
    this.#enabled = !this.#enabled;
    this.#toggle!.setAttribute("aria-pressed", String(this.#enabled));
    this.#toggle!.textContent = this.#enabled ? "live" : "off";
    this.#refreshDump();
  };
  #onSkip = (): void => {
    this.#skipEmpty = this.#skip!.checked;
    if (this.#emu && this.#addr != null) {
      const a = this.#addr;
      const block = this.#emu.hle.userMemory.listBlocks().find(b => a >= b.start && a < b.start + b.size);
      if (block) this.#addr = this.#viewAddrForBlock(block.start);
    }
    this.#renderPicker();
  };

  /** Address to start the dump at for a chosen allocation. With "skip empty" on,
   *  jump past the leading run of untouched bytes (00 from a fresh heap, FF from
   *  stack fill) to the first window with real data. Otherwise the block base. */
  #viewAddrForBlock(start: number): number {
    if (!this.#emu || !this.#skipEmpty) return start;
    const block = this.#emu.hle.userMemory.listBlocks().find(b => b.start === start);
    if (!block) return start;
    return this.#firstNonEmpty(block.start, block.size) ?? start;
  }

  #firstNonEmpty(start: number, size: number): number | null {
    const ram = this.#emu!.bus.ramBuffer;
    const baseIdx = toPhysical(start) - MemoryRegion.RAM_START;
    if (baseIdx < 0) return null;
    const end = Math.min(baseIdx + size, ram.length);
    for (let i = baseIdx; i < end; i++) {
      const b = ram[i]!;
      if (b !== 0x00 && b !== 0xff) return (start + (i - baseIdx)) & ~(BYTES_PER_ROW - 1);
    }
    return null;
  }

  // ── Imperative fills (preserve focus / scroll) ────────────────────────────────
  #renderPicker(): void {
    const sel = this.#select, input = this.#input, sumEl = this.#sum;
    if (!this.#emu || !sel || !input || !sumEl) return;
    const alloc = this.#emu.hle.userMemory;
    const blocks = alloc.isInitialized() ? alloc.listBlocks() : [];
    // Only show the high-value regions: the loaded ELF and the game's heap blocks.
    const hiddenTag = (tag: string): boolean =>
      tag.startsWith("stack/") || tag.startsWith("module/") || tag === "usersystemlib";
    const taken = blocks.filter(b => b.taken && !hiddenTag(b.tag));

    if (taken.length === 0) {
      this.#blockSig = "";
      sel.innerHTML = "";
      sumEl.innerHTML = "";
      if (this.#dump) this.#dump.innerHTML = `<div class="dim">No memory blocks yet</div>`;
      return;
    }

    const sig = taken.map(b => `${b.start}:${b.size}`).join(",");
    if (sig !== this.#blockSig) {
      this.#blockSig = sig;
      const prev = sel.value;
      sel.innerHTML = taken.map(b =>
        `<option value="${b.start}">${esc(b.tag || "(untagged)")} · 0x${b.start.toString(16)} · ${fmtSize(b.size)}</option>`
      ).join("");
      if (prev) sel.value = prev;
    }

    if (this.#addr == null) {
      const biggest = taken.reduce((a, b) => (b.size > a.size ? b : a));
      this.#addr = this.#viewAddrForBlock(biggest.start);
    }
    const base = this.#addr & ~(BYTES_PER_ROW - 1);
    // We live in light DOM inside <debug-panel>'s shadow, so the focused element
    // is on that shadow root, not the document.
    const active = (this.getRootNode() as ShadowRoot | Document).activeElement;
    const block = blocks.find(b => base >= b.start && base < b.start + b.size);
    if (active !== sel) sel.value = block?.taken ? String(block.start) : "";
    if (active !== input) input.value = `0x${base.toString(16)}`;

    const free = alloc.getTotalFreeBytes();
    const largest = alloc.getLargestFreeBlockSize();
    const where = block
      ? `${block.taken ? "in" : "free near"} <b>${esc(block.tag || "(untagged)")}</b> · +${fmtSize(base - block.start)}`
      : `<b>unmapped</b>`;
    sumEl.innerHTML = `${where} &middot; free <b>${fmtSize(free)}</b> &middot; largest <b>${fmtSize(largest)}</b>`;

    this.#refreshDump();
  }

  #refreshDump(): void {
    const dump = this.#dump;
    if (!this.#emu || this.#addr == null || !dump) return;
    if (!this.#enabled) { dump.innerHTML = `<div class="dim">paused</div>`; return; }
    const base = this.#addr & ~(BYTES_PER_ROW - 1);
    const bus = this.#emu.bus;
    const rows: string[] = [];
    for (let r = 0; r < ROWS; r++) {
      const off = base + r * BYTES_PER_ROW;
      let hexStr = "", asc = "";
      for (let c = 0; c < BYTES_PER_ROW; c++) {
        const byte = bus.readU8(off + c);
        hexStr += byte.toString(16).padStart(2, "0") + (c < BYTES_PER_ROW - 1 ? " " : "");
        asc += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
      }
      rows.push(
        `<div class="hexrow"><span class="hx-off">${hex8(off)}</span>` +
        `<span class="hx-hex">${hexStr}</span><span class="hx-asc">${esc(asc)}</span></div>`
      );
    }
    // Fixed row count → stable height, so save/restore scroll across the rebuild.
    const scroll = dump.scrollTop;
    dump.innerHTML = rows.join("");
    dump.scrollTop = scroll;
  }
}

customElements.define("memory-panel", MemoryPanel);
