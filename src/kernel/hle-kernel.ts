import type { MemoryBus } from "../memory/memory-bus.js";
import { MemoryRegion } from "../memory/memory-map.js";
import type { AllegrexRegisters } from "../cpu/registers.js";
import type { AllegrexCPU } from "../cpu/cpu.js";
import type { CoreTiming, EventTypeId } from "../timing/core-timing.js";
import { GeDispatcher } from "../gpu/ge-dispatcher.js";
import { Logger } from "../utils/logger.js";
import { PGF } from "./hle-font.js";
import { PspFileSystem } from "./psp-filesystem.js";
import { AudioEngine } from "../audio/audio-engine.js";
import type { SavedataStore } from "../storage/savedata-store.js";
import { registerAudioHLE } from "./hle-audio.js";
import { registerThreadHLE } from "./hle-thread.js";
import { registerSyncHLE } from "./hle-sync.js";
import { registerDisplayHLE } from "./hle-display.js";
import { registerCtrlHLE } from "./hle-ctrl.js";
import { registerIoHLE } from "./hle-io.js";
import { registerPowerHLE } from "./hle-power.js";
import { registerNetHLE } from "./hle-net.js";
import { registerMediaHLE } from "./hle-media.js";
import { registerPsmfPlayerHLE } from "./hle-psmf-player.js";
import { registerUtilityHLE } from "./hle-utility.js";
import {
  FONT, GE, NID_NAMES,
} from "./nids.js";

const log = Logger.get("HLE");

// PPSSPP sceGe.cpp: list IDs are XOR'd with this magic before being returned to
// user code, and unmasked on every inbound syscall that takes a list ID.
const GE_LIST_ID_MAGIC = 0x35000000;
const pspLog = Logger.get("PSP");

/**
 * HLEKernel
 *
 * High-Level Emulation of the PSP kernel and system libraries.
 *
 * When the CPU executes a SYSCALL instruction the top-level emulator
 * catches it here instead of routing execution into a BIOS ROM image.
 * Each NID (numeric identifier) maps to a handler function that reads
 * arguments from the MIPS ABI registers ($a0–$a3, then stack), does
 * host-side work, and places a return value in $v0 (and $v1 if needed).
 *
 * MIPS O32 calling convention used by the PSP:
 *   $a0 = first argument  (r4)
 *   $a1 = second argument (r5)
 *   $a2 = third argument  (r6)
 *   $a3 = fourth argument (r7)
 *   $v0 = return value    (r2)
 *   $v1 = second return   (r3)  (used by e.g. sceKernelGetSystemTime)
 *
 * PSP syscall encoding:
 *   The game code calls a stub function which executes:
 *     syscall 0x<nid-derived-code>
 *   We decode the NID from the call-table, but for our purposes we
 *   register handlers by their NID directly.
 *
 * Reference: https://github.com/hrydgard/ppsspp (HLE module implementations)
 */

export type HLEHandler = (regs: AllegrexRegisters, bus: MemoryBus) => void;

export interface InputSnapshot {
  buttons: number;
  analog: { x: number; y: number };
}

export enum ThreadState { RUNNING, READY, WAITING, DORMANT, DEAD }
export enum WaitType { NONE, DELAY, VBLANK, SLEEP, SEMA, EVENT_FLAG, AUDIO, ATRAC_DECODE, GE_DRAW_SYNC, GE_LIST_SYNC, THREAD_END, MUTEX }

/** GE display list states (modeled after PPSSPP's PSP_GE_DL_STATE_*) */
export enum GeListState { NONE, QUEUED, DRAWING, STALLING, COMPLETED, PAUSED }

export interface GeListEntry {
  id: number;
  listAddr: number;       // original start address
  pc: number;             // current GE program counter
  stallAddr: number;      // stall address (0 = no stall)
  state: GeListState;
}

export interface ThreadContext {
  gpr: Uint32Array;       // 32 general-purpose registers
  hi: number; lo: number; // multiply/divide results
  pc: number;
  fpr: Uint32Array;       // 32 scalar FPU registers
  fcr31: number;          // FPU control register
  // Allegrex VFPU state
  vfpr: Float32Array;     // 128 VFPU scalar registers (4×4 matrices)
  vfpuCtrl: Uint32Array;  // 16 VFPU control registers
  vfpuCc: number;         // VFPU condition code bits
  vpfxs: number; vpfxt: number; vpfxd: number;                     // VPFX prefix words
  vpfxsEnabled: boolean; vpfxtEnabled: boolean; vpfxdEnabled: boolean;
}

/** PSP kernel callback object — PPSSPP sceKernelThread.cpp:NativeCallback */
export interface PSPCallback {
  id: number;
  name: string;
  threadId: number;       // owning thread
  entrypoint: number;     // callback function address
  commonArg: number;      // user argument ($a2 when called)
  notifyCount: number;    // how many times notified (pending)
  notifyArg: number;      // argument from sceKernelNotifyCallback ($a1 when called)
}

export interface Thread {
  id: number;
  entry: number;
  stackSize: number;
  stackBase: number;
  stackTop: number;
  k0: number;             // kernel thread-local pointer ($k0)
  priority: number;
  state: ThreadState;
  waitType: WaitType;
  context: ThreadContext;
  wakeupCount: number;
  /** Callback IDs registered by this thread — PPSSPP PSPThread::callbacks */
  callbacks: number[];
  /** When true, CB-variant wait will process callbacks — PPSSPP PSPThread::isProcessingCallbacks */
  isProcessingCallbacks: boolean;
  // Wait-condition details
  waitSemaId: number;     // semaphore being waited on (WaitType.SEMA)
  waitSemaCount: number;  // required signal count
  waitEvfId: number;      // event flag ID being waited on (WaitType.EVENT_FLAG)
  waitEvfBits: number;    // bits pattern to match
  waitEvfMode: number;    // AND/OR/CLEAR flags
  waitEvfOutPtr: number;  // address to write matched pattern
  waitGeListId: number;   // GE list being waited on (WaitType.GE_LIST_SYNC)
  waitDeadlineVbl: number; // VBlank count at which a timed wait expires
  waitWakeTimeMs: number;  // performance.now() deadline for WaitType.AUDIO
  waitThreadEndId: number; // thread ID being waited on (WaitType.THREAD_END)
  waitMutexId: number;     // mutex ID being waited on (WaitType.MUTEX)
  waitMutexCount: number;  // lock count requested
  pendingWakeCallback: (() => void) | undefined; // called before waking from ATRAC_DECODE
}

export class HLEKernel {
  private readonly handlers = new Map<number, HLEHandler>();
  /** Reverse map: syscall code → NID (for debug logging) */
  private syscallToNid = new Map<number, number>();
  private warnedSyscalls = new Set<number>();
  /** Threads indexed by thread ID */
  readonly threads = new Map<number, Thread>();
  nextThreadId = 1;
  /** Currently running thread ID (0 = main/module_start, before any threads) */
  currentThreadId: number = 0;
  /** Thread entry to jump to after module_start returns (backward compat) */
  pendingThreadEntry: { entry: number; arglen: number; argp: number; sp: number; k0: number } | null = null;

  /** Thread IDs woken from async ATRAC decode — processed in wakeAudioThreads. */
  readonly pendingAtracWakes = new Set<number>();

  /** Persistent save data storage (IndexedDB in browser, in-memory fallback in Node.js) */
  savedataStore: SavedataStore | null = null;

  /** Optional callback for savedata UI overlay: (action, gameName, saveName, done, error) */
  onSavedataEvent: ((action: string, game: string, save: string, done: boolean, error: boolean) => void) | null = null;

  /** Optional callback for save slot selection UI (LISTLOAD/LISTSAVE modes).
   *  Called with action + slot info, returns a Promise resolving to the selected name or null. */
  onSavedataListSelect: ((action: "Load" | "Save", slots: Array<{ name: string; hasData: boolean; sizeKB: number; title: string }>) => Promise<string | null>) | null = null;

  /** PSP kernel callbacks — PPSSPP kernelObjects for PSPCallback type */
  readonly pspCallbacks = new Map<number, PSPCallback>();
  nextPspCallbackId = 1;

  /**
   * Pending MipsCall for callback dispatch.
   * PPSSPP uses a full MipsCall queue per thread; we simplify to one active call.
   * When set, the CPU is redirected to the callback entrypoint. When the callback
   * returns (via cbReturnTrampolineAddr), the saved state is restored.
   */
  private activeMipsCall: {
    savedPc: number;
    savedV0: number;
    savedV1: number;
    savedRegsOnStack: boolean; // true if we pushed regs to the game stack
    threadId: number;
    // Saved wait state for ActionAfterMipsCall (PPSSPP sceKernelThread.cpp:266-274)
    savedWaitType: WaitType;
    savedIsProcessingCallbacks: boolean;
    savedThreadState: ThreadState;
  } | null = null;

  /** Address of the callback-return trampoline (SYSCALL instruction).
   *  PPSSPP: cbReturnHackAddr, written during __KernelThreadingInit. */
  private cbReturnTrampolineAddr = 0x08000020;
  private cbReturnTrampolineWritten = false;
  private static readonly SYSCALL_CB_RETURN = 0xFFFFE; // reserved syscall code

  /** Bump allocator for PSP_SMEM_Low allocations (grows upward).
   *  Initialized to a fallback; emulator.ts calls setHeapBase() after ELF load. */
  nextAllocAddr = 0x09000000;
  /** Ceiling for low/high heap — matches the bottom of the stack pool. PSP-2000/3000: 64 MB → top at 0x0BFF0000. */
  nextHighAddr = 0x0BFF0000;
  readonly memBlocks = new Map<number, { addr: number; size: number; name: string }>();
  nextBlockId = 0x100;

  /**
   * FPL pool tracking: fplId → { base, blockSize, numBlocks, nextBlock }
   * Separate from memBlocks so AllocateFpl can cycle through blocks properly.
   */
  readonly fplPools = new Map<number, { base: number; blockSize: number; numBlocks: number; nextBlock: number }>();

  /**
   * Bump allocator for thread stacks (grows downward from 0x0BFF0000).
   * The heap grows upward from loadedEnd; the collision guard in
   * sceKernelCreateThread catches any overlap before it causes corruption.
   */
  nextStackTopAddr = 0x0BFF0000;

  /** Called by emulator.ts after ELF load to position the heap above loaded segments. */
  setHeapBase(addr: number): void {
    if (addr > 0) this.nextAllocAddr = (addr + 0xFF) & ~0xFF;
  }

  /** Semaphores: id → { count, maxCount } */
  readonly semaphores = new Map<number, { name: string; attr: number; initCount: number; count: number; maxCount: number }>();

  /** SAS grain size set by __sceSasInit; used to block the mixing thread. */
  sasGrainSize = 256;

  /** GE IDs */
  private nextGeListId = 1;
  private geDispatcher!: GeDispatcher;
  /** GE display lists: listId → entry */
  private geLists = new Map<number, GeListEntry>();
  /** FIFO processing order for queued GE lists */
  private geListQueue: number[] = [];

  /**
   * GE callbacks registered via sceGeSetCallback.
   * cbId → { signalFunc, signalArg, finishFunc, finishArg }
   */
  private geCallbacks = new Map<number, { signalFunc: number; signalArg: number; finishFunc: number; finishArg: number }>();
  /** The cbId of the most recently registered GE callback (used to fire on SIGNAL). */
  private activeGeCbId = 0;

  /** Reference to the CPU — set by PSPEmulator after construction so we can invoke callbacks. */
  cpu: AllegrexCPU | null = null;

  /** Virtual filesystem populated by the frontend before boot: PSP path → file bytes. */
  public fileData = new Map<string, Uint8Array>();

  /** Virtual filesystem with CWD tracking, path resolution, and directory enumeration. */
  readonly pspFs!: PspFileSystem;

  /** When non-null, sceIoWrite to fd 1/2 appends raw text here (for pspautotests). */
  public stdoutBuffer: string[] | null = null;

  /** Loaded PGF fonts by index (populated lazily on sceFontNewLib) */
  private pgfFonts: (PGF | null)[] = [];
  /** Map font handle → pgfFonts index */
  private fontHandleMap = new Map<number, number>();
  private nextFontHandle = 2;

  /** Open file descriptors: fd → { path, data, position, asyncResult } */
  private readonly openFiles = new Map<number, { path: string; data: Uint8Array; position: number; asyncResult: number }>();
  private nextFd = 3; // 0/1/2 reserved for stdin/stdout/stderr


  /** Scheduling / timing */
  vblankCount: number = 0;
  cycleCount: number = 0;
  ioOpsCount: number = 0;
  currentButtons: number = 0;
  /** Tracks how many times each stubbed syscall has been called (name → count). */
  readonly stubCalls = new Map<string, number>();

  coreTiming: CoreTiming | null = null;
  wakeThreadEventId: EventTypeId = -1;

  /** Process pending VTimer handler callbacks. Set by hle-media.ts after registration. */
  processVTimerCallbacks: (() => void) | null = null;

  /**
   * Set by the scheduler when no READY threads exist.
   * The CPU run-loop checks this flag to break out of idle spinning
   * instead of burning cycles waiting for a VBlank or timer wake-up.
   */
  idleBreak: boolean = false;

  /**
   * Guest address of the "module return" trampoline written by the emulator
   * during boot. Threads that finish execution jump here to trigger a clean
   * module-exit syscall.
   */
  threadReturnAddr: number = 0;

  inputSnapshot: (() => InputSnapshot) | null = null;
  framebufAddr:   number = 0;
  framebufWidth:  number = 512;
  framebufFormat: number = 3;

  // ── Display state (PPSSPP sceDisplay.cpp / Core/HW/Display.cpp) ─────────
  /** True after sceDisplaySetMode succeeds (PPSSPP sceDisplay.cpp:816) */
  displayHasSetMode = false;
  displayMode   = 0;    // PSP_DISPLAY_MODE_LCD = 0
  displayWidth  = 480;
  displayHeight = 272;
  /** True during VBlank period (Display.cpp:46, set in DisplayFireVblankStart/End) */
  isVblank = false;
  /** CoreTiming tick at the start of the current frame (Display.cpp:40) */
  frameStartTicks = 0;
  /** Accumulated horizontal count base — incremented by 286 per VBlank (Display.cpp:45) */
  hCountBase = 0;
  /** PPSSPP Display.cpp:47 — horizontal counts per VBlank */
  static readonly HCOUNT_PER_VBLANK = 286;
  /** PPSSPP sceDisplay.cpp:103 — resume mode (no-op state storage) */
  displayResumeMode = 0;
  /** PPSSPP sceDisplay.cpp:104 — hold mode (no-op state storage) */
  displayHoldMode = 0;
  /** PPSSPP sceDisplay.cpp:187 — default brightness = 84 (AC level) */
  displayBrightnessLevel = 84;

  // ── GE break state (PPSSPP GPUCommon.cpp:604) ──────────────────────────
  /** True after sceGeBreak mode=0 — sceGeContinue checks this to decide RUNNING vs QUEUED */
  private geIsBreak = false;
  /** EDRAM address translation value (PPSSPP GPUCommon edramTranslation_, default 0x400) */
  private geEdramTranslation = 0x400;

  /**
   * Audio engine. Always present — call audioEngine.init() from the frontend
   * after a user gesture to unlock the AudioContext and start producing sound.
   */
  readonly audioEngine: AudioEngine = new AudioEngine();

  /** GE draw target (where the GE last drew — use this for rendering when non-zero). */
  get geFbAddr(): number   { return this.geDispatcher?.geFbAddr   ?? 0; }
  get geFbWidth(): number  { return this.geDispatcher?.geFbWidth  ?? 512; }
  get geFbFormat(): number { return this.geDispatcher?.geFbFormat ?? 3; }
  get geListCount(): number  { return this.geDispatcher?.listCount  ?? 0; }
  get gePrimCount(): number  { return this.geDispatcher?.primCount  ?? 0; }
  get geClearCount(): number { return this.geDispatcher?.clearCount ?? 0; }
  get geSkipCount(): number  { return this.geDispatcher?.skipCount  ?? 0; }

  /** Wire up CoreTiming and register timing-driven events (call once per emulator instance). */
  initTiming(ct: CoreTiming): void {
    this.coreTiming = ct;
    this.wakeThreadEventId = ct.registerEventType("WakeThread", (_cyclesLate, threadId) => {
      const t = this.threads.get(threadId);
      if (t && t.state === ThreadState.WAITING && t.waitType === WaitType.DELAY) {
        t.state    = ThreadState.READY;
        t.waitType = WaitType.NONE;
        // Don't overwrite gpr[2] — the caller (sceIoRead, sceKernelDelayThread, etc.)
        // already set the correct return value in the saved context.
        if (!this.hasRunningThread() && this.cpu) {
          this.idleBreak = false;
          this.reschedule(this.cpu.regs);
          // Process pending callbacks if this was a CB-variant wait
          // PPSSPP sceKernelThread.cpp:1647-1651
          if (t.isProcessingCallbacks && this.currentThreadId === t.id) {
            this.processThreadCallbacks(this.cpu.regs);
          }
        }
      }
    });
  }

  /** Return a lightweight snapshot of all thread states (for debug UI). */
  getThreadsSnapshot(): Array<{ id: number; state: ThreadState; priority: number; pc: number; waitType: WaitType }> {
    const out: Array<{ id: number; state: ThreadState; priority: number; pc: number; waitType: WaitType }> = [];
    for (const t of this.threads.values()) {
      out.push({ id: t.id, state: t.state, priority: t.priority, pc: t.context.pc, waitType: t.waitType });
    }
    return out;
  }

  constructor(readonly bus: MemoryBus) {
    this.pspFs = new PspFileSystem(this.fileData);
    this.registerBuiltins();
    registerAudioHLE(this);
    registerThreadHLE(this);
    registerSyncHLE(this);
    registerDisplayHLE(this);
    registerCtrlHLE(this);
    registerIoHLE(this);
    registerPowerHLE(this);
    registerNetHLE(this);
    registerPsmfPlayerHLE(this);
    registerMediaHLE(this);
    registerUtilityHLE(this);
  }

  initGeWorker(ramSab: SharedArrayBuffer, vramSab: SharedArrayBuffer, scratchpadSab: SharedArrayBuffer): void {
    this.geDispatcher = new GeDispatcher(ramSab, vramSab, scratchpadSab);
  }

  terminateGeWorker(): void { this.geDispatcher?.terminate(); }

  /** Register a handler for a given NID. Overwrites any existing handler. */
  register(nid: number, handler: HLEHandler): void {
    if (this.handlers.has(nid)) {
      log.warn(`register(0x${nid.toString(16)}) overwriting existing handler`);
    }
    this.handlers.set(nid, handler);
  }

  /** Register a stub (no-op) handler that returns `v0 = retval`.
   *  Skips if a real handler is already registered (never overwrites a real impl with a stub). */
  stub(nid: number, retval = 0): void {
    if (this.handlers.has(nid)) {
      log.warn(`stub(0x${nid.toString(16)}) skipped — already registered`);
      return;
    }
    const name = NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`;
    this.handlers.set(nid, (regs) => {
      this.stubCalls.set(name, (this.stubCalls.get(name) ?? 0) + 1);
      regs.setGpr(2, retval);
    });
  }

  /**
   * Re-register handlers under the syscall codes assigned by the import stub patcher.
   * nidBySyscall maps syscallCode → NID. For each entry where we have a handler
   * registered by NID, we re-register it under the syscall code.
   */
  remapSyscalls(nidBySyscall: Map<number, number>): void {
    // Save original NID→handler map
    const nidHandlers = new Map(this.handlers);
    // Clear and rebuild with syscall codes
    const remapped = new Map<number, HLEHandler>();
    let mapped = 0;
    const unmappedNids: string[] = [];
    for (const [syscallCode, nid] of nidBySyscall) {
      const handler = nidHandlers.get(nid);
      if (handler) {
        remapped.set(syscallCode, handler);
        mapped++;
      } else {
        const name = NID_NAMES.get(nid);
        unmappedNids.push(name ? `${name} (0x${nid.toString(16)})` : `0x${nid.toString(16)}`);
      }
    }
    // Replace handler map — keep NID-based entries too for any direct syscalls
    for (const [code, handler] of remapped) {
      this.handlers.set(code, handler);
    }
    // Store reverse map for debug logging
    this.syscallToNid = new Map(nidBySyscall);
    log.info(`Remapped ${mapped} syscalls (${unmappedNids.length} unimplemented NIDs)`);
    if (unmappedNids.length > 0) {
      log.warn(`Unimplemented: ${unmappedNids.join(', ')}`);
    }
  }

  /** For testing: look up the NID registered for a given syscall code. */
  getNidBySyscallForTest(syscallCode: number): number | undefined {
    return this.syscallToNid.get(syscallCode);
  }

  /** Dispatch a syscall. The syscall code is the lower 20 bits of the SYSCALL instruction. */
  dispatch(syscallCode: number, regs: AllegrexRegisters): void {
    const nid = this.syscallToNid.get(syscallCode);



    const handler = this.handlers.get(syscallCode);
    if (!handler) {
      // Rate-limit: only log once per unique syscall code
      if (!this.warnedSyscalls.has(syscallCode)) {
        this.warnedSyscalls.add(syscallCode);
        const nidHex = nid != null ? nid.toString(16).padStart(8, "0") : null;
        const name   = nid != null ? (NID_NAMES.get(nid) ?? null) : null;
        const nidStr = nidHex != null
          ? (name != null ? `${name} (0x${nidHex})` : `0x${nidHex}`)
          : "unknown NID";
        log.warn(`Unimplemented syscall 0x${syscallCode.toString(16).padStart(5, "0")} — ${nidStr}`);
      }
      regs.setGpr(2, 0); // return success to avoid game bail-out
      return;
    }
    handler(regs, this.bus);
  }

  // ── Thread context save/restore & scheduling ───────────────────────────

  /** Save CPU state into thread context */
  saveContext(thread: Thread, regs: AllegrexRegisters): void {
    thread.context.gpr.set(regs.gpr);
    thread.context.hi = regs.hi;
    thread.context.lo = regs.lo;
    thread.context.pc = regs.pc;
    thread.context.fpr.set(regs.fpr);
    thread.context.fcr31 = regs.fcr31;
    thread.context.vfpr.set(regs.vfpr);
    thread.context.vfpuCtrl.set(regs.vfpuCtrl);
    thread.context.vfpuCc = regs.vfpuCc;
    thread.context.vpfxs = regs.vpfxs;
    thread.context.vpfxt = regs.vpfxt;
    thread.context.vpfxd = regs.vpfxd;
    thread.context.vpfxsEnabled = regs.vpfxsEnabled;
    thread.context.vpfxtEnabled = regs.vpfxtEnabled;
    thread.context.vpfxdEnabled = regs.vpfxdEnabled;
  }

  /** Restore CPU state from thread context */
  restoreContext(thread: Thread, regs: AllegrexRegisters): void {
    regs.gpr.set(thread.context.gpr);
    regs.hi = thread.context.hi;
    regs.lo = thread.context.lo;
    regs.pc = thread.context.pc;
    regs.fpr.set(thread.context.fpr);
    regs.fcr31 = thread.context.fcr31;
    regs.vfpr.set(thread.context.vfpr);
    regs.vfpuCtrl.set(thread.context.vfpuCtrl);
    regs.vfpuCc = thread.context.vfpuCc;
    regs.vpfxs = thread.context.vpfxs;
    regs.vpfxt = thread.context.vpfxt;
    regs.vpfxd = thread.context.vpfxd;
    regs.vpfxsEnabled = thread.context.vpfxsEnabled;
    regs.vpfxtEnabled = thread.context.vpfxtEnabled;
    regs.vpfxdEnabled = thread.context.vpfxdEnabled;
  }

  /**
   * Insert a pre-built thread directly into the scheduler.
   * Intended for unit tests that need fine-grained control over thread state
   * without going through the full sceKernelCreateThread syscall path.
   */
  addThreadForTest(thread: Thread): void {
    this.threads.set(thread.id, thread);
  }

  /** Returns true if any thread is currently in the RUNNING state. */
  hasRunningThread(): boolean {
    for (const thread of this.threads.values()) {
      if (thread.state === ThreadState.RUNNING) return true;
    }
    return false;
  }

  /** Pick highest-priority READY thread and switch to it. Returns true if a thread was found. */
  reschedule(regs: AllegrexRegisters): boolean {
    // Save current thread
    const current = this.currentThreadId > 0 ? this.threads.get(this.currentThreadId) : null;
    if (current && current.state === ThreadState.RUNNING) {
      current.state = ThreadState.READY;
      this.saveContext(current, regs);
    }

    // Find highest-priority READY thread (lowest priority number = highest priority)
    let best: Thread | null = null;
    for (const t of this.threads.values()) {
      if (t.state === ThreadState.READY) {
        if (!best || t.priority < best.priority) best = t;
      }
    }

    if (best) {
      best.state = ThreadState.RUNNING;
      this.currentThreadId = best.id;
      log.debug(`reschedule→tid=${best.id} pc=0x${best.context.pc.toString(16)} sp=0x${best.context.gpr[29]!.toString(16)}`);
      this.restoreContext(best, regs);
      regs.setGpr(26, best.k0); // $k0 = TCB
      return true;
    }
    return false;
  }

  /**
   * Yield the current thread's timeslice to any READY thread with lower priority.
   * Unlike reschedule(), this excludes the current thread from selection so that
   * a lower-priority READY thread actually gets CPU time.  The yielding thread
   * is marked READY and will resume when the other thread blocks or yields.
   * Returns true if another thread was scheduled.
   */
  yieldToOtherThread(regs: AllegrexRegisters): boolean {
    const current = this.threads.get(this.currentThreadId);
    if (!current) return false;

    // Find a different READY thread
    let best: Thread | null = null;
    for (const t of this.threads.values()) {
      if (t.id !== current.id && t.state === ThreadState.READY) {
        if (!best || t.priority < best.priority) best = t;
      }
    }

    if (best) {
      current.state = ThreadState.READY;
      this.saveContext(current, regs);
      best.state = ThreadState.RUNNING;
      this.currentThreadId = best.id;
      this.restoreContext(best, regs);
      regs.setGpr(26, best.k0);
      return true;
    }
    return false;
  }

  /** Mark current thread as DEAD, wake any threads waiting on it, and reschedule. */
  exitCurrentThread(regs: AllegrexRegisters): boolean {
    const dyingId = this.currentThreadId;
    const t = this.threads.get(dyingId);
    if (t) {
      t.state = ThreadState.DEAD;
      this.saveContext(t, regs);
      this.pspFs.threadEnded(dyingId);
    }
    // Wake any threads waiting for this thread to end
    for (const w of this.threads.values()) {
      if (w.state === ThreadState.WAITING && w.waitType === WaitType.THREAD_END && w.waitThreadEndId === dyingId) {
        w.state = ThreadState.READY;
        w.waitType = WaitType.NONE;
        w.waitThreadEndId = 0;
      }
    }
    return this.reschedule(regs);
  }

  /**
   * Suspend the current thread until the next VBlank.
   * Used by audio output handlers to simulate blocking output calls.
   * Sets $v0 = 0 in the woken thread's context.
   */
  blockCurrentThreadOnVblank(regs: AllegrexRegisters): void {
    const t = this.threads.get(this.currentThreadId);
    if (t) {
      t.state    = ThreadState.WAITING;
      t.waitType = WaitType.VBLANK;
      this.saveContext(t, regs);
      t.context.gpr[2] = 0;
      if (!this.reschedule(regs)) this.idleBreak = true;
    } else {
      regs.setGpr(2, 0);
    }
  }

  /**
   * Block the current audio thread for the real-time duration of `sampleCount`
   * samples at `sampleRate` Hz, using a wall-clock deadline (performance.now).
   *
   * Wall-clock timing is used instead of step-count timing because the CPU
   * run loop exits early (idleBreak) whenever all other threads are sleeping,
   * making step counts an unreliable proxy for elapsed time.
   *
   * `wakeAudioThreads()` must be called each frame (in runFrame) to poll the
   * deadlines and reschedule threads whose time has come.
   */
  blockForAudio(regs: AllegrexRegisters, sampleCount: number, sampleRate: number): void {
    const durationMs = (sampleCount / sampleRate) * 1_000;
    const t = this.threads.get(this.currentThreadId);
    if (t) {
      t.state            = ThreadState.WAITING;
      t.waitType         = WaitType.AUDIO;
      t.waitWakeTimeMs   = performance.now() + durationMs;
      this.saveContext(t, regs);
      t.context.gpr[2]   = 0;
      if (!this.reschedule(regs)) this.idleBreak = true;
    } else {
      regs.setGpr(2, 0);
    }
  }

  /**
   * Block the current thread until an ATRAC decode completes.
   * `wakeCallback` is called (with bus access) just before the thread resumes,
   * so it can write the decode output to guest memory.
   */
  blockAtracDecode(regs: AllegrexRegisters, wakeCallback: () => void): void {
    const t = this.threads.get(this.currentThreadId);
    if (t) {
      t.state               = ThreadState.WAITING;
      t.waitType            = WaitType.ATRAC_DECODE;
      t.pendingWakeCallback = wakeCallback;
      this.saveContext(t, regs);
      t.context.gpr[2] = 0; // v0 = 0 (success, written to saved context)
      if (!this.reschedule(regs)) this.idleBreak = true;
    } else {
      wakeCallback();
    }
  }

  /**
   * Wake any AUDIO-waiting threads whose wall-clock deadline has passed,
   * and any threads whose ATRAC decode has completed.
   * Call this at the start of every emulator frame.
   */
  wakeAudioThreads(regs: AllegrexRegisters): void {
    const now = performance.now();
    let woke = false;
    for (const t of this.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.AUDIO && now >= t.waitWakeTimeMs) {
        t.state    = ThreadState.READY;
        t.waitType = WaitType.NONE;
        woke       = true;
      }
    }
    // Wake threads whose ATRAC decode completed (signalled from Promise callback)
    if (this.pendingAtracWakes.size > 0) {
      for (const tid of this.pendingAtracWakes) {
        const t = this.threads.get(tid);
        if (t && t.state === ThreadState.WAITING && t.waitType === WaitType.ATRAC_DECODE) {
          t.pendingWakeCallback?.();
          t.pendingWakeCallback = undefined;
          t.state    = ThreadState.READY;
          t.waitType = WaitType.NONE;
          woke       = true;
        }
      }
      this.pendingAtracWakes.clear();
    }
    if (woke && !this.hasRunningThread()) {
      this.idleBreak = false;
      this.reschedule(regs);
    }
  }

  /**
   * Called each VBlank — mirrors PPSSPP DisplayFireVblankStart (Display.cpp:239-248)
   * then drains GE completions and wakes sleeping threads.
   */
  onVblank(regs: AllegrexRegisters): void {
    // DisplayFireVblankStart (Display.cpp:240-248)
    this.frameStartTicks = this.coreTiming?.getTicks() ?? 0;
    this.isVblank = true;
    this.hCountBase += HLEKernel.HCOUNT_PER_VBLANK;
    if (this.hCountBase > 0x7FFFFFFF) {
      this.hCountBase -= 0x80000000;
    }

    this.drainGeCompletions(regs);
    this.vblankCount++;
    let woke = false;
    // Wake draw-sync waiters at VBlank if no active lists remain
    if (!this.hasActiveGeLists()) {
      for (const t of this.threads.values()) {
        if (t.state === ThreadState.WAITING && t.waitType === WaitType.GE_DRAW_SYNC) {
          t.state = ThreadState.READY;
          t.waitType = WaitType.NONE;
          woke = true;
        }
      }
    }
    for (const t of this.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.VBLANK) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0;
        woke = true;
      }
    }
    if (woke) {
      this.reschedule(regs);
    }
  }

  /**
   * Called when VBlank period ends — mirrors PPSSPP DisplayFireVblankEnd (Display.cpp:251-252).
   */
  onVblankEnd(): void {
    this.isVblank = false;
  }

  /**
   * Check and dispatch pending callbacks on the current thread using PPSSPP's
   * MipsCall mechanism (sceKernelThread.cpp:3078-3132).
   *
   * Instead of running the callback in a mini CPU loop, this redirects the CPU's
   * PC/RA/args so the callback runs as normal MIPS code. When the callback does
   * `jr $ra`, it hits our trampoline which fires returnFromMipsCall(),
   * restoring the original state.
   *
   * This is critical: the callback uses the game's own stack (shifted down by 128
   * bytes), so its frame is properly below the caller's — no sibling-frame overlap.
   *
   * Returns true if a callback was dispatched (CPU is now running the callback).
   */
  processThreadCallbacks(regs: AllegrexRegisters): boolean {
    if (this.activeMipsCall) return false; // already in a callback

    const t = this.threads.get(this.currentThreadId);
    if (!t || !t.isProcessingCallbacks) return false;

    for (const cbId of t.callbacks) {
      const cb = this.pspCallbacks.get(cbId);
      if (cb && cb.notifyCount > 0) {
        const count = cb.notifyCount;
        const arg = cb.notifyArg;
        cb.notifyCount = 0;
        cb.notifyArg = 0;

        // Write the callback-return trampoline on first use
        // Uses the same pattern as the module-return trampoline: jr $ra; syscall N
        // But since the stub pattern is different for trampolines, we write:
        //   SYSCALL (cbReturn) followed by NOP
        if (!this.cbReturnTrampolineWritten) {
          const SYSCALL = 0x0000000c | (HLEKernel.SYSCALL_CB_RETURN << 6);
          this.bus.writeU32(this.cbReturnTrampolineAddr, SYSCALL);
          this.bus.writeU32(this.cbReturnTrampolineAddr + 4, 0); // NOP
          this.register(HLEKernel.SYSCALL_CB_RETURN, (regs2) => {
            this.returnFromMipsCall(regs2);
          });
          this.cbReturnTrampolineWritten = true;
        }

        // PPSSPP __KernelExecuteMipsCallOnCurrentThread (line 3094-3131):
        // 1. Grab 128 bytes of stack space
        const REGS_SIZE = 32 * 4; // 128 bytes
        const sp = regs.getGpr(29);
        const newSp = sp - REGS_SIZE;

        // 2. Save caller-saved regs to the game's stack
        for (let i = 4; i <= 15; i++) {
          this.bus.writeU32(newSp + i * 4, regs.getGpr(i));
        }
        this.bus.writeU32(newSp + 24 * 4, regs.getGpr(24));
        this.bus.writeU32(newSp + 25 * 4, regs.getGpr(25));
        this.bus.writeU32(newSp + 31 * 4, regs.getGpr(31));

        // 3. Save PC, $v0, $v1
        this.activeMipsCall = {
          savedPc: regs.pc,
          savedV0: regs.getGpr(2),
          savedV1: regs.getGpr(3),
          savedRegsOnStack: true,
          threadId: this.currentThreadId,
          savedWaitType: t.waitType,
          savedIsProcessingCallbacks: t.isProcessingCallbacks,
          savedThreadState: t.state,
        };

        // 4. Redirect CPU to callback
        regs.setGpr(29, newSp);
        regs.pc = cb.entrypoint;
        regs.setGpr(31, this.cbReturnTrampolineAddr);
        regs.setGpr(4, count);
        regs.setGpr(5, arg);
        regs.setGpr(6, cb.commonArg);

        log.debug(`MipsCall: callback 0x${cb.entrypoint.toString(16)} tid=${this.currentThreadId}`);
        return true;
      }
    }

    t.isProcessingCallbacks = false;
    return false;
  }

  /**
   * Handle return from a MipsCall callback.
   * PPSSPP sceKernelThread.cpp:3134-3190 __KernelReturnFromMipsCall.
   */
  returnFromMipsCall(regs: AllegrexRegisters): void {
    const call = this.activeMipsCall;
    if (!call) {
      log.warn("returnFromMipsCall with no active call");
      return;
    }
    this.activeMipsCall = null;

    // Restore saved registers from game stack (PPSSPP line 3157-3164)
    const sp = regs.getGpr(29);
    for (let i = 4; i <= 15; i++) {
      regs.setGpr(i, this.bus.readU32(sp + i * 4));
    }
    regs.setGpr(24, this.bus.readU32(sp + 24 * 4));
    regs.setGpr(25, this.bus.readU32(sp + 25 * 4));
    regs.setGpr(31, this.bus.readU32(sp + 31 * 4));
    regs.setGpr(29, sp + 32 * 4); // restore $sp

    // Restore PC and $v0/$v1 (PPSSPP line 3168-3171)
    regs.pc = call.savedPc;
    regs.setGpr(2, call.savedV0);
    regs.setGpr(3, call.savedV1);

    // Restore thread state (PPSSPP ActionAfterMipsCall::run line 2832-2852)
    const t = this.threads.get(call.threadId);
    if (t) {
      t.isProcessingCallbacks = call.savedIsProcessingCallbacks;
      // Check for more pending callbacks
      if (t.isProcessingCallbacks) {
        this.processThreadCallbacks(regs);
      }
    }
  }

  // ── Built-in module registrations ──────────────────────────────────────────

  private registerBuiltins(): void {
    this.registerFontHandlers();
    this.registerGe();
  }

  // ── sceGe ────────────────────────────────────────────────────────────────

  private registerGe(): void {
    // sceGeEdramGetAddr — return VRAM start
    this.register(GE.sceGeEdramGetAddr, (regs) => {
      regs.setGpr(2, 0x04000000);
    });

    // sceGeSetCallback(cbdata) — register GE callback, return ID
    // PPSSPP sceGe.cpp:474-508: uses fixed 16-slot array, finds first free slot.
    this.register(GE.sceGeSetCallback, (regs) => {
      const cbdata = regs.getGpr(4);
      // Find first free slot in [0, 16) — matches PPSSPP ge_used_callbacks[16]
      let cbId = -1;
      for (let i = 0; i < 16; i++) {
        if (!this.geCallbacks.has(i)) {
          cbId = i;
          break;
        }
      }
      if (cbId === -1) {
        regs.setGpr(2, 0x80000022); // SCE_KERNEL_ERROR_OUT_OF_MEMORY
        return;
      }
      // PspGeCallbackData struct:
      //   +0: signal_func pointer
      //   +4: signal_arg pointer
      //   +8: finish_func pointer
      //  +12: finish_arg pointer
      const signalFunc = this.bus.readU32(cbdata + 0);
      const signalArg  = this.bus.readU32(cbdata + 4);
      const finishFunc = this.bus.readU32(cbdata + 8);
      const finishArg  = this.bus.readU32(cbdata + 12);
      this.geCallbacks.set(cbId, { signalFunc, signalArg, finishFunc, finishArg });
      this.activeGeCbId = cbId;
      regs.setGpr(2, cbId);
    });

    // sceGeListEnQueue(list, stall, cbid, arg) — queue display list
    // PPSSPP sceGe.cpp:353-373, GPUCommon.cpp:349-466
    this.register(GE.sceGeListEnQueue, (regs) => {
      const listAddr = regs.getGpr(4);
      const stallAddr = regs.getGpr(5);

      // GPUCommon.cpp:356 — validate 4-byte alignment
      if (((listAddr | stallAddr) & 3) !== 0) {
        regs.setGpr(2, 0x80000103); // SCE_KERNEL_ERROR_INVALID_POINTER
        return;
      }

      const listId = this.nextGeListId++;
      const entry: GeListEntry = {
        id: listId, listAddr, pc: listAddr, stallAddr,
        state: GeListState.DRAWING,
      };
      this.geLists.set(listId, entry);
      this.geListQueue.push(listId);
      this.geDispatcher?.enqueue(listId, listAddr, stallAddr);
      regs.setGpr(2, GE_LIST_ID_MAGIC ^ listId);
    });

    // sceGeListUpdateStallAddr(listId, stallAddr) — advance stall for ring buffer
    this.register(GE.sceGeListUpdateStallAddr, (regs) => {
      const listId = regs.getGpr(4) ^ GE_LIST_ID_MAGIC;
      const newStall = regs.getGpr(5);
      const entry = this.geLists.get(listId);
      if (entry) {
        entry.stallAddr = newStall;
        if (entry.state === GeListState.COMPLETED) {
          // Ring buffer wrap: restart from listAddr
          entry.pc = entry.listAddr;
          entry.state = GeListState.DRAWING;
          if (!this.geListQueue.includes(listId)) {
            this.geListQueue.push(listId);
          }
          this.geDispatcher?.enqueue(listId, entry.listAddr, newStall);
        } else {
          this.geDispatcher?.updateStall(newStall);
        }
      }
      regs.setGpr(2, 0);
    });

    // sceGeListSync(listId, syncType) — wait for a specific list
    // PPSSPP GPUCommon.cpp:224-268 — mode 0 = wait, mode 1 = poll
    this.register(GE.sceGeListSync, (regs) => {
      const listId = regs.getGpr(4) ^ GE_LIST_ID_MAGIC;
      const syncType = regs.getGpr(5);

      // GPUCommon.cpp:230-231 — validate mode
      if (syncType < 0 || syncType > 1) {
        regs.setGpr(2, 0x80000107); // SCE_KERNEL_ERROR_INVALID_MODE
        return;
      }

      const entry = this.geLists.get(listId);

      if (syncType === 1) {
        // Poll mode: return list state
        regs.setGpr(2, entry ? entry.state : GeListState.COMPLETED);
        return;
      }

      if (!entry || entry.state === GeListState.COMPLETED || entry.state === GeListState.NONE) {
        regs.setGpr(2, 0);
        return;
      }

      // Block until this list finishes
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.GE_LIST_SYNC;
        t.waitGeListId = listId;
        this.saveContext(t, regs);
        t.context.gpr[2] = 0;
        if (!this.reschedule(regs)) {
          // No other threads — busy-poll up to 8ms
          const deadline = performance.now() + 8;
          while (performance.now() < deadline) {
            const done = this.geDispatcher?.drainCompletions() ?? [];
            for (const id of done) this._completeGeList(id);
            const currentEntry = this.geLists.get(listId);
            if (!currentEntry || currentEntry.state === GeListState.COMPLETED) break;
          }
          t.state = ThreadState.READY;
          t.waitType = WaitType.NONE;
          this.restoreContext(t, regs);
          regs.setGpr(2, 0);
        }
      } else {
        regs.setGpr(2, 0);
      }
    });

    // sceGeDrawSync(syncType) — wait for all GE lists to finish
    // PPSSPP GPUCommon.cpp:174-215 — mode 0 = wait, mode 1 = poll
    this.register(GE.sceGeDrawSync, (regs) => {
      const syncType = regs.getGpr(4);

      // GPUCommon.cpp:177-178 — validate mode
      if (syncType < 0 || syncType > 1) {
        regs.setGpr(2, 0x80000107); // SCE_KERNEL_ERROR_INVALID_MODE
        return;
      }

      if (syncType === 1) {
        // Poll mode: return PSP_GE_LIST_DRAWING (2) or PSP_GE_LIST_COMPLETED (0)
        regs.setGpr(2, this.hasActiveGeLists() ? 2 : 0);
        return;
      }

      if (!this.hasActiveGeLists()) {
        this._wakeGeDrawSyncWaiters();
        regs.setGpr(2, 0);
        return;
      }

      // Block calling thread until all GE work completes
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.GE_DRAW_SYNC;
        this.saveContext(t, regs);
        t.context.gpr[2] = 0;
        if (!this.reschedule(regs)) {
          // No other threads — busy-poll up to 8ms
          const deadline = performance.now() + 8;
          while (performance.now() < deadline && this.hasActiveGeLists()) {
            const done = this.geDispatcher?.drainCompletions() ?? [];
            for (const id of done) this._completeGeList(id);
          }
          t.state = ThreadState.READY;
          t.waitType = WaitType.NONE;
          this.restoreContext(t, regs);
          regs.setGpr(2, 0);
        }
      } else {
        regs.setGpr(2, 0);
      }
    });

    // sceGeEdramGetSize — return 2MB
    this.register(GE.sceGeEdramGetSize, (regs) => {
      regs.setGpr(2, 0x00200000);
    });

    // sceGeUnsetCallback(cbId) — PPSSPP sceGe.cpp:510-527
    // Validates cbId < 16, marks callback slot as unused, returns 0.
    this.register(GE.sceGeUnsetCallback, (regs) => {
      const cbId = regs.getGpr(4);
      if (cbId < 0 || cbId >= 16) {
        regs.setGpr(2, 0x80000100); // SCE_KERNEL_ERROR_INVALID_ID
        return;
      }
      this.geCallbacks.delete(cbId);
      if (this.activeGeCbId === cbId) this.activeGeCbId = 0;
      regs.setGpr(2, 0);
    });

    // sceGeBreak(mode, unknownPtr) — PPSSPP sceGe.cpp:453-472, GPUCommon.cpp:545-607
    // mode 0: pause current list, return LIST_ID_MAGIC ^ listId
    // mode 1: clear all lists, return 0
    this.register(GE.sceGeBreak, (regs) => {
      const mode = regs.getGpr(4);
      if (mode > 1) {
        regs.setGpr(2, 0x80000107); // SCE_KERNEL_ERROR_INVALID_MODE
        return;
      }

      if (this.geListQueue.length === 0) {
        // GPUCommon::Break — no currentList → SCE_KERNEL_ERROR_ALREADY
        regs.setGpr(2, 0x80000020); // SCE_KERNEL_ERROR_ALREADY (ErrorCodes.h:8)
        return;
      }

      if (mode === 1) {
        // GPUCommon.cpp:553-564 — clear ALL lists, does NOT set isbreak
        for (const entry of this.geLists.values()) {
          entry.state = GeListState.NONE;
        }
        this.geListQueue.length = 0;
        this.nextGeListId = 1;
        // Note: mode 1 does NOT set isbreak (GPUCommon.cpp:564 returns 0, no isbreak=true)
        regs.setGpr(2, 0);
        return;
      }

      // mode === 0: pause current (front of queue)
      const listId = this.geListQueue[0]!;
      const entry = this.geLists.get(listId);
      if (!entry) {
        regs.setGpr(2, 0x80000020); // SCE_KERNEL_ERROR_ALREADY
        return;
      }

      // GPUCommon.cpp:567-572 — NONE/COMPLETED → error
      if (entry.state === GeListState.NONE || entry.state === GeListState.COMPLETED) {
        regs.setGpr(2, 0x80000004); // SCE_KERNEL_ERROR_BAD_ARGUMENT (SDK >= 2.0)
        return;
      }
      // GPUCommon.cpp:574-586 — already PAUSED → SCE_KERNEL_ERROR_BUSY
      if (entry.state === GeListState.PAUSED) {
        regs.setGpr(2, 0x80000021); // SCE_KERNEL_ERROR_BUSY
        return;
      }

      // GPUCommon.cpp:588-606 — pause (QUEUED or DRAWING)
      entry.state = GeListState.PAUSED;
      this.geIsBreak = true;
      regs.setGpr(2, GE_LIST_ID_MAGIC ^ listId);
    });

    // sceGeContinue() — PPSSPP sceGe.cpp:438-451, GPUCommon.cpp:504-543
    // Resumes after sceGeBreak. If isbreak: set QUEUED. Else: set RUNNING.
    this.register(GE.sceGeContinue, (regs) => {
      if (this.geListQueue.length === 0) {
        // GPUCommon.cpp:506-507 — no currentList
        regs.setGpr(2, 0);
        return;
      }

      const listId = this.geListQueue[0]!;
      const entry = this.geLists.get(listId);
      if (!entry) {
        regs.setGpr(2, 0);
        return;
      }

      if (entry.state === GeListState.PAUSED) {
        if (!this.geIsBreak) {
          // GPUCommon.cpp:515-516 — resume running
          entry.state = GeListState.DRAWING;
        } else {
          // GPUCommon.cpp:524-525 — set queued after break
          entry.state = GeListState.QUEUED;
        }
        this.geIsBreak = false;
        // Re-enqueue to worker for processing
        this.geDispatcher?.enqueue(listId, entry.pc, entry.stallAddr);
        regs.setGpr(2, 0);
      } else if (entry.state === GeListState.DRAWING) {
        // GPUCommon.cpp:528-531
        regs.setGpr(2, 0x80000020);
      } else {
        // GPUCommon.cpp:534-537
        regs.setGpr(2, 0x80000004);
      }
    });

    // sceGeGetStack(index, stackPtr) — PPSSPP GPUCommon.cpp:270-293
    // Returns current call stack depth. Our GE worker doesn't expose the call stack,
    // so return 0 (empty stack) which is the common case.
    this.register(GE.sceGeGetStack, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceGeListEnQueueHead(list, stall, cbid, arg) — PPSSPP sceGe.cpp:375-395
    // Same as sceGeListEnQueue but inserts at front of queue (head=true).
    // GPUCommon.cpp:438-450: if currentList is not PAUSED → SCE_KERNEL_ERROR_INVALID_VALUE.
    this.register(GE.sceGeListEnQueueHead, (regs) => {
      const listAddr  = regs.getGpr(4);
      const stallAddr = regs.getGpr(5);

      // Validate alignment (GPUCommon.cpp:356)
      if (((listAddr | stallAddr) & 3) !== 0) {
        regs.setGpr(2, 0x80000103); // SCE_KERNEL_ERROR_INVALID_POINTER
        return;
      }

      const listId = this.nextGeListId++;
      const entry: GeListEntry = {
        id: listId, listAddr, pc: listAddr, stallAddr,
        state: GeListState.PAUSED, // GPUCommon.cpp:447 — head list starts PAUSED
      };

      // If there's a current front list, it must be PAUSED to enqueue at head
      if (this.geListQueue.length > 0) {
        const frontId = this.geListQueue[0]!;
        const front = this.geLists.get(frontId);
        if (front && front.state !== GeListState.PAUSED) {
          // GPUCommon.cpp:440-441
          regs.setGpr(2, 0x800001fe); // SCE_KERNEL_ERROR_INVALID_VALUE
          return;
        }
        // GPUCommon.cpp:442-444 — demote current to QUEUED
        if (front) {
          front.state = GeListState.QUEUED;
        }
      }

      this.geLists.set(listId, entry);
      this.geListQueue.unshift(listId); // Insert at HEAD (GPUCommon.cpp:450)
      this.geDispatcher?.enqueue(listId, listAddr, stallAddr);
      regs.setGpr(2, GE_LIST_ID_MAGIC ^ listId);
    });

    // sceGeListDeQueue(listId) — PPSSPP sceGe.cpp:397-402, GPUCommon.cpp:468-488
    // Removes a queued (not yet started) display list.
    this.register(GE.sceGeListDeQueue, (regs) => {
      const listId = regs.getGpr(4) ^ GE_LIST_ID_MAGIC;
      const entry = this.geLists.get(listId);
      if (!entry || entry.state === GeListState.NONE) {
        regs.setGpr(2, 0x80000100); // SCE_KERNEL_ERROR_INVALID_ID
        return;
      }
      // GPUCommon.cpp:473-474 — if started (DRAWING), return BUSY
      if (entry.state === GeListState.DRAWING) {
        regs.setGpr(2, 0x80000021); // SCE_KERNEL_ERROR_BUSY
        return;
      }
      // GPUCommon.cpp:476-487 — remove from queue, wake waiters
      entry.state = GeListState.NONE;
      const idx = this.geListQueue.indexOf(listId);
      if (idx >= 0) this.geListQueue.splice(idx, 1);
      this._wakeGeListWaiters(listId);
      if (!this.hasActiveGeLists()) this._wakeGeDrawSyncWaiters();
      regs.setGpr(2, 0);
    });

    // sceGeEdramSetAddrTranslation(new_size) — PPSSPP sceGe.cpp:611-622, GPUCommon.cpp:712-715
    // Validates: 0 or power-of-two in [0x200, 0x1000]. Swaps old/new, returns old.
    this.register(GE.sceGeEdramSetAddrTranslation, (regs) => {
      const newSize = regs.getGpr(4);
      const outsideRange = newSize !== 0 && (newSize < 0x200 || newSize > 0x1000);
      const notPowerOfTwo = newSize !== 0 && (newSize & (newSize - 1)) !== 0;
      if (outsideRange || notPowerOfTwo) {
        regs.setGpr(2, 0x800001fe); // SCE_KERNEL_ERROR_INVALID_VALUE
        return;
      }
      // GPUCommon.cpp:713 — std::swap(edramTranslation_, value); return value;
      const old = this.geEdramTranslation;
      this.geEdramTranslation = newSize;
      regs.setGpr(2, old);
    });

    // sceGeSaveContext(ctxAddr) — PPSSPP sceGe.cpp:531-545, GPUState.cpp:122-168
    // Saves GE command state (256 cmds + matrices) to memory.
    // Our GE state lives in a Web Worker — we write a minimal context
    // (cmdmem[i] = i << 24, zeroed matrices) matching GPUgstate::Reset() defaults.
    this.register(GE.sceGeSaveContext, (regs, bus) => {
      const ctxAddr = regs.getGpr(4);
      if (ctxAddr === 0) {
        regs.setGpr(2, -1);
        return;
      }
      // GPUState.cpp:122-168 context layout:
      // ptr[0..16]: header (vertexAddr at [5], indexAddr at [6], offsetAddr at [7])
      // ptr[17..]: command words + matrix data
      // Total: ~512 u32s — zero-fill for a clean default context.
      for (let i = 0; i < 512; i++) {
        bus.writeU32(ctxAddr + i * 4, 0);
      }
      regs.setGpr(2, 0);
    });

    // sceGeRestoreContext(ctxAddr) — PPSSPP sceGe.cpp:547-558, GPUState.cpp:205-239
    // If GPU busy → SCE_KERNEL_ERROR_BUSY. If valid addr, restores gstate from memory.
    // Since our GE state is in the worker, we accept the call and skip the actual restore.
    // PPSSPP only guards with BusyDrawing() and Memory::IsValidAddress(), not null check.
    this.register(GE.sceGeRestoreContext, (regs) => {
      // PPSSPP sceGe.cpp:548-549 — gpu->BusyDrawing() check omitted (we don't track busy state)
      // If ctxAddr is valid, PPSSPP calls gstate.Restore() + gpu->ReapplyGfxState()
      // We skip the actual restore since GE state is in the worker.
      regs.setGpr(2, 0);
    });

    // sceGeGetCmd(cmd) — PPSSPP sceGe.cpp:575-605
    // Returns gstate.cmdmem[cmd]. Matrix data commands are masked.
    // Since our GE state is in the worker, return default (cmd << 24).
    this.register(GE.sceGeGetCmd, (regs) => {
      const cmd = regs.getGpr(4);
      if (cmd < 0 || cmd >= 256) {
        regs.setGpr(2, 0x80000102); // SCE_KERNEL_ERROR_INVALID_INDEX (ErrorCodes.h:14)
        return;
      }
      // GPUgstate::Reset — cmdmem[i] = i << 24 (GPUState.cpp:107)
      regs.setGpr(2, cmd << 24);
    });

    // sceGeGetMtx(type, matrixPtr) — PPSSPP sceGe.cpp:560-573, GPUCommon.cpp:302-330
    // Reads a matrix (12 or 16 float24 values). Since GE state is in worker, return zeros.
    this.register(GE.sceGeGetMtx, (regs, bus) => {
      const type = regs.getGpr(4);
      const matrixPtr = regs.getGpr(5);
      // ge_constants.h:349-360:
      // GE_MTX_BONE0..7 = 0..7, GE_MTX_WORLD = 8, GE_MTX_VIEW = 9,
      // GE_MTX_PROJECTION = 10 (4×4 = 16 floats), GE_MTX_TEXGEN = 11 (3×4 = 12 floats)
      if (type < 0 || type > 11) {
        regs.setGpr(2, 0x80000102); // SCE_KERNEL_ERROR_INVALID_INDEX (ErrorCodes.h:14)
        return;
      }
      if (matrixPtr === 0) {
        regs.setGpr(2, -1);
        return;
      }
      const size = type === 10 ? 16 : 12; // GE_MTX_PROJECTION (10) is 4×4, others are 3×4
      for (let i = 0; i < size; i++) {
        bus.writeU32(matrixPtr + i * 4, 0);
      }
      regs.setGpr(2, 0);
    });
  }


  // ── GE signal callback invoker ───────────────────────────────────────────

  /**
   * Address of the BREAK instruction used as a return trampoline for GE signal
   * callbacks.  Written to RAM during the first _invokeGeSignal call.
   */
  // Placed in low kernel RAM [0x08000000, 0x08400000) — always within the CPU's valid execution
  // range and never touched by user ELF segments (which start at 0x08800000+).
  // PPSSPP equivalent: intReturnHackAddr allocated from kernelMemory (same region).
  private geCallbackTrampolineAddr = 0x08000010;
  private geCallbackTrampolineWritten = false;

  /**
   * Invoke the registered GE signal_func by running the CPU as a mini
   * call frame.  Called from the GEProcessor.signalCallback closure during
   * GE list execution.
   *
   * Saves the entire CPU register state, sets up the call (a0=signalId,
   * a1=signalArg, ra=GE trampoline, pc=signal_func), runs the CPU until
   * the BREAK at the trampoline, then restores registers.
   */
  /**
   * Fire the registered GE finish_func callback.  Called after executeList
   * returns -1 (END command hit) to mimic the PSP GE finish interrupt.
   * sceGu uses this to reset the ring-buffer write pointer and allow the next
   * frame to reuse the buffer.
   */
  private _invokeGeFinish(): void {
    const cb = this.geCallbacks.get(this.activeGeCbId);
    if (!cb || cb.finishFunc === 0) return;
    this._invokeGeCb(cb.finishFunc, 0 /* finish id is always 0 */, cb.finishArg);
  }

  private _invokeGeSignal(signalId: number): void {
    const cb = this.geCallbacks.get(this.activeGeCbId);
    if (!cb || cb.signalFunc === 0) return;
    this._invokeGeCb(cb.signalFunc, signalId, cb.signalArg);
  }

  /** Are there any GE lists still being processed? */
  hasActiveGeLists(): boolean {
    // Check dispatcher's pending queue first (authoritative when worker is active)
    if (this.geDispatcher?.hasActive()) return true;
    // Also check kernel's own list queue for non-completed lists
    for (const id of this.geListQueue) {
      const e = this.geLists.get(id);
      if (e && e.state !== GeListState.COMPLETED) return true;
    }
    return false;
  }

  private _completeGeList(listId: number): void {
    const entry = this.geLists.get(listId);
    if (entry) {
      entry.state = GeListState.COMPLETED;
      const idx = this.geListQueue.indexOf(listId);
      if (idx >= 0) this.geListQueue.splice(idx, 1);
    }
    this._invokeGeFinish();
    this._wakeGeListWaiters(listId);
  }

  drainGeCompletions(regs: AllegrexRegisters): void {
    if (this.geDispatcher) {
      const done = this.geDispatcher.drainCompletions();
      for (const id of done) this._completeGeList(id);
    }

    // Always check: wake draw-sync waiters when no active GE lists remain.
    // PPSSPP GPUCommon.cpp:215 — InterruptEnd wakes threads after last list finishes.
    if (!this.hasActiveGeLists()) {
      let woke = false;
      for (const t of this.threads.values()) {
        if (t.state === ThreadState.WAITING && t.waitType === WaitType.GE_DRAW_SYNC) {
          t.state = ThreadState.READY;
          t.waitType = WaitType.NONE;
          woke = true;
        }
      }
      if (woke && !this.hasRunningThread()) {
        this.reschedule(regs);
      }
    }
  }

  handleGeSignal(_regs: AllegrexRegisters): void {
    if (!this.geDispatcher) return;
    this.geDispatcher.handlePendingSignal((signalId) => {
      this._invokeGeSignal(signalId);
    });
  }

  private _wakeGeDrawSyncWaiters(): void {
    for (const t of this.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.GE_DRAW_SYNC) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
      }
    }
  }

  private _wakeGeListWaiters(listId: number): void {
    for (const t of this.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.GE_LIST_SYNC && t.waitGeListId === listId) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
      }
    }
  }

  /**
   * Invoke a GE callback function (signal_func or finish_func) by running
   * the CPU as a mini call frame.  This is needed because the sceGu ring
   * buffer threshold is managed by these callbacks in game code.
   *
   * Parameters:
   *   funcAddr  — address of the callback function
   *   a0        — first argument (signal/finish ID)
   *   a1        — second argument (signal/finish arg pointer)
   */
  _invokeGeCb(funcAddr: number, a0: number, a1: number, a2?: number): void {
    const cpu = this.cpu;
    if (!cpu || funcAddr === 0) return;

    // Validate: callback must be in RAM code/data space.
    // Accept RAM below the stack pool (kernel + user code, heap) and scratchpad.
    // PPSSPP: intReturnHackAddr is in kernelMemory [RAM_START, 0x08400000);
    //         user callbacks are in user RAM [0x08800000, ...).
    // Reject VRAM, the top-of-RAM stack region (nextStackTopAddr upward), etc.
    const phys = funcAddr & 0x1FFFFFFF;
    const stackPoolBase = this.nextStackTopAddr & 0x1FFFFFFF;   // stacks grow down from here
    const validCode = (phys >= MemoryRegion.RAM_START && phys < stackPoolBase) ||
                      (phys >= MemoryRegion.SCRATCHPAD_START &&
                       phys <  MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE);
    if (!validCode) {
      log.warn(`GE callback 0x${funcAddr.toString(16)} not in valid code region — skipping`);
      return;
    }

    // Write the BREAK trampoline on first use
    if (!this.geCallbackTrampolineWritten) {
      // BREAK 0 = opcode 0x0000000D
      this.bus.writeU32(this.geCallbackTrampolineAddr, 0x0000000D);
      this.bus.writeU32(this.geCallbackTrampolineAddr + 4, 0); // NOP (delay slot safety)
      this.geCallbackTrampolineWritten = true;
    }

    const regs = cpu.regs;

    // Save registers: all 32 GPRs + hi + lo + pc + delay slot
    const savedGpr = new Uint32Array(32);
    for (let i = 0; i < 32; i++) savedGpr[i] = regs.getGpr(i);
    const savedHi  = regs.hi;
    const savedLo  = regs.lo;
    const savedPc  = regs.pc;
    const savedInDelaySlot    = cpu.inDelaySlot;
    const savedDelaySlotTarget = cpu.delaySlotTarget;

    // Move $sp down to give the callback its own stack frame.
    // Without this, the callback's stack writes (e.g. saving $ra) corrupt the
    // caller's frame — the original memory is not restored, only the register is.
    // PPSSPP dispatches callbacks through the interrupt system which manages stack space;
    // we emulate this by reserving 512 bytes below the current $sp.
    const CALLBACK_STACK_SPACE = 512;
    const savedSp = regs.getGpr(29);
    regs.setGpr(29, savedSp - CALLBACK_STACK_SPACE);

    // Set up the call frame: a0, a1, a2(optional), ra=trampoline, pc=funcAddr
    regs.setGpr(4,  a0);
    regs.setGpr(5,  a1);
    if (a2 !== undefined) regs.setGpr(6, a2);
    regs.setGpr(31, this.geCallbackTrampolineAddr);
    regs.pc = funcAddr;
    cpu.inDelaySlot = false;

    // Install a one-shot onBreak that fires when the callback returns
    let returned = false;
    const prevOnBreak = cpu.onBreak;
    cpu.onBreak = (pc: number) => {
      if (pc === this.geCallbackTrampolineAddr) {
        returned = true;
        return true; // handled — suppress BREAK log in executor
      }
      return prevOnBreak ? prevOnBreak(pc) : false;
    };

    // Run CPU until callback returns to trampoline BREAK
    const MAX_CALLBACK_STEPS = 200_000;
    let steps = 0;
    while (!returned && !cpu.stepFaulted && steps < MAX_CALLBACK_STEPS) {
      cpu.step();
      steps++;
    }

    if (steps >= MAX_CALLBACK_STEPS) {
      log.warn(`GE callback exceeded step limit (funcAddr=0x${funcAddr.toString(16)})`);
    }
    // Restore CPU state — callbacks must not affect the main execution context
    cpu.onBreak = prevOnBreak;
    for (let i = 0; i < 32; i++) regs.setGpr(i, savedGpr[i]!);
    regs.hi = savedHi;
    regs.lo = savedLo;
    regs.pc = savedPc;
    cpu.inDelaySlot = savedInDelaySlot;
    cpu.delaySlotTarget = savedDelaySlotTarget;
    cpu.stepFaulted = false; // clear any fault from callback
  }

  // ── sceUtils / sceMisc ───────────────────────────────────────────────────


  // ── sceFont / sceLibFttt ─────────────────────────────────────────────────

  private registerFontHandlers(): void {
    // ── sceFont / sceLibFttt stubs ─────────────────────────────────────────
    //
    // NIDs verified against PPSSPP sceFont.cpp sceLibFont[] table.
    // One dummy font (handle=2), plausible 12×14px metrics, blank glyphs.
    //
    // Struct sizes (from PPSSPP PGF.h):
    //   PGFCharInfo  = 60 bytes
    //   PGFFontInfo  = 264 bytes (10×s32 + 10×f32 + s16+s16+s32+s32 + PGFFontStyle(168) + BPP+pad(4))
    //
    // All fixed-point metrics use 26.6 format (multiply pixels by 64).

    // Helper: write a float into PSP memory
    const writeF32 = (addr: number, v: number, bus: MemoryBus) => {
      const tmp = new DataView(new ArrayBuffer(4));
      tmp.setFloat32(0, v, true);
      bus.writeU32(addr, tmp.getUint32(0, true));
    };

    // Helper: fill PGFFontInfo (264 bytes) at ptr with 12×14px dummy metrics
    const writeFontInfo = (ptr: number, bus: MemoryBus) => {
      for (let i = 0; i < 264; i += 4) bus.writeU32(ptr + i, 0);
      const W26 = 12 * 64, H26 = 14 * 64;
      bus.writeU32(ptr +  0, W26); bus.writeU32(ptr +  4, H26); // maxGlyphWidth/HeightI
      bus.writeU32(ptr +  8, H26); bus.writeU32(ptr + 12, 0);   // ascender / descender
      bus.writeU32(ptr + 16, 0);   bus.writeU32(ptr + 20, H26); // leftX / baseY
      bus.writeU32(ptr + 24, 0);   bus.writeU32(ptr + 28, H26); // centerX / topY
      bus.writeU32(ptr + 32, W26); bus.writeU32(ptr + 36, H26); // advanceX / advanceY
      writeF32(ptr + 40, 12, bus); writeF32(ptr + 44, 14, bus);
      writeF32(ptr + 48, 14, bus); writeF32(ptr + 52,  0, bus);
      writeF32(ptr + 56,  0, bus); writeF32(ptr + 60, 14, bus);
      writeF32(ptr + 64,  0, bus); writeF32(ptr + 68, 14, bus);
      writeF32(ptr + 72, 12, bus); writeF32(ptr + 76, 14, bus);
      bus.writeU16(ptr + 80, 12); bus.writeU16(ptr + 82, 14); // maxGlyphWidth/Height px
      bus.writeU32(ptr + 84, 256);  // numGlyphs
      bus.writeU8 (ptr + 260, 4);   // BPP
    };

    // Helper: zero a blank glyph into the GlyphImage buffer
    // GlyphImage: pixelFormat(4) xPos64(4) yPos64(4) bufWidth(2) bufHeight(2) bytesPerLine(2) pad(2) bufferPtr(4)
    const writeBlankGlyph = (glyphImagePtr: number, bus: MemoryBus) => {
      if (glyphImagePtr === 0) return;
      const bufWidth     = bus.readU16(glyphImagePtr + 12);
      const bufHeight    = bus.readU16(glyphImagePtr + 14);
      const bytesPerLine = bus.readU16(glyphImagePtr + 16);
      const bufferPtr    = bus.readU32(glyphImagePtr + 20);
      if (bufferPtr !== 0 && bufWidth > 0 && bufHeight > 0) {
        for (let i = 0; i < bytesPerLine * bufHeight; i++) bus.writeU8(bufferPtr + i, 0);
      }
    };

    // Helper: resolve font handle → PGF instance (or null)
    const getPgf = (handle: number): PGF | null => {
      const idx = this.fontHandleMap.get(handle);
      if (idx === undefined) return null;
      return this.pgfFonts[idx] ?? null;
    };

    // Load all available PGF fonts from flash0:/font/ltn*.pgf
    const loadPgfFonts = () => {
      if (this.pgfFonts.length > 0) return; // already loaded
      const names = [
        "ltn0.pgf","ltn1.pgf","ltn2.pgf","ltn3.pgf","ltn4.pgf","ltn5.pgf",
        "ltn6.pgf","ltn7.pgf","ltn8.pgf","ltn9.pgf","ltn10.pgf","ltn11.pgf",
        "ltn12.pgf","ltn13.pgf","ltn14.pgf",
      ];
      for (const name of names) {
        const data = this.pspFs.getFileData(`flash0:/font/${name}`, 0);
        if (data) {
          const pgf = new PGF(data.buffer as ArrayBuffer);
          this.pgfFonts.push(pgf);
        } else {
          this.pgfFonts.push(null);
        }
      }
      const loaded = this.pgfFonts.filter(Boolean).length;
      log.info(`Font system: ${loaded}/${names.length} PGF fonts loaded`);
    };

    // sceFontNewLib(params, errorCodePtr) → lib handle 1
    this.register(FONT.sceFontNewLib, (regs, bus) => {
      if (regs.getGpr(5) !== 0) bus.writeU32(regs.getGpr(5), 0);
      loadPgfFonts();
      regs.setGpr(2, 1);
    });

    // sceFontGetNumFontList(libHandle, errorCodePtr) → 1
    this.register(FONT.sceFontGetNumFontList, (regs, bus) => {
      if (regs.getGpr(5) !== 0) bus.writeU32(regs.getGpr(5), 0);
      regs.setGpr(2, 1);
    });

    // sceFontFindOptimumFont(libHandle, stylePtr, errorCodePtr) → 0 (font index)
    this.register(FONT.sceFontFindOptimumFont, (regs, bus) => {
      if (regs.getGpr(6) !== 0) bus.writeU32(regs.getGpr(6), 0);
      regs.setGpr(2, 0);
    });

    // sceFontFindFont(libHandle, stylePtr, errorCodePtr) → 0
    this.register(FONT.sceFontFindFont, (regs, bus) => {
      if (regs.getGpr(6) !== 0) bus.writeU32(regs.getGpr(6), 0);
      regs.setGpr(2, 0);
    });

    // sceFontOpen(libHandle, index, mode, errorCodePtr) → font handle
    this.register(FONT.sceFontOpen, (regs, bus) => {
      if (regs.getGpr(7) !== 0) bus.writeU32(regs.getGpr(7), 0);
      const idx = regs.getGpr(5);
      const handle = this.nextFontHandle++;
      this.fontHandleMap.set(handle, idx);
      regs.setGpr(2, handle);
    });

    // sceFontOpenUserFile(libHandle, pathPtr, mode, errorCodePtr) → font handle
    this.register(FONT.sceFontOpenUserFile, (regs, bus) => {
      if (regs.getGpr(7) !== 0) bus.writeU32(regs.getGpr(7), 0);
      // Try to load a PGF directly from the path
      const pathPtr = regs.getGpr(5);
      const path = this.readCString(bus, pathPtr);
      const data = this.pspFs.getFileData(path, this.currentThreadId);
      const handle = this.nextFontHandle++;
      if (data) {
        const pgf = new PGF(data.buffer as ArrayBuffer);
        const idx = this.pgfFonts.length;
        this.pgfFonts.push(pgf);
        this.fontHandleMap.set(handle, idx);
      } else {
        this.fontHandleMap.set(handle, 0);
      }
      regs.setGpr(2, handle);
    });

    // sceFontOpenUserMemory(libHandle, memPtr, memLen, errorCodePtr) → font handle
    this.register(FONT.sceFontOpenUserMemory, (regs, bus) => {
      if (regs.getGpr(7) !== 0) bus.writeU32(regs.getGpr(7), 0);
      const handle = this.nextFontHandle++;
      this.fontHandleMap.set(handle, 0);
      regs.setGpr(2, handle);
    });

    // sceFontClose(fontHandle) → 0
    this.register(FONT.sceFontClose, (regs) => { regs.setGpr(2, 0); });

    // sceFontDoneLib(libHandle) → 0
    this.register(FONT.sceFontDoneLib, (regs) => { regs.setGpr(2, 0); });

    // sceFontFlush(fontHandle) → 0
    this.register(FONT.sceFontFlush, (regs) => { regs.setGpr(2, 0); });

    // sceFontSetResolution(libHandle, hRes, vRes) → 0
    this.register(FONT.sceFontSetResolution, (regs) => { regs.setGpr(2, 0); });

    // sceFontSetAltCharacterCode(libHandle, charCode) → 0
    this.register(FONT.sceFontSetAltCharacterCode, (regs) => { regs.setGpr(2, 0); });

    // sceFontCalcMemorySize() → 0
    this.register(FONT.sceFontCalcMemorySize, (regs) => { regs.setGpr(2, 0); });

    // sceFontGetFontInfo(fontHandle, fontInfoPtr) → 0
    this.register(FONT.sceFontGetFontInfo, (regs, bus) => {
      if (regs.getGpr(5) !== 0) writeFontInfo(regs.getGpr(5), bus);
      regs.setGpr(2, 0);
    });

    // sceFontGetFontInfoByIndexNumber(libHandle, fontInfoPtr, index) → 0
    // fontInfoPtr receives PGFFontStyle (168 bytes); zero-fill suffices.
    this.register(FONT.sceFontGetFontInfoByIndexNumber, (regs, bus) => {
      const ptr = regs.getGpr(5);
      if (ptr !== 0) for (let i = 0; i < 168; i += 4) bus.writeU32(ptr + i, 0);
      regs.setGpr(2, 0);
    });

    // sceFontGetFontList(libHandle, fontStyleListPtr, numFonts) → 0
    this.register(FONT.sceFontGetFontList, (regs, bus) => {
      const ptr = regs.getGpr(5);
      if (ptr !== 0) for (let i = 0; i < 168; i += 4) bus.writeU32(ptr + i, 0);
      regs.setGpr(2, 0);
    });

    // sceFontGetCharInfo(fontHandle, charCode, charInfoPtr) → 0
    // PGFCharInfo (60 bytes): bitmapW(4) bitmapH(4) left(4) top(4) sfp26W(4) sfp26H(4)
    //   ascender(4) descender(4) bearingHX(4) bearingHY(4) bearingVX(4) bearingVY(4)
    //   advanceH(4) advanceV(4) shadowFlags(2) shadowId(2)
    this.register(FONT.sceFontGetCharInfo, (regs, bus) => {
      const charInfoPtr = regs.getGpr(6);
      if (charInfoPtr !== 0) {
        for (let i = 0; i < 60; i += 4) bus.writeU32(charInfoPtr + i, 0);
        const pgf = getPgf(regs.getGpr(4));
        const glyph = pgf?.getGlyph(regs.getGpr(5)) ?? null;
        if (glyph) {
          bus.writeU32(charInfoPtr +  0, glyph.w);
          bus.writeU32(charInfoPtr +  4, glyph.h);
          bus.writeU32(charInfoPtr +  8, glyph.left);
          bus.writeU32(charInfoPtr + 12, glyph.top);
          bus.writeU32(charInfoPtr + 16, glyph.dimensionWidth);
          bus.writeU32(charInfoPtr + 20, glyph.dimensionHeight);
          bus.writeU32(charInfoPtr + 24, glyph.yAdjustH);   // sfp26Ascender
          bus.writeU32(charInfoPtr + 28, (glyph.yAdjustH - glyph.dimensionHeight) >>> 0); // sfp26Descender
          bus.writeU32(charInfoPtr + 32, glyph.xAdjustH);   // bearingHX
          bus.writeU32(charInfoPtr + 36, glyph.yAdjustH);   // bearingHY
          bus.writeU32(charInfoPtr + 40, glyph.xAdjustV);   // bearingVX
          bus.writeU32(charInfoPtr + 44, glyph.yAdjustV);   // bearingVY
          bus.writeU32(charInfoPtr + 48, glyph.advanceH);
          bus.writeU32(charInfoPtr + 52, glyph.advanceV);
        } else {
          // Fallback: plausible 12×14px metrics
          bus.writeU32(charInfoPtr +  0, 12);
          bus.writeU32(charInfoPtr +  4, 14);
          bus.writeU32(charInfoPtr + 16, 12 * 64);
          bus.writeU32(charInfoPtr + 20, 14 * 64);
          bus.writeU32(charInfoPtr + 24, 14 * 64);
          bus.writeU32(charInfoPtr + 48, 12 * 64);
          bus.writeU32(charInfoPtr + 52, 14 * 64);
        }
      }
      regs.setGpr(2, 0);
    });

    // sceFontGetShadowInfo — same struct as GetCharInfo, return zeroed
    this.register(FONT.sceFontGetShadowInfo, (regs, bus) => {
      const ptr = regs.getGpr(6);
      if (ptr !== 0) for (let i = 0; i < 60; i += 4) bus.writeU32(ptr + i, 0);
      regs.setGpr(2, 0);
    });

    // sceFontGetCharImageRect / sceFontGetShadowImageRect → zero rect
    this.register(FONT.sceFontGetCharImageRect, (regs) => { regs.setGpr(2, 0); });
    this.register(FONT.sceFontGetShadowImageRect, (regs) => { regs.setGpr(2, 0); });

    // sceFontGetCharGlyphImage(fontHandle, charCode, glyphImagePtr) → 0
    this.register(FONT.sceFontGetCharGlyphImage, (regs, bus) => {
      const pgf = getPgf(regs.getGpr(4));
      if (pgf) pgf.drawCharacter(bus, regs.getGpr(6), regs.getGpr(5), 0x20);
      else writeBlankGlyph(regs.getGpr(6), bus);
      regs.setGpr(2, 0);
    });

    // sceFontGetCharGlyphImage_Clip(fontHandle, charCode, glyphImagePtr, ...) → 0
    this.register(FONT.sceFontGetCharGlyphImage_Clip, (regs, bus) => {
      const pgf = getPgf(regs.getGpr(4));
      if (pgf) pgf.drawCharacter(bus, regs.getGpr(6), regs.getGpr(5), 0x20);
      else writeBlankGlyph(regs.getGpr(6), bus);
      regs.setGpr(2, 0);
    });

    // sceFontGetShadowGlyphImage / sceFontGetShadowGlyphImage_Clip → blank
    this.register(FONT.sceFontGetShadowGlyphImage, (regs, bus) => {
      writeBlankGlyph(regs.getGpr(6), bus); regs.setGpr(2, 0);
    });
    this.register(FONT.sceFontGetShadowGlyphImage_Clip, (regs, bus) => {
      writeBlankGlyph(regs.getGpr(6), bus); regs.setGpr(2, 0);
    });

    // sceFontPixelToPointH/V, sceFontPointToPixelH/V → return 0.0 (float)
    this.register(FONT.sceFontPixelToPointH, (regs) => { regs.setGpr(2, 0); });
    this.register(FONT.sceFontPixelToPointV, (regs) => { regs.setGpr(2, 0); });
    this.register(FONT.sceFontPointToPixelH, (regs) => { regs.setGpr(2, 0); });
    this.register(FONT.sceFontPointToPixelV, (regs) => { regs.setGpr(2, 0); });

  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Read a null-terminated ASCII/UTF-8 string from guest memory. */
  readCString(bus: MemoryBus, addr: number): string {
    // Reject null and any address clearly below PSP RAM (0x08000000) or scratchpad (0x00010000)
    if (addr === 0 || (addr < 0x00010000 && (addr & 0x1fffffff) < 0x00010000)) return "";
    let result = "";
    let ptr = addr;
    for (;;) {
      const byte = bus.readU8(ptr++);
      if (byte === 0) break;
      result += String.fromCharCode(byte);
    }
    return result;
  }

  /**
   * Compute a new file position from a seek operation.
   * @param current  Current file position.
   * @param fileSize Total file size.
   * @param offset   Seek offset.
   * @param whence   0=SEEK_SET, 1=SEEK_CUR, 2=SEEK_END
   */
  computeSeekPosition(current: number, fileSize: number, offset: number, whence: number): number {
    let newPosition: number;
    switch (whence) {
      case 0: newPosition = offset;              break; // SEEK_SET
      case 1: newPosition = current + offset;    break; // SEEK_CUR
      case 2: newPosition = fileSize + offset;   break; // SEEK_END
      default: newPosition = current;            break;
    }
    return Math.max(0, Math.min(newPosition, fileSize));
  }
}
