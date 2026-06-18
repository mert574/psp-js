# Syscall Flow & ABI

## The flow

A PSP game is MIPS code. When it needs the OS, it issues a `syscall` instruction. The emulator turns that into a TypeScript handler call:

```
SYSCALL instruction
  → the executor sets cpu.pendingSyscall = code
  → cpu.step() sees the flag and calls hle.dispatch(code, regs)
  → the registered handler for that NID runs
```

(A flag is used rather than a thrown exception for speed; there are roughly 2000 syscalls per frame. A `SyscallException` class exists but is not on this path.)

Handlers are registered by **NID** (a numeric identifier for a PSP library function):

```ts
import { THREAD } from "./nids.js";

kernel.register(THREAD.sceKernelCreateThread, (regs, bus) => {
  // implement the syscall, set the return value in v0, etc.
});
```

At load time, the loader patches the game's import stubs and assigns each NID a syscall code; `HLEKernel` keeps a `syscallToNid` map so dispatch can resolve a code back to its NID.

## MIPS O32 ABI

The PSP uses the MIPS O32 calling convention:

| Role | Register | Number |
| --- | --- | --- |
| Arguments | `a0`-`a3` | `$4`-`$7` |
| Return value | `v0` | `$2` |
| Return address | `ra` | `$31` |
| Stack pointer | `sp` | `$29` |

Inside a handler, read arguments with `regs.getGpr(4)` … `regs.getGpr(7)` and set the return value into `v0` (`$2`).

::: warning Set the return value before rescheduling
An HLE handler must set `v0` **before** it calls `kernel.reschedule()`. Rescheduling can switch the running thread, so writing the return value afterwards would write it to the wrong thread's registers.
:::

## NID constants

NID values are referenced by name rather than as raw hex. They live in `src/kernel/nids.ts` as per-module `as const` objects (`THREAD`, `DISPLAY`, `IO`, `SEMA`, `MUTEX`, and so on):

```ts
import { THREAD, KERNEL } from "./nids.js";
kernel.register(THREAD.sceKernelCreateThread, handler);
```

When verifying a NID, cross-reference both `ppsspp_niddb.xml` and the PPSSPP `sce*.cpp` source (the source wins on conflict). Run `npx tsx tools/find-dup-nids.ts` to check for duplicate values.

## register vs stub

`HLEKernel` exposes two ways to wire a NID:

- `kernel.register(nid, handler)`, a real implementation.
- `kernel.stub(nid)`, an unimplemented no-op that just tracks call counts (shown in the debug panel). `stub()` skips if a real handler is already registered.

If PPSSPP's implementation is effectively "return 0", use `register()` returning 0, not `stub()`, stubs are only for genuinely unimplemented functions. See [Conventions](/reference/conventions) for handler placement rules.
