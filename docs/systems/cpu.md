# CPU (Allegrex)

The PSP's CPU is the **Allegrex**, a MIPS32 core with a vector FPU (VFPU). The interpreter lives in `src/cpu/`.

| File | Contents |
| --- | --- |
| `cpu.ts` | `AllegrexCPU` (the fetch/decode/execute loop) and `SyscallException` |
| `registers.ts` | `AllegrexRegisters`, GPRs, hi/lo, FPU, VFPU, CP0 |
| `decoder.ts` | `decodeInto`, in-place instruction decode |
| `executor.ts` | `executeInstruction`, opcode dispatch |
| `disasm.ts` | MIPS disassembler (used by tools and the profiler) |
| `cpu-profiler.ts` | `CpuProfiler`, instruction-mix and hot-PC sampling |
| `opcodes.ts` | Opcode constants (cold paths only) |

## Register file

`AllegrexRegisters` stores registers in typed arrays for cache friendliness, not as object properties:

- `gpr: Uint32Array`, 32 general-purpose registers (`r0`-`r31`).
- `pc`, `hi`, `lo` (`number`): the program counter and the hi/lo multiply/divide result registers.
- `fpr: Uint32Array`, 32 FPU registers (raw bits).
- `vfpr: Float32Array`, 128 VFPU scalars, addressed as 8 × 4×4 matrices.
- `vfpuCtrl: Uint32Array`, 16 VFPU control registers (prefixes, etc.).

## The execution loop

`step()` runs one instruction: bounds-check the PC, fetch the `u32` (a fast RAM path bypasses region dispatch), decode in place, execute. `run(maxSteps)` loops `step()` until the budget is spent, a fault occurs, or `hle.idleBreak` is set (all threads waiting).

### Branch delay slots

MIPS executes the instruction *after* a branch/jump before the branch takes effect. The CPU tracks this with `inDelaySlot` and `delaySlotTarget`. The run loop never stops between an instruction and its delay slot, which is why save states and thread switches never split a delay pair.

### Syscalls

A `SYSCALL` instruction sets a `pendingSyscall` flag (cheaper than throwing for the ~2000 syscalls per frame). After the instruction executes, the CPU resolves any delay slot and calls `hle.dispatch(code, regs)`. Caller-saved registers are then clobbered to `0xDEADBEEF` (matching PPSSPP) unless a MipsCall (callback) is in flight. See [Syscall Flow & ABI](/reference/syscalls).

### Faults

A bad PC (outside RAM/scratchpad) or an execute fault sets `stepFaulted`; the run loop exits and the kernel kills the thread and reschedules.

## VFPU

The VFPU has 128 float32 registers arranged as 4×4 matrices, addressed `[matrix][row][col]` per the PSP ABI. Instructions can apply **prefixes** (`vpfxs`/`vpfxt`/`vpfxd`) that swizzle, negate, or constant-substitute operands; the prefix state is transient and cleared after the instruction that uses it.

## Profiling

`CpuProfiler` counts instruction classes and samples hot PCs. It is only invoked when `cpu.profiler` is set, so it adds zero cost on a normal run. From the browser console, `_dbgCpuProf.start()` / `.report()` drive it. The frame-level profiler (`_dbgPerf`) is separate so instruction counting doesn't skew frame timing.

::: tip Performance
The executor's dispatch switch uses literal hex cases, not opcode constants. V8 compiles literal cases into a jump table, while object-property cases are several times slower. See [Conventions](/reference/conventions#opcode-dispatch).
:::

## Gotchas

- FPU rounding: `FCR31` bits select nearest / toward-zero / +∞ / −∞. JS always rounds to nearest, so the executor rounds manually for the non-default modes.
- After a syscall, `$at`, `$a0`-`$a3`, `$t0`-`$t9` read back as `0xDEADBEEF` (intentional, matches PPSSPP) unless a callback is active.
