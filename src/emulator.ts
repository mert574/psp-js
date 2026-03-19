import { MemoryBus } from "./memory/memory-bus.js";
import { AllegrexCPU } from "./cpu/cpu.js";
import { HLEKernel, ThreadState } from "./kernel/hle-kernel.js";
import { CoreTiming } from "./timing/core-timing.js";
import { loadElf } from "./loader/elf.js";
import { isPbp, parsePbp } from "./loader/pbp.js";
import { pspDecryptPRX } from "./loader/prx-decrypter.js";
import { createSavedataStore } from "./storage/savedata-store.js";
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
  readonly bus = MemoryBus.create();
  readonly cpu = new AllegrexCPU(this.bus);
  readonly hle = new HLEKernel(this.bus);
  readonly coreTiming = new CoreTiming();
  halted: boolean = false;

  private _vblankFired = false;
  private _vblankEventId = -1;
  private _leaveVblankEventId = -1;
  private static readonly MAX_SLICE = 100_000;

  constructor() {
    this.cpu.hle = this.hle;
    this.hle.cpu = this.cpu;
    this.hle.initTiming(this.coreTiming);
  }

  async loadElfBinary(data: Uint8Array): Promise<void> {
    // Initialize persistent save data storage
    this.hle.savedataStore = await createSavedataStore();

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

    const { entryPoint, moduleStartFunc, gp, nidBySyscall, loadedEnd } = loadElf(data, this.bus);
    this.hle.setHeapBase(loadedEnd);
    // Use module_start_func from export table if available, otherwise ELF entry
    const startAddr = moduleStartFunc ?? entryPoint;
    this.cpu.regs.pc = startAddr;

    // Wire up HLE handlers: re-register each NID handler under the syscall
    // code that the import stub patcher assigned.
    this.hle.remapSyscalls(nidBySyscall);

    // Set up initial register state like the PSP kernel does before entry
    this.cpu.regs.setGpr(28, gp); // $gp = absolute GP address from module_info
    log.info(`[EMU] Initializing GP=0x${gp.toString(16)}`);
    // SP: top of user memory (PSP-2000/3000: 64 MB RAM ends at 0x0C000000, leave some space)
    this.cpu.regs.setGpr(29, 0x0BFFF000); // $sp

    // Write a "module return" trampoline at a reserved address.
    const TRAMPOLINE_ADDR = 0x0BFFF800;
    this.hle.threadReturnAddr = TRAMPOLINE_ADDR;
    const SYSCALL_MODULE_RETURN = 0xFFFFF; // reserved syscall code
    const SYSCALL = 0x0000000c | (SYSCALL_MODULE_RETURN << 6);
    this.bus.writeU32(TRAMPOLINE_ADDR,     SYSCALL);
    this.bus.writeU32(TRAMPOLINE_ADDR + 4, 0); // NOP

    log.info(`[EMU] Entry=0x${startAddr.toString(16)} RA=0x${TRAMPOLINE_ADDR.toString(16)} SP=0x0BFFF000`);

    // Register the module-return handler
    this.hle.register(SYSCALL_MODULE_RETURN, (regs) => {
      hleLog.info("module_start returned");
      // Mark the main thread as DEAD and reschedule to the next READY thread
      if (this.hle.currentThreadId > 0) {
        if (!this.hle.exitCurrentThread(regs)) {
          // No READY threads right now, but there may be WAITING threads
          // that will be woken by CoreTiming events (delays, VBlank, etc.).
          // Only truly halt if there are no threads left at all.
          const hasWaiting = [...this.hle.threads.values()].some(
            t => t.state === ThreadState.WAITING || t.state === ThreadState.READY
          );
          if (hasWaiting) {
            hleLog.info("Thread exited, no READY threads — idle until timed event");
            this.hle.idleBreak = true;
          } else {
            hleLog.info("Thread exited, no remaining threads — halting.");
            this.halted = true;
            this.cpu.stepFaulted = true;
          }
        }
      } else {
        // module_start returned without any thread running — use the scheduler
        // to pick the best READY thread (created via sceKernelStartThread during
        // module_start).  This properly sets currentThreadId and restores the
        // full thread context so runFrame switches to thread-scheduler mode.
        this.hle.pendingThreadEntry = null;
        if (!this.hle.reschedule(regs)) {
          hleLog.info("No pending threads — halting.");
          this.halted = true;
          this.cpu.stepFaulted = true;
        } else {
          hleLog.info(`Scheduled thread ${this.hle.currentThreadId} after module_start`);
        }
      }
    });

    this.cpu.regs.setGpr(31, TRAMPOLINE_ADDR); // $ra → trampoline

    log.info(`ELF loaded, entry=0x${entryPoint.toString(16)}, module_start=0x${startAddr.toString(16)}, SP=0x0BFFF000, RA=0x${TRAMPOLINE_ADDR.toString(16)}`);

    this.coreTiming.init();
    this._initVblankSchedule();
  }

  private _initVblankSchedule(): void {
    // PPSSPP timing constants (sceDisplay.cpp:132-136, __DisplaySetFramerate):
    // frameMs  = 1001.0 / 60 ≈ 16.683 ms
    // vblankMs = 0.7315 ms (the VBlank period duration)
    const FRAME_MS   = 1001.0 / 60;
    const VBLANK_MS  = 0.7315;

    // LeaveVBlank event — fires 0.7315ms after EnterVBlank, clears isVblank.
    // PPSSPP sceDisplay.cpp:733-740 (hleLeaveVblank):
    //   Schedules next EnterVBlank at (frameMs - vblankMs) from now.
    if (this._leaveVblankEventId === -1) {
      this._leaveVblankEventId = this.coreTiming.registerEventType("LeaveVBlank", (cyclesLate) => {
        this.hle.onVblankEnd();
        // sceDisplay.cpp:736 — schedule next EnterVBlank
        this.coreTiming.scheduleEvent(
          Math.max(1, this.coreTiming.msToCycles(FRAME_MS - VBLANK_MS) - cyclesLate),
          this._vblankEventId
        );
      });
    }

    // EnterVBlank event — fires at (frameMs - vblankMs) into each frame.
    // PPSSPP sceDisplay.cpp:512-555 (hleEnterVblank):
    //   Schedules LeaveVBlank at vblankMs from now.
    if (this._vblankEventId === -1) {
      this._vblankEventId = this.coreTiming.registerEventType("VBlank", (cyclesLate) => {
        this._vblankFired = true;
        this.hle.onVblank(this.cpu.regs);
        // sceDisplay.cpp:519 — schedule LeaveVBlank
        this.coreTiming.scheduleEvent(
          Math.max(1, this.coreTiming.msToCycles(VBLANK_MS) - cyclesLate),
          this._leaveVblankEventId
        );
      });
    }
    // PPSSPP sceDisplay.cpp:210 — first EnterVBlank fires at (frameMs - vblankMs)
    // because vblank START happens that far into the frame, not at the frame boundary.
    this.coreTiming.scheduleEvent(
      this.coreTiming.msToCycles(FRAME_MS - VBLANK_MS),
      this._vblankEventId
    );
  }

  async initWorker(): Promise<void> {
    // Inline GE processing: runs synchronously on the main thread.
    // The Worker-based path has a race condition with stall-based rendering:
    // postMessage delivery is async, so UpdateStallAddr arrives before the
    // Worker even starts processing, causing blank frames.
    // TODO: Redesign Worker to use SharedArrayBuffer command ring instead of postMessage.
  }

  /**
   * Run one frame: execute CPU in slices until the VBlank event fires
   * (or a safety budget is exhausted). VBlank is scheduled via CoreTiming
   * at ~16.683 ms intervals, matching PPSSPP's sceDisplay timing.
   *
   * Two execution modes:
   *  1. module_start phase (currentThreadId === 0): runs before any threads exist.
   *  2. Thread-scheduler phase: runs only when a thread is in RUNNING state.
   */
  runFrame(): void {
    this._vblankFired = false;

    // Safety budget: 2 frames to prevent infinite loops when VBlank is never fired
    // (e.g. game loaded without _initVblankSchedule being called yet).
    const maxBudget = this.coreTiming.msToCycles(33.4);
    let budgetSpent = 0;

    // Wake audio threads (wall-clock based — intentional, tied to Web Audio hardware)
    this.hle.wakeAudioThreads(this.cpu.regs);

    while (!this._vblankFired && budgetSpent < maxBudget) {
      // Check dynamically each iteration — module_start may transition to thread mode
      // mid-frame, and threads may block/wake at any time.
      const inModuleStart = this.hle.currentThreadId === 0;
      const hasRunning = inModuleStart || this.hle.hasRunningThread();

      if (!hasRunning) {
        // No runnable thread — fast-forward CoreTiming to next event (idle skip).
        // Equivalent to PPSSPP's CoreTiming::Idle().
        const delta = this.coreTiming.nextEventDelta();
        if (!isFinite(delta)) break; // nothing scheduled — stop
        const skip = Math.min(delta, PSPEmulator.MAX_SLICE);
        this.coreTiming.advance(skip > 0 ? skip : 1);
        budgetSpent += skip > 0 ? skip : 1;
        // CoreTiming events (VBlank, WakeThread) may have set threads to READY.
        // Try to pick one up — mirrors PPSSPP's post-Idle() reschedule check.
        if (!this.hle.hasRunningThread()) {
          this.hle.reschedule(this.cpu.regs);
        }
        continue;
      }

      this.hle.idleBreak = false;
      const delta = this.coreTiming.nextEventDelta();
      const slice = isFinite(delta) && delta > 0
        ? Math.min(delta, PSPEmulator.MAX_SLICE)
        : PSPEmulator.MAX_SLICE;
      const ran = this.cpu.run(slice);
      if (this.cpu.stepFaulted) { this.halted = true; return; }
      budgetSpent += ran;

      this.coreTiming.advance(ran);
      this.hle.handleGeSignal(this.cpu.regs);
      this.hle.processVTimerCallbacks?.();
      this.hle.wakeAudioThreads(this.cpu.regs);
    }

    this.hle.drainGeCompletions(this.cpu.regs);

    // GE completions may have woken threads — give them a slice
    if (this.hle.hasRunningThread()) {
      this.hle.idleBreak = false;
      const ran = this.cpu.run(PSPEmulator.MAX_SLICE);
      if (this.cpu.stepFaulted) { this.halted = true; return; }
      this.coreTiming.advance(ran);
    }
  }

  run(maxSteps?: number): void {
    this.cpu.run(maxSteps);
    if (this.cpu.stepFaulted) {
      this.halted = true;
    }
  }
}
