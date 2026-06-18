# GPU (GE)

The PSP's GPU is the **Graphics Engine** (GE). It executes display lists: streams of commands the game writes to memory and submits with `sceGeListEnQueue`. Each command is a 32-bit word (an 8-bit opcode plus a 24-bit parameter).

The GE code lives in `src/gpu/`.

## The GE runs inline on the main thread

::: warning Important
A Web Worker GE path exists (`GeDispatcher` in `ge-dispatcher.ts` + `ge-worker.ts`) but is **dead code**, it is never initialized. The GE runs **inline on the main thread** in both the browser and headless.
:::

The live path is `GEProcessor.executeCommand` in `ge-processor.ts`, called once per GE command. To measure GE cost, hook `executeCommand`. Do **not** hook `executeList`/`executeListBudgeted`, they are not on the inline path, so a wrapper there records zero calls and silently hides GE time inside what looks like interpreter time.

## Two renderers

The GE has two interchangeable backends, switchable live from a renderer dropdown in the UI (`renderer-select`); WebGL is the default and software is used when the dropdown value is `software`:

- **WebGL** (`ge-webgl-renderer.ts`, `WebGLGERenderer`), the default. Translates GE primitives into WebGL draw calls (via [twgl.js](https://twgljs.org/)). Render targets are GPU framebuffer objects (FBOs), tracked as **virtual framebuffers** (VFBs).
- **Software** (the rasterizer in `ge-processor.ts` plus `ge-fragment.ts`), rasterizes straight into the VRAM byte array. This is what runs headless (no WebGL in Node), and it is presented to the canvas by `framebuffer-renderer.ts`.

The pipeline that builds vertices, lighting and textures is shared (`ge-vertex.ts`, `ge-lighting.ts`, `ge-texture.ts`); only the final draw differs.

### WebGL vs VRAM, and why they can diverge

WebGL keeps rendered pixels in FBOs, separate from the VRAM byte array. The software rasterizer writes pixels directly into VRAM. So for a given frame the two backends keep the image in different places. This matters for:

- **Render-to-texture**, a game draws to an offscreen buffer then samples it as a texture. WebGL serves that from a VFB; software reads it from VRAM. The renderer matches a texture address against the VFB set to bind the right one.
- **Save states**, a state captures VRAM, so cross-renderer behaviour depends on both writing the same byte layout (see below).

### Framebuffer byte order

Software VRAM stores pixels in PSP/hardware order (`byte0 = red` for the 8888 format), the same as WebGL writes. The software fragment pipeline works in an R/B-swapped space internally for historical reasons, and `readPixel`/`writePixel` (in `ge-fragment.ts`) translate at the VRAM boundary so the stored bytes are hardware-order. The present path therefore needs no channel swizzle.

## Textures and CLUTs

`ge-texture.ts` samples textures for the software path; `ge-texture-upload.ts` decodes a whole texture to RGBA for WebGL upload. Formats:

| `texFormat` | Meaning |
| --- | --- |
| 0-3 | Direct color (5650 / 5551 / 4444 / 8888) |
| 4-7 | CLUT-indexed (T4 / T8 / T16 / T32) |
| 8-10 | DXT1 / DXT3 / DXT5 |

CLUT (palette) formats: `clutFormat` 0 = 565, 1 = 5551, 2 = 4444, 3 = 8888. The software sampler reads the CLUT live from `clutAddr` each sample.

## Clears and the scissor

Clear-mode sprite rects (`doClearRect`) and all draws are clamped to the **scissor rectangle**, not just the 480×272 screen. This matters because games place textures (CLUTs, sprite atlases) in VRAM just past the visible rows of a buffer and rely on the scissor to keep clears off them; clamping only to the screen lets a tall clear overrun and wipe that data.

## Block transfers

`doBlockTransfer` copies rectangles between memory regions (e.g. RAM → VRAM). On the WebGL path, if both source and destination are VFBs it does a GPU blit; if the source overlaps a VFB it reads that FBO back to VRAM first so the CPU copy sees current pixels.

## GE finish callbacks

GE list completion can invoke a game callback. This uses a mini CPU loop with a `BREAK` trampoline at `0x08000010`; 512 bytes of stack are reserved below `$sp` to avoid corrupting the interrupted thread.
