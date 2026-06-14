# Handoff: God of War (gow-sparta) runs at ~1 fps

Continuation handoff for a PSP HLE emulator (TypeScript, runs in the browser).
**This is a pure performance problem.** Read §1 and §2 before anything else —
an earlier version of this doc (and the memory notes) were built on a wrong
premise; don't repeat that.

---

## 1. The task (corrected)

`God of War: Ghost of Sparta` (`test/fixtures/gow-sparta.iso`) boots and renders
correctly, but runs at **~1 fps**. The user confirms it is **NOT stuck** — it
advances and moves past the warning screen, it just takes ~1000 frames to do so
because each frame is so slow. So:

- **Goal: make the emulator fast enough to run GoW at a usable framerate.**
- It is a straightforward "the emulator is too slow for this game's per-frame
  workload" problem. Rendering is correct. Nothing is hung or corrupt.

## 2. DO NOT chase the "corruption / stuck / GAME.BIN" theory

A previous investigation (including the committed memory file
`memory/project_gow_investigation.md`) claimed the low fps was caused by memory
corruption (a skipped `GAME.BIN` read shifting the heap, a clobbered vtable, a
"20K-element sort on garbage", "stuck on splash"). **That premise was wrong.**

- It originated from **headless** behavior, where the emulator faults at frame
  ~15 (`Bad PC=0`). The **browser** run does NOT fault — it runs clean and just
  slowly, and it advances normally.
- "Stuck on the splash" was never observed by the user; it was an unverified
  assumption that then drove the whole corruption hunt.
- Treat `memory/project_gow_investigation.md` as **superseded** for the perf
  task. The GAME.BIN / heap-shift / DiscSpinnerThread-enqueue thread is a
  headless artifact, not the browser's problem. Don't reopen it for fps.

---

## 3. What's actually true about the performance (verified)

- **It's CPU-bound on the main thread, not GPU.** `presentToScreen` (the WebGL
  blit to screen) measures ~0 ms. The cost is in `emulator.runFrame()` — the
  MIPS interpreter plus the inline GE command/vertex processing, all on the main
  thread in WebGL mode.
- **Measure true fps as the rAF-to-rAF delta, NOT `runFrame()` ms.** An earlier
  mistake timed `runFrame` alone (~108 ms at a light frame) and wrongly reported
  "11 fps". The real frame period is ~700-900 ms (≈1 fps). At the heavy intro
  scene the emulator's own CPU meter shows ~100%.
- The GoW intro is genuinely heavy: it submits ~8000 GE primitives/frame (a
  multi-pass glow-text effect), so there's a lot of GE vertex decode/transform
  plus the MIPS code that builds those display lists.

## 4. Work already done that helps (committed)

`ee4442d` "Cut WebGL per-draw GL state churn via dirty-tracking and a cached
pipeline" (`src/gpu/ge-webgl-renderer.ts`): the renderer used to re-issue ~177k
redundant GL state calls/frame (uniforms/blend/colorMask/cull/attribs all set per
draw). Now dirty-tracked → a few hundred. This cut the GE *draw* portion of
`runFrame` ~10× and is verified correct (163 tests pass, rendering pixel-
identical). It's a real on-target win but only covers the draw-call overhead, not
the interpreter or the GE vertex pipeline.

## 5. The real next step

Find where the heavy-scene `runFrame` time actually goes and optimize the
dominant part. Two candidates, not yet cleanly split:

1. **MIPS interpreter** — the fetch/decode/execute hot loop running GoW's own
   per-frame code. Files: `src/cpu/cpu.ts`, `src/cpu/decoder.ts`,
   `src/cpu/executor.ts`, `src/cpu/registers.ts`. Highest ceiling, biggest effort
   (interpreter micro-opt; a JIT would be a large project).
2. **GE command + vertex processing** — `ge-processor.ts` `doPrim()` /
   `transformVertex()` and `ge-vertex.ts` `parseVertices()`, run for ~8000
   prims/frame. More tractable; likely a meaningful chunk on this scene.

Plan:
1. Profile **one heavy-scene frame** in the browser: split `runFrame` time into
   (a) MIPS-interpreter vs (b) GE doPrim/parseVertices/transformVertex vs
   (c) the already-cheap drawPrimitives. (Hook `_dbgEmu.runFrame`, wrap
   `geProcessor.doPrim` / the renderer's `drawPrimitives`; compute MIPS =
   runFrame − GE time.)
2. Optimize whichever dominates. If GE vertex processing: look at per-vertex
   allocation, the transform math, redundant per-prim work. If interpreter:
   profile the hottest opcodes / decode path.
3. Re-measure with the rAF-to-rAF metric to confirm real fps moved.

## 6. Profiling rules (important — user got burned by long runs)

- **Headless faults at frame ~15**, so steady-state perf must be profiled in the
  **browser** (`npm run dev`, open `?iso=/gow-sparta.iso`).
- Make every browser measurement **self-terminating**: gate at ~frame 30 (the
  user confirmed ~30 frames is representative enough), measure ~8-10 frames, then
  stop the rAF loop from inside the injected script (don't rely on polling).
- **Kill the emulation the moment you have the data** (reload the page) — it pegs
  the machine. Don't leave it running between observations.
- Use the emulator's own debug panel CPU% and the rAF-to-rAF delta together;
  don't trust `runFrame` ms as "fps".

---

## 7. Key files

- `src/emulator.ts` — `runFrame()` (~line 477): runs CPU until vblank.
- `src/cpu/cpu.ts`, `decoder.ts`, `executor.ts`, `registers.ts` — MIPS interpreter.
- `src/gpu/ge-processor.ts` — inline GE: `doPrim`, `transformVertex`, dispatch.
- `src/gpu/ge-vertex.ts` — `parseVertices` (per-prim vertex decode).
- `src/gpu/ge-webgl-renderer.ts` — WebGL draw path (already optimized, §4).
- `src/frontend/main.ts` — `runOneFrame`/`frameLoop`: present + HUD + debug panel
  (debug panel `update()` throttles; present ~0 ms).
- Memory: `memory/project_webgl_perf_drawcalls.md` (the §4 work).
  `memory/project_gow_investigation.md` — **superseded for fps** (see §2).

## 8. Git state

- `ee4442d` WebGL per-draw GL state dirty-tracking (the §4 perf win) — committed.
- `268fce3` this handoff + GoW debug tools — committed.
- Earlier this session (rendering/HLE, unrelated to fps): `f44970e` Namco
  through-mode z, `f2a7ca9` GoW intro fade cull fix, `7f4fea9` three HLE handlers.

## 9. Project conventions

- Match PPSSPP exactly; read `ppsspp-reference/` before changing PSP behavior.
- Never hardcode NIDs (`src/kernel/nids.ts`); never hardcode user-memory end.
- Commit only when the user explicitly asks (one-time per request).
- `npx tsc --noEmit` to type-check; tests:
  `npx vitest run src/ test/game-boot-regression.test.ts test/pspautotests/pspautotests.test.ts test/pspautotests/pspautotests-gpu.test.ts`.
