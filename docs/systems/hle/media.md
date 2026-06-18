# SAS, RTC, VTimer, registry (`hle-media.ts`)

A mixed module covering the audio synth (`sceSas`), the real-time clock (`sceRtc`), virtual timers (`sceKernelVTimer`), and the system registry (`sceReg`). It also holds a large set of stubs for codecs and libraries that are not implemented.

## sceSas (audio synth)

A real port of PPSSPP's `Core/HW/SasAudio.cpp`. There is one global SAS core (`SasInstance`), and voices are actually synthesized: VAG and PCM playback, per-voice volume/pitch, ADSR envelopes, key on/off, and pause all work. Reverb and the noise/triangle/pulse waveforms and ATRAC3 voices are not synthesized yet.

| Signature | What it does |
| --- | --- |
| `__sceSasInit(core: u32, grainSize: u32, maxVoices: u32, outputMode: u32, sampleRate: u32): u32` | Validates the core address (64-byte aligned, in RAM), voice count (1-32), grain size (0x40-0x800, 32-byte aligned), output mode (0 or 1), and sample rate (44100), matching the hardware error codes. On success it stores the grain size, sets the output mode, resets all voices, and returns 0. |
| `__sceSasCore(core: u32, outAddr: u32): u32` | Synthesizes one grain by mixing the active voices into `outAddr`, then blocks the thread for the grain's worth of audio time. Returns 0. |
| `__sceSasCoreWithMix(core: u32, inoutAddr: u32, leftVolume: int, rightVolume: int): u32` | Synthesize-and-mix variant: mixes the voices additively into the existing buffer at `inoutAddr` using the left/right volumes. Blocks for the grain like `__sceSasCore` and returns 0. |
| `__sceSasGetGrain(core: u32): u32` | Returns the current grain size. |
| `__sceSasSetGrain(core: u32, grain: int): u32` | Sets the grain size (falls back to 256 if 0). Returns 0. |
| `__sceSasGetEndFlag(core: u32): u32` | Returns the bitmask of voices that have finished playing (`sas.getEndFlag()`). |
| `__sceSasGetOutputmode(core: u32): u32` | Returns the stored output mode. |
| `__sceSasSetOutputmode(core: u32, mode: u32): u32` | Stores the output mode. Returns 0. |
| `__sceSasSetVoice(core: u32, voiceNum: int, vagAddr: u32, size: int, loop: int): u32` | Sets a VAG voice (address, size, loop). Returns `0x80260002` for a bad voice number, else 0. |
| `__sceSasSetVoicePCM(core: u32, voiceNum: int, pcmAddr: u32, size: int, loopPos: int): u32` | Sets a raw PCM voice and starts it playing. Validates size (1-0x10000) and loop position, returning the matching error codes, else 0. |
| `__sceSasSetPitch(core: u32, voiceNum: int, pitch: int): u32` | Sets a voice's pitch. Bad voice returns `0x80260002`, else 0. |
| `__sceSasSetVolume(core: u32, voiceNum: int, leftVol: int, rightVol: int, effectLeft: int, effectRight: int): u32` | Sets the voice's dry and effect (wet) left/right volumes. Bad voice returns `0x80260002`, else 0. |
| `__sceSasSetSimpleADSR(core: u32, voiceNum: int, ADSREnv1: int, ADSREnv2: int): u32` | Sets the envelope from the two packed ADSR words. Bad voice returns `0x80260002`, else 0. |
| `__sceSasSetADSR(core: u32, voiceNum: int, flag: int, attackRate: int, decayRate: int, sustainRate: int, releaseRate: int): u32` | Sets the four ADSR rates. Bad voice returns `0x80260002`, else 0. |
| `__sceSasSetADSRmode(core: u32, voiceNum: int, flag: int, attackType: int, decayType: int, sustainType: int, releaseType: int): u32` | Sets the ADSR curve modes. Bad voice returns `0x80260002`, else 0. |
| `__sceSasSetSL(core: u32, voiceNum: int, sustainLevel: int): u32` | Sets the envelope sustain level. Bad voice returns `0x80260002`, else 0. |
| `__sceSasGetEnvelopeHeight(core: u32, voiceNum: int): u32` | Returns the voice's current envelope height. Bad voice returns `0x80260002`. |
| `__sceSasSetKeyOn(core: u32, voiceNum: int): u32` | Key-on (start the envelope) for the voice. Bad voice returns `0x80260002`, else 0. |
| `__sceSasSetKeyOff(core: u32, voiceNum: int): u32` | Key-off (release the envelope) for the voice. Bad voice returns `0x80260002`, else 0. |
| `__sceSasSetPause(core: u32, voiceBitmask: u32, pause: int): u32` | Sets the paused flag on every voice in the bitmask. Returns 0. |
| `__sceSasGetPauseFlag(core: u32): u32` | Returns the bitmask of paused voices. |
| `__sceSasRevType(core: u32, type: int): u32` | Reverb type setter. Accepted but not synthesized, returns 0. |
| `__sceSasRevParam(core: u32, delay: int, feedback: int): u32` | Reverb delay/feedback setter. Accepted but not synthesized, returns 0. |
| `__sceSasRevEVOL(core: u32, lv: u32, rv: u32): u32` | Reverb effect-volume setter. Accepted but not synthesized, returns 0. |
| `__sceSasRevVON(core: u32, dry: int, wet: int): u32` | Reverb voice-on setter. Accepted but not synthesized, returns 0. |

Not synthesized, registered as no-op stubs: `__sceSasSetTrianglarWave`, `__sceSasSetSteepWave`, `__sceSasSetNoise`, `__sceSasSetVoiceATRAC3`, `__sceSasConcatenateATRAC3`, `__sceSasUnsetATRAC3`, `__sceSasGetAllEnvelopeHeights`.

## sceRtc (real-time clock)

| Signature | What it does |
| --- | --- |
| `sceRtcGetCurrentTick(tickPtr: u32): u32` | Writes the emulated microsecond count (from CoreTiming) as a u64 tick at `tickPtr`. Returns 0. |
| `sceRtcGetTickResolution(): u32` | Returns 1000000 (ticks are microseconds). |
| `sceRtcGetCurrentClock(pspTimePtr: u32, tz: int): int` | Writes a 16-byte `ScePspDateTime` for the host wall-clock time shifted by `tz` minutes, with the microsecond field taken from emulated time. Returns 0. |
| `sceRtcGetCurrentClockLocalTime(pspTimePtr: u32): int` | Writes a 16-byte `ScePspDateTime` for host local time, microsecond from emulated time. Returns 0. |
| `sceRtcCompareTick(tick1Ptr: u32, tick2Ptr: u32): int` | Reads two u64 ticks and returns -1, 0, or 1 depending on which is larger. |

The other sceRtc functions (tick math, formatting, conversions, alarms, leap-year/day helpers) are no-op stubs.

## sceKernelVTimer

Software virtual timers backed by CoreTiming events. Each timer tracks its name, active flag, base/current time in microseconds, schedule, and an optional guest handler. When a handler fires it runs through the mini-CPU-run trampoline pattern, the same way GE callbacks do.

| Signature | What it does |
| --- | --- |
| `sceKernelCreateVTimer(name: const char*, optParamAddr: u32): SceUID` | Rejects a null name pointer, stores the name (max 31 chars), ignores `optParamAddr`, and returns the new timer id. |
| `sceKernelDeleteVTimer(uid: SceUID): u32` | Deletes the timer. Returns `UNKNOWN_VTID` if the id is not known, else 0. |
| `sceKernelStartVTimer(uid: SceUID): u32` | Sets the timer active and records its base time, scheduling the handler if one is set. Returns 1 if it was already running, 0 on a fresh start. |
| `sceKernelStopVTimer(uid: SceUID): u32` | Adds the run so far into `current` and clears the active flag. Returns 0 if it was already stopped, else 1. |
| `sceKernelGetVTimerBase(uid: SceUID, baseClockAddr: u32): u32` | Writes the timer's base time as a u64 to the pointer. Returns 0. |
| `sceKernelGetVTimerBaseWide(uid: SceUID): u64` | Returns the base time directly in `v0:v1`, or all-ones (-1) for a bad id. |
| `sceKernelGetVTimerTime(uid: SceUID, timeClockAddr: u32): u32` | Writes the live current time as a u64 to the pointer. Returns 0. |
| `sceKernelGetVTimerTimeWide(uid: SceUID): u64` | Returns the live current time in `v0:v1`, or all-ones (-1) for a bad id. |
| `sceKernelSetVTimerTime(uid: SceUID, timeClockAddr: u32): u32` | Reads the new time, writes the old time back to the pointer, adjusts `current` so the next read returns the new value, and reschedules. Returns 0. |
| `sceKernelSetVTimerTimeWide(uid: SceUID, timeClock: u64): u64` | Wide variant: takes the new time in `a2:a3`, returns the previous time in `v0:v1`. |
| `sceKernelSetVTimerHandler(uid: SceUID, scheduleAddr: u32, handlerFuncAddr: u32, commonAddr: u32): u32` | Reads a u64 schedule from `scheduleAddr`, stores the handler and its user argument, and (re)schedules the CoreTiming event. Returns 0. |
| `sceKernelSetVTimerHandlerWide(uid: SceUID, schedule: u64, handlerFuncAddr: u32, commonAddr: u32): u32` | Wide variant: schedule arrives in `a2:a3`, handler in `$t0`, user argument in `$t1`. Returns 0. |
| `sceKernelCancelVTimerHandler(uid: SceUID): u32` | Clears the timer's handler. Returns 0. |
| `sceKernelReferVTimerStatus(uid: SceUID, statusAddr: u32): u32` | Builds the 72-byte `NativeVTimer` (name, active flag, base, live current, schedule, handler and common addresses) and copies `min(caller_size, 72)` bytes into the buffer. Returns 0. |
| `sceKernelUSec2SysClock(usec: u32, clockPtr: u32): int` | Writes `usec` as the low word of a u64 system clock (SysClock counts microseconds), high word 0. Returns 0. |
| `sceKernelUSec2SysClockWide(usec: u32): u64` | Returns a u64 in `v0:v1`. Our handler returns the host wall-clock microseconds rather than converting the `usec` argument, so treat this as a partial implementation. |
| `sceKernelSysClock2USecWide(lowClock: u32, highClock: u32, lowPtr: u32, highPtr: u32): int` | Splits the u64 clock into seconds (`lowPtr`) and remaining microseconds (`highPtr`); if only the second pointer is given it gets the low 32 bits. Returns 0. |

## sceReg (registry)

Reads the PSP system registry (language, button-assign, network settings, and so on) from an in-memory tree in `psp-registry.ts`. Only one registry exists, so its handle is always 0.

| Signature | What it does |
| --- | --- |
| `sceRegOpenRegistry(regParamAddr: u32, mode: int, regHandleAddr: u32): int` | Writes handle 0 to `regHandleAddr`. Returns 0. |
| `sceRegCloseRegistry(regHandle: int): int` | Clears the open-category map. Returns 0. |
| `sceRegOpenCategory(regHandle: int, name: const char*, mode: int, regHandleAddr: u32): int` | Looks the category path up in the registry tree. On a match it allocates a category handle and writes it out; if not found it writes -1 and returns `CATEGORY_NOT_FOUND`. |
| `sceRegCloseCategory(regHandle: int): int` | Drops the category handle. Returns 0. |
| `sceRegGetKeysNum(catHandle: int, numAddr: u32): int` | Writes the number of keys in the open category to `numAddr` (0 if the handle is unknown). Returns 0. |
| `sceRegGetKeys(catHandle: int, bufAddr: u32, num: int): int` | Writes up to `num` key names into `bufAddr` as 27-byte null-terminated entries. Returns 0. |
| `sceRegGetKeyInfo(catHandle: int, name: const char*, outKeyHandleAddr: u32, outTypeAddr: u32, outSizeAddr: u32): int` | Finds the key by name (case-insensitive) and writes its index as the key handle, its type code (dir=1, int=2, str=3, bin=4), and its size. The 5th argument (`outSizeAddr`) is read from the stack at `sp+16`. Returns 0 on a hit, -1 if not found. |
| `sceRegGetKeyValue(catHandle: int, keyHandle: int, bufAddr: u32, size: u32): int` | Writes the value for the key index returned by `sceRegGetKeyInfo`: a u32 for int keys, or a null-terminated string (clamped to `size`) for str/bin keys. Returns 0. |

The registry write/create/flush/remove and by-name lookup functions are no-op stubs.

## Stubs

This module also registers a large set of no-op stubs for libraries it does not implement: the PSMF/sceMpeg NIDs not handled by `hle-psmf-player.ts`, deflate/gzip/zlib (`sceDeflate`, `sceGzip`, `sceZlib`), G729 voice codec (`sceG729`), JPEG/MJPEG (`sceJpeg`), the character-conversion library (`sceCcc`), and the 3D audio bridge (`sceP3da`). Each stub returns 0 (a few return 1) and counts its calls in the debug panel.
