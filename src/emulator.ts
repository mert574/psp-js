import { MemoryBus } from "./memory/memory-bus.js";
import { AllegrexCPU } from "./cpu/cpu.js";
import { HLEKernel } from "./kernel/hle-kernel.js";
import { loadElf } from "./loader/elf.js";
import { isPbp, parsePbp } from "./loader/pbp.js";
import { pspDecryptPRX } from "./loader/prx-decrypter.js";
import { Logger } from "./utils/logger.js";

const log = Logger.get("EMU");
const hleLog = Logger.get("HLE");

const MAGIC_ELF     = 0x7f454c46; // "\x7fELF" big-endian
const MAGIC_PSP_ENC = 0x7e505350; // "~PSP"   big-endian — Kirk-encrypted

/**
 * PSPEmulator
 *
 * Top-level façade that owns all subsystems and exposes a simple API
 * for loading a binary and running it.
 *
 * This is an HLE emulator — no BIOS ROM is required. System calls are
 * intercepted by the HLEKernel which implements PSP OS functions directly
 * in TypeScript, the same approach used by PPSSPP.
 *
 * Usage:
 *   const emu = new PSPEmulator();
 *   emu.loadElfBinary(elfBytes);
 *   emu.run(1_000_000); // run up to 1 million instructions
 */
export class PSPEmulator {
  readonly bus = new MemoryBus();
  readonly cpu = new AllegrexCPU(this.bus);
  readonly hle = new HLEKernel(this.bus);
  halted: boolean = false;

  constructor() {
    this.cpu.hle = this.hle;
  }

  async loadElfBinary(data: Uint8Array): Promise<void> {
    // Unwrap PBP container if needed (homebrew format)
    if (isPbp(data)) {
      const pbp = parsePbp(data);
      log.info(`PBP detected, extracting data.psp (${pbp.dataPsp.byteLength} bytes)`);
      data = pbp.dataPsp;
    }

    // Check for Kirk-encrypted executable (~PSP magic) and decrypt
    if (data.byteLength >= 4) {
      const view = new DataView(data.buffer, data.byteOffset, 4);
      const magic = view.getUint32(0, false);
      if (magic === MAGIC_PSP_ENC) {
        log.info(`Encrypted PRX detected (~PSP magic), attempting decryption...`);
        const decrypted = await pspDecryptPRX(data);
        if (!decrypted) {
          throw new Error(
            "Failed to decrypt PSP executable. The encryption tag may not be supported."
          );
        }
        log.info(`PRX decrypted successfully (${decrypted.byteLength} bytes)`);
        data = decrypted;
      }
    }

    const { entryPoint, moduleStartFunc, nidBySyscall } = loadElf(data, this.bus);
    // Use module_start_func from export table if available, otherwise ELF entry
    const startAddr = moduleStartFunc ?? entryPoint;
    this.cpu.regs.pc = startAddr;

    // Wire up HLE handlers: re-register each NID handler under the syscall
    // code that the import stub patcher assigned.
    this.hle.remapSyscalls(nidBySyscall);

    // Set up initial register state like the PSP kernel does before entry
    // SP: top of user memory (32 MB RAM ends at 0x0A000000, leave some space)
    this.cpu.regs.setGpr(29, 0x09FFF000); // $sp

    // Write a "module return" trampoline at a reserved address.
    // When module_start does `jr $ra`, it jumps here and executes a special
    // SYSCALL that the HLE kernel intercepts to handle post-module_start logic
    // (e.g. jumping to threads created during module_start).
    const TRAMPOLINE_ADDR = 0x09FFF800;
    const SYSCALL_MODULE_RETURN = 0xFFFFF; // reserved syscall code
    // Write: SYSCALL (module return) followed by a NOP.
    // The handler sets stepFaulted to stop execution immediately.
    const SYSCALL = 0x0000000c | (SYSCALL_MODULE_RETURN << 6);
    this.bus.writeU32(TRAMPOLINE_ADDR,     SYSCALL);
    this.bus.writeU32(TRAMPOLINE_ADDR + 4, 0); // NOP

    // Register the module-return handler
    this.hle.register(SYSCALL_MODULE_RETURN, (regs) => {
      hleLog.info("module_start returned");
      const nextEntry = this.hle.pendingThreadEntry;
      if (nextEntry != null) {
        hleLog.info(`Jumping to pending thread entry: 0x${nextEntry.toString(16)}`);
        regs.pc = nextEntry;
        this.hle.pendingThreadEntry = null;
        regs.setGpr(31, TRAMPOLINE_ADDR); // return here again when thread exits
      } else {
        hleLog.info("No pending threads — halting.");
        this.halted = true;
        this.cpu.stepFaulted = true; // stop the CPU run loop immediately
      }
    });

    this.cpu.regs.setGpr(31, TRAMPOLINE_ADDR); // $ra → trampoline

    log.info(`ELF loaded, entry=0x${entryPoint.toString(16)}, module_start=0x${startAddr.toString(16)}, SP=0x09FFF000, RA=0x${TRAMPOLINE_ADDR.toString(16)}`);
  }

  run(maxSteps?: number): void {
    this.cpu.run(maxSteps);
    if (this.cpu.stepFaulted) {
      this.halted = true;
    }
  }
}
