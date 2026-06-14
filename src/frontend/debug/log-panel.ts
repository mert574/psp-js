import { html, type TemplateResult } from "lit";
import { SubPanel } from "./sub-panel.js";
import { Logger, type LogLevel } from "../../utils/logger.js";
import { esc } from "../lib/format.js";

const MAX_LINES = 50;
const WINDOW_MS = 500;

/** Log section: warnings/errors from the Logger, newest first. Filled
 *  imperatively to keep the view pinned to the top across rebuilds. */
export class LogPanel extends SubPanel {
  #lines: Array<{ level: LogLevel; ns: string; msg: string; time: string }> = [];
  #body: HTMLElement | null = null;
  #last = 0;

  override render(): TemplateResult {
    return html`<section class="section">
      <h4>Log <span class="note">(warn / error)</span></h4>
      <div class="log scrollbox"></div>
    </section>`;
  }

  protected override firstUpdated(): void {
    this.#body = this.querySelector(".log");
  }

  override connectedCallback(): void {
    super.connectedCallback();
    Logger.setWarnHook((level, ns, msg) => {
      const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
      this.#lines.push({ level, ns, msg, time });
      if (this.#lines.length > MAX_LINES) this.#lines.shift();
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    Logger.setWarnHook(null);
  }

  reset(): void {
    this.#lines = [];
    this.#last = 0;
    if (this.#body) this.#body.innerHTML = "";
  }

  tick(now: number): void {
    if (now - this.#last < WINDOW_MS) return;
    this.#last = now;
    const log = this.#body;
    if (!log) return;
    if (this.#lines.length === 0) { log.innerHTML = `<div class="dim">No warnings yet</div>`; return; }
    // Newest first; keep pinned to the top so the latest line stays visible.
    const wasAtTop = log.scrollTop <= 4;
    log.innerHTML = this.#lines.slice().reverse().map(({ level, ns, msg, time }) => {
      const cls = level === "error" ? "error" : "warn";
      return `<div class="logline ${cls}"><div class="logline__head"><span class="logline__time">${time}</span><span class="logline__ns">${esc(ns)}</span></div><span class="logline__msg">${esc(msg)}</span></div>`;
    }).join("");
    if (wasAtTop) log.scrollTop = 0;
  }
}

customElements.define("log-panel", LogPanel);
