# Handoff: God of War (gow-sparta) runs at 1-3 fps + stuck on warning splash

This is a continuation handoff for a PSP HLE emulator (TypeScript, runs in browser).
Read this top to bottom, then read the linked memory files. The task is **not** a
rendering problem — it's a CPU/memory-corruption bug. Don't repeat the rendering
rabbit hole described below.

---

## 1. The task

`God of War: Ghost of Sparta` (`test/fixtures/gow-sparta.iso`, disc id UCUS98737)
boots, reaches the EPILEPSY/WARNING splash screen, and runs at ~1-3 fps, never
advancing past the splash. Goal: make it run at a usable framerate (which also
fixes the stuck-at-splash, because they are the SAME bug).

---

## 2. TL;DR root cause (well established)

The low fps and the stuck splash are one bug:

1. GoW streams data via a `DiscSpinnerThread`. PPSSPP reads a **65016-byte
   `DATA/ENGLISH/GAME.BIN`** early in boot. **Our run never reads it.**
2. That missing ~65 KB allocation shifts the game's *own* internal heap
   **0x10300 bytes lower** than PPSSPP.
3. So a later `sceIoReadAsync(size=0x40000)` (KRATOS_FX streaming) lands its
   buffer end on top of a **live C++ vtable** and overwrites it.
4. Calling through the garbage vtable → `Bad PC=0x0` (headless faults at frame
   ~15; the browser survives via timing but stays corrupt).
5. With corrupt data, the game's main thread runs a bogus **~20,000-element sort
   every frame** → ~100% CPU → 1-3 fps.

So: fix = make the game read GAME.BIN (restoring the heap layout). Everything
else is downstream.

**It is CPU-bound, not GPU-bound.** Measure true fps as **rAF-to-rAF delta**, not
`runFrame()` ms. `presentToScreen` is ~0 ms. (An earlier mistake measured
`runFrame` only and wrongly concluded 11 fps; real is ~1.3.)

---

## 3. What is CONFIRMED CORRECT (do not re-investigate)

- **ISO metadata is right.** `tools/debug-gow2-isocheck.ts` shows
  `GAME.BIN lba=0x96ec0 size=65016`, `FRONTEND_ASSETS lba=0x46480`,
  `R6_INTRO lba=0xb8e20` — all match PPSSPP's `sce_lbn` sectors.
- **getstat returns the right sector.** `getstat(FRONTEND)` → `st_private[0]=0x46480`.
- **Dread per-entry startSector is a dead end.** Already implemented; GoW uses
  explicit getstat, not the Dread sector. Don't chase this again.
- **Our early allocations match PPSSPP up to the R6_INTRO probe.** The probe
  buffer is `0x8c4a320` in both. Divergence is strictly *after* that.
- **Memory size is correct** (gow is a 32 MB / PSP-1000 game; detected from
  PARAM.SFO MEMSIZE; committed earlier). FPL pool base `0x8c5f300` matches PPSSPP.

---

## 4. NEW finding this session (the narrowing — start here)

Traced the `DiscSpinnerThread` (it is **tid 3**) end-to-end with
`tools/debug-gow2-spinner.ts`. Its entire syscall sequence is:

```
sceIoOpen("disc0:/PSP_GAME/USRDIR/MOVIES/R6_INTRO.PMF") -> fd 0x1b
sceIoChangeAsyncPriority(0x1b, 0x38)
sceIoReadAsync(0x1b, buf=0x8c4a320, size=1)   <- 1-byte probe, buffer matches PPSSPP
sceKernelDelayThread(100000us)
sceIoPollAsync(0x1b, ...) -> 0                 <- completes fine
... then an ENDLESS sceKernelDelayThread(100000us) idle loop, reads NOTHING else
```

So the spinner does the R6_INTRO probe correctly, then **idles forever** (state
READY, just delaying — NOT blocked on a sema). It never reads GAME.BIN because
**the GAME.BIN streaming request is never ENQUEUED to it**.

PPSSPP, right after the same probe, reads `GAME.BIN @0x08cee440`. We don't enqueue
it. So the divergence is in **whoever enqueues streaming requests** (the main
thread `tid 1` / the game's streaming API), not in the spinner.

The main thread (`tid 1`) separately opens FRONTEND_ASSETS / KRATOS_FX **by name**
(a synchronous path) — see `tools/debug-gow2-disc.ts` for the full UMD + IO
timeline. The corruption surfaces as `sceIoOpenAsync(a0=0x1f001f)` (garbage path
pointer) AFTER KRATOS, but the GAME.BIN-enqueue divergence happens BEFORE that.

---

## 5. THE NEXT STEP (truly remaining work)

Find the call PPSSPP makes — right after the R6_INTRO probe completes — that
enqueues the GAME.BIN read, and figure out why our run doesn't make it. Likely a
game-streaming-API call on `tid 1` gated by some return value (UMD / devctl /
volatile-mem / a sema/event between t1 and the spinner). Suspects to compare:
`sceUmd*`, `sceIoDevctl`, `scePowerVolatileMemLock`, semaphore/eventflag signals.

**You almost certainly need a PPSSPP instruction/HLE trace to diff against** — the
IO log alone isn't enough to see the enqueue branch. Ask the user to capture
PPSSPP `sceKernel`+`sceIo` (and ideally a CPU/JIT trace) at Debug for the
post-R6_INTRO-probe window. There is already a captured PPSSPP IO log referenced
in the memory (`~/.config/ppsspp/PSP/SYSTEM/DUMP/log.txt`) — re-capture with the
same channels.

Alternative (lower odds): blind instruction-trace `tid 1` from just after the
R6_INTRO probe to the FRONTEND open, looking for a branch that should reach a
file-load enqueue.

---

## 6. Key files

Source (the emulator):
- `src/kernel/hle-io.ts` — all `sceIo*`: open/read/async (`sceIoReadAsync`,
  `sceIoPollAsync` ~line 763, `sceIoWaitAsync`), `sceIoGetstat`/`writeIoStat`
  (~line 174, writes `st_private[0]=startSector` at offset 0x40), `sceIoDread`
  (~line 573). `sce_lbn` raw-open resolution lives here too.
- `src/kernel/psp-filesystem.ts` — `getDirListing` (~line 315), `getFileInfo`,
  `setFileSector`, `this.sectors` map. The startSector comment at ~line 329 is the
  (already-tried) Dread path.
- `src/kernel/hle-power.ts` — `sceUmd*` + `scePowerVolatileMem*` handlers (the
  UMD-readiness dance + volatile mem are suspects for gating the enqueue).
- `src/emulator.ts` — `runFrame()` (~line 477, runs CPU until vblank), boot/ELF
  load, file registration (`fileData.set`). Browser boot path.
- `test/helpers/boot-game.ts` — headless boot (`loadGame`, `mountIso` ~line 83);
  sets file sectors via `setFileSector`. Headless faults at frame ~15 (recover by
  the `cpu.step` PC=0 trampoline the debug tools use).

Debug tools (all headless, `npx tsx tools/<name>.ts`; untracked):
- `tools/debug-gow2-spinner.ts` — **start here**: maps thread name→tid, traces
  DiscSpinnerThread syscalls, dumps all thread states. (This produced §4.)
- `tools/debug-gow2-disc.ts` — UMD + IO (getstat/open/devctl) timeline with
  calling thread; flags GAME.BIN / sce_lbn. (Dread spam is collapsed.)
- `tools/debug-gow2-isocheck.ts` — verifies ISO lba/size for the streamed files.
- `tools/debug-gow2-getstat.ts`, `-readseq.ts`, `-readsite.ts`, `-openptr.ts`,
  `-timeline.ts`, `-alloc.ts`, `-perf.ts`, `-loop.ts`, `-caller.ts`, etc. —
  older tools from prior sessions (read order, vtable-write/read ordering,
  per-thread stepping, alloc trace, hot-PC). See the memory for what each does.

Memory (READ THESE — auto-loaded context for the project):
- `/Users/mert.yildiz/.claude/projects/-Users-mert-yildiz-Developer-mert574-psp-js/memory/project_gow_investigation.md`
  — the full investigation incl. the corruption mechanism, the PPSSPP log diff,
  and the "NARROWED (2026-06-14)" section matching §4 here.
- `.../memory/project_psp_memory_model.md` — PSP heap/memory rules (32 vs 64 MB).
- `.../memory/project_webgl_perf_drawcalls.md` — the ORTHOGONAL renderer work (§7).
- `.../memory/MEMORY.md` — the index.

PPSSPP reference (ground truth — always consult):
- `ppsspp-reference/Core/HLE/sceIo.cpp` (async IO, getstat, sce_lbn),
  `ppsspp-reference/Core/HLE/scePower.cpp` (UMD/volatile mem),
  `ppsspp-reference/Core/HLE/sceUmd*.cpp`.

---

## 7. Orthogonal work in flight (decide: keep or drop)

While (wrongly) chasing rendering, I optimized the WebGL renderer's per-draw GL
overhead: dirty-track uniforms/blend/colorMask/cull + bind program+attribs once.
This cut ~177k redundant GL calls/frame to a few hundred on draw-heavy scenes and
made `runFrame`'s GE-draw cost ~10× cheaper. It is **correct and tested (163 tests
pass, rendering pixel-identical)** but **does NOT fix GoW** (GoW is CPU-bound on
the game's own sort, not on GE draws).

- It lives **uncommitted on disk** in `src/gpu/ge-webgl-renderer.ts` (the only
  modified tracked file: `git status` shows `M src/gpu/ge-webgl-renderer.ts`).
- It's a genuine general win for other draw-heavy games. Either commit it
  separately (it's self-contained) or `git checkout src/gpu/ge-webgl-renderer.ts`
  to drop it. Do not let it muddle the GoW fix.
- Details in `memory/project_webgl_perf_drawcalls.md`.

---

## 8. Git state (as of handoff)

Committed earlier this session (all unrelated to GoW fps; WebGL/HLE correctness):
- `f44970e` Fix Namco splash in WebGL by normalizing through-mode vertex z
- `f2a7ca9` Fix GoW intro text fade in WebGL by inverting cull face for the Y-flip
- `7f4fea9` Implement sceAtracIsSecondBufferNeeded, scePowerGetPllClockFrequencyInt, sceHprmPeekCurrentKey

Uncommitted: `src/gpu/ge-webgl-renderer.ts` (the §7 perf work). Untracked:
`tools/debug-*.ts` scratch tools (intentionally not committed).

---

## 9. How to run / verify

- Type-check: `npx tsc --noEmit`
- Tests: `npx vitest run src/ test/game-boot-regression.test.ts test/pspautotests/pspautotests.test.ts test/pspautotests/pspautotests-gpu.test.ts` (163 pass)
- Headless GoW boot: any `tools/debug-gow2-*.ts` via `npx tsx`. GoW faults at
  frame ~15 headless; the tools install a `cpu.step` trampoline (`if pc==0:
  pc=ra`) to limp past and observe steady state.
- Browser (only if you must — GoW is SLOW and will peg the machine): `npm run dev`,
  open with `?iso=/gow-sparta.iso`. **Kill the emulation immediately after grabbing
  data** (reload the page); don't leave it running. Prefer headless.

---

## 10. Gotchas / rules (project conventions)

- Always match PPSSPP exactly; read `ppsspp-reference/` before changing PSP behavior.
- Never hardcode NIDs (use `src/kernel/nids.ts`); never hardcode user-memory end.
- Real HLE handlers go ABOVE the `kernel.stub(...)` section in each `hle-*.ts`.
- The user wants CPU-not-GPU framing here — don't relapse into renderer theories.
- Commit only when the user explicitly asks, in their current message (one-time).
