# Display (`hle-display.ts`)

Implements `sceDisplay`: the display mode, the framebuffer pointer, and vblank synchronization.

## Mode and framebuffer

| Signature | What it does |
| --- | --- |
| `sceDisplaySetMode(displayMode: int, displayWidth: int, displayHeight: int): u32` | Validates the mode and stores it. Only LCD mode 0 at 480x272 is accepted; a wrong mode returns `0x80000107` and a wrong size returns `0x80000104`. PPSSPP waits for vblank on success, our handler returns immediately (most games do not depend on the wait). |
| `sceDisplaySetFrameBuf(topaddr: u32, linesize: int, pixelformat: int, sync: int): int` | Stores the address, stride, and pixel format of the framebuffer that is presented to the screen, and remembers the first two distinct buffer addresses seen. Always returns 0. |
| `sceDisplayGetFrameBuf(topaddrPtr: u32, linesizePtr: u32, pixelFormatPtr: u32, latchedMode: int): u32` | Writes the current framebuffer address, stride, and pixel format back through the three pointers (skipping any that are 0) and returns 0. |
| `sceDisplayGetMode(modeAddr: u32, widthAddr: u32, heightAddr: u32): u32` | Writes the stored display mode, width, and height back through the three pointers (skipping any that are 0) and returns 0. |
| `sceDisplayIsForeground(): u32` | Returns 1 when a mode has been set and the framebuffer address is non-zero, otherwise 0. |
| `sceDisplayGetBrightness(levelAddr: u32, otherAddr: u32): u32` | Writes the stored brightness level to `levelAddr` and 0 to `otherAddr` (skipping either if it is 0), then returns 0. |
| `sceDisplaySetBrightness(level: int, other: int): u32` | Stores the brightness level and returns 0. |
| `sceDisplaySetHoldMode(hMode: u32): u32` | No-op that stores the hold-mode value and returns 0. |
| `sceDisplaySetResumeMode(rMode: u32): u32` | No-op that stores the resume-mode value and returns 0. |
| `sceDisplayGetResumeMode(resumeModeAddr: u32): u32` | Writes the stored resume-mode value to `resumeModeAddr` (if non-zero) and returns 0. |

## Vblank

| Signature | What it does |
| --- | --- |
| `sceDisplayWaitVblankStart(): int` | Blocks the calling thread with the `VBLANK` wait type until the next vblank, which the [core timing](/systems/timing) scheduler raises each frame. |
| `sceDisplayWaitVblankStartCB(): int` | Same wait as `sceDisplayWaitVblankStart`, but also processes pending callbacks while waiting. |
| `sceDisplayWaitVblank(): int` | If already inside the vblank period, returns 1 and yields to other threads; otherwise blocks until the next vblank. |
| `sceDisplayWaitVblankCB(): int` | Same as `sceDisplayWaitVblank`, but processes pending callbacks if the thread actually blocks. |
| `sceDisplayWaitVblankStartMulti(vblanks: int): int` | Meant to wait for `vblanks` vblanks; rejects a non-positive count with `0x800001fe`. We simplify to a single vblank wait, which is enough for most games. |
| `sceDisplayWaitVblankStartMultiCB(vblanks: int): int` | Same simplified single-vblank wait as `sceDisplayWaitVblankStartMulti`, intended as the callback-processing variant. |
| `sceDisplayGetVcount(): int` | Returns the running vblank counter. |
| `sceDisplayGetCurrentHcount(): int` | Returns the horizontal scanline count into the current frame, computed as `1 + ticksIntoFrame / ticksPerHline` where `ticksPerHline = CPU_HZ / 60 / 286`. Returns 1 when core timing is not available. |
| `sceDisplayGetAccumulatedHcount(): int` | Returns `(hCountBase + currentHcount) & 0x7FFFFFFF`, the running total of scanlines since boot. |
| `sceDisplayAdjustAccumulatedHcount(value: int): int` | Shifts `hCountBase` by the difference between `value` and the current accumulated hcount; rejects a negative `value` with `0x800001fe`, otherwise returns 0. |
| `sceDisplayIsVblank(): u32` | Returns 1 when currently in the vblank period, 0 otherwise. |
| `sceDisplayIsVsync(): u32` | Returns 1 when the current tick falls inside the vsync window (about 0.5925ms to 0.7265ms into the frame), 0 otherwise. |
| `sceDisplayGetFramePerSec(): float` | Returns the PSP refresh rate `59.9400599` as a float in `$f0`. |

All handlers in this module are real; there are no stubs.
