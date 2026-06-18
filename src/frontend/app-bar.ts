import { LitElement, html, css } from "lit";
import { formatClock } from "./clock.js";

// The page header: PSP.js logo, a short tagline, a GitHub link, and the PSP
// XMB-style clock at the far right. The clock used to be wired up by initClock()
// against a global #app-clock element; now that the header lives in shadow DOM,
// the component owns the clock and updates it each minute itself.
class AppBar extends LitElement {
  static override styles = css`
    *, *::before, *::after { box-sizing: border-box; }

    /* The global "* { padding: 0 }" reset in style.css applies to the host
       element and overrides :host padding, so the layout (flex/gap/padding)
       lives on an inner wrapper inside the shadow tree, which that reset can't
       reach. :host keeps only the visual chrome (the reset doesn't touch those). */
    :host {
      display: block;
      border-bottom: 1px solid var(--border);
      background: rgba(13, 17, 23, 0.72);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 12px 24px;
    }

    .logo {
      font-size: 18px;
      font-weight: var(--fw-black);
      letter-spacing: 0.5px;
      text-decoration: none;
      display: inline-flex;
      align-items: baseline;
    }
    .mark { color: var(--text); }
    .dot {
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }

    .tag {
      font-size: 12px;
      color: var(--muted);
      padding-left: 14px;
      border-left: 1px solid var(--border);
    }
    @media (max-width: 620px) { .tag { display: none; } }

    .spacer { flex: 1; }

    .link {
      font-size: 13px;
      color: var(--muted);
      text-decoration: none;
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      transition: color 0.15s, background 0.15s;
    }
    .link:hover { color: var(--text); background: var(--surface-2); }

    /* PSP XMB-style clock (see clock.ts). Sits at the far right of the app bar. */
    .clock {
      font-size: 14px;
      color: var(--text);
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.04em;
      white-space: nowrap;
      text-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
    }
  `;

  static override properties = {
    _clock: { state: true },
  };
  declare _clock: string;

  // Timer handles so we can clean up if the header is ever removed.
  #firstTick = 0;
  #interval = 0;

  constructor() {
    super();
    this._clock = formatClock();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._clock = formatClock();
    // Line up the first tick with the next minute boundary, then tick each minute.
    const msToNextMinute = 60000 - (Date.now() % 60000);
    this.#firstTick = window.setTimeout(() => {
      this._clock = formatClock();
      this.#interval = window.setInterval(() => { this._clock = formatClock(); }, 60000);
    }, msToNextMinute);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.#firstTick) { clearTimeout(this.#firstTick); this.#firstTick = 0; }
    if (this.#interval) { clearInterval(this.#interval); this.#interval = 0; }
  }

  override render() {
    return html`
      <div class="bar">
        <a href="/" class="logo" aria-label="PSP.js home">
          <span class="mark">PSP</span><span class="dot">.js</span>
        </a>
        <span class="tag">PSP emulator</span>
        <span class="spacer"></span>
        <a class="link" href="https://github.com/mert574/psp-js" target="_blank" rel="noopener">GitHub</a>
        <span class="clock" aria-label="Date and time">${this._clock}</span>
      </div>
    `;
  }
}

customElements.define("app-bar", AppBar);
