# CPU Opcode Reference

This page lists the MIPS Allegrex instructions the interpreter implements, grouped by category. It is derived from the dispatch in `src/cpu/executor.ts`, the opcode constants in `src/cpu/opcodes.ts`, and the field decode in `src/cpu/decoder.ts`. Anything not listed here is treated as a NOP or throws "Unimplemented" at run time.

A few interpreter-wide notes:

- **Branch delay slots.** Every branch and jump takes effect after the following instruction runs. The interpreter schedules this with `inDelaySlot` / `delaySlotTarget` and never stops between an instruction and its delay slot.
- **Branch-likely** variants (the `*L` forms) skip the delay-slot instruction when the branch is not taken.
- **No overflow traps.** `ADD`/`ADDI`/`SUB` do not raise the MIPS overflow exception; they behave like their unsigned counterparts.
- **`SYSCALL`** sets `cpu.pendingSyscall` and `cpu.step()` dispatches it into the HLE kernel (see [Syscall Flow](/reference/syscalls)).

## Arithmetic and logic (register)

These are `SPECIAL` (op `0x00`) R-type instructions.

| Mnemonic | Funct | Description |
| --- | --- | --- |
| `ADD` | `0x20` | `rd = rs + rt` (overflow ignored) |
| `ADDU` | `0x21` | `rd = rs + rt` |
| `SUB` | `0x22` | `rd = rs - rt` (overflow ignored) |
| `SUBU` | `0x23` | `rd = rs - rt` |
| `AND` | `0x24` | `rd = rs & rt` |
| `OR` | `0x25` | `rd = rs \| rt` |
| `XOR` | `0x26` | `rd = rs ^ rt` |
| `NOR` | `0x27` | `rd = ~(rs \| rt)` |
| `SLT` | `0x2a` | `rd = (rs < rt) ? 1 : 0`, signed |
| `SLTU` | `0x2b` | `rd = (rs < rt) ? 1 : 0`, unsigned |
| `MAX` | `0x2c` | `rd = max(rs, rt)`, signed (Allegrex) |
| `MIN` | `0x2d` | `rd = min(rs, rt)`, signed (Allegrex) |
| `MOVZ` | `0x0a` | `if (rt == 0) rd = rs` |
| `MOVN` | `0x0b` | `if (rt != 0) rd = rs` |

## Arithmetic and logic (immediate)

I-type instructions with their own primary opcode.

| Mnemonic | Op | Description |
| --- | --- | --- |
| `ADDI` | `0x08` | `rt = rs + sign_ext(imm)` (overflow ignored) |
| `ADDIU` | `0x09` | `rt = rs + sign_ext(imm)` |
| `SLTI` | `0x0a` | `rt = (rs < sign_ext(imm)) ? 1 : 0`, signed |
| `SLTIU` | `0x0b` | `rt = (rs < imm) ? 1 : 0`, unsigned |
| `ANDI` | `0x0c` | `rt = rs & zero_ext(imm)` |
| `ORI` | `0x0d` | `rt = rs \| zero_ext(imm)` |
| `XORI` | `0x0e` | `rt = rs ^ zero_ext(imm)` |
| `LUI` | `0x0f` | `rt = imm << 16` |

## Shifts

`SPECIAL` R-type. The Allegrex reuses the `SRL`/`SRLV` encodings for rotates, selected by a bit in the `rs`/`shamt` field.

| Mnemonic | Funct | Description |
| --- | --- | --- |
| `SLL` | `0x00` | `rd = rt << shamt` |
| `SRL` | `0x02` | `rd = rt >>> shamt` (logical) |
| `ROTR` | `0x02` | rotate right by `shamt` (when `rs & 1`) |
| `SRA` | `0x03` | `rd = rt >> shamt` (arithmetic) |
| `SLLV` | `0x04` | `rd = rt << (rs & 31)` |
| `SRLV` | `0x06` | `rd = rt >>> (rs & 31)` |
| `ROTRV` | `0x06` | rotate right by `rs & 31` (when `shamt & 1`) |
| `SRAV` | `0x07` | `rd = rt >> (rs & 31)` (arithmetic) |

## Multiply, divide, and HI/LO

`SPECIAL` R-type. Results land in the `hi`/`lo` registers. The Allegrex keeps the multiply-accumulate forms here (not in `SPECIAL2`).

| Mnemonic | Funct | Description |
| --- | --- | --- |
| `MULT` | `0x18` | signed `hi:lo = rs * rt` |
| `MULTU` | `0x19` | unsigned `hi:lo = rs * rt` |
| `DIV` | `0x1a` | signed `lo = rs / rt`, `hi = rs % rt` |
| `DIVU` | `0x1b` | unsigned `lo = rs / rt`, `hi = rs % rt` |
| `MADD` | `0x1c` | signed `hi:lo += rs * rt` (Allegrex) |
| `MADDU` | `0x1d` | unsigned `hi:lo += rs * rt` (Allegrex) |
| `MSUB` | `0x2e` | signed `hi:lo -= rs * rt` (Allegrex) |
| `MSUBU` | `0x2f` | unsigned `hi:lo -= rs * rt` (Allegrex) |
| `MFHI` | `0x10` | `rd = hi` |
| `MTHI` | `0x11` | `hi = rs` |
| `MFLO` | `0x12` | `rd = lo` |
| `MTLO` | `0x13` | `lo = rs` |

## Bit manipulation

`CLZ`/`CLO` live in `SPECIAL` on the Allegrex; the rest are `SPECIAL3` (op `0x1f`), where `SEB`/`SEH`/`WSBH`/`WSBW`/`BITREV` are selected by the `shamt` field.

| Mnemonic | Description |
| --- | --- |
| `CLZ` | count leading zeros of `rs` into `rd` |
| `CLO` | count leading ones of `rs` into `rd` |
| `EXT` | extract a bit field from `rs` into `rt` |
| `INS` | insert a bit field from `rs` into `rt` |
| `SEB` | sign-extend the low byte |
| `SEH` | sign-extend the low halfword |
| `WSBH` | swap bytes within each halfword |
| `WSBW` | reverse all four bytes of the word |
| `BITREV` | reverse the 32 bits |
| `RDHWR` | read hardware register (only ULR/reg 29 is meaningful) |

## Loads and stores

| Mnemonic | Op | Description |
| --- | --- | --- |
| `LB` | `0x20` | load byte, sign-extended |
| `LH` | `0x21` | load halfword, sign-extended |
| `LW` | `0x23` | load word |
| `LBU` | `0x24` | load byte, zero-extended |
| `LHU` | `0x25` | load halfword, zero-extended |
| `SB` | `0x28` | store byte |
| `SH` | `0x29` | store halfword |
| `SW` | `0x2b` | store word |
| `LWL` | `0x22` | load word left (unaligned) |
| `LWR` | `0x26` | load word right (unaligned) |
| `SWL` | `0x2a` | store word left (unaligned) |
| `SWR` | `0x2e` | store word right (unaligned) |
| `LL` | `0x30` | load linked (behaves like `LW` here) |
| `SC` | `0x38` | store conditional (always succeeds, sets `rt = 1`) |
| `CACHE` | `0x2f` | cache control, NOP |

## Branches and jumps

| Mnemonic | Encoding | Condition |
| --- | --- | --- |
| `J` | op `0x02` | unconditional jump |
| `JAL` | op `0x03` | jump and link (`ra = pc + 8`) |
| `JR` | `SPECIAL 0x08` | jump to `rs` |
| `JALR` | `SPECIAL 0x09` | jump to `rs`, link into `rd` |
| `BEQ` | op `0x04` | `rs == rt` |
| `BNE` | op `0x05` | `rs != rt` |
| `BLEZ` | op `0x06` | `rs <= 0` |
| `BGTZ` | op `0x07` | `rs > 0` |
| `BEQL` | op `0x14` | `rs == rt` (likely) |
| `BNEL` | op `0x15` | `rs != rt` (likely) |
| `BLEZL` | op `0x16` | `rs <= 0` (likely) |
| `BGTZL` | op `0x17` | `rs > 0` (likely) |

### REGIMM (op `0x01`)

The branch condition is selected by the `rt` field. The `AL` forms link into `ra`.

| Mnemonic | rt | Condition |
| --- | --- | --- |
| `BLTZ` | `0x00` | `rs < 0` |
| `BGEZ` | `0x01` | `rs >= 0` |
| `BLTZL` | `0x02` | `rs < 0` (likely) |
| `BGEZL` | `0x03` | `rs >= 0` (likely) |
| `BLTZAL` | `0x10` | `rs < 0`, link |
| `BGEZAL` | `0x11` | `rs >= 0`, link |
| `BLTZALL` | `0x12` | `rs < 0`, link (likely) |
| `BGEZALL` | `0x13` | `rs >= 0`, link (likely) |

## FPU (COP1)

Single-precision only. Moves and the branch use the `rs` field as the sub-opcode; the computational ops use the `S` (single) format with the funct field, and `W` (word) format for integer conversion.

| Mnemonic | Description |
| --- | --- |
| `MFC1` | move FPR bits to GPR |
| `MTC1` | move GPR bits to FPR |
| `CFC1` | move from FPU control register (`FCR31`) |
| `CTC1` | move to FPU control register (`FCR31`) |
| `BC1` | branch on the FPU condition bit (true/false, with likely forms) |
| `ADD.S` | `fd = fs + ft` |
| `SUB.S` | `fd = fs - ft` |
| `MUL.S` | `fd = fs * ft` |
| `DIV.S` | `fd = fs / ft` |
| `SQRT.S` | `fd = sqrt(fs)` |
| `ABS.S` | `fd = abs(fs)` |
| `MOV.S` | `fd = fs` |
| `NEG.S` | `fd = -fs` |
| `ROUND.W.S` | convert to int, round to nearest even |
| `TRUNC.W.S` | convert to int, truncate |
| `CEIL.W.S` | convert to int, toward +inf |
| `FLOOR.W.S` | convert to int, toward -inf |
| `CVT.W.S` | convert float to int using the `FCR31` rounding mode |
| `CVT.S.W` | convert int to float |
| `C.cond.S` | compare `fs` and `ft`, set the FPU condition bit (funct `0x30` to `0x3f`) |
| `LWC1` | load word into FPR |
| `SWC1` | store word from FPR |

The arithmetic ops apply the `FCR31` rounding mode and flush-to-zero bit.

## System control (COP0)

Only the registers the HLE kernel needs are modeled (`Status` = 12, `Cause` = 13, `EPC` = 14).

| Mnemonic | Description |
| --- | --- |
| `MFC0` | move from a CP0 register (unhandled registers read 0) |
| `MTC0` | move to a CP0 register |
| `ERET` | return from exception (`pc = EPC`) |

## System and special

| Mnemonic | Encoding | Description |
| --- | --- | --- |
| `SYSCALL` | `SPECIAL 0x0c` | dispatch to the HLE kernel via the pending-syscall flag |
| `BREAK` | `SPECIAL 0x0d` | soft exception; an `onBreak` handler can claim it (used by the GE callback trampoline) |
| `SYNC` | `SPECIAL 0x0f` | memory barrier, NOP |
| `HALT` / `MFIC` / `MTIC` | `SPECIAL2` (op `0x1c`) | interrupt-controller ops, all NOP under HLE |

## VFPU

The VFPU is a 128-register vector unit. Operands are single (`S`), pair (`P`), triple (`T`), or quad (`Q`), encoded in the instruction. Most ALU ops honor the operand **prefixes** (`vpfxs`/`vpfxt`/`vpfxd`), which swizzle, negate, take absolute value, substitute constants, and saturate or mask the result. The prefixes are consumed by the next VFPU op.

### Load, store, and move

| Mnemonic | Description |
| --- | --- |
| `LV.S` / `SV.S` | load/store one VFPU scalar |
| `LV.Q` / `SV.Q` | load/store an aligned quad |
| `LVL.Q` / `LVR.Q` | unaligned quad load (left/right) |
| `SVL.Q` / `SVR.Q` | unaligned quad store (left/right) |
| `MFV` / `MTV` | move a VFPU register to/from a GPR (COP2) |
| `MFVC` / `MTVC` | move a VFPU control register to/from a GPR |

### Arithmetic

| Mnemonic | Description |
| --- | --- |
| `vadd` / `vsub` | element-wise add / subtract |
| `vdiv` | element-wise divide |
| `vmul` | element-wise multiply |
| `vscl` | scale a vector by a scalar |
| `vdot` | dot product into a scalar |
| `vhdp` | homogeneous dot product (last source lane forced to 1) |
| `vcrs` | cross product (triple) |
| `vdet` | 2D determinant |
| `vsbn` | scale by setting the exponent from an integer |
| `vfad` / `vavg` | horizontal sum / average |

### Compare and select

| Mnemonic | Description |
| --- | --- |
| `vcmp` | compare lanes against a condition, set the VFPU condition code |
| `vmin` / `vmax` | element-wise min / max |
| `vscmp` | sign of `s - t` per lane |
| `vsge` | `s >= t ? 1 : 0` per lane |
| `vslt` | `s < t ? 1 : 0` per lane |
| `vcmov` | conditional move on the condition code |

### Single-argument and transcendental

| Mnemonic | Description |
| --- | --- |
| `vmov` / `vabs` / `vneg` | copy / absolute value / negate |
| `vidt` | identity-row generator |
| `vzero` / `vone` | fill with 0 / 1 |
| `vsat0` / `vsat1` | saturate to `[0, 1]` / `[-1, 1]` |
| `vrcp` / `vnrcp` | reciprocal / negated reciprocal |
| `vrsq` | reciprocal square root |
| `vsqrt` | square root |
| `vsin` / `vcos` / `vnsin` | sine / cosine / negated sine (argument in quarter-turns) |
| `vasin` | arcsine |
| `vexp2` / `vlog2` / `vrexp2` | base-2 exponential / logarithm / reciprocal exponential |
| `vcst` | load a named VFPU constant |
| `vsgn` | sign of each lane |
| `vocp` / `vsocp` | one's complement (`1 - x`) / saturated one's complement pairs |

### Conversions

| Mnemonic | Description |
| --- | --- |
| `vf2in` / `vf2iz` / `vf2iu` / `vf2id` | float to int (round / toward zero / ceil / floor), with a scale |
| `vi2f` | int to float, with a scale |
| `vf2h` / `vh2f` | float to half / half to float |
| `vuc2i` / `vc2i` / `vus2i` / `vs2i` | unpack unsigned/signed char and short to int |
| `vi2uc` / `vi2c` / `vi2us` / `vi2s` | pack int down to unsigned/signed char and short |
| `vt4444` / `vt5551` / `vt5650` | pack to 16-bit color formats |

### Utility

| Mnemonic | Description |
| --- | --- |
| `vsrt1` / `vsrt2` / `vsrt3` / `vsrt4` | sorting-network min/max passes |
| `vbfy1` / `vbfy2` | butterfly add/subtract |

### Matrix

| Mnemonic | Description |
| --- | --- |
| `vmmul` | matrix multiply |
| `vtfm` / `vhtfm` | matrix-vector transform (homogeneous form forces the last coordinate to 1) |
| `vmscl` | scale a matrix by a scalar |
| `vmmov` | copy a matrix |
| `vmidt` | identity matrix |
| `vmzero` / `vmone` | matrix of 0 / 1 |
| `vcrsp` | 3D cross product |
| `vqmul` | quaternion multiply |
| `vrot` | rotation-row generator from an angle |

### Prefixes and immediates

| Mnemonic | Description |
| --- | --- |
| `vpfxs` / `vpfxt` / `vpfxd` | set the source/source/destination prefix for the next op |
| `viim.s` | load a 16-bit signed integer immediate into a scalar |
| `vfim.s` | load a half-float immediate into a scalar |

### VFPU branches

`bvf` / `bvt` / `bvfl` / `bvtl` branch on a selected bit of the VFPU condition code (false/true, with likely forms).

See [CPU (Allegrex)](/systems/cpu) for the fetch, decode, execute loop and the register file.
