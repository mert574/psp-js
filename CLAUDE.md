# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A PSP (PlayStation Portable) HLE emulator in TypeScript that runs in the browser. HLE = High-Level Emulation (like PPSSPP) — no BIOS ROM required. System calls are intercepted and implemented directly in TypeScript.

It boots real commercial games: it decrypts KIRK-encrypted EBOOTs, loads ISO/PBP, runs the MIPS Allegrex CPU + VFPU, renders the GE (GPU) over WebGL, decodes ATRAC3+ audio and MPEG/PSMF video, and persists savedata.

## Commands

```bash
npx tsc --noEmit           # Type-check (run after every change)
npm run typecheck          # Same thing via package script
npx vitest run             # Run all tests
npx vitest run src/        # Run unit tests only (skip integration tests that need ISOs)
npx vitest run src/timing/ # Run specific test directory
npm run dev                # Vite dev server (browser frontend) — serves with COOP/COEP for SharedArrayBuffer
npm run build              # TypeScript compilation (tsc)
npm run build:web          # Vite production build to dist-web/
npm run docs:dev           # VitePress docs dev server (port 5174)
npm run docs:build         # Build the docs site to docs/.vitepress/dist
npm run dev:all            # Run the app and the docs together (docs proxied under /docs/)
npx tsx tools/boot-iso.ts test/fixtures/puzzle-bobble.iso 100   # Boot ISO for N frames (headless, node)
npx tsx tools/game-diag.ts test/fixtures/gta.iso                # Headless game diagnostics
npx tsx tools/find-dup-nids.ts                                  # Check for duplicate NID values
```

The dev/preview server must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (configured in `vite.config.ts`) — without these, `SharedArrayBuffer` is unavailable and the GE worker can't run.

## Documentation

A VitePress docs site lives in `docs/`: end-user guide, per-subsystem and per-HLE-module reference, CPU/GE opcode references, and an architecture animation. CI builds it and publishes it under `/psp-js/docs/` next to the app (see `.github/workflows/deploy-pages.yml`). When you change emulated behavior, update the matching page so the docs stay accurate.

## Architecture

```
PSPEmulator (src/emulator.ts)
├── AllegrexCPU       — MIPS fetch→decode→execute, branch delay slots, VFPU, SyscallException (src/cpu/)
├── MemoryBus         — 64MB RAM (0x08000000), 2MB VRAM (0x04000000), 16KB scratchpad (src/memory/)
├── HLEKernel         — Syscall dispatch, thread scheduler, all sceXxx handlers (src/kernel/hle-*.ts)
├── CoreTiming        — Cycle-accurate event scheduler (models PPSSPP CoreTiming.cpp) (src/timing/)
├── GEProcessor       — GE command processing, runs INLINE on the main thread (src/gpu/ge-processor.ts)
└── GeDispatcher      — Web Worker GE path; DEAD CODE, never initialized (src/gpu/ge-dispatcher.ts + ge-worker.ts)
```

### Major Subsystems

- **`src/cpu/`** — AllegrexCPU: decoder, executor, registers (32 GPR + hi/lo + CP0 + VFPU), branch delay slots.
- **`src/memory/`** — MemoryBus (RAM/VRAM/scratchpad routing) + BlockAllocator (PPSSPP port, used for stacks/heaps/partitions).
- **`src/kernel/`** — HLEKernel + per-module `hle-*.ts` handlers (thread, io, display, ctrl, audio, sync, power, net, font, media, mpeg, psmf-player, utility). NID constants in `nids.ts`.
- **`src/gpu/`** — GE (Graphics Engine): command processor, vertex/lighting/patches/texture pipeline, WebGL renderer (`ge-webgl-renderer.ts`), software framebuffer renderer, and the off-thread `ge-worker.ts`.
- **`src/loader/`** — ELF loader, PBP parser, and PRX decrypter (KIRK-decrypts + gzip-decompresses encrypted `~PSP` EBOOTs; HLE'd module PRXes are skipped per `HLE_PRX_NAMES`).
- **`src/crypto/`** — AES, SHA1, KIRK engine, AMCTRL — the crypto primitives behind PRX/savedata decryption.
- **`src/iso/`** — ISO9660 reader, SFO (param.sfo) parser, ISO metadata.
- **`src/audio/`** — AudioWorklet engine + ATRAC3+ decode (via bundled ffmpeg/libav).
- **`src/media/`** — MPEG and PSMF video: demux + decode (WebCodecs) for intro/cutscene videos.
- **`src/storage/`** — savedata store + file store (browser-persisted).
- **`src/frontend/`** — browser UI: game library, input mapping, debug panel, savedata overlay, PMF playback. Entry point `main.ts` (loaded by `index.html`).

### Syscall Flow

`SYSCALL instruction` → `SyscallException(code)` → `cpu.ts catches` → `hle.dispatch(code, regs)`

Handlers registered by NID: `kernel.register(THREAD.sceKernelCreateThread, (regs, bus) => { ... })`

MIPS O32 ABI: `a0-a3 = $4-$7` (args), `v0 = $2` (return), `ra = $31`, `sp = $29`

### HLE File Organization

Each `src/kernel/hle-*.ts` file follows this structure:
1. Real `kernel.register()` handlers (actual implementations) — **top**
2. `kernel.stub()` calls (unimplemented no-ops) — **bottom, after all register() calls**

`kernel.stub(nid)` skips if a real handler is already registered and tracks call counts in the debug panel.

### NID Constants

All PSP NID hex values live in `src/kernel/nids.ts` as per-module `as const` objects. Never use raw hex — always reference named constants:

```typescript
import { THREAD, KERNEL } from "./nids.js";
kernel.register(THREAD.sceKernelCreateThread, handler);
```

### Thread Scheduler

- Threads: `Map<id, Thread>` with states `RUNNING | READY | WAITING | DORMANT | DEAD`
- Wait types: `DELAY | VBLANK | SLEEP | SEMA | EVENT_FLAG | AUDIO | GE_DRAW_SYNC | ...`
- `currentThreadId = 0` means module_start phase (before any threads)
- `reschedule(regs)` picks highest-priority READY thread
- `idleBreak` flag: CPU run loop exits when all threads are waiting

### CoreTiming

Models PPSSPP's `CoreTiming.cpp`. CPU_HZ starts at 222MHz (not 333MHz), changes dynamically via `scePowerSetClockFrequency`. VBlank fires every ~16.683ms. Events scheduled by cycle count, not wall clock.

### GE Worker (DISABLED: GE actually runs INLINE on the main thread)

The Web Worker path (`GeDispatcher`, `src/gpu/ge-worker.ts`) exists but is **dead code**. `initGeWorker()` is never called, so `geDispatcher` is always null and every GE path falls through `if (!this.geDispatcher) this._processGeQueue()`. GE runs **inline on the main thread** in BOTH browser and headless: `_processGeQueue` → `_scanAndCompleteGeList` → `_scanGeListHeadless` → `GEProcessor.executeCommand` (one call per GE command). The worker was turned off because of a postMessage/stall race (`emulator.ts initWorker` is a no-op). Reviving it is a real, currently-unrealized way to offload GE work from the main thread so it runs next to the interpreter.

Profiling note: to measure GE cost, hook `GEProcessor.executeCommand` (the live inline entry). Do NOT hook `executeList`/`executeListBudgeted`; they are not on the inline path, so a wrapper there records zero calls and silently hides GE time inside what looks like "interpreter" time.

Block transfers (`doBlockTransfer`) can write to RAM, a source of data races if the worker is ever revived.

GE finish callbacks use a mini-CPU-loop with BREAK trampoline at `0x08000010`. Stack space (512 bytes) is reserved below `$sp` to prevent corruption.

## PPSSPP Reference

**Always consult PPSSPP source** (`ppsspp-reference/` submodule) as authoritative ground truth for any PSP emulation behavior. When verifying NIDs, cross-reference BOTH:
1. `ppsspp_niddb.xml` — comprehensive NID database
2. `ppsspp-reference/Core/HLE/sce*.cpp` — source code (wins on conflict, XML can be outdated)

## PSP Hardware Constants (PSP-2000/3000 Slim)

- RAM: 64MB (`0x08000000 - 0x0BFFFFFF`)
- VRAM: 2MB (`0x04000000 - 0x041FFFFF`)
- CPU: 222MHz default (games set 333MHz via scePowerSetClockFrequency)
- Display: 480x272
- Volatile RAM: 4MB at `0x08400000`

## Testing

- CPU tests: programs as u32 arrays written to RAM at `0x08000000`
- Data addresses must be well past program end (e.g., `RAM + 100`)
- BEQ offset is in **words** from `(PC+4)`, not bytes
- Integration tests boot real ISOs from `test/fixtures/`
- `tools/boot-iso.ts` — headless ISO boot for diagnostics (no GE worker in node)

## Key Rules

- When adding a real handler, place it ABOVE the stubs section — never after stubs
- If PPSSPP's implementation is just "return 0", use `kernel.register()` not `kernel.stub()` — stubs are only for truly unimplemented functions
- Utility dialogs (savedata, msgdialog, netconf) need state machines. PPSSPP `PSPDialog.h` statuses: `0=NONE, 1=INITIALIZE, 2=RUNNING, 3=FINISHED, 4=SHUTDOWN`. Typical flow: InitStart sets the status, GetStatus auto-advances `INITIALIZE→RUNNING` and `SHUTDOWN→NONE`, the game polls for `FINISHED(3)` then calls ShutdownStart to go `→4→0`. Returning an error from InitStart crashes games. (See `src/kernel/hle-utility.ts`.)
- Agents must use Read/Edit/Write/Grep/Glob tools for file operations — never Bash with python/sed/awk/cat
