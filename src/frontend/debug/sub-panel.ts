import { LitElement } from "lit";

/** Base for the debug panel's section sub-components. They render in light DOM
 *  (no shadow) so the parent <debug-panel>'s adopted stylesheet styles them, and
 *  the host tag is display:contents so the <section> participates directly in the
 *  panel's flex layout. Each panel owns its own state and update cadence; the
 *  parent just forwards tick()/reset() every frame. */
export abstract class SubPanel extends LitElement {
  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }
}
