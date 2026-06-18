# Utility dialogs & heap (`hle-utility.ts`)

Implements `sceUtility` (the system dialogs and module loading), `sceHeap`, and a few small libraries (`sceImpose`, `sceHprm`).

The PSP types referenced below are: `u32` (unsigned 32-bit, also used for pointers), `int` (signed 32-bit). Dialog calls return `int` (0 on success, a negative-looking `0x80110xxx` error otherwise).

## System dialogs

The savedata, message, on-screen-keyboard, and netconf dialogs are state machines. The status follows the PSP convention: 0 NONE, 1 INITIALIZE, 2 RUNNING, 3 FINISHED, 4 SHUTDOWN. A game calls `InitStart`, polls `GetStatus` until it reads FINISHED (3), then calls `ShutdownStart`. `GetStatus` auto-advances INITIALIZE to RUNNING and SHUTDOWN to NONE. Returning an error from `InitStart` crashes games, so the handlers always return 0 from it.

### Savedata

| Signature | What it does |
| --- | --- |
| `sceUtilitySavedataInitStart(paramAddr: u32): int` | Starts a savedata operation. `paramAddr` points at a `SceUtilitySavedataParam` struct; the handler reads `mode`, the game/save/file names, and the data buffer, then dispatches on the mode: load, save, delete, list, and the size-query modes all run here through `SavedataStore`. Visible list modes (LISTLOAD / LISTSAVE) call out to the UI slot picker; everything else runs the IO straight away. Always returns 0 (the real result is stashed and written later). |
| `sceUtilitySavedataGetStatus(): int` | Returns the current savedata dialog status, then advances INITIALIZE to RUNNING and SHUTDOWN to NONE. FINISHED stays put until the game calls `ShutdownStart`. |
| `sceUtilitySavedataUpdate(animSpeed: int): int` | Drives the dialog forward one frame. Once the IO from `InitStart` is done, non-visible modes go straight to FINISHED; visible dialogs auto-dismiss after a few frames (we have no real dialog UI). Returns 0. |
| `sceUtilitySavedataShutdownStart(): int` | Writes the saved operation result into `common.result` of the param struct, sets status to SHUTDOWN, and notifies the UI overlay that the operation finished. Returns 0. |

### Message dialog

| Signature | What it does |
| --- | --- |
| `sceUtilityMsgDialogInitStart(paramAddr: u32): int` | Opens a message dialog. Reads the UTF-8 message string from offset 60 of the `pspMessageDialog` struct and logs it, then sets status to INITIALIZE. Returns 0. |
| `sceUtilityMsgDialogGetStatus(): int` | Returns the current message-dialog status and auto-advances INITIALIZE to RUNNING and SHUTDOWN to NONE. |
| `sceUtilityMsgDialogUpdate(animSpeed: int): int` | Confirms the dialog immediately since there is no UI: writes `common.result = 0`, sets `buttonPressed = YES/OK` on V2+ params (when `common.size >= 580`), and moves to FINISHED. Returns `0x80110001` (invalid status) if not currently RUNNING. |
| `sceUtilityMsgDialogShutdownStart(): int` | Sets the message-dialog status to SHUTDOWN. Returns 0. |

### On-screen keyboard (OSK)

| Signature | What it does |
| --- | --- |
| `sceUtilityOskInitStart(oskPtr: u32): int` | Opens the on-screen keyboard. Stores the param pointer and sets status to INITIALIZE. Returns 0. |
| `sceUtilityOskGetStatus(): int` | Returns the current OSK status and auto-advances INITIALIZE to RUNNING and SHUTDOWN to NONE. |
| `sceUtilityOskUpdate(animSpeed: int): int` | Since there is no keyboard UI, writes a fixed string ("PSPjs") into the field's `outtext` buffer, sets the field result to CHANGED and the params state to FINISHED, then moves the dialog to FINISHED. Returns `0x80110001` if not currently RUNNING. |
| `sceUtilityOskShutdownStart(): int` | Sets the OSK status to SHUTDOWN. Returns 0. |

### Net config

| Signature | What it does |
| --- | --- |
| `sceUtilityNetconfInitStart(paramsAddr: u32): int` | Starts the netconf dialog. There is no real network setup, so this jumps straight to RUNNING. Returns 0. |
| `sceUtilityNetconfGetStatus(): int` | Returns the current netconf status and walks it forward (RUNNING to FINISHED to SHUTDOWN to NONE) so the game's poll sees it complete on its own. |
| `sceUtilityNetconfShutdownStart(): int` | Moves netconf from FINISHED to SHUTDOWN. Returns 0. (`sceUtilityNetconfShutdownStartAlt` is registered to the same behavior for the alternate NID.) |

## System parameters and modules

| Signature | What it does |
| --- | --- |
| `sceUtilityGetSystemParamInt(id: u32, destAddr: u32): int` | Writes a fixed system setting for the given `id` to `*destAddr`: language English (1), date format YYYYMMDD, 12-hour time, UTC timezone, daylight savings off, X-as-confirm button. Returns 0. |
| `sceUtilityGetSystemParamString(id: u32, destAddr: u32, destSize: int): int` | Writes an empty string (a single null byte) to `*destAddr` for any string param (nickname and so on). Our handler ignores `id` and `destSize`. Returns 0. |
| `sceUtilityLoadModule(module: u32): u32` | All utility modules are HLE'd and never really loaded, so this just returns 0. |
| `sceUtilityLoadAvModule(module: u32): u32` | Same idea for the AV modules (0-7): returns 0, or `0x80110F01` (bad module id) when `module > 7`. |
| `sceUtilityUnloadModule(module: u32): u32` | Mirror of `sceUtilityLoadModule`. Modules are HLE'd and never loaded, so unload always returns 0. |

## sceHeap

A user-space heap that some games build on top of partition memory. The heap handle is its base address; allocations come from a simple address-sorted block list (split on alloc, merge adjacent free blocks on free), ported from PPSSPP's `sceHeap.cpp`.

| Signature | What it does |
| --- | --- |
| `sceHeapCreateHeap(name: const char*, heapSize: u32, attr: int, paramsPtr: u32): u32` | Allocates `heapSize` (rounded up to 4) from `userMemory` (from the top when the `HIGHMEM` attr bit is set), reserves a 128-byte header, and returns the base address as the heap handle. Returns 0 on failure. |
| `sceHeapDeleteHeap(heapAddr: u32): int` | Drops the heap object for `heapAddr`. Like PPSSPP, it does not free the underlying partition memory. Returns 0, or `0x80000100` (invalid id) if the heap is unknown. |
| `sceHeapAllocHeapMemory(heapAddr: u32, memSize: u32): u32` | Allocates `memSize` (plus 8 bytes of overhead, grain 4, from the top of the pool) inside the heap. Returns the address, `0xFFFFFFFF` when the pool is full, or `0x80000100` if the heap is unknown. |
| `sceHeapAllocHeapMemoryWithOption(heapAddr: u32, memSize: u32, paramsPtr: u32): u32` | Same as `sceHeapAllocHeapMemory` but reads an alignment grain from the options struct at `paramsPtr` (when its size field is at least 8). Returns the address, `0xFFFFFFFF` on failure, or 0 if the heap is unknown. |
| `sceHeapReallocHeapMemory(heapAddr: u32, memPtr: u32, memSize: int): int` | Unimplemented in PPSSPP too, so this returns 0. |
| `sceHeapReallocHeapMemoryWithOption(heapPtr: u32, memPtr: u32, memSize: int, paramsPtr: u32): int` | Also unimplemented in PPSSPP; returns 0. |
| `sceHeapFreeHeapMemory(heapAddr: u32, memAddr: u32): int` | Frees the block at `memAddr` and merges adjacent free space. A null `memAddr` is a no-op success. Returns 0, `0x80000103` (invalid pointer) if the block is not found, or `0x80000100` if the heap is unknown. |
| `sceHeapGetTotalFreeSize(heapAddr: u32): int` | Returns the total free bytes in the heap, minus 8 reserved for the next allocation's overhead. Returns `0x80000100` if the heap is unknown. |
| `sceHeapIsAllocatedHeapMemory(heapPtr: u32, memPtr: u32): int` | Returns 1 if `memPtr` is a live allocation in that heap, 0 otherwise (also 0 for an unknown heap, `0x80000103` for a null `memPtr`). |
| `sceHeapGetMallinfo(heapAddr: u32, infoPtr: u32): int` | Unimplemented in PPSSPP too; returns 0. |

## Small libraries

| Signature | What it does |
| --- | --- |
| `sceImposeGetLanguageMode(languagePtr: u32, btnPtr: u32): u32` | Writes the system language (English, 1) and the enter-button assignment (Cross, 1) to the out pointers. A no-op stub here would leave the game reading garbage and flip a language branch (for example GoW loads `DATA/<language>/GAME.BIN`), so these stay consistent with `sceUtilityGetSystemParamInt`. Returns 0. |
| `sceHprmPeekCurrentKey(keyAddress: u32): u32` | HPRM is the headset remote buttons. Writes 0 (no remote key pressed) to `*keyAddress` and returns 0. |

## Stubs (no-op)

The less-common functions are registered as no-op stubs (call counts tracked in the debug panel). These cover the dialogs we do not draw (auth, netplay, NP signin, PSN, gamedata install, gamesharing, HTML viewer, screenshot, store checkout, RSS reader/subscriber, savedata error, PS3 scan, DNAS, install, auto-connect), the message-dialog abort and the internal `__Utility*Dialog` helpers, the net-param queries (`sceUtilityCheckNetParam`, `sceUtilityGetNetParam`, `sceUtilityGetNetParamLatestID`), the system-param setters (`sceUtilitySetSystemParamInt` / `String`), net/USB module load and unload plus AV unload, the unnamed `sceUtility_*` NIDs, the rest of `sceImpose` and `sceHprm`, the DMAC copies (`sceDmacMemcpy` / `sceDmacTryMemcpy`), the `sceGameUpdate*` calls, and the `sceSircs*` infrared calls.
