# Synchronization & system memory (`hle-sync.ts`)

Implements the kernel synchronization primitives and the partition memory allocator: semaphores, mutexes (including lightweight mutexes), event flags, fixed and variable pools, message pipes, and the `sceKernelSysMem*` calls. Signatures below match PPSSPP (`Core/HLE/sceKernelSemaphore.cpp`, `sceKernelMutex.cpp`, `sceKernelEventFlag.cpp`, `sceKernelMemory.cpp`, `sceKernelMsgPipe.cpp`, `sceKernel.cpp`); types use PSP convention (`SceUID` is an `int` object id, `u32` is an address or unsigned word).

## Semaphores

Waiting threads block with the `SEMA` wait type until the count allows them through.

| Signature | What it does |
| --- | --- |
| `sceKernelCreateSema(name: u32, attr: u32, initVal: int, maxVal: int, optionPtr: u32): SceUID` | Creates a semaphore, copies the name (up to 31 chars), and returns its id. `maxVal <= 0` becomes `0x7fffffff`. |
| `sceKernelDeleteSema(id: SceUID): int` | Deletes the semaphore and wakes every thread waiting on it with `WAIT_DELETE`. |
| `sceKernelSignalSema(id: SceUID, signal: int): int` | Adds `signal` to the count (capped at `maxCount`) and wakes any waiters whose requested count is now satisfied. |
| `sceKernelWaitSema(id: SceUID, wantedCount: int, timeoutPtr: u32): int` | Takes `wantedCount` from the count or blocks until it is available. Returns `CAN_NOT_WAIT` if called inside an interrupt or GE callback. `timeoutPtr`, if set, schedules a wake via CoreTiming. |
| `sceKernelWaitSemaCB(id: SceUID, wantedCount: int, timeoutPtr: u32): int` | Same as `sceKernelWaitSema` but the wait is allowed to run thread callbacks while blocked. |
| `sceKernelPollSema(id: SceUID, wantedCount: int): int` | Non-blocking take: succeeds if the count is high enough, otherwise returns `SEMA_ZERO`. |
| `sceKernelCancelSema(id: SceUID, newCount: int, numWaitThreadsPtr: u32): int` | Wakes all waiters with `WAIT_CANCEL`, writes the waiter count to `numWaitThreadsPtr`, and resets the count to `newCount` (or `initCount` if `newCount < 0`). |
| `sceKernelReferSemaStatus(id: SceUID, infoPtr: u32): int` | Fills the 56-byte `SceKernelSemaInfo` struct at `infoPtr` (name, attr, init/current/max count, waiting-thread count). |

## Mutexes

Standard mutexes track recursion level and the owning thread id in kernel state.

| Signature | What it does |
| --- | --- |
| `sceKernelCreateMutex(name: u32, attr: u32, initialCount: int, optionsPtr: u32): SceUID` | Creates a mutex; a non-zero `initialCount` makes the creating thread the initial owner. Rejects a count above 1 unless the recursive attribute is set. |
| `sceKernelDeleteMutex(id: SceUID): int` | Deletes the mutex. |
| `sceKernelLockMutex(id: SceUID, count: int, timeoutPtr: u32): int` | Acquires the mutex `count` times, recurses if the caller already owns it (recursive attribute), or blocks with the `MUTEX` wait type. The `timeoutPtr` argument is accepted but not turned into a scheduled timeout here. |
| `sceKernelLockMutexCB(id: SceUID, count: int, timeoutPtr: u32): int` | Same as `sceKernelLockMutex` but processes pending callbacks after a non-blocking lock. |
| `sceKernelTryLockMutex(id: SceUID, count: int): int` | Non-blocking lock; returns `TRYLOCK_FAILED` instead of blocking when the mutex is held by another thread. |
| `sceKernelUnlockMutex(id: SceUID, count: int): int` | Drops `count` levels; when the level hits zero, hands the mutex to the highest-priority waiting thread. |

## Lightweight mutexes

LwMutex keeps its lock state in a 32-byte user-memory workarea (lockLevel, lockThread, attr, uid). The kernel only tracks the waiting-thread list.

| Signature | What it does |
| --- | --- |
| `sceKernelCreateLwMutex(workareaPtr: u32, name: u32, attr: u32, initialCount: int, optionsPtr: u32): int` | Allocates an id, zeroes the workarea, and writes the initial lock state into it. |
| `sceKernelDeleteLwMutex(workareaPtr: u32): int` | Reads the uid from the workarea, wakes all waiters with `WAIT_DELETE`, and clears lockLevel/lockThread/uid in the workarea. |
| `sceKernelLockLwMutex(workareaPtr: u32, count: int, timeoutPtr: u32): int` | Tries to acquire via the workarea; on contention adds the thread to the wait list with the `LWMUTEX` wait type. The `_sceKernelLockLwMutex` alias maps to the same handler. The `timeoutPtr` argument is accepted but not scheduled here. |
| `sceKernelLockLwMutexCB(workareaPtr: u32, count: int, timeoutPtr: u32): int` | Same as the lock above but the wait may run callbacks (`_sceKernelLockLwMutexCB` aliases it). |
| `sceKernelTryLockLwMutex(workareaPtr: u32, count: int): int` | Pre-6.00 try-lock: returns `TRYLOCK_FAILED` on any failure (`_sceKernelTryLockLwMutex` aliases it). |
| `sceKernelTryLockLwMutex_600(workareaPtr: u32, count: int): int` | 6.00+ try-lock: returns the specific error code instead of a generic failure. |
| `sceKernelUnlockLwMutex(workareaPtr: u32, count: int): int` | Drops `count` levels in the workarea; at zero it hands the lock to the next waiter (by priority if the attribute is set, otherwise FIFO). `_sceKernelUnlockLwMutex` aliases it. |
| `sceKernelReferLwMutexStatus(workareaPtr: u32, infoPtr: u32): int` | Fills the `SceKernelLwMutexInfo` struct at `infoPtr` from the workarea and kernel state. |
| `sceKernelReferLwMutexStatusByID(uid: SceUID, infoPtr: u32): int` | Same as above but looks the lwmutex up by its kernel id rather than the workarea pointer. |

## Event flags

Threads wait on a bit pattern with AND/OR match modes and optional clear-on-match.

| Signature | What it does |
| --- | --- |
| `sceKernelCreateEventFlag(name: u32, attr: u32, initPattern: u32, optPtr: u32): SceUID` | Creates an event flag with the given initial bit pattern. |
| `sceKernelSetEventFlag(id: SceUID, bitsToSet: u32): int` | ORs `bitsToSet` into the pattern and wakes any waiters whose condition is now met (applying their clear mode). |
| `sceKernelClearEventFlag(id: SceUID, bits: u32): int` | ANDs the pattern with `bits` (clears the bits that are 0 in `bits`). |
| `sceKernelWaitEventFlag(id: SceUID, bits: u32, wait: u32, outBitsPtr: u32, timeoutPtr: u32): int` | Returns at once if the bit condition is met, otherwise blocks with the `EVENT_FLAG` wait type. A timeout of 0 returns `WAIT_TIMEOUT` immediately; a positive timeout schedules a wake. Returns `CAN_NOT_WAIT` inside an interrupt. |
| `sceKernelWaitEventFlagCB(id: SceUID, bits: u32, wait: u32, outBitsPtr: u32, timeoutPtr: u32): int` | Same as above but the wait may run callbacks. |
| `sceKernelPollEventFlag(id: SceUID, bits: u32, wait: u32, outBitsPtr: u32): int` | Non-blocking check; writes the current pattern to `outBitsPtr` and returns `EVF_COND` if the condition is not met. |
| `sceKernelDeleteEventFlag(id: SceUID): int` | Deletes the flag and wakes all waiters with `WAIT_DELETE`. |

## FPL (fixed-size pool)

Blocks are equal-sized and tracked by a free/used boolean per block; the pool memory comes from the shared user allocator.

| Signature | What it does |
| --- | --- |
| `sceKernelCreateFpl(name: u32, mpid: u32, attr: u32, blockSize: u32, numBlocks: u32, optPtr: u32): SceUID` | Allocates `numBlocks` blocks of 4-byte-aligned `blockSize` from user memory and returns the pool id. `numBlocks` is read from `$t0` and clamped to 1..4096. |
| `sceKernelDeleteFpl(uid: SceUID): int` | Frees the pool and wakes its waiters with `WAIT_DELETE`. |
| `sceKernelAllocateFpl(uid: SceUID, blockPtrAddr: u32, timeoutPtr: u32): int` | Writes a free block address to `blockPtrAddr`, or blocks with the `FPL` wait type until a block is freed. `timeoutPtr` is accepted but not scheduled here. |
| `sceKernelTryAllocateFpl(uid: SceUID, blockPtrAddr: u32): int` | Non-blocking allocate; returns `NO_MEMORY` when the pool is full. |
| `sceKernelFreeFpl(uid: SceUID, blockPtr: u32): int` | Returns the block to the pool and hands it to one waiting thread if any. |

## VPL (variable-size pool)

A PPSSPP-compatible block allocator that splits from the end of the pool, with an 8-byte-unit block header per allocation.

| Signature | What it does |
| --- | --- |
| `sceKernelCreateVpl(name: u32, partition: int, attr: u32, vplSize: u32, optPtr: u32): SceUID` | Allocates the pool (size aligned to 8, bumped to `0x1000` if `<= 0x30`) and sets up one big free block. |
| `sceKernelDeleteVpl(uid: SceUID): int` | Frees the pool and wakes its waiters with `WAIT_DELETE`. |
| `sceKernelAllocateVpl(uid: SceUID, size: u32, addrPtr: u32, timeoutPtr: u32): int` | Allocates `size` bytes and writes the pointer to `addrPtr`, or blocks with the `VPL` wait type. `timeoutPtr` is accepted but not scheduled here. |
| `sceKernelAllocateVplCB(uid: SceUID, size: u32, addrPtr: u32, timeoutPtr: u32): int` | Shares the same handler as `sceKernelAllocateVpl` (the callback variant is not treated differently here). |
| `sceKernelTryAllocateVpl(uid: SceUID, size: u32, addrPtr: u32): int` | Non-blocking allocate; returns `NO_MEMORY` when no block is large enough. |
| `sceKernelFreeVpl(uid: SceUID, addr: u32): int` | Frees the allocation, merges adjacent free blocks, and wakes one waiting thread if its request now fits. |

## Message pipes

| Signature | What it does |
| --- | --- |
| `sceKernelCreateMsgPipe(name: u32, partition: int, attr: u32, size: u32, optionsPtr: u32): int` | Returns a fresh id only; no pipe buffer or message transfer is implemented. |
| `sceKernelDeleteMsgPipe(uid: SceUID): int` | No-op stub. |
| `sceKernelSendMsgPipe(uid: SceUID, sendBufAddr: u32, sendSize: u32, waitMode: u32, resultAddr: u32, timeoutPtr: u32): int` | No-op stub; nothing is queued. |
| `sceKernelTrySendMsgPipe(uid: SceUID, sendBufAddr: u32, sendSize: u32, waitMode: u32, resultAddr: u32): int` | No-op stub. |
| `sceKernelReceiveMsgPipe(uid: SceUID, receiveBufAddr: u32, receiveSize: u32, waitMode: u32, resultAddr: u32, timeoutPtr: u32): int` | No-op stub; nothing is delivered. |
| `sceKernelTryReceiveMsgPipe(uid: SceUID, receiveBufAddr: u32, receiveSize: u32, waitMode: u32, resultAddr: u32): int` | No-op stub. |

## System memory

These allocate from the shared user pool (`kernel.userMemory`) and track blocks in `kernel.memBlocks`.

| Signature | What it does |
| --- | --- |
| `sceKernelAllocPartitionMemory(partition: int, name: u32, type: int, size: u32, addr: u32): SceUID` | Allocates a block by placement type (0 low, 1 high, 2 at `addr`, 3 low-aligned, 4 high-aligned) and returns its id. Validates name, type range, and size. |
| `sceKernelFreePartitionMemory(id: SceUID): int` | Frees the block and drops its tracking entry. |
| `sceKernelGetBlockHeadAddr(id: SceUID): u32` | Returns the base address of a block, or 0 if unknown. |
| `sceKernelMaxFreeMemSize(): u32` | Returns the largest contiguous allocatable block size. |
| `sceKernelTotalFreeMemSize(): u32` | Returns the total free bytes in the user pool. |
| `sceKernelMemset(addr: u32, fillc: u32, n: u32): u32` | Real memory fill of `n` bytes; returns the destination pointer. Also serves `sce_paf_private_memset`. |
| `sceKernelMemcpy(dst: u32, src: u32, size: u32): u32` | Real forward copy (not memmove) of `size` bytes; returns the destination. Also serves `sce_paf_private_memcpy`. |
| `AllocMemoryBlock(name: u32, type: u32, size: u32, paramsAddr: u32): SceUID` | User-level block allocate (type 0 low, 1 high); validates the params struct, type, size, and name. |
| `GetMemoryBlockPtr(uid: u32, addr: u32): u32` | Writes the block base to `addr`; always returns 0 even for an unknown uid (matches PPSSPP). |
| `FreeMemoryBlock(uid: u32): u32` | Frees a user-level block, or returns `UNKNOWN_UID` if it does not exist. |

## Cache and version calls

There is no emulated cache, so the cache calls are effectively no-ops (some still validate their size argument).

| Signature | What it does |
| --- | --- |
| `sceKernelDcacheWritebackRange(addr: u32, size: int): int` | Returns an error if `size < 0`, otherwise 0; no actual writeback. |
| `sceKernelDcacheWritebackInvalidateRange(addr: u32, size: int): int` | Same size check, otherwise a no-op. |
| `sceKernelDcacheWritebackAll(): int` | No-op, returns 0. |
| `sceKernelDcacheWritebackInvalidateAll(): int` | No-op, returns 0. |
| `sceKernelIcacheInvalidateAll(): u32` | No-op, returns 0. |
| `sceKernelIcacheInvalidateRange(addr: u32, size: int): int` | No-op stub. |
| `sceKernelDevkitVersion(): u32` | Reports firmware `6.60` (`0x06060010`). |
| `sceKernelSetCompiledSdkVersion(sdkVersion: int): int` | Records the SDK version the game was built with. The versioned variants `sceKernelSetCompiledSdkVersion350_360`, `370`, `500_505`, and `603_605` behave the same (record and return 0); `380_390` is not wired up because its NID is missing from `nids.ts`. |
| `sceKernelGetCompiledSdkVersion(): int` | Returns the SDK version last recorded. |
| `sceKernelSetCompilerVersion(version: int): int` | Records nothing meaningful; logs and returns 0. |

## Stub summary

Five message-pipe calls are no-op stubs (`sceKernelDeleteMsgPipe`, `sceKernelSendMsgPipe`, `sceKernelReceiveMsgPipe`, `sceKernelTrySendMsgPipe`, `sceKernelTryReceiveMsgPipe`), and `sceKernelIcacheInvalidateRange` is a stub. `sceKernelCreateMsgPipe` returns an id but stores no pipe. Everything else listed above is a real handler.
