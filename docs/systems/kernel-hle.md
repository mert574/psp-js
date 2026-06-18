# Kernel & HLE

The HLE kernel is the heart of the emulator: it implements the PSP operating system in TypeScript. It dispatches syscalls, schedules threads, and provides every `sceXxx` function a game calls. The code lives in `src/kernel/`.

## HLEKernel

`HLEKernel` (`hle-kernel.ts`) owns the syscall table and the scheduler. A handler has the type:

`HLEHandler = (regs: AllegrexRegisters, bus: MemoryBus) => void`

Key methods:

`register(nid: number, handler: HLEHandler): void`

Bind a NID to a real handler. Warns if it overwrites an existing one.

`stub(nid: number, retval = 0): void`

Bind a NID to a no-op that sets `v0 = retval` and counts the call (shown in the debug panel). Skips if a real handler is already registered, so a stub never replaces a real implementation.

`dispatch(syscallCode: number, regs: AllegrexRegisters): void`

Run the handler for a syscall. Called when the CPU reaches a syscall; looks the handler up directly by syscall code and invokes it. If none is registered it returns success (`v0 = 0`) and logs the code once (the `syscallToNid` map is used only to name the code in that warning).

`reschedule(regs: AllegrexRegisters): boolean`

Pick the highest-priority `READY` thread and switch to it. Returns whether a thread is now running.

`ensureGeProcessor(): GEProcessor`

Return the GE processor, creating it on first use.

See [Syscall Flow & ABI](/reference/syscalls) for the full dispatch path and the MIPS calling convention.

## Per-module handlers

Each PSP library is implemented in its own `hle-*.ts` file (thread, io, display, ctrl, audio, sync, power, net, font, media, mpeg, psmf-player, utility, …). Every file follows the same shape:

1. Real `kernel.register()` handlers at the **top**.
2. `kernel.stub()` calls at the **bottom**.

When adding a real handler, place it above the stubs. See [Conventions](/reference/conventions#handler-placement).

## NID constants

NIDs are numeric identifiers for library functions. All of them live in `src/kernel/nids.ts` as per-module `as const` objects (`THREAD`, `DISPLAY`, `IO`, `SEMA`, `MUTEX`, and so on). Code imports the named constant rather than a raw hex value:

```ts
import { SEMA, MUTEX, THREAD } from "./nids.js";
```

## Thread scheduler

The PSP is cooperatively/priority scheduled. The kernel keeps threads in a `Map<id, Thread>`, each in one of these states:

```
RUNNING | READY | WAITING | DORMANT | DEAD
```

Threads block on a **wait type**:

```
DELAY | VBLANK | SLEEP | SEMA | EVENT_FLAG | AUDIO | GE_DRAW_SYNC | ...
```

Notes:

- `currentThreadId = 0` means the module-start phase, before any threads have been created.
- The `idleBreak` flag lets the CPU run loop exit when every thread is waiting, there is nothing to run until an event fires.
- Thread stacks are filled with `0xFF` in `sceKernelStartThread` (not at create time), matching PPSSPP's `FillStack` timing.

## Memory allocation

Thread stacks, partition memory, and heaps all allocate from one pool: `HLEKernel.userMemory`, a `BlockAllocator` whose range follows the memory size (`[0x08800000, 0x0A000000)` by default, `[0x08800000, 0x0C000000)` for 64 MB games). See [Memory](/systems/memory).

## Verifying behaviour

Behavior is matched against PPSSPP. The `ppsspp_niddb.xml` database and the `ppsspp-reference/Core/HLE/sce*.cpp` source are the references, and the source wins where they disagree. See [Conventions](/reference/conventions#ppsspp-as-the-reference).
