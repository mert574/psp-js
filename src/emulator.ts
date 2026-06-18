import { MemoryBus } from "./memory/memory-bus.js";
import { AllegrexCPU } from "./cpu/cpu.js";
import { HLEKernel, ThreadState } from "./kernel/hle-kernel.js";
import { CoreTiming } from "./timing/core-timing.js";
import { loadElf } from "./loader/elf.js";
import { parseSfo } from "./iso/sfo.js";
import { isPbp, parsePbp } from "./loader/pbp.js";
import { pspDecryptPRX } from "./loader/prx-decrypter.js";
import { createSavedataStore } from "./storage/savedata-store.js";
import { createFileStore } from "./storage/file-store.js";
import { packContainer, unpackContainer, fnv1a, type StateSection } from "./state/state-container.js";
import { SECTION, SAVESTATE_FORMAT_VERSION, SUPPORTED_FORMAT_VERSIONS, type SnapshotJson } from "./state/save-state.js";
import { Logger } from "./utils/logger.js";

const log = Logger.get("EMU");
const hleLog = Logger.get("HLE");

const MAGIC_PSP_ENC = 0x7e505350; // "~PSP"   big-endian — Kirk-encrypted

/** Module names we HLE — skip decrypt/decompress for these (matches PPSSPP ShouldHLEModule). */
const HLE_PRX_NAMES = new Set([
  "sceATRAC3plus_Library", "sceAtrac3plus", "sceAudiocodec_Driver",
  "sceMpeg_library", "scePsmf_library", "scePsmfP_library", "scePsmfPlayer",
  "sceSAScore", "sceSasCore", "libsas",
  "sceAudio_Driver", "sceAudio",
  "sceNet_Library", "sceNetInet_Library", "sceNetApctl_Library",
  "sceNetAdhoc_Library", "sceNetAdhocctl_Library", "sceNetAdhocMatching_Library",
  "sceNetResolver_Library", "sceNet_Service", "sceNetIfhandle_Service",
  "sceFont_Library", "sceLibFont",
  "sceSsl_Module", "sceParseHTTPheader_Library", "sceParseUri_Library",
  "sceHttp_Library", "sceHttps_Module",
  "sceDeflt", "sceNpDrm_user_Module", "sceNp",
  "sceOpenPSID_Library", "scePauth_Module",
  "sceMp3_Library", "sceAac_Library",
  "sceP3da_Library", "sceGameUpdate_Library",
  "sceMpegbase_Driver", "sceVideocodec_Driver",
  "sceNetAdhocAuth_Service", "sceNetAdhocDownload_Library",
  "sceNetAdhocDiscover_Library", "sceMemab_Driver",
  "sceUSB_Driver", "sceUsbPspcm_Driver", "sceUsbAcc_Driver",
  "sceUsbCam_Driver", "sceUsbGps_Driver", "sceUsbMic_Driver",
  "sceIdStorage_Service", "sceReg_Service",
]);

/**
 * Decompress gzip data, tolerating truncated/corrupt trailers common in PSP PRXes.
 *
 * DecompressionStream("deflate-raw") is used instead of "gzip" because PSP gzip
 * streams often have invalid CRC32 trailers. We strip the gzip header ourselves
 * and try with/without the 8-byte trailer to handle both cases.
 */
async function decompressGzip(data: Uint8Array): Promise<Uint8Array | null> {
  const rawDeflate = skipGzipHeader(data);
  // Try with full data first, then without the 8-byte gzip trailer (CRC32 + ISIZE)
  for (const strip of [0, 8]) {
    const input = strip > 0 && rawDeflate.byteLength > strip
      ? rawDeflate.subarray(0, rawDeflate.byteLength - strip)
      : rawDeflate;
    const result = await tryDeflateRaw(input);
    if (result && result.byteLength > 0) return result;
  }
  return null;
}

/**
 * Attempt raw deflate decompression.
 * Keeps any data that was successfully decompressed even if the stream errors
 * on trailing bytes — PSP gzip streams often have CRC/padding that the browser's
 * strict DecompressionStream rejects ("Junk found after end of compressed data").
 */
async function tryDeflateRaw(input: Uint8Array): Promise<Uint8Array | null> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Write input and close — don't await, let the pipe process asynchronously.
  // Errors from write/close will surface when we read.
  writer.write(new Uint8Array(input) as unknown as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});

  // Read all available decompressed chunks. If the stream errors partway
  // through (e.g. trailing junk after a valid deflate stream), keep whatever
  // was already decompressed — that's the actual file content.
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    // Stream errored — use whatever chunks we got so far
  }

  const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
  if (totalLen === 0) return null;
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Skip a gzip header to get to the raw deflate stream. */
function skipGzipHeader(data: Uint8Array): Uint8Array {
  if (data.byteLength < 10 || data[0] !== 0x1f || data[1] !== 0x8b) return data;
  let off = 10;
  const flg = data[3]!;
  if (flg & 0x04) { // FEXTRA
    if (off + 2 > data.byteLength) return data;
    const xlen = data[off]! | (data[off + 1]! << 8);
    off += 2 + xlen;
  }
  if (flg & 0x08) { // FNAME
    while (off < data.byteLength && data[off] !== 0) off++;
    off++; // skip null terminator
  }
  if (flg & 0x10) { // FCOMMENT
    while (off < data.byteLength && data[off] !== 0) off++;
    off++;
  }
  if (flg & 0x02) off += 2; // FHCRC
  return data.subarray(off);
}

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

  /** Disc id of the loaded game (from PARAM.SFO), captured at boot. Save states
   *  are bound to this so a state only restores onto the same game. */
  gameId: string = "";
  /** FNV-1a hash of the EBOOT this game was booted from. A save state stores it
   *  and refuses to load onto a different build of the game. */
  ebootHash: number = 0;

  private _vblankFired = false;
  private _vblankEventId = -1;
  private _leaveVblankEventId = -1;
  private static readonly MAX_SLICE = 100_000;

  constructor() {
    this.cpu.hle = this.hle;
    this.hle.cpu = this.cpu;
    this.hle.initTiming(this.coreTiming);
  }

  /**
   * Decide whether the game runs in the full PSP-2000 64MB layout (true) or the
   * default PSP-1000 32MB layout (false). PPSSPP InitMemorySizeForGame: a game
   * gets 64MB only if its PARAM.SFO sets MEMSIZE=1 (or it's an HD remaster).
   * This matters because games compute their heap layout from the reported free
   * memory — a 64MB layout given to a 32MB game makes its own sub-allocations
   * collide (God of War: a streaming read landed on a live vtable). The ISO is
   * already mounted into fileData by the time loadElfBinary runs.
   */
  private detectLargeMemory(): boolean {
    for (const [key, data] of this.hle.fileData) {
      if (key.toLowerCase().endsWith("psp_game/param.sfo")) {
        try {
          const sfo = parseSfo(data.slice().buffer as ArrayBuffer);
          return sfo.MEMSIZE === 1;
        } catch { return false; }
      }
    }
    return false;
  }

  async loadElfBinary(data: Uint8Array, bootFilename = "disc0:/PSP_GAME/SYSDIR/EBOOT.BIN"): Promise<void> {
    // Bind any future save state to this game. The disc id is read from the
    // already-mounted PARAM.SFO; homebrew without an SFO gets "". The EBOOT hash
    // is computed further down, after unwrap/decrypt, so it matches no matter
    // whether the caller passed raw or pre-decrypted bytes.
    this.gameId = this._extractGameId();

    // Initialize persistent save data storage
    this.hle.savedataStore = await createSavedataStore();

    // Load any raw-IO save files persisted from previous sessions into the
    // in-memory filesystem so the game sees them as existing files. ms0: saves
    // survive across games like a real memory stick.
    this.hle.fileStore = await createFileStore();
    try {
      const persisted = await this.hle.fileStore.loadAll();
      for (const [path, data] of persisted) {
        this.hle.fileData.set(path, data);
      }
      if (persisted.size > 0) log.info(`Loaded ${persisted.size} persisted save file(s)`);
    } catch (err) {
      log.warn(`Failed to load persisted files: ${err}`);
    }

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

    // Hash the final ELF (post unwrap/decrypt) to bind save states to this build.
    this.ebootHash = fnv1a(data);

    const { entryPoint, moduleStartFunc, gp, nidBySyscall, loadedEnd, nextSyscallCode } = loadElf(data, this.bus);
    this.hle.setHeapBase(loadedEnd, this.detectLargeMemory());
    this.hle.nextSyscallCode = nextSyscallCode;
    // Use module_start_func from export table if available, otherwise ELF entry
    const startAddr = moduleStartFunc ?? entryPoint;
    this.cpu.regs.pc = startAddr;

    // Wire up HLE handlers: re-register each NID handler under the syscall
    // code that the import stub patcher assigned.
    this.hle.remapSyscalls(nidBySyscall);

    // Set up initial register state like the PSP kernel does before entry
    this.cpu.regs.setGpr(28, gp); // $gp = absolute GP address from module_info
    log.info(`[EMU] Initializing GP=0x${gp.toString(16)}`);

    // Allocate module_start stack from userMemory (matching PPSSPP root thread setup).
    // 0x40000 matches the real-PSP root/main thread stack for a LoadExec'd module
    // (the sysmem autotest's StackStart 0x3EF7C = 0x40000 - header). PPSSPP frees
    // this root stack before the game creates its big Fpl pool ("Freeing thread
    // stack root"); we free it in the module-return handler below.
    const MODULE_START_STACK = 0x40000;
    const moduleStackBase = this.hle.userMemory.alloc(MODULE_START_STACK, true, "stack/root");

    // Root thread stack setup matching PPSSPP __KernelResetThread → FillStack
    // then __KernelSetupRootThread (sceKernelThread.cpp:328-366, 1776-1806):
    // fill 0xFF, k0 area = top 256 bytes, then the boot args block, then 64 bytes headroom.
    let sp = moduleStackBase === -1 ? 0x0BFFF000 : (moduleStackBase + MODULE_START_STACK) >>> 0;
    if (moduleStackBase !== -1) {
      for (let i = 0; i < MODULE_START_STACK; i += 4) this.bus.writeU32(moduleStackBase + i, 0xFFFFFFFF);
      const k0 = sp - 0x100;
      for (let i = 0; i < 0x100; i += 4) this.bus.writeU32(k0 + i, 0);
      this.bus.writeU32(k0 + 0xC8, moduleStackBase); // initialStack
      this.bus.writeU32(k0 + 0xF8, 0xFFFFFFFF);
      this.bus.writeU32(k0 + 0xFC, 0xFFFFFFFF);
      this.cpu.regs.setGpr(26, k0); // $k0
      sp = k0;
    }
    // Boot args: PPSSPP __KernelLoadExec passes the exec path string (incl. NUL)
    // as the root thread's args — crt0 forwards these to user_main.
    const argBytes = new TextEncoder().encode(bootFilename);
    const argSize = argBytes.length + 1;
    sp = (sp - ((argSize + 0xf) & ~0xf)) >>> 0;
    for (let i = 0; i < argBytes.length; i++) this.bus.writeU8(sp + i, argBytes[i]!);
    this.bus.writeU8(sp + argBytes.length, 0);
    this.cpu.regs.setGpr(4, argSize); // a0 = args size
    this.cpu.regs.setGpr(5, sp);      // a1 = args block on root stack
    sp = (sp - 64) >>> 0;             // kernel headroom, matches __KernelSetupRootThread
    this.cpu.regs.setGpr(29, sp);     // $sp

    // Write a "module return" trampoline in low kernel memory (outside userMemory,
    // so freed stacks can't clobber it). 0x08000010 = GE BREAK, 0x08000020 = cb return.
    const TRAMPOLINE_ADDR = 0x08000030;
    this.hle.threadReturnAddr = TRAMPOLINE_ADDR;
    const SYSCALL_MODULE_RETURN = 0xFFFFF; // reserved syscall code
    const SYSCALL = 0x0000000c | (SYSCALL_MODULE_RETURN << 6);
    this.bus.writeU32(TRAMPOLINE_ADDR,     SYSCALL);
    this.bus.writeU32(TRAMPOLINE_ADDR + 4, 0); // NOP

    log.info(`[EMU] Entry=0x${startAddr.toString(16)} RA=0x${TRAMPOLINE_ADDR.toString(16)} SP=0x${sp.toString(16)}`);

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
        // PPSSPP __KernelReturnFromModuleFunc deletes the root thread, freeing
        // its stack — later thread stacks allocate from the very top of RAM.
        if (moduleStackBase !== -1) this.hle.userMemory.free(moduleStackBase);
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

    log.info(`ELF loaded, entry=0x${entryPoint.toString(16)}, module_start=0x${startAddr.toString(16)}, SP=0x${sp.toString(16)}, RA=0x${TRAMPOLINE_ADDR.toString(16)}`);

    // Pre-decrypt all PRX files in the filesystem so sceKernelLoadModule can be synchronous
    await this._preDecryptModules();

    this.coreTiming.init();
    this._initVblankSchedule();
  }

  /** Pre-process PRX files: decompress gzip, decrypt ~PSP encryption. */
  private async _preDecryptModules(): Promise<void> {
    let prxCount = 0;
    for (const [path, data] of this.hle.fileData) {
      if (!path.toLowerCase().endsWith(".prx")) continue;
      prxCount++;
      log.info(`Pre-processing PRX: ${path} (${data.byteLength} bytes, magic=0x${data.byteLength >= 2 ? (data[0]!.toString(16) + data[1]!.toString(16)) : "?"})`);

      if (data.byteLength < 4) continue;

      let processed = data;

      // PPSSPP: check module name from ~PSP header BEFORE decrypting.
      // If it's a known HLE module, skip decrypt+decompress entirely — it'll be faked at load time.
      if (processed.byteLength > 0x2A) {
        const hdrMagic = new DataView(processed.buffer, processed.byteOffset, 4).getUint32(0, false);
        if (hdrMagic === MAGIC_PSP_ENC) {
          let modName = "";
          for (let i = 0; i < 28; i++) {
            const b = processed[0x0A + i]!;
            if (b === 0) break;
            modName += String.fromCharCode(b);
          }
          if (modName && HLE_PRX_NAMES.has(modName)) {
            log.info(`Pre-processing PRX: ${path} — HLE module "${modName}", skipping decrypt`);
            continue;
          }
        }
      }

      // Loop: PRX files can be multi-layered (~PSP encrypted → gzip → ELF, etc.)
      for (let pass = 0; pass < 4; pass++) {
        if (processed.byteLength < 4) break;
        const m0 = processed[0]!;
        const m1 = processed[1]!;
        const magic32 = new DataView(processed.buffer, processed.byteOffset, 4).getUint32(0, false);

        if (m0 === 0x1f && m1 === 0x8b) {
          // Gzip compressed — use raw deflate (skip header + trailer) to avoid CRC issues
          const decompressed = await decompressGzip(processed);
          if (decompressed && decompressed.byteLength > 0) {
            processed = decompressed;
            log.info(`Decompressed PRX: ${path} (${processed.byteLength} bytes)`);
            continue;
          } else {
            log.warn(`Failed to decompress PRX: ${path}`);
            break;
          }
        } else if (magic32 === MAGIC_PSP_ENC) {
          // ~PSP encrypted — read header fields before decryption
          const prxView = new DataView(processed.buffer, processed.byteOffset, processed.byteLength);
          const compAttr = prxView.getUint16(6, true);
          const elfSize = prxView.getUint32(0x28, true);
          const isGzip = (compAttr & 1) !== 0;

          const decrypted = await pspDecryptPRX(processed);
          if (decrypted) {
            processed = decrypted;
            log.info(`Decrypted PRX: ${path} (${processed.byteLength} bytes, gzip=${isGzip}, elfSize=${elfSize})`);

            // Decompress gzip if comp_attribute flag set (matches PPSSPP sceKernelModule.cpp:1108)
            if (isGzip && processed.byteLength > 0) {
              const decompressed = await decompressGzip(processed);
              if (decompressed && decompressed.byteLength > 0) {
                processed = decompressed;
                log.info(`Decompressed gzipped PRX: ${path} (${processed.byteLength} bytes)`);
              } else {
                log.warn(`Failed to decompress gzipped PRX: ${path}`);
              }
            }
            continue;
          } else {
            log.warn(`Failed to decrypt PRX: ${path}`);
            break;
          }
        } else {
          break; // no more transforms needed
        }
      }

      if (processed !== data) {
        this.hle.fileData.set(path, processed);
      }
    }
    log.info(`Pre-processed ${prxCount} PRX file(s)`);
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
      // PSP is preemptive: before running the slice, make sure the highest-
      // priority READY thread is the one executing (a compute-bound low-prio
      // thread otherwise starves higher-prio READY threads — see God of War).
      this.hle.preemptIfHigherPriorityReady(this.cpu.regs);
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

  // ── save states ────────────────────────────────────────────────────────────

  /** Read the disc id from the mounted PARAM.SFO, or "" for homebrew. */
  private _extractGameId(): string {
    for (const [key, fileData] of this.hle.fileData) {
      if (key.toLowerCase().endsWith("psp_game/param.sfo")) {
        try {
          const sfo = parseSfo(fileData.slice().buffer as ArrayBuffer);
          return String(sfo["DISC_ID"] ?? "");
        } catch { return ""; }
      }
    }
    return "";
  }

  /**
   * Capture the whole machine into a portable save-state blob.
   *
   * Must be called at a frame boundary (after runFrame returns), when no async
   * wake callbacks are in flight. The structured state is JSON, memory and CPU
   * register files are raw/gzipped binary sections. The blob does NOT contain
   * the game itself, only its disc id and EBOOT hash, so restoring needs the
   * same game booted first.
   */
  /**
   * Capture the whole machine synchronously, WITHOUT compressing. Returns the
   * raw (uncompressed) container sections plus the game-binding info. This is
   * the part that must run on the main thread because it reads live emulator
   * state; it's fast (a few memcpys + JSON.stringify). The slow gzip is left to
   * the caller (packContainer), which can run on a worker so the UI doesn't
   * freeze. The memory buffers are copied here so a later runFrame can't tear
   * the snapshot while compression is in flight.
   */
  captureSnapshot(meta: Record<string, unknown> = {}): {
    gameId: string;
    contentHash: number;
    formatVersion: number;
    meta: Record<string, unknown>;
    sections: StateSection[];
  } {
    const blockers = this.hle.snapshotBlockers();
    if (blockers.length > 0) {
      throw new Error(`cannot save state right now: ${blockers.join("; ")}`);
    }

    const json: SnapshotJson = {
      schema: SAVESTATE_FORMAT_VERSION,
      cpu: this.cpu.serialize(),
      regs: this.cpu.regs.serializeScalars(),
      coreTiming: this.coreTiming.serialize(),
      kernel: this.hle.serialize(),
      ge: this.hle.geProcessor ? this.hle.geProcessor.serialize() : null,
      emu: { halted: this.halted },
    };
    const stateBytes = new TextEncoder().encode(JSON.stringify(json));

    return {
      gameId: this.gameId,
      contentHash: this.ebootHash,
      formatVersion: SAVESTATE_FORMAT_VERSION,
      meta,
      sections: [
        { name: SECTION.RAM,        codec: "gzip", bytes: this.bus.ramBuffer.slice() },
        { name: SECTION.VRAM,       codec: "gzip", bytes: this.bus.vramBuffer.slice() },
        { name: SECTION.SCRATCHPAD, codec: "raw",  bytes: this.bus.scratchpadBuffer.slice() },
        { name: SECTION.CPUREGS,    codec: "raw",  bytes: this.cpu.regs.dumpRegBuffers() },
        { name: SECTION.STATE,      codec: "gzip", bytes: stateBytes },
      ],
    };
  }

  async saveState(meta: Record<string, unknown> = {}): Promise<Uint8Array> {
    const cap = this.captureSnapshot(meta);
    return packContainer(
      { gameId: cap.gameId, contentHash: cap.contentHash, formatVersion: cap.formatVersion, meta: cap.meta },
      cap.sections,
    );
  }

  /**
   * Overlay a save-state blob onto THIS emulator. The caller must have already
   * booted the matching game (loadElfBinary) so all handlers, trampolines, and
   * CoreTiming event types are wired up. We then overwrite the mutable state.
   *
   * Throws if the blob is for a different game/build unless ignoreGameMismatch.
   * After this returns, a browser caller should re-attach its GE renderer and
   * invalidate its texture cache before drawing again.
   */
  async loadState(blob: Uint8Array, opts: { ignoreGameMismatch?: boolean; allowBuildMismatch?: boolean } = {}): Promise<void> {
    const parsed = await unpackContainer(blob);
    // Game-title (disc id) mismatch is a hard stop: the state's guest addresses
    // belong to a different game entirely.
    if (!opts.ignoreGameMismatch && parsed.gameId !== this.gameId) {
      throw Object.assign(
        new Error(`save state is for game "${parsed.gameId}", but "${this.gameId || "(none)"}" is loaded`),
        { code: "GAME_MISMATCH" },
      );
    }
    // Same game title but a different EBOOT build (different rip/patch/region):
    // the code layout may differ, so this is risky. Block by default but let the
    // caller force it when they know the builds are close enough.
    if (!opts.ignoreGameMismatch && !opts.allowBuildMismatch && parsed.contentHash !== this.ebootHash) {
      throw Object.assign(
        new Error("save state was taken from a different build of this game (the EBOOT differs)"),
        { code: "BUILD_MISMATCH" },
      );
    }

    const section = (name: string): Uint8Array => {
      const b = parsed.sections.get(name);
      if (!b) throw new Error(`save state is missing the "${name}" section`);
      return b;
    };
    // The header carries the format version (readable without the state section).
    // Refuse anything not in the supported list; a future migrator would branch
    // on parsed.formatVersion here to upgrade an older file before overlaying.
    if (!SUPPORTED_FORMAT_VERSIONS.includes(parsed.formatVersion)) {
      throw new Error(`save state format v${parsed.formatVersion} is not supported (this build reads: ${SUPPORTED_FORMAT_VERSIONS.join(", ")})`);
    }
    const json = JSON.parse(new TextDecoder().decode(section(SECTION.STATE))) as SnapshotJson;
    if (json.schema !== parsed.formatVersion) {
      throw new Error(`save state is inconsistent (header v${parsed.formatVersion}, content v${json.schema})`);
    }

    // Memory first.
    this.bus.loadRam(section(SECTION.RAM));
    this.bus.loadVram(section(SECTION.VRAM));
    this.bus.loadScratchpad(section(SECTION.SCRATCHPAD));

    // CPU register files + scalars.
    this.cpu.regs.loadRegBuffers(section(SECTION.CPUREGS));
    this.cpu.regs.deserializeScalars(json.regs);
    this.cpu.deserialize(json.cpu);

    // Timing before the kernel: the kernel's restored event ids line up with
    // the freshly registered event types, and CoreTiming remaps its queue by
    // event-type name.
    this.coreTiming.deserialize(json.coreTiming);
    this.hle.deserialize(json.kernel);

    // GE render state. The WebGL renderer's caches are derived from VRAM + this
    // state and rebuild on the next draw.
    if (json.ge) this.hle.ensureGeProcessor().deserialize(json.ge);

    this.halted = json.emu.halted;
  }
}
