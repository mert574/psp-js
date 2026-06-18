import { html, type TemplateResult } from "lit";
import { SubPanel } from "./sub-panel.js";
import type { PSPEmulator } from "../../emulator.js";

/**
 * Save State section: export the running machine to a .pspstate file, or import
 * one back. A state is bound to the loaded game's disc id and EBOOT hash, so
 * importing only works while the same game is running. Importing overlays the
 * state onto the live emulator (handlers and trampolines are already wired from
 * the original boot), then invalidates the GE texture cache so the next frame
 * redraws from the restored VRAM.
 */
export class SavestatePanel extends SubPanel {
  static override properties = { status: { state: true }, busy: { state: true }, forceName: { state: true } };
  declare status: string;
  declare busy: boolean;
  /** Non-empty when the last import was blocked by a build mismatch; shows the
   *  Force button so the user can override (the bytes are held in #forceBytes). */
  declare forceName: string;

  #emu: PSPEmulator | null = null;
  #frames = 0;
  #forceBytes: Uint8Array | null = null;

  constructor() {
    super();
    this.status = "";
    this.busy = false;
    this.forceName = "";
  }

  override render(): TemplateResult {
    return html`
      <section class="section">
        <h4>Save State</h4>
        <div class="savestate-actions">
          <button @click=${this.#onExport} ?disabled=${this.busy}>Export</button>
          <button @click=${this.#onImportClick} ?disabled=${this.busy}>Import</button>
          ${this.forceName
            ? html`<button @click=${this.#onForce} ?disabled=${this.busy} title="The save is from a different build of this game; restoring anyway may crash.">Force import (build differs)</button>`
            : ""}
          <input type="file" accept=".pspstate" hidden @change=${this.#onFile} />
        </div>
        ${this.status ? html`<div class="savestate-status dim">${this.status}</div>` : ""}
      </section>`;
  }

  reset(): void {
    this.status = "";
    this.busy = false;
    this.forceName = "";
    this.#forceBytes = null;
    this.#frames = 0;
  }

  tick(emu: PSPEmulator, _now: number): void {
    this.#emu = emu;
    this.#frames++;
  }

  #onExport = async (): Promise<void> => {
    const emu = this.#emu;
    if (!emu) { this.status = "No game running"; return; }
    this.busy = true;
    this.status = "Exporting...";
    // Let the busy/status repaint before the synchronous capture briefly blocks
    // the thread; the slow gzip then runs in a worker so the UI stays live.
    await nextFrame();
    try {
      const renderer = emu.hle.geProcessor?.webglRenderer ? "webgl" : "software";
      const cap = emu.captureSnapshot({ frames: this.#frames, renderer });
      const blob = await packInWorker(cap);
      const name = `${emu.gameId || "homebrew"}-v${cap.formatVersion}-${renderer}-${dateTimeStamp()}.pspstate`;
      downloadBlob(blob, name);
      this.status = `Exported ${fmtSize(blob.byteLength)}`;
    } catch (err) {
      this.status = `Export failed: ${errMsg(err)}`;
    } finally {
      this.busy = false;
    }
  };

  #onImportClick = (): void => {
    this.renderRoot.querySelector<HTMLInputElement>('input[type="file"]')?.click();
  };

  #onFile = async (ev: Event): Promise<void> => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // allow re-importing the same file
    if (!file || !this.#emu) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await this.#applyState(bytes, file.name, false);
  };

  #onForce = (): void => {
    if (this.#forceBytes) void this.#applyState(this.#forceBytes, this.forceName, true);
  };

  async #applyState(bytes: Uint8Array, name: string, force: boolean): Promise<void> {
    const emu = this.#emu;
    if (!emu) return;
    this.busy = true;
    try {
      await emu.loadState(bytes, force ? { allowBuildMismatch: true } : {});
      // VRAM and GE state changed under the renderer: drop the cached textures
      // and the GPU framebuffers so both rebuild from the restored VRAM.
      const renderer = emu.hle.geProcessor?.webglRenderer;
      renderer?.invalidateTextures?.();
      renderer?.clearVFBs?.();
      this.status = force ? `Imported ${name} (forced; build differs)` : `Imported ${name}`;
      this.forceName = "";
      this.#forceBytes = null;
    } catch (err) {
      if ((err as { code?: string }).code === "BUILD_MISMATCH") {
        // Same game title, different EBOOT build. Offer to force it.
        this.#forceBytes = bytes;
        this.forceName = name;
        this.status = `${name} is from a different build of this game.`;
      } else {
        this.forceName = "";
        this.#forceBytes = null;
        this.status = `Import failed: ${errMsg(err)}`;
      }
    } finally {
      this.busy = false;
    }
  }
}

/** Run the gzip/packing off the main thread so a big export doesn't freeze the
 *  UI. The capture (which must read live emulator state) already happened on the
 *  main thread; here we only hand the raw section buffers to the worker. */
function packInWorker(cap: ReturnType<PSPEmulator["captureSnapshot"]>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../../state/savestate-pack.worker.ts", import.meta.url), { type: "module" });
    const transfers = cap.sections.map(s => s.bytes.buffer);
    worker.onmessage = (e: MessageEvent<{ ok: boolean; blob?: ArrayBuffer; error?: string }>) => {
      worker.terminate();
      if (e.data.ok && e.data.blob) resolve(new Uint8Array(e.data.blob));
      else reject(new Error(e.data.error ?? "save state packing failed"));
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage(
      {
        gameId: cap.gameId,
        contentHash: cap.contentHash,
        formatVersion: cap.formatVersion,
        meta: cap.meta,
        sections: cap.sections.map(s => ({ name: s.name, codec: s.codec, bytes: s.bytes.buffer })),
      },
      transfers,
    );
  });
}

/** Yield to the event loop for one frame so a pending render can paint. */
function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function fmtSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;
}

/** Readable, sortable local timestamp for filenames, e.g. "2026-06-18_143025". */
function dateTimeStamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function downloadBlob(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

customElements.define("savestate-panel", SavestatePanel);
