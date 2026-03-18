# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A PSP (PlayStation Portable) HLE emulator in TypeScript. HLE = High-Level Emulation (like PPSSPP) — no BIOS ROM required. System calls are intercepted and implemented directly in TypeScript.

## Commands

```bash
npx tsc --noEmit          # Type-check (run after every change)
npx vitest run             # Run all tests
npx vitest run src/        # Run unit tests only (skip integration tests that need ISOs)
npx vitest run src/timing/ # Run specific test directory
npm run dev                # Vite dev server (browser frontend)
npm run build              # TypeScript compilation to dist/
npx tsx tools/boot-iso.ts test/fixtures/puzzle-bobble.iso 100  # Boot ISO for N frames (node)
npx tsx tools/find-dup-nids.ts   # Check for duplicate NID values
```

## Architecture

```
PSPEmulator (src/emulator.ts)
├── AllegrexCPU       — MIPS fetch→decode→execute, branch delay slots, SyscallException
├── MemoryBus         — 64MB RAM (0x08000000), 2MB VRAM (0x04000000), 16KB scratchpad
├── HLEKernel         — Syscall dispatch, thread scheduler, all sceXxx handlers
├── CoreTiming        — Cycle-accurate event scheduler (models PPSSPP CoreTiming.cpp)
├── GeDispatcher      — Coordinates GE command lists with Web Worker
└── GE Worker         — Off-thread GE command processing via SharedArrayBuffer
```

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

### GE Worker

GPU command lists processed on a Web Worker with SharedArrayBuffer. The worker reads GE commands from shared RAM, writes pixels to shared VRAM. Block transfers (`doBlockTransfer`) can write to RAM — this is a source of data races.

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
- Utility dialogs (savedata, msgdialog, netconf) need state machines: `VISIBLE(2) → QUIT(3) → FINISHED(4) → NONE(0)` — returning error from InitStart crashes games
- Agents must use Read/Edit/Write/Grep/Glob tools for file operations — never Bash with python/sed/awk/cat
