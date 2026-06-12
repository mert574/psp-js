import { MemoryBus } from "../memory/memory-bus.js";
import { Logger } from "../utils/logger.js";

declare global {
  interface Window {
    __elfDebug?: {
      modinfoAddr: number;
      pPaddr: number;
      pVaddr0: number;
      pOffset0: number;
      libent: number;
      libentend: number;
      libstub: number;
      libstubend: number;
      modName: string;
    };
  }
}

const log = Logger.get("ELF");

/**
 * Minimal ELF loader for 32-bit little-endian MIPS binaries (PSP executables).
 *
 * ELF header layout (32-bit):
 *   0x00  e_ident[16]   — magic + class/data/version/OS-ABI
 *   0x10  e_type   (2)  — object file type
 *   0x12  e_machine(2)  — architecture (0x08 = MIPS)
 *   0x14  e_version(4)
 *   0x18  e_entry  (4)  — entry point virtual address
 *   0x1C  e_phoff  (4)  — program header table offset
 *   0x20  e_shoff  (4)  — section header table offset
 *   0x24  e_flags  (4)
 *   0x28  e_ehsize (2)
 *   0x2A  e_phentsize(2)
 *   0x2C  e_phnum  (2)  — number of program header entries
 *   ...
 *
 * Program header entry (32-bit):
 *   0x00  p_type   (4)  — 1=PT_LOAD
 *   0x04  p_offset (4)  — offset in file
 *   0x08  p_vaddr  (4)  — virtual address to load at
 *   0x0C  p_paddr  (4)  — physical address (ignored)
 *   0x10  p_filesz (4)  — bytes in file
 *   0x14  p_memsz  (4)  — bytes in memory (remainder zero-filled)
 *   0x18  p_flags  (4)
 *   0x1C  p_align  (4)
 */

const ELF_MAGIC = 0x7f454c46; // "\x7fELF" (big-endian u32)
const PT_LOAD   = 1;
const ET_PRX    = 0xFFA0;     // PSP PRX relocatable module
const PRX_BASE  = 0x08804000; // Default load address for PSP executables

// Section header types
const SHT_PRXREL  = 0x700000A0; // PSP PRX relocation type (SHT_PSPREL in PPSSPP)
// MIPS relocation types
const R_MIPS_NONE    = 0;
const R_MIPS_16      = 1;
const R_MIPS_32      = 2;
const R_MIPS_26      = 4;
const R_MIPS_HI16    = 5;
const R_MIPS_LO16    = 6;

// MIPS instruction encodings
const MIPS_JR_RA   = 0x03e00008; // jr $ra
const MIPS_SYSCALL = 0x0000000c; // syscall (code in bits 25:6)

// Well-known export NIDs
const NID_MODULE_START = 0xD632ACDB;
const NID_MODULE_STOP  = 0xCEE8593C;
const NID_MODULE_START_THREAD_PARAM = 0x0F7C276C;

export interface LoadResult {
  entryPoint: number;
  /** module_start_func from export table (may differ from ELF entry) */
  moduleStartFunc: number | null;
  /** Global pointer value from module_info */
  gp: number;
  /** Map from syscall code → NID, for wiring up HLE handlers */
  nidBySyscall: Map<number, number>;
  /** Highest address written by any PT_LOAD segment (aligned to 256 bytes) */
  loadedEnd: number;
  /** Next available syscall code (for loading additional modules) */
  nextSyscallCode: number;
  /** Module name from module_info */
  moduleName: string;
}

/**
 * Compute total memory size needed by ELF PT_LOAD segments without loading.
 * Returns 0 if no loadable segments found.
 */
export function computeElfMemorySize(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const le = data[5] === 1;
  const phoff     = view.getUint32(0x1c, le);
  const phentsize = view.getUint16(0x2a, le);
  const phnum     = view.getUint16(0x2c, le);

  let lo = 0xFFFFFFFF;
  let hi = 0;
  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize;
    if (view.getUint32(ph, le) !== PT_LOAD) continue;
    const vaddr = view.getUint32(ph + 0x08, le);
    const memsz = view.getUint32(ph + 0x14, le);
    if (vaddr < lo) lo = vaddr;
    if (vaddr + memsz > hi) hi = vaddr + memsz;
  }
  return hi > lo ? ((hi - lo + 0xFF) & ~0xFF) : 0;
}

export function loadElf(data: Uint8Array, bus: MemoryBus, baseAddress?: number, startSyscallCode?: number): LoadResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Validate ELF magic
  const magic = view.getUint32(0, false); // big-endian read of first 4 bytes
  if (magic !== ELF_MAGIC) {
    throw new Error(`Not an ELF file (magic=0x${magic.toString(16)})`);
  }

  const littleEndian = data[5] === 1;
  const le = littleEndian;

  const eType      = view.getUint16(0x10, le);
  const entryPoint = view.getUint32(0x18, le);
  const phoff      = view.getUint32(0x1c, le);
  const shoff      = view.getUint32(0x20, le);
  const phentsize  = view.getUint16(0x2a, le);
  const phnum      = view.getUint16(0x2c, le);
  const shentsize  = view.getUint16(0x2e, le);
  const shnum      = view.getUint16(0x30, le);

  // PRX modules use relative addresses — relocate to a base address
  const isPrx = eType === ET_PRX;
  const baseAddr = isPrx ? (baseAddress ?? PRX_BASE) : 0;

  log.debug(`type=0x${eType.toString(16)} entry=0x${entryPoint.toString(16)} phoff=${phoff} phnum=${phnum} shoff=${shoff} shnum=${shnum} shentsize=${shentsize} isPrx=${isPrx}`);
  if (isPrx && shoff !== 0) {
    const shTypes = [];
    for (let s = 0; s < Math.min(shnum, 10); s++) {
      shTypes.push('0x' + view.getUint32(shoff + s * shentsize + 0x04, le).toString(16));
    }
    log.debug(`first section types: ${shTypes.join(', ')}${shnum > 10 ? '...' : ''}`);
  }

  // Collect segment load addresses for relocation
  const segmentBases: number[] = [];
  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize;
    const pVaddr = view.getUint32(ph + 0x08, le);
    segmentBases.push((pVaddr + baseAddr) >>> 0);
  }

  // Load PT_LOAD segments
  let loadedEnd = 0;
  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize;
    const pType   = view.getUint32(ph + 0x00, le);
    const pOffset = view.getUint32(ph + 0x04, le);
    const pVaddr  = view.getUint32(ph + 0x08, le);
    const pFilesz = view.getUint32(ph + 0x10, le);
    const pMemsz  = view.getUint32(ph + 0x14, le);

    if (pType !== PT_LOAD) continue;

    const loadAddr = (pVaddr + baseAddr) >>> 0;
    // Copy file bytes to RAM
    for (let b = 0; b < pFilesz; b++) {
      bus.writeU8(loadAddr + b, data[pOffset + b]!);
    }
    // Zero-fill the BSS region (memsz > filesz)
    for (let b = pFilesz; b < pMemsz; b++) {
      bus.writeU8(loadAddr + b, 0);
    }
    const segEnd = (loadAddr + pMemsz + 0xFF) & ~0xFF;
    if (segEnd > loadedEnd) loadedEnd = segEnd;
  }

  // Apply MIPS relocations for PRX modules
  if (isPrx && shoff !== 0 && shnum > 0) {
    applyRelocations(view, le, shoff, shentsize, shnum, baseAddr, segmentBases, bus);
  }

  // Parse module_info and patch import stubs.
  // PPSSPP does this for BOTH ET_PRX and ET_EXEC (decrypted retail EBOOTs are
  // often ET_EXEC) — sceKernelModule.cpp uses the same paddr formula for each.
  const nidBySyscall = new Map<number, number>();
  const pPaddrCheck = phnum > 0 ? view.getUint32(phoff + 0x0c, le) : 0;
  if (phnum > 0 && pPaddrCheck !== 0) {
    const ph0 = phoff;
    const pPaddr   = view.getUint32(ph0 + 0x0c, le);
    const pVaddr0  = view.getUint32(ph0 + 0x08, le);
    const pOffset0 = view.getUint32(ph0 + 0x04, le);
    // PPSSPP: modinfoaddr = seg0.vaddr + (seg0.paddr & 0x7FFFFFFF) - seg0.offset
    // pPaddr is a file offset; subtract segment file offset to get offset within segment
    const modinfoAddr = ((baseAddr + pVaddr0 + (pPaddr & 0x7FFFFFFF) - pOffset0) >>> 0);

    log.debug(`module_info: pPaddr=0x${pPaddr.toString(16)} modinfoAddr=0x${modinfoAddr.toString(16)}`);

    // Dump raw bytes at modinfoAddr for debugging
    const rawDump: string[] = [];
    for (let i = 0; i < 0x34; i += 4) {
      rawDump.push(`+0x${i.toString(16)}=0x${bus.readU32(modinfoAddr + i).toString(16)}`);
    }
    log.debug(`module_info raw: ${rawDump.join(' ')}`);

    // PspModuleInfo layout:
    //   0x00: moduleAttrs (u16)
    //   0x02: moduleVersion (u16)
    //   0x04: name (28 bytes)
    //   0x20: gp (u32)
    //   0x24: libent (u32)
    //   0x28: libentend (u32)
    //   0x2C: libstub (u32)
    //   0x30: libstubend (u32)
    // libent/libstub pointer fields are absolute PSP addresses: the R_MIPS_32
    // relocation pass has already added baseAddr to each pointer field in the
    // SceModuleInfo struct.  Reading them and adding baseAddr again would push
    // them out of the valid PSP RAM range (see PPSSPP sceKernelModule.cpp:1293+).
    const gpRaw      = bus.readU32(modinfoAddr + 0x20);
    const libent     = bus.readU32(modinfoAddr + 0x24);
    const libentend  = bus.readU32(modinfoAddr + 0x28);
    const libstub    = bus.readU32(modinfoAddr + 0x2C);
    const libstubend = bus.readU32(modinfoAddr + 0x30);

    // gp_value in SceModuleInfo is stored as a relative offset from the
    // segment base, not as a pointer with a relocation entry.  When it reads
    // as 0 it means "start of segment" — the absolute GP is therefore baseAddr.
    const gpValue = gpRaw !== 0 ? gpRaw : baseAddr;

    log.info(`[ELF] Module Info found at 0x${modinfoAddr.toString(16)}:`);
    log.info(`[ELF]   gp_raw=0x${gpRaw.toString(16)} → gp_abs=0x${gpValue.toString(16)}`);
    log.info(`[ELF]   libent=0x${libent.toString(16)} libstub=0x${libstub.toString(16)}`);

    // Read module name for logging
    let modName = "";
    for (let i = 0; i < 28; i++) {
      const b = bus.readU8(modinfoAddr + 0x04 + i);
      if (b === 0) break;
      modName += String.fromCharCode(b);
    }
    log.info(`[ELF] Module name: "${modName}"`);

    // Store debug info globally for inspection
    if (typeof window !== "undefined") {
      (window as any).__elfDebug = { modinfoAddr, pPaddr, pVaddr0, pOffset0, libent, libentend, libstub, libstubend, modName };
    }

    // Parse export table to find module_start_func
    let moduleStartFunc: number | null = null;
    if (libent !== 0 && libentend > libent) {
      moduleStartFunc = parseExportTable(bus, libent, libentend);
    }

    let nextCode = startSyscallCode ?? 1;
    if (libstub !== 0 && libstubend > libstub) {
      nextCode = patchImportStubs(bus, libstub, libstubend, nidBySyscall, nextCode);
    } else {
      log.warn(`No import stubs found (libstub=0x${libstub.toString(16)} libstubend=0x${libstubend.toString(16)})`);
    }

    const elfEntry = (entryPoint + baseAddr) >>> 0;
    if (moduleStartFunc != null && moduleStartFunc !== elfEntry) {
      log.debug(`module_start_func=0x${moduleStartFunc.toString(16)} differs from ELF entry=0x${elfEntry.toString(16)}`);
    }

    return { entryPoint: elfEntry, moduleStartFunc, gp: gpValue, nidBySyscall, loadedEnd, nextSyscallCode: nextCode, moduleName: modName };
  }

  return { entryPoint: (entryPoint + baseAddr) >>> 0, moduleStartFunc: null, gp: 0, nidBySyscall, loadedEnd, nextSyscallCode: startSyscallCode ?? 1, moduleName: "" };
}

/**
 * Parse PspLibEntEntry tables (module exports) and find module_start_func.
 *
 * PspLibEntEntry layout (from PPSSPP):
 *   0x00: name       (u32) — pointer to module name string (0 = own module)
 *   0x04: version    (u16)
 *   0x06: flags      (u16)
 *   0x08: size       (u8)  — entry size in u32 units
 *   0x09: vcount     (u8)  — variable export count
 *   0x0A: fcount     (u16) — function export count
 *   0x0C: resident   (u32) — pointer to NIDs array followed by addresses array
 *
 * Resident layout: [NID_func0..NID_funcN, NID_var0..NID_varM, ADDR_func0..ADDR_funcN, ADDR_var0..ADDR_varM]
 */
function parseExportTable(bus: MemoryBus, libent: number, libentend: number): number | null {
  let pos = libent;
  let moduleStartFunc: number | null = null;

  while (pos < libentend) {
    const sizeU32  = bus.readU8(pos + 0x08);
    if (sizeU32 === 0) break;

    const vcount   = bus.readU8(pos + 0x09);
    const fcount   = bus.readU16(pos + 0x0A);
    const resident = bus.readU32(pos + 0x0C);

    if (resident !== 0 && fcount > 0) {
      const exportPtr = resident + (fcount + vcount) * 4; // addresses start after NIDs
      for (let j = 0; j < fcount; j++) {
        const nid  = bus.readU32(resident + j * 4);
        const addr = bus.readU32(exportPtr + j * 4);
        if (nid === NID_MODULE_START) {
          moduleStartFunc = addr;
          log.info(`Found module_start export: 0x${addr.toString(16)}`);
        }
      }
    }

    pos += sizeU32 * 4;
  }

  return moduleStartFunc;
}

/**
 * Parse PspLibStubEntry tables and patch each import stub with JR $RA + SYSCALL.
 *
 * PspLibStubEntry layout (from PPSSPP):
 *   0x00: name       (u32) — pointer to library name string
 *   0x04: version    (u16)
 *   0x06: flags      (u16)
 *   0x08: size       (u8)  — struct size in u32 units (5 or 6)
 *   0x09: numVars    (u8)
 *   0x0A: numFuncs   (u16)
 *   0x0C: nidData    (u32) — pointer to NID array
 *   0x10: firstSymAddr (u32) — pointer to stub function array
 *   0x14: varData    (u32) — (optional, only if size >= 6)
 *
 * Each function stub is 8 bytes (2 MIPS instructions).
 * We patch with: JR $RA + SYSCALL <code>
 * The syscall code is a sequential index; nidBySyscall maps code→NID.
 */
function patchImportStubs(
  bus: MemoryBus,
  libstub: number, libstubend: number,
  nidBySyscall: Map<number, number>,
  startCode: number = 1,
): number {
  let pos = libstub;
  let nextSyscallCode = startCode;
  let totalPatched = 0;

  while (pos < libstubend) {
    const namePtr  = bus.readU32(pos + 0x00);
    const sizeU32  = bus.readU8(pos + 0x08);
    const numFuncs = bus.readU16(pos + 0x0A);
    const nidData  = bus.readU32(pos + 0x0C);
    const stubAddr = bus.readU32(pos + 0x10);

    if (sizeU32 === 0) break; // safety

    // Read library name
    let libName = "";
    if (namePtr !== 0) {
      for (let i = 0; i < 64; i++) {
        const b = bus.readU8(namePtr + i);
        if (b === 0) break;
        libName += String.fromCharCode(b);
      }
    }

    log.debug(`Import lib="${libName}" funcs=${numFuncs} nidData=0x${nidData.toString(16)} stubs=0x${stubAddr.toString(16)}`);

    // Patch each function stub
    for (let i = 0; i < numFuncs; i++) {
      const nid = bus.readU32(nidData + i * 4);
      const stub = stubAddr + i * 8;
      const code = nextSyscallCode++;

      // Write: JR $RA at stub, SYSCALL code at stub+4
      bus.writeU32(stub, MIPS_JR_RA);
      bus.writeU32(stub + 4, MIPS_SYSCALL | (code << 6));

      nidBySyscall.set(code, nid);
      totalPatched++;
    }

    pos += sizeU32 * 4; // size is in u32 units
  }

  log.info(`Patched ${totalPatched} import stubs (${nextSyscallCode - 1} syscall codes assigned)`);
  return nextSyscallCode;
}

/**
 * Process SHT_REL sections and apply MIPS relocations.
 * PSP PRX uses standard MIPS ELF relocations with one extension:
 * the top byte of r_info encodes the target segment index (OFS_BASE)
 * and the next byte encodes the address segment index (ADDR_BASE).
 */
function applyRelocations(
  view: DataView, le: boolean,
  shoff: number, shentsize: number, shnum: number,
  baseAddr: number, segmentBases: number[],
  bus: MemoryBus
): void {
  let relocCount = 0;
  let relSectionCount = 0;
  // Track HI16 values for pairing with LO16
  const hi16List: { addr: number; value: number }[] = [];

  for (let s = 0; s < shnum; s++) {
    const sh = shoff + s * shentsize;
    const shType = view.getUint32(sh + 0x04, le);
    // Only process PSP PRX relocations (SHT_PRXREL).
    // SHT_REL uses a different r_info format (symbol index, not segment index)
    // and is not supported for PSP PRX — PPSSPP skips them too.
    if (shType !== SHT_PRXREL) continue;
    relSectionCount++;

    const relOffset = view.getUint32(sh + 0x10, le);
    const relSize   = view.getUint32(sh + 0x14, le);
    const relEntsize = view.getUint32(sh + 0x24, le) || 8; // default 8 for 32-bit REL
    log.debug(`REL section #${relSectionCount}: offset=${relOffset} size=${relSize} entsize=${relEntsize} numRels=${relSize / relEntsize}`);
    const numRels = relSize / relEntsize;

    for (let r = 0; r < numRels; r++) {
      const rel = relOffset + r * relEntsize;
      const rOffset = view.getUint32(rel + 0x00, le);
      const rInfo   = view.getUint32(rel + 0x04, le);

      const rType    = rInfo & 0xFF;
      const ofsBase  = (rInfo >> 8) & 0xFF;   // segment index for the offset
      const addrBase = (rInfo >> 16) & 0xFF;   // segment index for the address

      if (rType === R_MIPS_NONE) continue;

      // Physical address where we apply the relocation
      const addr = ((segmentBases[ofsBase] ?? baseAddr) + rOffset) >>> 0;
      // Base address to add for the referenced segment
      const relocBase = segmentBases[addrBase] ?? baseAddr;

      // Read current 32-bit word at relocation target
      // Skip relocations pointing outside mapped memory (e.g. absent segments)
      let word: number;
      try {
        word = bus.readU32(addr);
      } catch {
        continue;
      }

      switch (rType) {
        case R_MIPS_32: {
          bus.writeU32(addr, (word + relocBase) >>> 0);
          break;
        }
        case R_MIPS_26: {
          // Low 26 bits are a word-address (shifted left 2 to get byte addr)
          const target = ((word & 0x03FFFFFF) << 2) + relocBase;
          bus.writeU32(addr, (word & 0xFC000000) | ((target >>> 2) & 0x03FFFFFF));
          break;
        }
        case R_MIPS_HI16: {
          hi16List.push({ addr, value: word });
          break;
        }
        case R_MIPS_LO16: {
          const lo = (word & 0xFFFF) << 16 >> 16; // sign-extend low 16 bits
          // Process all pending HI16 entries
          for (const hi16 of hi16List) {
            const hiOrig = (hi16.value & 0xFFFF) << 16;
            const combined = hiOrig + lo + relocBase;
            const newHi = ((combined >>> 16) + ((combined & 0x8000) ? 1 : 0)) & 0xFFFF;
            bus.writeU32(hi16.addr, (hi16.value & 0xFFFF0000) | newHi);
          }
          hi16List.length = 0;
          // Apply to the LO16 itself
          const newLo = (lo + relocBase) & 0xFFFF;
          bus.writeU32(addr, (word & 0xFFFF0000) | newLo);
          break;
        }
        case R_MIPS_16: {
          const val16 = (word & 0xFFFF) << 16 >> 16; // sign-extend
          const newVal = (val16 + relocBase) & 0xFFFF;
          bus.writeU32(addr, (word & 0xFFFF0000) | newVal);
          break;
        }
        default:
          // Unsupported relocation type — skip silently
          break;
      }
      relocCount++;
    }
  }

  log.info(`Found ${relSectionCount} REL sections, applied ${relocCount} relocations`);
}
