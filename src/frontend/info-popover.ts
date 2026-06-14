/** A small "i" info trigger with a hover/focus popover. Wraps its children as the
 *  popover body and gives each instance its own CSS anchor-name, so multiple
 *  popovers don't all anchor to the last `.info` in the DOM (a shared anchor-name
 *  resolves to one element). The popover is position:fixed and anchor()-positioned,
 *  so it escapes a scroll container and tracks its own trigger on scroll.
 *
 *  It works in light DOM (no shadow) so the host's styles (`.info` / `.info-pop`)
 *  reach the projected content — the popover body often has nested markup that
 *  ::slotted() can't reach. Usage: <info-popover label="...">…content…</info-popover>. */
let infoPopSeq = 0;

export class InfoPopover extends HTMLElement {
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
