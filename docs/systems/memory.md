# Memory

The memory subsystem (`src/memory/`) owns the PSP address space and the allocator that hands out user memory.

| File | Contents |
| --- | --- |
| `memory-bus.ts` | `MemoryBus`, routes reads/writes to RAM, VRAM, or scratchpad |
| `memory-map.ts` | Region constants and `toPhysical()` |
| `block-allocator.ts` | `BlockAllocator`, a port of PPSSPP's allocator |

## The address space

| Region | Address | Size |
| --- | --- | --- |
| Scratchpad (on-chip SRAM) | `0x00010000` | 16 KB |
| VRAM | `0x04000000` | 2 MB |
| Main RAM (user + kernel) | `0x08000000` | 32 or 64 MB |
| HW I/O registers | `0x1C000000` | stubbed (reads 0, drops writes) |
| Kernel ROM / BIOS | `0x1FC00000` | not implemented (HLE) |

`toPhysical(vaddr)` masks off the kseg0/kseg1 bits (`vaddr & 0x1FFFFFFF`) and the bus dispatches to the matching region. The CPU instruction fetch has a fast path (`fetchRamU32`) that skips the region dispatch.

### MemoryBus

`readU8(vaddr: number): number` / `readU16(vaddr: number): number` / `readU32(vaddr: number): number`

Read 1, 2, or 4 bytes at a virtual address, routed to the matching region.

`writeU8(vaddr: number, value: number): void` / `writeU16(vaddr: number, value: number): void` / `writeU32(vaddr: number, value: number): void`

Write 1, 2, or 4 bytes at a virtual address.

`readBytes(vaddr: number, byteCount: number): Uint8Array`

Copy a range out of memory into a fresh array.

`writeBytes(vaddr: number, data: Uint8Array): void`

Copy a byte array into memory starting at a virtual address.

`fetchRamU32(phys: number): number`

Fast 32-bit read used by the CPU instruction fetch. Takes a physical RAM offset and skips the region dispatch.

`loadRam(bytes: Uint8Array): void` / `loadVram(bytes: Uint8Array): void` / `loadScratchpad(bytes: Uint8Array): void`

Bulk-replace a whole region (used to restore a save state). The byte length must match the region size.

`watchWriteAddr: number` and `onWatchWrite: ((vaddr: number, value: number) => void) | null`

A debug hook: set `watchWriteAddr` to a physical address and `onWatchWrite` to a callback to log writes to that address. The check only runs on `writeU32` (the 8- and 16-bit writers do not check it), and it is effectively free while `watchWriteAddr` is 0.

## The PSP memory model

Main RAM is **32 MB by default** (user space ends at `0x0A000000`). The full 64 MB is only available if `PARAM.SFO`'s `MEMSIZE == 1`, or the game is on the HD-remaster list.

The size is detected at boot rather than hardcoded. Getting it wrong shifts every game's own sub-allocations and corrupts them.

The heap base is the module end, including the `~PSP`-header bss. The root (`module_start`) thread stack (`0x4000` bytes, 16 KB) is allocated from the top of the user pool with the tag `stack/module_start` and is freed when `module_start` returns, through the thread-return cleanup that calls `userMemory.free`.

## BlockAllocator

`BlockAllocator` is a port of PPSSPP's `Core/Util/BlockAllocator.cpp`: a doubly-linked list of free/taken blocks that merges adjacent free blocks on release. The kernel uses one instance, `HLEKernel.userMemory` (grain 256), and **everything** allocates from it: thread stacks, partition memory (`sceKernelAllocPartitionMemory`), and heaps. Its range follows the memory size: `[0x08800000, 0x0A000000)` by default (32 MB), `[0x08800000, 0x0C000000)` for 64 MB games.

### API

`init(rangeStart: number, rangeSize: number): void`

Initialize the allocator over a byte range.

`alloc(size: number, fromTop = false, tag = ""): number`

Allocate `size` bytes. Returns the start address, or `-1` if it does not fit. `fromTop` allocates from the high end; `tag` labels the block for debugging.

`allocAligned(size: number, sizeGrain: number, grain: number, fromTop = false, tag = ""): number`

Like `alloc`, but rounds the size up to `sizeGrain` and aligns the address to `grain`.

`allocAt(position: number, size: number, tag = ""): number`

Allocate at a specific address. Returns `position`, or `-1` if that range is not free.

`free(position: number): boolean` / `freeExact(position: number): boolean`

Free the taken block that contains `position`, merging it with adjacent free blocks. Returns `false` if no taken block contains that address. `freeExact` is stricter: it only frees when `position` is exactly the block's start.

`getTotalFreeBytes(): number` / `getLargestFreeBlockSize(): number` / `isBlockFree(position: number): boolean`

Query free space and block state.

`serialize(): BlockAllocatorState` / `deserialize(state: BlockAllocatorState): void`

Save and restore the block list for save states. `BlockAllocatorState` is `{ rangeSize: number; blocks: Array<{ start: number; size: number; taken: boolean; tag: string }> }`.

## Gotchas

- The HW I/O region (~60 MB) has no backing buffer: reads return 0, writes are dropped.
- The watch-write hook is checked on every `writeU32` (not on 8- or 16-bit writes) but is effectively free when `watchWriteAddr` is 0.
- Because the allocator merges on free, a later `allocAligned` can return a slightly different address (grain-aligned).
- Stack fill (`0xFF`) happens in `sceKernelStartThread`, not at create time, matching PPSSPP's `FillStack` timing.
