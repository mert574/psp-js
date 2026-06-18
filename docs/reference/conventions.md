# Conventions

How the code is organized and a few patterns to follow when extending it.

## PPSSPP as the reference

PSP behavior in this project is matched against [PPSSPP](https://github.com/hrydgard/ppsspp), which is included as the `ppsspp-reference/` submodule. When checking a NID or a behavior, two sources are useful:

1. `ppsspp_niddb.xml`, the NID database.
2. `ppsspp-reference/Core/HLE/sce*.cpp`, the source. The source wins if it disagrees with the XML, which can be out of date.

## NID constants

PSP NID hex values live in `src/kernel/nids.ts` as per-module `as const` objects. Code references the named constant rather than a raw hex literal:

```ts
import { SEMA, MUTEX } from "./nids.js";
kernel.register(SEMA.sceKernelCreateSema, handler);
```

## Handler placement

Each `src/kernel/hle-*.ts` file is laid out the same way:

1. Real `kernel.register()` handlers (actual implementations) at the top.
2. `kernel.stub()` calls (unimplemented no-ops) at the bottom, after the `register()` calls.

A new real handler goes above the stubs section. If PPSSPP's implementation is just "return 0", use `register()` returning 0 rather than `stub()`.

## Utility dialogs are state machines

Savedata, msgdialog, and netconf dialogs are state machines. The PPSSPP `PSPDialog.h` statuses are:

| Status | Meaning |
| --- | --- |
| 0 | NONE |
| 1 | INITIALIZE |
| 2 | RUNNING |
| 3 | FINISHED |
| 4 | SHUTDOWN |

The usual flow: `InitStart` sets the status, `GetStatus` advances `INITIALIZE` to `RUNNING` and `SHUTDOWN` to `NONE`, the game polls for `FINISHED` (3), then `ShutdownStart` goes to 4 and back to 0. Returning an error from `InitStart` crashes games. See `src/kernel/hle-utility.ts`.

## The GE runs inline on the main thread

A Web Worker GE path exists (`GeDispatcher` in `src/gpu/ge-dispatcher.ts`, with the worker side in `src/gpu/ge-worker.ts`) but is dead code. `initGeWorker()` is never called, so the GE runs inline on the main thread in both the browser and headless. To profile GE cost, hook `GEProcessor.executeCommand` (the live inline entry), not `executeList` or `executeListBudgeted`. See [GPU (GE)](/systems/gpu-ge).

## Opcode dispatch

The executor's dispatch switches use literal hex cases rather than opcode constants. V8 compiles a dense literal-case switch into a jump table, while object-property cases are several times slower (and a `const enum` only inlines in the production bundle, not in dev or vitest). Constants are fine in cold paths such as the disassembler and profiler.
