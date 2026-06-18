# Loader & Crypto

Getting a commercial game running means turning an encrypted, compressed container into MIPS code in RAM with its imports wired to HLE handlers. The loader (`src/loader/`) drives that, using the crypto primitives in `src/crypto/`.

## Loader

| File | Contents |
| --- | --- |
| `elf.ts` | `loadElf`, loads PT_LOAD segments, resolves relocations, patches syscall stubs |
| `pbp.ts` | `isPbp`, `parsePbp`, the PBP container format |
| `prx-decrypter.ts` | `pspDecryptPRX`, KIRK decrypt of `~PSP` modules |

### The boot pipeline

`PSPEmulator.loadElfBinary` (`src/emulator.ts`) runs the chain:

1. If the data is a **PBP**, `parsePbp` extracts the sub-files (`PARAM.SFO`, `ICON0.PNG`, `ICON1.PMF`, `PIC0.PNG`, `PIC1.PNG`, `SND0.AT3`, `data.psp`) into a `PbpContents`, and the `data.psp` is the module.
2. If the module starts with the `~PSP` magic (`0x7e505350`), it is KIRK-encrypted, `pspDecryptPRX` decrypts it.
3. The result may be gzip-compressed; the emulator decompresses it (tolerating the truncated/corrupt trailers common in PSP PRXes, via `DecompressionStream("deflate-raw")`).
4. `loadElf` loads the ELF: copies PT_LOAD segments, resolves MIPS relocations (HI16/LO16 pairs, R_MIPS_26, R_MIPS_32, …), and **patches import stubs**, each stub is rewritten to `JR $RA` + `SYSCALL code` with a freshly-assigned code, and a `nidBySyscall` map is returned.
5. The emulator calls `hle.remapSyscalls(nidBySyscall)` to wire those codes to handlers, sets `$gp` from the module info, and sets up the root thread.

PRXes are pre-decrypted at boot (`_preDecryptModules`) so `sceKernelLoadModule` is synchronous. Modules named in `HLE_PRX_NAMES` are **not** decrypted, their functions are HLE'd, so the loader fakes their NID handlers instead.

::: tip Module entry
Games run from the `module_start` export when present (preferred), falling back to the ELF entry point. The NID-to-syscall-code mapping is per-game (each game patches its own stubs), captured by the loader and applied via `remapSyscalls()`.
:::

## Crypto

`src/crypto/` provides the primitives behind PRX and savedata decryption:

| File | Provides |
| --- | --- |
| `kirk.ts` | The KIRK engine for PGD/savedata, a port of PPSSPP's `libkirk`. Implements CMD4, CMD7, CMD11, CMD14 and init (CMD5/CMD8 are fuse-based and intentionally left out, matching PPSSPP). The PRX-decrypt side (`kirkCMD1`) lives in `src/loader/kirk.ts` |
| `aes.ts` | AES-128 in CBC mode, plus CMAC |
| `sha1.ts` | SHA1 (used by KIRK for signature verification) |
| `amctrl.ts` | AMCTRL / PGD, decrypts NPDRM savedata blocks (`pgdOpen`, `pgdDecryptBlock`) |
| `kirk-keys.ts` | The hardcoded key vault |

- **EBOOT decryption** uses `pspDecryptPRX` → `kirkCMD1`.
- **Savedata decryption** (NPDRM/PGD files) goes through `pgdOpen` then `pgdDecryptBlock` per block (the block size comes from the PGD header at offset 0x48). In `hle-io.ts`, `sceIoIoctl` command `0x04100001` opens the PGD after the file is opened, and reads decrypt block by block.

::: warning Licensing
The KIRK port and key vault are derived from PPSSPP / libkirk, which are GPL. See the repository's licensing notes before redistributing.
:::

## Gotchas

- PRXes can be doubly wrapped: `~PSP` → gzip → an inner PRX that is itself `~PSP`. The pre-decrypt loop checks both magics each pass.
- Some PSP gzip streams are non-standard (truncated trailer, wrong CRC); the decompressor keeps whatever decoded successfully rather than failing hard.
- The decrypt key is chosen by the PRX tag at offset `0xD0`. `pspDecryptPRX` tries each decrypt type in turn (type0/1/2/5/6) and returns `null` if all of them fail (which includes SHA1 verification mismatch).
