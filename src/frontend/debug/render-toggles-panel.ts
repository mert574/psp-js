import { html, type TemplateResult } from "lit";
import { SubPanel } from "./sub-panel.js";
import type { PSPEmulator } from "../../emulator.js";

type ToggleKey =
  | "textures" | "lighting" | "fog" | "colorDoubling" | "alphaBlend"
  | "depthTest" | "cull" | "alphaTest" | "colorTest" | "stencilTest" | "scissor";

const TOGGLES: { key: ToggleKey; label: string }[] = [
  { key: "textures", label: "Textures" },
  { key: "lighting", label: "Lighting" },
  { key: "fog", label: "Fog" },
  { key: "colorDoubling", label: "Color doubling" },
  { key: "alphaBlend", label: "Alpha blend" },
  { key: "depthTest", label: "Depth test" },
  { key: "cull", label: "Backface cull" },
  { key: "alphaTest", label: "Alpha test" },
  { key: "colorTest", label: "Color test" },
  { key: "stencilTest", label: "Stencil test" },
  { key: "scissor", label: "Scissor" },
];

type Overrides = Record<ToggleKey, boolean>;
const DEFAULTS: Overrides = {
  textures: true, lighting: true, fog: true, colorDoubling: true, alphaBlend: true,
  depthTest: true, cull: true, alphaTest: true, colorTest: true, stencilTest: true, scissor: true,
};

/**
 * Render section: force individual GE features off for the whole scene to
 * isolate a rendering bug (e.g. "is this purple cast fog or vertex color?").
 * Unchecked = forced off; checked = the game's own setting is honored. The
 * flags live on `geProcessor.debugOverrides` and apply to the WebGL path
 * (lighting also affects the software path). They are not saved in savestates.
 *
 * The draw-call scrubber renders only the first N draw calls of the frame, so
 * you can watch a (paused) frame build up draw by draw and see which draw paints
 * which pixels. It needs the WebGL renderer; pause first, then drag.
 */
export class RenderTogglesPanel extends SubPanel {
  static override properties = {
    vals: { state: true },
    drawTotal: { state: true },
    drawLimit: { state: true },
    hasWebgl: { state: true },
  };
  declare vals: Overrides;
  declare drawTotal: number;
  /** -1 = unlimited (render all draws). */
  declare drawLimit: number;
  declare hasWebgl: boolean;

  #emu: PSPEmulator | null = null;

  constructor() {
    super();
    this.vals = { ...DEFAULTS };
    this.drawTotal = 0;
    this.drawLimit = -1;
    this.hasWebgl = false;
  }

  override render(): TemplateResult {
    const limited = this.drawLimit >= 0;
    const shown = limited ? this.drawLimit : this.drawTotal;
    return html`
      <section class="section">
        <h4>Render</h4>
        <div class="rtoggles">
          ${TOGGLES.map(t => html`
            <label class="rtoggles__row">
              <input type="checkbox" .checked=${this.vals[t.key]} @change=${(e: Event) => this.#onToggle(t.key, e)} />
              <span>${t.label}</span>
            </label>`)}
        </div>
        ${this.hasWebgl ? html`
          <div class="rscrub">
            <div class="rscrub__head">
              <span>Draw calls</span>
              <b>${limited ? `${shown} / ${this.drawTotal}` : `all (${this.drawTotal})`}</b>
              ${limited ? html`<button class="rscrub__all" @click=${this.#onShowAll}>all</button>` : ""}
            </div>
            <input
              type="range"
              min="0"
              max=${Math.max(1, this.drawTotal)}
              .value=${String(shown)}
              @input=${this.#onScrub}
              title="Render only the first N draw calls of the frame (pause first)"
            />
          </div>` : ""}
      </section>`;
  }

  reset(): void {
    // Drop the draw limit on reboot (prim counts differ per game). Keep the
    // feature toggles so they persist across reboots.
    this.drawLimit = -1;
    this.drawTotal = 0;
  }

  tick(emu: PSPEmulator, _now: number): void {
    this.#emu = emu;
    const ge = emu.hle.geProcessor;
    const ov = ge?.debugOverrides as Overrides | undefined;
    if (ov) {
      // The processor is the source of truth; mirror it into the UI in case a
      // new GEProcessor was created on reboot (or it changed elsewhere).
      for (const t of TOGGLES) {
        if (this.vals[t.key] !== ov[t.key]) { this.vals = { ...ov }; break; }
      }
    }
    const r = ge?.webglRenderer ?? null;
    this.hasWebgl = !!r;
    if (r && r.dbgFramePrimCount !== this.drawTotal) this.drawTotal = r.dbgFramePrimCount;
  }

  #onToggle(key: ToggleKey, ev: Event): void {
    const checked = (ev.target as HTMLInputElement).checked;
    this.vals = { ...this.vals, [key]: checked };
    const ov = this.#emu?.hle.geProcessor?.debugOverrides as Overrides | undefined;
    if (ov) ov[key] = checked;
    this.#rerender();
  }

  #onScrub = (ev: Event): void => {
    const v = Number((ev.target as HTMLInputElement).value);
    // Dragging fully right means "show everything" → unlimited.
    this.drawLimit = v >= this.drawTotal ? -1 : v;
    this.#applyLimit();
  };

  #onShowAll = (): void => {
    this.drawLimit = -1;
    this.#applyLimit();
  };

  #applyLimit(): void {
    const r = this.#emu?.hle.geProcessor?.webglRenderer;
    if (r) r.debugDrawLimit = this.drawLimit;
    this.#rerender();
  }

  /** Ask the host to re-render one frame so the change shows while paused. */
  #rerender(): void {
    this.dispatchEvent(new CustomEvent("debug-rerender", { bubbles: true, composed: true }));
  }
}

customElements.define("render-toggles-panel", RenderTogglesPanel);
