# Threads & modules (`hle-thread.ts`)

Implements `sceKernelThread*` plus module management, callbacks, interrupt control, message boxes, alarms, and timing helpers. It is the largest HLE module and covers most of what a game's main loop touches.

Each entry below shows the PSP prototype and what our handler actually does. Argument types follow PPSSPP: `u32` is a 32-bit value or guest address, `int` a signed integer, `SceUID` an object id, and a return type of `int`/`SceUID` lands in `$v0`.

## Threads

| Signature | What it does |
| --- | --- |
| `int sceKernelCreateThread(const char *name, u32 entry, u32 priority, int stackSize, u32 attr, u32 optionAddr)` | Allocates a stack from `userMemory` (top-down, minimum 512 bytes, 256-byte aligned), builds a dormant `ThreadContext`, and returns the new thread id. The stack is not filled yet, that happens at start time. |
| `int sceKernelStartThread(SceUID thid, int argSize, u32 argBlockPtr)` | Resets the thread context, fills the whole stack with `0xFF`, sets up the k0 area, copies `argSize` bytes of args onto the new stack, and sets the thread to `READY`. Errors with `ILLEGAL_CONTEXT` if called from interrupt context. During the module_start phase it records a pending entry instead of rescheduling. |
| `int sceKernelDelayThread(u32 usec)` | Blocks the caller for `usec` microseconds by putting it in a `DELAY` wait and scheduling a CoreTiming wake event. Returns `CAN_NOT_WAIT` if called from interrupt context. |
| `int sceKernelDelayThreadCB(u32 usec)` | Same as `sceKernelDelayThread`, but also sets the thread's processing-callbacks flag so pending callbacks fire while it waits. |
| `int sceKernelTerminateThread(SceUID thid)` | Forces the target thread to `DORMANT` and clears its wait. On newer SDKs it errors with `ILLEGAL_CONTEXT` when called from interrupt context, and with `UNKNOWN_THID` for an unknown id. |
| `int sceKernelTerminateDeleteThread(SceUID thid)` | Forces the thread `DORMANT`, frees its stack, and removes the thread entry. Returns `UNKNOWN_THID` for an unknown id. |
| `int sceKernelChangeThreadPriority(SceUID thid, int priority)` | Sets the priority of the given thread (id `0` means the current thread). Always returns success. |
| `int sceKernelChangeCurrentThreadAttr(u32 clearAttr, u32 setAttr)` | Shares the same handler as `sceKernelChangeThreadPriority`, so in practice it just writes the current thread's priority field and returns success. The attribute masks are not applied. |
| `int sceKernelCheckThreadStack()` | Returns a fixed `0x4000` as the reported stack headroom rather than computing the real free space. |

## Modules

| Signature | What it does |
| --- | --- |
| `u32 sceKernelLoadModule(const char *name, u32 flags, u32 optionAddr)` | Reads the file from the virtual filesystem and returns a module id. PRXes whose modname is in the HLE list (for example `sceAtrac3plus`, `sceMpeg_library`, `sceNet_Library`, `sceFont_Library`) are registered as fake modules instead of being executed, since HLE provides their functions. A real ELF is loaded into `userMemory` and its imports are wired to HLE handlers; if any import is still unimplemented the module is faked so its native code never runs. |
| `u32 sceKernelLoadModuleByID(u32 id, u32 flags, u32 optionAddr)` | Always registers a fake module and returns its id, without reading the file descriptor. |
| `u32 sceKernelStartModule(u32 moduleId, u32 argSize, u32 argp, u32 returnValueAddr, u32 optionAddr)` | For a fake or entry-less module it just sets it started and returns success. For a real module it spins up a module_start thread (its own stack, args in `$a0`/`$a1`) and reschedules so the entry point runs. |
| `u32 sceKernelSelfStopUnloadModuleWithStatus(...)` | No-op stub: logs and returns success. (PPSSPP only implements the plain `sceKernelSelfStopUnloadModule(exitCode, argSize, argp)`; the WithStatus variant is not in the reference source, so the exact argument list is not verified here.) |
| `u32 sceKernelGetModuleId()` | We only track one running module, so this returns the fixed id `1`. |
| `u32 sceKernelGetModuleIdByAddress(u32 addr)` | Returns module `1` for any address inside RAM, otherwise `UNKNOWN_MODULE`. |

## Callbacks and interrupts

| Signature | What it does |
| --- | --- |
| `SceUID sceKernelCreateCallback(const char *name, u32 entrypoint, u32 signalArg)` | Creates a callback record, attaches it to the current thread, and returns its id. Callbacks fire at the next `...CB` wait. |
| `int sceKernelNotifyCallback(SceUID cbId, int notifyArg)` | Bumps the callback's notify count, stores `notifyArg`, then reschedules so a thread waiting in a CB-wait can run the callback. Returns `UNKNOWN_CBID` for an unknown id. |
| `void sceKernelCheckCallback()` | Forces callback processing on the current thread. Returns `1` if a callback was dispatched, `0` otherwise (matching PPSSPP's pre-set-then-clear of `$v0`). |
| `int sceKernelGetCallbackCount(SceUID cbId)` | Returns the callback's notify count, or `UNKNOWN_CBID` for an unknown id. |
| `int _sceKernelReturnFromCallback()` | No-op that returns `0`; the framework handles the actual callback-frame cleanup. |
| `int sceKernelRegisterExitCallback(SceUID cbId)` | No-op stub: returns `0`. The exit callback is not invoked. |
| `int sceKernelCpuSuspendIntr()` | Records the previous interrupt-enabled flag, disables interrupts, and returns the previous state (the value the caller later passes back to resume). |
| `void sceKernelCpuResumeIntr(u32 enable)` | Re-enables interrupts when `enable` is `1`, processes any alarm fires that were deferred while interrupts were off, and reschedules if a higher-priority thread became ready. `sceKernelCpuResumeIntrWithSync` uses the same handler. |
| `int sceKernelIsCpuIntrEnable()` | Returns the real interrupt-enabled state (`1` or `0`). Games poll this inside spinlocks, so returning a constant would break those loops. |
| `u32 sceKernelRegisterSubIntrHandler(u32 intrNumber, u32 subIntrNumber, u32 handler, u32 handlerArg)` | Records a sub-interrupt handler in a table keyed by `intrNumber * 32 + subIntrNumber`. Returns `ILLEGAL_INTRCODE` for an out-of-range line and `FOUND_HANDLER` if one is already registered. |
| `sceKernelReleaseSubIntrHandler` / `sceKernelEnableSubIntr` / `sceKernelDisableSubIntr` | Manage and toggle the sub-interrupt entries from `sceKernelRegisterSubIntrHandler`. Bookkeeping only; no real interrupt ever dispatches them. |
| `u32 sceKernelSuspendDispatchThread()` | Suspends thread switching so the caller can run a critical section without being preempted. Returns the old dispatch flag. Errors with `CPUDI` if interrupts are disabled. |
| `u32 sceKernelResumeDispatchThread(u32 enabled)` | Restores the dispatch flag and reschedules. Errors with `CPUDI` if interrupts are disabled. |

## Message boxes and alarms

| Signature | What it does |
| --- | --- |
| `SceUID sceKernelCreateMbx(const char *name, u32 attr, u32 optAddr)` | Creates an empty message-box queue and returns its id. Our queue is a simple list of message pointers; `attr` and options are ignored. |
| `int sceKernelSendMbx(SceUID id, u32 packetAddr)` | Pushes the message pointer onto the queue. Returns `UNKNOWN_MBXID` for an unknown id. |
| `int sceKernelReceiveMbx(SceUID id, u32 packetAddrPtr, u32 timeoutPtr)` | Pops the oldest message and writes its pointer to `packetAddrPtr`. If the queue is empty it returns success without blocking (real blocking on an empty mailbox is not implemented yet). |
| `int sceKernelReceiveMbxCB(SceUID id, u32 packetAddrPtr, u32 timeoutPtr)` | Same as `sceKernelReceiveMbx`; the callback variant does not add extra behavior here. |
| `int sceKernelPollMbx(SceUID id, u32 packetAddrPtr)` | Non-blocking receive: pops a message if one is queued, otherwise returns `MBOX_NOMSG`. |
| `int sceKernelDeleteMbx(SceUID id)` | Removes the mailbox. Returns `UNKNOWN_MBXID` for an unknown id. |
| `SceUID sceKernelSetAlarm(SceUInt micro, u32 handlerPtr, u32 commonPtr)` | Schedules a one-shot CoreTiming event after `micro` microseconds and returns an alarm id. When it fires, the guest handler runs in interrupt context; a positive return value reschedules the alarm, otherwise it is removed. |
| `int sceKernelCancelAlarm(SceUID alarmId)` | Unschedules the pending event and drops the alarm. Returns `UNKNOWN_ALMID` for an unknown id. |

## Timing and utilities

| Signature | What it does |
| --- | --- |
| `int sceKernelGetSystemTime(u32 sysclockPtr)` | Writes the emulated microseconds since boot (64-bit, from CoreTiming) to `sysclockPtr` and returns `0`. |
| `u32 sceKernelGetSystemTimeLow()` | Returns the low 32 bits of the emulated microsecond clock. |
| `u64 sceKernelGetSystemTimeWide()` | Returns the full 64-bit microsecond clock across `$v0`/`$v1`. |
| `int sceKernelSysClock2USec(u32 sysclockPtr, u32 highPtr, u32 lowPtr)` | Reads a 64-bit clock value and splits it into whole seconds (to `highPtr`) and remaining microseconds (to `lowPtr`). |
| `u32 sceKernelLibcClock()` | Returns the low 32 bits of the emulated microseconds since boot. |
| `u32 sceKernelLibcTime(u32 outPtr)` | Returns a unix timestamp (boot wall-clock plus emulated elapsed seconds) and also writes it to `outPtr` when that points into RAM. |
| `u32 sceKernelLibcGettimeofday(u32 timeAddr, u32 tzAddr)` | Writes seconds and microseconds (boot wall-clock plus emulated elapsed time) into the `timeval` at `timeAddr`. The timezone pointer is ignored. |
| `int sceKernelUtilsMd5Digest(u32 dataAddr, int len, u32 digestAddr)` | One-shot MD5 over `len` bytes at `dataAddr`, writing the 16-byte digest to `digestAddr`. Computed with a pure-JS MD5. |
| `int sceKernelUtilsMd5BlockInit(u32 ctxAddr)` | Streaming MD5: resets the hash state. The state lives in our module; the guest `ctxAddr` is not used as storage. |
| `int sceKernelUtilsMd5BlockUpdate(u32 ctxAddr, u32 dataAddr, int len)` | Folds `len` bytes at `dataAddr` into the running MD5. |
| `int sceKernelUtilsMd5BlockResult(u32 ctxAddr, u32 digestAddr)` | Writes the 16-byte MD5 digest to `digestAddr`. |
| `int sceKernelUtilsSha1Digest(u32 dataAddr, int len, u32 digestAddr)` | One-shot SHA1 over `len` bytes at `dataAddr`, writing the 20-byte digest to `digestAddr`. Computed with a pure-JS SHA1. |
| `int sceKernelUtilsSha1BlockInit(u32 ctxAddr)` | Streaming SHA1: resets the hash state. |
| `int sceKernelUtilsSha1BlockUpdate(u32 ctxAddr, u32 dataAddr, int len)` | Folds `len` bytes at `dataAddr` into the running SHA1. |
| `int sceKernelUtilsSha1BlockResult(u32 ctxAddr, u32 digestAddr)` | Writes the 20-byte SHA1 digest to `digestAddr`. |
| `int sceKernelPrintf(const char *formatString)` | Reads the format string and logs it to the captured stdout. Returns `0`. |
| `u32 sceKernelGetGPI()` | Models the debug input pins; always returns `0`. |
| `void sceKernelSetGPO(u32 ledBits)` | Models the LED/output port; ignores its value. |

Around 135 less-common functions in this module are registered as no-op stubs.
