# Game compatibility & known issues, 2026-06-19

Current snapshot of what runs and what's still broken. "Renders" means real
pixels (not a black framebuffer); WebGL is the default browser renderer, the
software rasterizer is the headless/fallback path. For the history of how each
fix landed, read the git log.

## Per-game status

| Game | Status | Notes |
|---|---|---|
| puzzle-bobble | **Playable** (full speed + sound, user-confirmed) | Regression test: `test/game-boot-regression.test.ts` |
| Gran Turismo (UCES01245) | **Plays, renders correctly** | Sky + all textures fixed by the DXT byte-order fix. One known glitch: the HUD/minimap is garbled during the race-start countdown and clears once racing (texture-upload timing). |
| ridge-racer | **Renders, 3D models visible** | The old "3D never submitted" deadlock no longer applies. |
| burnout-legends | **Reaches in-game** | The loader busy-spin is gone. Minor bugs may remain. |
| wipeout-pure | **Intro videos play; menus render** (user-confirmed, browser) | Real WebCodecs H.264 decode. Deeper gameplay less exercised. |
| gta (GTA3) | **Renders** | MPEG ringbuffer path works. |
| metal-slug | **Renders** | In-game flip + missing-characters fixed. |
| cladun-rpg | **Renders, reaches menus** | To start: press UP then X. |
| puyo-puyo | **Renders** | Menu/logo/text fixed (16-bit depth quantization). |
| Duke3D (homebrew) | **Boots** (browser, PBP path) | Pass `disc0:/EBOOT.PBP` for PBPs. Not testable in the ISO-only headless harness. |
| space-invaders | **Black / clears-only** | Event-flag bits never set, then a CPU spin loop. Likely the same intro-video wait as others. |
| lbp | **Bails at boot** | "pthread API call from non-pthread thread"; our threads aren't registered as SCE pthreads. Also needs sceHttp. |
| gow-sparta | **Runs but ~1-2 fps** | Not stuck, just slow: host-GPU bound on ~7k micro draw calls/frame. |

## Known issues

**Rendering**

- Gran Turismo race-start HUD/minimap is garbled during the countdown (clears once racing). Texture-upload timing, not the DXT path or depth.
- Deferred GPU-accuracy gaps from the PPSSPP audit, each with a reason in the code: 16-bit color replication, WebGL doubled-alpha blend, FRAMEBUFWIDTH high bits, morph weights, WebGL CLUT hashing.
- The software rasterizer mis-projects some games' 3D off-screen (e.g. GT), so it renders black there. WebGL is the path to trust for those; the software path is for headless diagnostics.

**Performance**

- God of War runs at ~1-2 fps in WebGL. It advances fine, it's just slow: one `drawArrays` per PSP primitive. The fix is batching same-state draws.

**Audio**

- SAS (`sceSas`) synthesizes only VAG and PCM voices (plus pitch, L/R volume, ADSR). Not done: ATRAC3 voices, noise/triangle/pulse waveform voices, and the reverb/effect-send path (dry mixing only).
- No MPEG/SAS reverb. (MPEG cutscene audio via `sceMpegAtracDecode` IS decoded and played, contrary to older notes.)

**Per-game blockers**

- Space Invaders: event-flag bits never set, then a spin loop.
- LBP: SCE pthread registration missing; needs sceHttp.

**Project-level**

- No LICENSE file even though GPL-derived PPSSPP/libkirk code is tracked (NID DB, KIRK ports, keyvault). Needs a GPL-2.0+ license and attribution.

## Planned / remaining work

1. sceMpeg intro-video handling for the games that still block on it.
2. God of War draw-call batching (the main perf lever).
3. Software-renderer perf: decoded-texture cache + incremental barycentric stepping.
4. Revive the GE Web Worker (currently dead code, disabled over a postMessage/stall race) to offload GE from the main thread, ideally over a SharedArrayBuffer command ring.
5. Utility dialog status numbering for msgdialog/netconf/osk (align with the savedata fix).
6. Headless harness support for directory-based homebrew (mount a dir as `ms0:/PSP/GAME/...`).

## Test counts

- Unit tests: 115/115 (verified 2026-06-19, `npx vitest run src/`).
- pspautotests: 47/47 at last full run (the older 6 GE-signal GPU failures and 2 sysmem failures are fixed). The suite is slow; run it deliberately, not casually.
- Puzzle Bobble boot regression: passing.
