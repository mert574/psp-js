# Controller (`hle-ctrl.ts`)

Implements `sceCtrl`: reading the buttons and analog stick, and the latch that reports newly pressed and released buttons. The button and analog values come from the frontend's input snapshot (`kernel.inputSnapshot`). For the keyboard and gamepad mapping that feeds this, see [Controls](/user/controls).

## Reading the pad

| Signature | What it does |
| --- | --- |
| `int sceCtrlReadBufferPositive(u32 ctrlDataPtr, u32 nBufs)` | Writes one pad sample (vblank count, button bitmask, analog X/Y) to `ctrlDataPtr`, then blocks the calling thread until the next vblank sample. Analog X/Y are mapped from our snapshot's [-1, 1] to [0, 255]. |
| `int sceCtrlPeekBufferPositive(u32 ctrlDataPtr, u32 nBufs)` | Same write as the `Read` variant but returns right away (1 sample) without blocking. |
| `int sceCtrlReadBufferNegative(u32 ctrlDataPtr, u32 nBufs)` | Like `ReadBufferPositive` but stores the inverted button bitmask (`~buttons`) and a zero vblank count, then blocks until the next vblank sample. |
| `int sceCtrlPeekBufferNegative(u32 ctrlDataPtr, u32 nBufs)` | Same inverted write as the `Read` negative variant, returns right away (1 sample) without blocking. |

## Latch

The latch accumulates button edges across samples so a game can ask for "just pressed" and "just released" without diffing pad buffers itself. The four words (make, break, press, release) are updated once per vblank in `onCtrlVblankSample`, matching the PSP's sampling.

| Signature | What it does |
| --- | --- |
| `u32 sceCtrlPeekLatch(u32 latchDataPtr)` | Writes the current latch (make, break, press, release) to `latchDataPtr` and returns the number of samples taken since the last read, without resetting the latch. |
| `u32 sceCtrlReadLatch(u32 latchDataPtr)` | Writes the current latch to `latchDataPtr`, returns the sample count, then clears the latch and its sample counter back to zero. |

## Sampling and modes

| Signature | What it does |
| --- | --- |
| `u32 sceCtrlSetSamplingMode(u32 mode)` | Sets whether the analog stick is reported (`mode` 0 = digital, 1 = analog) and returns the previous mode. A `mode` greater than 1 returns `SCE_KERNEL_ERROR_INVALID_MODE` (`0x80000107`). |
| `int sceCtrlGetSamplingMode(u32 modePtr)` | Writes the current sampling mode to `modePtr` and returns 0. Our handler always reports analog mode (1). |
| `u32 sceCtrlSetSamplingCycle(u32 cycle)` | Stores the sampling cycle and returns the previous value. A `cycle` in (0, 5555) or above 20000 returns `SCE_KERNEL_ERROR_INVALID_VALUE` (`0x800001fe`). We keep the value but do not re-time sampling off it (sampling stays on vblank). |
| `int sceCtrlGetSamplingCycle(u32 cyclePtr)` | Writes the stored cycle to `cyclePtr` and returns 0. Our handler writes 0. |
| `int sceCtrlSetIdleCancelThreshold(int idleReset, int idleBack)` | Stores the two idle-cancel thresholds (analog movement that would reset the auto-suspend idle timer), each in [-1, 128]; out-of-range returns `SCE_KERNEL_ERROR_INVALID_VALUE`. We store the values faithfully but run no idle timer. |
| `int sceCtrlGetIdleCancelThreshold(u32 idleResetPtr, u32 idleBackPtr)` | Writes the stored thresholds back to `idleResetPtr` and `idleBackPtr` (default -1 = disabled) and returns 0. |

## Stubs

These are no-op stubs (no real PSP signature is published for them; PPSSPP also leaves them unimplemented), present so games that call them do not fault:

- `sceCtrlInit` returns 1.
- `sceCtrlSetRapidFire` returns 0.
- `sceCtrlClearRapidFire` returns 0.
- `sceCtrlSetSuspendingExtraSamples` returns 0.
- `sceCtrlGetSuspendingExtraSamples` returns 0.
