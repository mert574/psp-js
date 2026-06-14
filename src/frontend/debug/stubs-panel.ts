import { html, type TemplateResult } from "lit";
import { SubPanel } from "./sub-panel.js";
import type { PSPEmulator } from "../../emulator.js";

const WINDOW_MS = 500;

/** Stubs Called section: unimplemented syscalls ranked by call count. */
export class StubsPanel extends SubPanel {
  static override properties = { tpl: { state: true } };
  declare tpl: TemplateResult;

  #last = 0;

  constructor() {
    super();
    this.tpl = html`<div class="dim">No stubs called</div>`;
  }

  override render(): TemplateResult {
    return html`<section class="section"><h4>Stubs Called</h4><div class="stubs scrollbox">${this.tpl}</div></section>`;
  }

  reset(): void { this.#last = 0; this.tpl = html`<div class="dim">No stubs called</div>`; }

  tick(emu: PSPEmulator, now: number): void {
    if (now - this.#last < WINDOW_MS) return;
    this.#last = now;
    const calls = emu.hle.stubCalls;
    if (calls.size === 0) { this.tpl = html`<div class="dim">No stubs called</div>`; return; }
    const sorted = [...calls.entries()].sort((a, b) => b[1] - a[1]);
    this.tpl = html`${sorted.map(([name, count]) =>
      html`<div class="stub"><span class="stub__name">${name}</span><span class="stub__count">&times;${count}</span></div>`
    )}`;
  }
}

customElements.define("stubs-panel", StubsPanel);
