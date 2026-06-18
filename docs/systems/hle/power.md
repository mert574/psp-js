# Power & UMD (`hle-power.ts`)

Implements `scePower`, `sceUmd`, and the volatile-memory lock from `sceSuspendForUser`. At boot the clock state is 222 MHz CPU / 111 MHz bus / 222 MHz PLL, the battery reads as full and on AC power, and the disc drive reports a present, ready medium.

## Clock frequency

| Signature | What it does |
| --- | --- |
| `scePowerSetClockFrequency(pllfreq: u32, cpufreq: u32, busfreq: u32): u32` | Set the PLL, CPU, and bus frequencies (MHz). We validate the ranges, store the values, and push the new CPU Hz into [core timing](/systems/timing). Returns 0. |
| `scePowerSetClockFrequency350(pllfreq: u32, cpufreq: u32, busfreq: u32): u32` | Alias NID for `scePowerSetClockFrequency` (PPSSPP scePower.cpp:602). Same behavior. |
| `scePowerSetClockFrequencyAlt(pllfreq: u32, cpufreq: u32, busfreq: u32): u32` | Another alias NID mapped to the same set-clock code. Same behavior. |
| `scePowerSetClockFrequencyAlt2(pllfreq: u32, cpufreq: u32, busfreq: u32): u32` | Alias NID `0x469989ad` (PPSSPP scePower.cpp:603), again the same set-clock code. |
| `scePowerGetCpuClockFrequency(): u32` | Return the current CPU frequency in MHz. |
| `scePowerGetCpuClockFrequencyInt(): u32` | Same value as `scePowerGetCpuClockFrequency`; the integer-named variant shares the implementation. |
| `scePowerGetBusClockFrequency(): u32` | Return the current bus frequency in MHz. |
| `scePowerGetBusClockFrequencyInt(): u32` | Same value as `scePowerGetBusClockFrequency`. |
| `scePowerGetPllClockFrequencyInt(): u32` | Return the PLL frequency in MHz. The requested MHz is snapped up to the PLL's fixed steps (about 190, 222, 266, 333) before being reported (PPSSPP scePower.cpp:520). |

## Battery and callbacks

| Signature | What it does |
| --- | --- |
| `scePowerGetBatteryLifePercent(): int` | Always returns 100 (full battery). |
| `scePowerIsBatteryExist(): int` | Always returns 1; a battery is always present here. |
| `scePowerIsBatteryCharging(): int` | Always returns 0; not charging because we report AC power. |
| `scePowerIsLowBattery(): int` | Always returns 0; the battery never reads low. |
| `scePowerIsPowerOnline(): int` | Always returns 1; always on AC power. |
| `scePowerRegisterCallback(slot: int, cbId: int): int` | Register a power-state callback in one of 16 user slots (slot -1 auto-picks the first free one). On success it fires the callback once with an initial state of AC power + battery exists + battery full. Returns the slot used, or a power error code (invalid slot, taken slot, slots full, etc.). |
| `scePowerUnregisterCallback(slotId: int): int` | Clear the callback in `slotId`. Returns 0, or a power error if the slot is out of range or already empty. |

## Volatile memory

| Signature | What it does |
| --- | --- |
| `sceKernelVolatileMemLock(type: int, paddr: u32, psize: u32): int` | Blocking lock of the 4 MB volatile region at `0x08400000`, which is always available here so it always succeeds. Writes the region base and size to `paddr`/`psize` when non-zero. Returns 0. `scePowerVolatileMemLock` is the same handler under a different NID. |
| `sceKernelVolatileMemTryLock(type: int, paddr: u32, psize: u32): int` | Non-blocking lock. Same as the blocking version, except it returns `0x80000310` (VMEM in use) when the region is already locked. `scePowerVolatileMemTryLock` shares this handler. |
| `sceKernelVolatileMemUnlock(type: int): int` | Release the volatile-memory lock. Returns 0. `scePowerVolatileMemUnlock` shares this handler. |
| `sceKernelPowerLock(lockType: int): int` | Prevent auto-suspend. Returns 0 when `lockType` is 0, else `0x80000107`. (Modeled but the suspend timer is not driven here.) |
| `sceKernelPowerUnlock(lockType: int): int` | Release the suspend lock. Returns 0 when `lockType` is 0, else `0x80000107`. |
| `sceKernelPowerTick(flag: int): int` | Refresh the auto-suspend timer. No-op that returns 0 (matches PPSSPP). |

## UMD

| Signature | What it does |
| --- | --- |
| `sceUmdActivate(mode: u32, name: const char *): int` | Activate the drive. Validates `mode` is 1 or 2, then notifies the registered drive callback with PRESENT \| READY \| READABLE. Returns 0, or `0x80010016` on a bad mode. Games pump `sceKernelCheckCallback` waiting for this notification, so without it their loading state machines hang. |
| `sceUmdDeactivate(mode: u32, name: const char *): int` | Deactivate the drive. Validates `mode <= 18`, then notifies the callback with PRESENT \| READY. Returns 0, or `0x80010016` on a bad mode. |
| `sceUmdGetDriveStat(): u32` | Return the drive status, always PRESENT \| READY \| READABLE (`0x02 \| 0x10 \| 0x20`). |
| `sceUmdCheckMedium(): int` | Return 1; a disc is always present. |
| `sceUmdWaitDriveStat(stat: u32): int` | Wait until the drive matches `stat`. The condition is always met here, so it returns 0 immediately. |
| `sceUmdWaitDriveStatCB(stat: u32, timeout: u32): int` | Callback variant. Same as above, returns 0 immediately. |
| `sceUmdWaitDriveStatWithTimer(stat: u32, timeout: u32): int` | Timer variant. Sets the return value to 0 then yields to another thread (PPSSPP sceUmd.cpp:404 reschedules even when the stat is already met). Without yielding, a game that busy-polls this (God of War's loader does, ~372x/frame) never lets its worker threads run. |
| `sceUmdRegisterUMDCallBack(cbId: u32): u32` | Store the drive callback id so `sceUmdActivate`/`sceUmdDeactivate` can notify it. Returns 0. |

The remaining functions are no-op stubs: 40 `scePower*` (battery details, idle/suspend requests, backlight, float-clock getters, power-switch mode, etc.) and 8 `sceUmd*` (disc info, error stat, replace permit/prohibit, MS/USB/WLAN use, callback unregister).
