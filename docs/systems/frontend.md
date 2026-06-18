# Frontend

The browser UI lives in `src/frontend/`. It's built with [Lit](https://lit.dev/) web components plus plain TypeScript, no heavyweight framework. The entry point is `main.ts`, loaded by `index.html`.

| File | Contents |
| --- | --- |
| `main.ts` | app entry: ISO/PBP loading, boot sequencing, the rAF loop, renderer wiring |
| `ui.ts` | UI helpers: switching between the file picker, game view, and gameplay views, plus status/error banners and preview audio |
| `input.ts` | keyboard/gamepad → PSP buttons (`sceCtrl`) |
| `debug-panel.ts` + `debug/*` | the debug sidebar and its sub-panels (Lit) |
| `game-library.ts` | the game browser (Lit) |
| `savedata-overlay.ts`, `savedata-list.ts` | in-game savedata management (Lit) |
| `pmf.ts`, `pmf-native.ts` | PSMF cutscene playback |

## Boot and the frame loop

`main.ts` constructs the `PSPEmulator`, loads the bundled `flash0` PGF fonts, wires up the UI events, and on a game selection runs the boot chain and starts a `requestAnimationFrame` loop that calls `emulator.runFrame()` each frame and then presents. A game can be loaded from the library (folder picker), a file input, or the `?iso=/name.iso` URL parameter for scripted sessions.

The emulator is exposed on `window._dbgEmu` for console inspection, alongside `_dbgPerf` (per-frame CPU/GE/present/idle breakdown) and `_dbgCpuProf` (interpreter instruction-mix and hot-PC sampling). Both profilers are off unless enabled, so they don't cost anything normally.

## Renderers

The renderer is chosen at boot and can be switched **live** from the debug panel without rebooting:

- `setupRenderer()` builds either the WebGL `WebGLGERenderer` or the software `FramebufferRenderer`. Each sizes the canvas backing store itself (WebGL to the resolution scale, software to native 480×272).
- `switchRenderer()` tears the current one down, retargets `geProcessor.webglRenderer`, and builds the other. It runs between frames, so the only visible effect is a frame or two of stale content while the game redraws into the new target.
- The debug panel's Performance section shows the **live** renderer (read from `geProcessor.webglRenderer`, not the dropdown) and the renderer label doubles as a click-to-switch toggle.

See [GPU (GE)](/systems/gpu-ge) for what the two renderers actually do.

## Input

`input.ts` maps the keyboard (arrows = d-pad, etc.) and the Gamepad API (analog stick + buttons) to PSP button bits, updated each frame and sampled by the `sceCtrl` handler.

## Debug panel

A Lit `<debug-panel>` hosts one light-DOM sub-component per section (Performance, GE draw stats, Threads, Memory hex view, GE, Savedata, Save state, Stubs, Logs). It is forwarded a `tick(emu, ...)` each frame while open; each sub-panel throttles its own refresh. Sub-panels communicate actions back to `main.ts` via composed/bubbling custom events (e.g. closing the panel, toggling the renderer).

## Gotchas

- The dev/preview server must send the COOP/COEP headers (in `vite.config.ts`) so `SharedArrayBuffer` is available.
- The game library is browser-only (IndexedDB + File API); none of it exists in headless Node.
- `requestAnimationFrame` is throttled when the tab is hidden, so the game pauses automatically.
