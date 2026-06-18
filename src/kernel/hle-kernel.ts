import type { MemoryBus } from "../memory/memory-bus.js";
import { MemoryRegion } from "../memory/memory-map.js";
import { BlockAllocator, type BlockAllocatorState } from "../memory/block-allocator.js";
import type { AllegrexRegisters } from "../cpu/registers.js";
import type { AllegrexCPU } from "../cpu/cpu.js";
import type { CoreTiming, EventTypeId } from "../timing/core-timing.js";
import { GeDispatcher } from "../gpu/ge-dispatcher.js";
import { GEProcessor } from "../gpu/ge-processor.js";
import { Logger } from "../utils/logger.js";
import { PGF } from "./hle-font.js";
import { PspFileSystem } from "./psp-filesystem.js";
import { AudioEngine } from "../audio/audio-engine.js";
import type { SavedataStore } from "../storage/savedata-store.js";
import type { FileStore } from "../storage/file-store.js";
import { registerAudioHLE } from "./hle-audio.js";
import { registerThreadHLE } from "./hle-thread.js";
import { registerSyncHLE } from "./hle-sync.js";
import { registerDisplayHLE } from "./hle-display.js";
import { registerCtrlHLE } from "./hle-ctrl.js";
import { registerIoHLE } from "./hle-io.js";
import { registerPowerHLE } from "./hle-power.js";
import { registerNetHLE } from "./hle-net.js";
import { registerMediaHLE } from "./hle-media.js";
import { registerMpegHLE } from "./hle-mpeg.js";
import { registerPsmfPlayerHLE } from "./hle-psmf-player.js";
import { registerUtilityHLE } from "./hle-utility.js";
import {
  FONT, GE, NID_NAMES,
} from "./nids.js";

const log = Logger.get("HLE");

// PPSSPP sceGe.cpp: list IDs are XOR'd with this magic before being returned to
// user code, and unmasked on every inbound syscall that takes a list ID.
const GE_LIST_ID_MAGIC = 0x35000000;

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
export enum WaitType { NONE, DELAY, VBLANK, SLEEP, SEMA, EVENT_FLAG, AUDIO, ATRAC_DECODE, GE_DRAW_SYNC, GE_LIST_SYNC, THREAD_END, MUTEX, FPL, VPL, MODULE, LWMUTEX, CTRL, ASYNC_IO }

export interface LoadedModule {
  id: number;
  name: string;
  path: string;
  entryAddr: number;
  gp: number;
  baseAddr: number;
  size: number;
  isFake: boolean;
  status: number; // 0=loaded, 1=started
}

/** GE display list states — must match PSP values (PPSSPP GPUDefinitions.h).
 *  NONE=0, QUEUED=1, DRAWING/RUNNING=2, COMPLETED=3, PAUSED=4.
 *  Note: "STALLING" is an internal PPSSPP concept (GPUSTATE_STALL), not a PSP DL state.
 *  We use STALLING internally but map it to DRAWING for sceGeListSync return values. */
export enum GeListState { NONE = 0, QUEUED = 1, DRAWING = 2, COMPLETED = 3, PAUSED = 4, STALLING = 5 }

/** SIGNAL behaviour types (PPSSPP ge_constants.h SignalBehavior) */
export enum GeSignalBehavior {
  NONE = 0,
  HANDLER_SUSPEND = 0x01,
  HANDLER_CONTINUE = 0x02,
  HANDLER_PAUSE = 0x03,
  SYNC = 0x08,
  JUMP = 0x10,
  CALL = 0x11,
  RET = 0x12,
  RJUMP = 0x13,
  RCALL = 0x14,
  OJUMP = 0x15,
  OCALL = 0x16,
  BREAK1 = 0xF0,
  BREAK2 = 0xFF,
}

/** GE call stack entry (for CALL/RET and SIGNAL CALL/RET) */
interface GeCallStackEntry {
  pc: number;
  offsetAddr: number;
  baseAddr: number;
  /** Raw BASE (0x10) cmdmem op at SIGNAL CALL time — SIGNAL RET restores it
   *  (real PSP restores the BASE register; gpu/ge/get checks via sceGeGetCmd). */
  baseCmd?: number;
  /** Raw OFFSET_ADDR (0x13) cmdmem op at SIGNAL CALL time */
  offsetCmd?: number;
}

export interface GeListEntry {
  id: number;
  listAddr: number;       // original start address
  pc: number;             // current GE program counter
  stallAddr: number;      // stall address (0 = no stall)
  state: GeListState;
  cbId: number;           // callback ID from sceGeListEnQueue (-1 = none)
  /** Last SIGNAL behaviour seen (PPSSPP DisplayList::signal) */
  signal: GeSignalBehavior;
  /** Sub-interrupt token from SIGNAL/FINISH (PPSSPP DisplayList::subIntrToken) */
  subIntrToken: number;
  /** GE call stack for CALL/RET within display lists */
  callStack: GeCallStackEntry[];
  /** Offset address register state (PPSSPP gstate_c.offsetAddr) */
  offsetAddr: number;
  /** Base address register (GE_CMD_BASE param) */
  baseAddr: number;
  /** Whether interrupts are enabled for this list (PPSSPP DisplayList::interruptsEnabled) */
  interruptsEnabled: boolean;
  /** True once the list has started executing (PPSSPP DisplayList::started) */
  started: boolean;
  /** Stack address from PspGeListArgs (PPSSPP DisplayList::stackAddr) */
  stackAddr: number;
  /** Context pointer from PspGeListArgs (PPSSPP DisplayList::context) */
  contextPtr: number;
  /** True after SIGNAL+END with an unknown behavior — the GE stops at the END
   *  but the list stays DRAWING (real PSP; gpu/signals/simple "Unknown" cases).
   *  Only sceGeBreak clears it (entries are recreated on enqueue). */
  signalHalted: boolean;
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
  waitFplId: number;       // FPL ID being waited on (WaitType.FPL)
  waitFplDataPtr: number;  // pointer to write allocated block address
  waitVplId: number;       // VPL ID being waited on (WaitType.VPL)
  waitVplSize: number;     // allocation size requested
  waitVplAddrPtr: number;  // pointer to write allocated address
  pendingWakeCallback: (() => void) | undefined; // called before waking from ATRAC_DECODE
  /** Saved wait type from before CB promotion (set by reschedule when promoting WAITING → READY for callbacks) */
  cbPromotedFromWaitType: WaitType;
}


/**
 * A per-module save-state port. Each HLE register function (hle-io, hle-audio,
 * etc.) keeps its runtime state in closure locals; it hands the kernel a port so
 * those locals can be saved and restored without moving them out of the closure.
 */
export interface StateModulePort {
  /** Return a JSON-round-trippable snapshot of this module's closure state. */
  save(): unknown;
  /** Restore this module's closure state from a snapshot made by save(). */
  load(data: unknown): void;
  /** Optional: reasons this module is not safe to snapshot right now (empty/none = safe). */
  blockers?(): string[];
}

/** Saved form of one Thread (see the Thread interface). The CPU context's typed
 *  arrays are stored as plain number arrays; pendingWakeCallback is skipped. */
export interface ThreadStateV1 {
  id: number;
  entry: number;
  stackSize: number;
  stackBase: number;
  stackTop: number;
  k0: number;
  priority: number;
  state: number;
  waitType: number;
  context: {
    gpr: number[]; hi: number; lo: number; pc: number;
    fpr: number[]; fcr31: number;
    vfpr: number[]; vfpuCtrl: number[]; vfpuCc: number;
    vpfxs: number; vpfxt: number; vpfxd: number;
    vpfxsEnabled: boolean; vpfxtEnabled: boolean; vpfxdEnabled: boolean;
  };
  wakeupCount: number;
  callbacks: number[];
  isProcessingCallbacks: boolean;
  waitSemaId: number; waitSemaCount: number;
  waitEvfId: number; waitEvfBits: number; waitEvfMode: number; waitEvfOutPtr: number;
  waitGeListId: number; waitDeadlineVbl: number; waitWakeTimeMs: number;
  waitThreadEndId: number;
  waitMutexId: number; waitMutexCount: number;
  waitFplId: number; waitFplDataPtr: number;
  waitVplId: number; waitVplSize: number; waitVplAddrPtr: number;
  cbPromotedFromWaitType: number;
}

/**
 * Save-state of the HLEKernel. A plain object that round-trips through JSON:
 * every Map is stored as an entry array, every typed array as a number array or
 * base64 string, and every guest-address number stays a number. Functions, host
 * objects, and the mounted game files are not part of this; a normal boot
 * rebuilds them. `modules` holds each registered StateModulePort's saved data
 * keyed by module name.
 */
export interface KernelStateV1 {
  version: 1;
  threads: ThreadStateV1[];
  nextThreadId: number;
  currentThreadId: number;
  pendingThreadEntry: { entry: number; arglen: number; argp: number; sp: number; k0: number } | null;
  pendingAtracWakes: number[];
  pspCallbacks: Array<[number, PSPCallback]>;
  nextPspCallbackId: number;
  activeMipsCall: HLEKernel["activeMipsCall"];
  userMemory: BlockAllocatorState;
  ramSize: number;
  memBlocks: Array<[number, { addr: number; size: number; name: string }]>;
  nextBlockId: number;
  fplPools: Array<[number, { base: number; blockSize: number; numBlocks: number; nextBlock: number }]>;
  semaphores: Array<[number, { name: string; attr: number; initCount: number; count: number; maxCount: number }]>;
  eventFlags: Array<[number, { pattern: number; attr: number }]>;
  subIntrs: Array<[number, { handler: number; arg: number; enabled: boolean }]>;
  sasGrainSize: number;
  nextGeListSlot: number;
  geLists: Array<[number, GeListEntry]>;
  geListQueue: number[];
  geCallbacks: Array<[number, { signalFunc: number; signalArg: number; finishFunc: number; finishArg: number }]>;
  activeGeCbId: number;
  geCommandMem: number[];
  geCommandMemReady: boolean;
  geVertexAddr: number;
  geIndexAddr: number;
  geOffsetAddr: number;
  gePendingSignalCb: { token: number; cbId: number; a2: number } | null;
  gePendingInterrupts: Array<{ func: number; a0: number; a1: number; listState?: number }>;
  geEdramTranslation: number;
  geIsBreak: boolean;
  suppressReschedule: boolean;
  vblankCount: number;
  cycleCount: number;
  ioOpsCount: number;
  geTimeMs: number;
  currentButtons: number;
  framebufAddr: number;
  framebufWidth: number;
  framebufFormat: number;
  stubCalls: Array<[string, number]>;
  idleBreak: boolean;
  compiledSdkVersion: number;
  interruptsEnabled: boolean;
  dispatchEnabled: boolean;
  pendingAlarmFires: number[];
  // Display state
  displayHasSetMode: boolean;
  displayMode: number;
  displayWidth: number;
  displayHeight: number;
  isVblank: boolean;
  frameStartTicks: number;
  hCountBase: number;
  displayResumeMode: number;
  displayHoldMode: number;
  displayBrightnessLevel: number;
  loadedModules: Array<[number, LoadedModule]>;
  nextSyscallCode: number;
  fontHandleMap: Array<[number, number]>;
  nextFontHandle: number;
  threadReturnAddr: number;
  cbReturnTrampolineWritten: boolean;
  /** Per-module closure state, keyed by the name passed to registerStateModule. */
  modules: Record<string, unknown>;
}

export class HLEKernel {
  private readonly handlers = new Map<number, HLEHandler>();
  /** Per-module save-state ports registered by the HLE register functions. */
  private readonly stateModules = new Map<string, StateModulePort>();
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

  /** Persistent storage for raw file IO writes (sceIoWrite to ms0:). */
  fileStore: FileStore | null = null;

  /** Optional callback for savedata UI overlay: (action, gameName, saveName, done, error) */
  onSavedataEvent: ((action: string, game: string, save: string, done: boolean, error: boolean) => void) | null = null;

  /** Optional callback for save slot selection UI (LISTLOAD/LISTSAVE modes).
   *  Called with action + slot info, returns a Promise resolving to the selected name or null. */
  onSavedataListSelect: ((action: "Load" | "Save", gameTitle: string, slots: Array<{ name: string; hasData: boolean; sizeKB: number; title: string }>) => Promise<string | null>) | null = null;

  /** PSP kernel callbacks — PPSSPP kernelObjects for PSPCallback type */
  readonly pspCallbacks = new Map<number, PSPCallback>();
  nextPspCallbackId = 1;

  /**
   * Pending MipsCall for callback dispatch.
   * PPSSPP uses a full MipsCall queue per thread; we simplify to one active call.
   * When set, the CPU is redirected to the callback entrypoint. When the callback
   * returns (via cbReturnTrampolineAddr), the saved state is restored.
   */
  /** Whether a MipsCall (callback dispatch) is currently active.
   *  Used by cpu.ts to avoid clobbering callback arguments. */
  get hasMipsCall(): boolean { return this.activeMipsCall !== null; }

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
    /** When true, returnFromMipsCall will force-check for more callbacks
     *  (used by sceKernelCheckCallback which bypasses isProcessingCallbacks). */
    forceCallbacks: boolean;
  } | null = null;

  /** Address of the callback-return trampoline (SYSCALL instruction).
   *  PPSSPP: cbReturnHackAddr, written during __KernelThreadingInit. */
  private cbReturnTrampolineAddr = 0x08000020;
  private cbReturnTrampolineWritten = false;
  private static readonly SYSCALL_CB_RETURN = 0xFFFFE; // reserved syscall code

  /**
   * User memory allocator — port of PPSSPP's userMemory BlockAllocator.
   * Grain=256 matches PPSSPP's `BlockAllocator userMemory(256)`.
   * Range: [0x08800000, 0x0C000000) for 64MB PSP (set in setHeapBase).
   */
  readonly userMemory = new BlockAllocator(256);
  readonly memBlocks = new Map<number, { addr: number; size: number; name: string }>();
  nextBlockId = 0x100;

  /** PSP RAM size (PPSSPP g_MemorySize): 0x02000000 (32MB) by default, 0x04000000
   *  (64MB) when the game requests it (PARAM.SFO MEMSIZE=1 / HD-remaster). Set in
   *  setHeapBase; the debug panel reads this instead of hardcoding 64MB. */
  ramSize = 0x04000000;

  /**
   * FPL pool tracking: fplId → { base, blockSize, numBlocks, nextBlock }
   * Separate from memBlocks so AllocateFpl can cycle through blocks properly.
   */
  readonly fplPools = new Map<number, { base: number; blockSize: number; numBlocks: number; nextBlock: number }>();

  /** Called by emulator.ts after ELF load to position the heap above loaded segments. */
  setHeapBase(loadedEnd: number, largeMemory = false): void {
    // Initialize userMemory matching PPSSPP:
    // userMemory.Init(PSP_GetUserMemoryBase(), PSP_GetUserMemoryEnd() - PSP_GetUserMemoryBase())
    // PSP_GetUserMemoryEnd() = 0x08000000 + g_MemorySize. g_MemorySize is
    // RAM_NORMAL_SIZE (32MB) by default and RAM_DOUBLE_SIZE (64MB) only when the
    // game requests it via PARAM.SFO MEMSIZE=1 (PPSSPP InitMemorySizeForGame).
    // Most games are 32MB; giving them 64MB shifts their whole heap layout and
    // makes their own allocations collide.
    const USER_MEM_BASE = 0x08800000;
    const USER_MEM_END  = largeMemory ? 0x0C000000 : 0x0A000000;
    this.ramSize = USER_MEM_END - 0x08000000; // g_MemorySize (32MB or 64MB)
    this.userMemory.init(USER_MEM_BASE, USER_MEM_END - USER_MEM_BASE);

    // Pre-allocate usersystemlib (PPSSPP sceKernelMemory.cpp:319)
    this.userMemory.allocAt(USER_MEM_BASE, 0x4000, "usersystemlib");
    // Mark ELF-loaded region as used (everything from usersystemlib end to loadedEnd)
    const elfEnd = loadedEnd > USER_MEM_BASE + 0x4000 ? (loadedEnd + 0xFF) & ~0xFF : USER_MEM_BASE + 0x4100;
    this.userMemory.allocAt(USER_MEM_BASE + 0x4000, elfEnd - (USER_MEM_BASE + 0x4000), "ELF");

    // Pre-fill free region with 0xFF (matches real PSP — stack scans expect this)
    for (let i = elfEnd; i < USER_MEM_END; i += 4) {
      this.bus.writeU32(i, 0xFFFFFFFF);
    }

  }

  /** Semaphores: id → { count, maxCount } */
  readonly semaphores = new Map<number, { name: string; attr: number; initCount: number; count: number; maxCount: number }>();
  /** Event flags: id → { pattern, attr }. Exposed for timeout handler to read pattern. */
  readonly eventFlags = new Map<number, { pattern: number; attr: number }>();

  /** Sub-interrupt handlers: key = intrNumber * 32 + subIntrNumber */
  readonly subIntrs = new Map<number, { handler: number; arg: number; enabled: boolean }>();

  /** SAS grain size set by __sceSasInit; used to block the mixing thread. */
  sasGrainSize = 256;

  /** GE display list pool — 64 slots matching PPSSPP's DisplayListMaxCount */
  private static readonly GE_MAX_LISTS = 64;
  private nextGeListSlot = 0;
  private geDispatcher!: GeDispatcher;
  /** Inline GE processor for headless mode (no Web Worker). Created lazily. */
  private inlineGe: GEProcessor | null = null;
  /** GE display lists: listId → entry (IDs are 0..63) */
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

  /** Basename of the most recently opened video-like file (.pmf etc.), used to
   *  label the fake MPEG decode frame. Null until a video file is opened. */
  public lastVideoPath: string | null = null;

  /** Loaded PGF fonts by index (populated lazily on sceFontNewLib) */
  private pgfFonts: (PGF | null)[] = [];
  /** Map font handle → pgfFonts index */
  private fontHandleMap = new Map<number, number>();
  private nextFontHandle = 2;


  /** Next available syscall code for dynamically loaded modules (set after main EBOOT load). */
  nextSyscallCode = 1;

  /** Loaded modules (sceKernelLoadModule tracking). */
  readonly loadedModules = new Map<number, LoadedModule>();

  /** Scheduling / timing */
  vblankCount: number = 0;
  cycleCount: number = 0;
  ioOpsCount: number = 0;
  /** Cumulative wall-time (ms) spent processing GE command lists = the emulated
   *  GPU's CPU load. Same path for both renderers (software raster vs WebGL draw
   *  submit happens inside the scan). Read as a per-window delta for a GPU-load %. */
  geTimeMs: number = 0;
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

  /** Return value ($v0) from the last _invokeGeCb guest function call.
   *  Captured before registers are restored so callers can inspect it. */
  lastGuestCallReturnValue: number = 0;

  /** True when interrupts are enabled (false after sceKernelCpuSuspendIntr).
   *  Alarm CoreTiming callbacks check this to defer handler invocation. */
  interruptsEnabled: boolean = true;

  /** True when thread dispatch is enabled (false after
   *  sceKernelSuspendDispatchThread). PPSSPP gates every thread switch on this
   *  (sceKernelThread.cpp dispatchEnabled) — a thread that suspends dispatch
   *  holds the CPU until it resumes, even against higher-priority READY threads. */
  dispatchEnabled: boolean = true;

  /** Pending alarm handler invocations queued while interrupts are suspended.
   *  Each entry is (alarmId). Processed when interruptsEnabled becomes true. */
  readonly pendingAlarmFires: number[] = [];

  /** Callback installed by hle-thread.ts to process pending alarm fires. */
  processAlarmFire: ((alarmId: number) => void) | null = null;

  inputSnapshot: (() => InputSnapshot) | null = null;
  /** Installed by hle-ctrl.ts: per-vblank controller sampling (updates the
   *  latch like PPSSPP __CtrlUpdateLatch, which runs on the ctrl sample event). */
  onCtrlVblankSample: (() => void) | null = null;
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
  /** When true, reschedule() is a no-op (matches PPSSPP interrupt context behavior) */
  private suppressReschedule = false;
  /** Compiled SDK version set by game via sceKernelSetCompiledSdkVersion.
   *  Affects behavior of several syscalls (GE, interrupts, etc.).
   *  Default 0 = unset (treated as old SDK). */
  compiledSdkVersion = 0;

  /** EDRAM address translation value (PPSSPP GPUCommon edramTranslation_, default 0x400) */
  private geEdramTranslation = 0x400;

  /** Re-entrancy guard: true while _scanGeListHeadless is executing.
   *  Prevents recursive scanning when a GE callback fires a syscall that
   *  re-enters hasActiveGeLists(). */
  private geScanningActive = false;
  /** Pending signal callback deferred from HANDLER_CONTINUE */
  private gePendingSignalCb: { token: number; cbId: number; a2: number } | null = null;
  /** Pending GE interrupts to fire during next blocking syscall (matches PPSSPP async delivery) */
  private gePendingInterrupts: Array<{ func: number; a0: number; a1: number; listState?: GeListState }> = [];

  /**
   * GE command memory — mirrors PPSSPP gstate.cmdmem[256].
   * cmdmem[cmd] stores the full 32-bit word of the last executed GE command
   * for each opcode (cmd = op >> 24). Reset state: cmdmem[i] = i << 24.
   * Used by sceGeGetCmd and sceGeSaveContext.
   */
  private readonly geCommandMem = new Uint32Array(256);
  /** Whether geCommandMem has been initialized to reset defaults */
  private geCommandMemReady = false;
  /** GE state: vertex address (PPSSPP gstate_c.vertexAddr) */
  private geVertexAddr = 0;
  /** GE state: index address (PPSSPP gstate_c.indexAddr) */
  private geIndexAddr = 0;
  /** GE state: offset address (PPSSPP gstate_c.offsetAddr) */
  private geOffsetAddr = 0;

  /**
   * Audio engine. Always present — call audioEngine.init() from the frontend
   * after a user gesture to unlock the AudioContext and start producing sound.
   */
  readonly audioEngine: AudioEngine = new AudioEngine();

  /** GE draw target (where the GE last drew — use this for rendering when non-zero). */
  get geFbAddr(): number   { return this.geDispatcher?.geFbAddr   ?? this.inlineGe?.currentFbAddr ?? 0; }
  get geFbWidth(): number  { return this.geDispatcher?.geFbWidth  ?? this.inlineGe?.currentFbWidth ?? 512; }
  get geFbFormat(): number { return this.geDispatcher?.geFbFormat ?? this.inlineGe?.currentFbFormat ?? 3; }
  get geListCount(): number  { return this.geDispatcher?.listCount  ?? this.inlineGe?.totalListCount ?? 0; }
  get gePrimCount(): number  { return this.geDispatcher?.primCount  ?? this.inlineGe?.totalPrimCount ?? 0; }
  get geClearCount(): number { return this.geDispatcher?.clearCount ?? this.inlineGe?.totalClearCount ?? 0; }
  get geSkipCount(): number  { return this.geDispatcher?.skipCount  ?? this.inlineGe?.totalSkipCount ?? 0; }

  /** Wire up CoreTiming and register timing-driven events (call once per emulator instance). */
  initTiming(ct: CoreTiming): void {
    this.coreTiming = ct;
    this.wakeThreadEventId = ct.registerEventType("WakeThread", (_cyclesLate, threadId) => {
      const t = this.threads.get(threadId);
      if (!t || t.state !== ThreadState.WAITING) return;

      if (t.waitType === WaitType.DELAY) {
        t.state    = ThreadState.READY;
        t.waitType = WaitType.NONE;
        // Don't overwrite gpr[2] — already set in saved context
      } else if (t.waitType === WaitType.EVENT_FLAG) {
        // Timeout on event flag wait — write current pattern to outBitsPtr
        const evf = this.eventFlags.get(t.waitEvfId);
        if (evf && t.waitEvfOutPtr !== 0 && this.bus) {
          this.bus.writeU32(t.waitEvfOutPtr, evf.pattern);
        }
        t.state    = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0x800201a8 >>> 0; // SCE_KERNEL_ERROR_WAIT_TIMEOUT
      } else if (t.waitType === WaitType.SEMA) {
        // Timeout on semaphore wait
        t.state    = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0x800201a8 >>> 0; // SCE_KERNEL_ERROR_WAIT_TIMEOUT
      } else if (t.waitType === WaitType.FPL) {
        t.state    = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0x800201a8 >>> 0; // SCE_KERNEL_ERROR_WAIT_TIMEOUT
      } else {
        t.state    = ThreadState.READY;
        t.waitType = WaitType.NONE;
      }

      if (!this.hasRunningThread() && this.cpu) {
        this.idleBreak = false;
        this.reschedule(this.cpu.regs);
        if (t.isProcessingCallbacks && this.currentThreadId === t.id) {
          this.processThreadCallbacks(this.cpu.regs);
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

  /** Read-only detail for the debug panel's thread inspector. Returns live values
   *  for the running thread (from CPU regs) and saved context for the rest. */
  getThreadDetail(id: number): {
    id: number; entry: number; priority: number; state: ThreadState; waitType: WaitType;
    pc: number; hi: number; lo: number;
    stackBase: number; stackTop: number; stackSize: number;
    gpr: number[];
    wait: {
      semaId: number; semaCount: number; evfId: number; evfBits: number; evfMode: number;
      mutexId: number; mutexCount: number; geListId: number; threadEndId: number;
      fplId: number; vplId: number; deadlineVbl: number;
    };
  } | null {
    const t = this.threads.get(id);
    if (!t) return null;
    // The running thread's live state is in the CPU regs, not its saved context.
    const r = (t.id === this.currentThreadId && t.state === ThreadState.RUNNING && this.cpu)
      ? this.cpu.regs : t.context;
    return {
      id: t.id, entry: t.entry, priority: t.priority, state: t.state, waitType: t.waitType,
      pc: r.pc,
      hi: r.hi,
      lo: r.lo,
      stackBase: t.stackBase, stackTop: t.stackTop, stackSize: t.stackSize,
      gpr: Array.from(r.gpr, v => v >>> 0),
      wait: {
        semaId: t.waitSemaId, semaCount: t.waitSemaCount,
        evfId: t.waitEvfId, evfBits: t.waitEvfBits, evfMode: t.waitEvfMode,
        mutexId: t.waitMutexId, mutexCount: t.waitMutexCount,
        geListId: t.waitGeListId, threadEndId: t.waitThreadEndId,
        fplId: t.waitFplId, vplId: t.waitVplId, deadlineVbl: t.waitDeadlineVbl,
      },
    };
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
    registerMpegHLE(this);
    registerMediaHLE(this);
    registerUtilityHLE(this);
  }

  initGeWorker(ramSab: SharedArrayBuffer, vramSab: SharedArrayBuffer, scratchpadSab: SharedArrayBuffer): void {
    this.geDispatcher = new GeDispatcher(ramSab, vramSab, scratchpadSab);
  }

  terminateGeWorker(): void { this.geDispatcher?.terminate(); }

  /** Scan a GE list inline and handle completion/pause. */
  private _scanAndCompleteGeList(listId: number, entry: GeListEntry): void {
    this.geScanningActive = true;
    const geStart = performance.now();
    const result = this._scanGeListHeadless(entry);
    this.geTimeMs += performance.now() - geStart;
    this.geScanningActive = false;

    // Note: HANDLER_CONTINUE signal callbacks are fired from _firePendingGeInterrupts()
    // during the next blocking syscall (matching PPSSPP's async interrupt delivery).

    if (result === GeListState.COMPLETED) {
      this._completeGeList(listId, /* skipCallbacks */ true);
      // Leave as COMPLETED — sceGeListSync needs to see this state.
      // NONE cleanup happens in sceGeDrawSync when all lists are done.
    }
    // PAUSED: leave in queue, will be resumed by sceGeContinue
  }

  /**
   * Process pending GE lists in headless mode.
   * Called from sync points (ListSync, DrawSync, UpdateStallAddr, Continue, VBlank).
   * Matches PPSSPP's ProcessDLQueue — only processes the front list at a time.
   * When the front list completes, moves to the next one.
   */
  private _processGeQueue(): void {
    if (this.geDispatcher || this.geScanningActive) return;
    // Process lists FIFO — only the front list runs at a time (PPSSPP: currentList = dlQueue.front)
    while (this.geListQueue.length > 0) {
      const id = this.geListQueue[0]!;
      const entry = this.geLists.get(id);
      if (!entry) { this.geListQueue.shift(); continue; }

      // Skip completed/none entries
      if (entry.state === GeListState.COMPLETED || entry.state === GeListState.NONE) {
        break; // Don't remove — sceGeListSync needs to see COMPLETED
      }

      // PAUSED lists wait for sceGeContinue
      if (entry.state === GeListState.PAUSED) break;

      // Lists halted at an unknown SIGNAL stay DRAWING but never run again
      // (only sceGeBreak clears them)
      if (entry.signalHalted) break;

      // QUEUED → DRAWING when becoming front. STALLING lists also go through
      // the scanner: PPSSPP makes a pc==stall list currentList and sets
      // started=true (GPUCommon.cpp:766-788) before noticing the stall.
      if (entry.state === GeListState.QUEUED || entry.state === GeListState.STALLING) {
        entry.state = GeListState.DRAWING;
      }

      if (entry.state === GeListState.DRAWING) {
        this._scanAndCompleteGeList(id, entry);
      }

      // If the list completed (state changed by _scanAndCompleteGeList), continue
      if ((entry.state as GeListState) === GeListState.COMPLETED) continue;

      // Otherwise (STALLING, PAUSED, etc.) stop — wait for more input
      break;
    }
  }

  /**
   * Fire pending GE interrupts (signal/finish callbacks) queued during list processing.
   * Called from blocking syscalls (delay, wait) to match PPSSPP's async interrupt delivery.
   */
  _firePendingGeInterrupts(): void {
    while (this.gePendingInterrupts.length > 0) {
      const intr = this.gePendingInterrupts.shift()!;
      // Temporarily set list states for callback visibility (signal sees DRAWING)
      const savedStates: Array<{ entry: GeListEntry; state: GeListState }> = [];
      const addedToQueue: number[] = [];
      if (intr.listState !== undefined) {
        for (const [id, e] of this.geLists.entries()) {
          if (e.state === GeListState.COMPLETED) {
            savedStates.push({ entry: e, state: e.state });
            e.state = intr.listState;
            if (!this.geListQueue.includes(id)) {
              this.geListQueue.push(id);
              addedToQueue.push(id);
            }
          }
        }
      }
      this._invokeGeCb(intr.func, intr.a0, intr.a1, 0);
      // Restore states and queue
      for (const { entry, state } of savedStates) {
        entry.state = state;
      }
      for (const id of addedToQueue) {
        const idx = this.geListQueue.indexOf(id);
        if (idx >= 0) this.geListQueue.splice(idx, 1);
      }
    }
  }

  /** Expose inline GE stats for diagnostics (boot-iso.ts) */
  get inlineGeListCount(): number { return this.inlineGe?.totalListCount ?? 0; }
  get inlineGePrimCount(): number { return this.inlineGe?.totalPrimCount ?? 0; }

  /** Access the inline GE processor (for attaching WebGL renderer). */
  get geProcessor(): GEProcessor | null { return this.inlineGe; }
  /** Ensure the inline GE processor exists. */
  ensureGeProcessor(): GEProcessor {
    if (!this.inlineGe) this.inlineGe = new GEProcessor(this.bus);
    return this.inlineGe;
  }

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
    const handler: HLEHandler & { isStub?: boolean } = (regs) => {
      this.stubCalls.set(name, (this.stubCalls.get(name) ?? 0) + 1);
      regs.setGpr(2, retval);
    };
    handler.isStub = true;
    this.handlers.set(nid, handler);
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
    // Count stubs vs real handlers
    let stubCount = 0;
    for (const [, handler] of remapped) {
      if ((handler as { isStub?: boolean }).isStub) stubCount++;
    }
    log.info(`Remapped ${mapped} syscalls (${mapped - stubCount} real, ${stubCount} stubs, ${unmappedNids.length} unimplemented)`);
    if (unmappedNids.length > 0) {
      log.warn(`Unimplemented: ${unmappedNids.join(', ')}`);
    }
  }

  /** Merge additional syscall→NID mappings for a dynamically loaded sub-module.
   *  Returns the number of unimplemented imports. */
  remapSyscallsAdditive(nidBySyscall: Map<number, number>): number {
    let mapped = 0;
    let stubCount = 0;
    const unmapped: string[] = [];
    for (const [syscallCode, nid] of nidBySyscall) {
      const handler = this.handlers.get(nid);
      if (handler) {
        this.handlers.set(syscallCode, handler);
        this.syscallToNid.set(syscallCode, nid);
        mapped++;
        if ((handler as { isStub?: boolean }).isStub) stubCount++;
      } else {
        const name = NID_NAMES.get(nid);
        unmapped.push(name ? `${name} (0x${nid.toString(16)})` : `0x${nid.toString(16)}`);
      }
    }
    log.info(`Remapped ${mapped} syscalls (${mapped - stubCount} real, ${stubCount} stubs, ${unmapped.length} unimplemented)`);
    if (unmapped.length > 0) log.warn(`Unimplemented: ${unmapped.join(', ')}`);
    return unmapped.length;
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

  /** True while a GE callback / interrupt handler runs in the mini CPU loop
   *  (_invokeGeCb). Blocking waits are illegal in interrupt context on the PSP
   *  (SCE_KERNEL_ERROR_CAN_NOT_WAIT) — blocking here would save a mid-callback
   *  CPU state into the thread context and corrupt execution on wake. */
  get inInterrupt(): boolean { return this.suppressReschedule; }

  /** Pick highest-priority READY thread and switch to it. Returns true if a thread was found. */
  reschedule(regs: AllegrexRegisters): boolean {
    // In GE callback (interrupt) context, suppress scheduling (PPSSPP behavior)
    if (this.suppressReschedule) return true;

    // Save current thread
    const current = this.currentThreadId > 0 ? this.threads.get(this.currentThreadId) : null;
    if (current && current.state === ThreadState.RUNNING) {
      current.state = ThreadState.READY;
      this.saveContext(current, regs);
    }

    // PPSSPP: __KernelReSchedule calls __KernelCheckCallbacks() which checks all
    // threads for pending callbacks. WAITING threads with isProcessingCallbacks=true
    // that have pending callbacks get promoted to READY so they can run the callback.
    // Track which threads were promoted so we can record their original state.
    for (const t of this.threads.values()) {
      if (t.state === ThreadState.WAITING && t.isProcessingCallbacks) {
        for (const cbId of t.callbacks) {
          const cb = this.pspCallbacks.get(cbId);
          if (cb && cb.notifyCount > 0) {
            // Save wait state before promotion so returnFromMipsCall can restore it
            t.cbPromotedFromWaitType = t.waitType;
            t.state = ThreadState.READY;
            break;
          }
        }
      }
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
      // PPSSPP: __KernelReSchedule calls __KernelCheckCallbacks() first, which
      // checks all threads with isProcessingCallbacks=true for pending callbacks.
      // We process them here for the newly-scheduled thread.
      if (best.isProcessingCallbacks) {
        const dispatched = this.processThreadCallbacks(regs);
        // If the thread was promoted from WAITING (CB-wait) for callback dispatch,
        // fix the saved thread state so returnFromMipsCall restores it to WAITING.
        // The cbPromotedFromWaitType was set during the promotion in reschedule().
        if (dispatched && best.cbPromotedFromWaitType !== WaitType.NONE && this.activeMipsCall) {
          this.activeMipsCall.savedThreadState = ThreadState.WAITING;
          this.activeMipsCall.savedWaitType = best.cbPromotedFromWaitType;
          best.cbPromotedFromWaitType = WaitType.NONE; // consumed
        }
      }
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
  /**
   * Preempt the running thread if a READY thread outranks it (lower priority
   * number = higher priority). PSP scheduling is preemptive, but ours is
   * otherwise cooperative (only reschedules at block/yield), so a compute-bound
   * low-priority thread can starve higher-priority READY threads. God of War
   * hit this: its main thread (prio 76) ran a long per-frame loop and never
   * yielded, so its loader threads (prio 46/56) sat READY and got 0% CPU.
   * Returns true if a switch happened.
   */
  preemptIfHigherPriorityReady(regs: AllegrexRegisters): boolean {
    // Never switch threads while interrupts/dispatch are suspended
    // (sceKernelCpuSuspendIntr) — the running thread holds the CPU until it
    // resumes, even against a higher-priority READY thread. The pspautotests
    // alarm test relies on this: main suspends interrupts and busy-loops, and
    // neither the alarm handler nor the higher-priority worker may run until it
    // resumes.
    if (!this.interruptsEnabled || !this.dispatchEnabled) return false;
    const cur = this.threads.get(this.currentThreadId);
    if (!cur || cur.state !== ThreadState.RUNNING) return false;
    let best: Thread | null = null;
    for (const t of this.threads.values()) {
      if (t.state === ThreadState.READY && t.priority < cur.priority) {
        if (!best || t.priority < best.priority) best = t;
      }
    }
    if (!best) return false;
    cur.state = ThreadState.READY;
    this.saveContext(cur, regs);
    best.state = ThreadState.RUNNING;
    this.currentThreadId = best.id;
    this.restoreContext(best, regs);
    regs.setGpr(26, best.k0);
    return true;
  }

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

  /** Mark current thread as DORMANT (exited but not deleted, matches PPSSPP — it
   *  can be restarted and waiters/exit-status queries still work), wake any
   *  threads waiting on it, and reschedule. */
  exitCurrentThread(regs: AllegrexRegisters): boolean {
    const dyingId = this.currentThreadId;
    const t = this.threads.get(dyingId);
    if (t) {
      t.state = ThreadState.DORMANT;
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
      t.isProcessingCallbacks = false; // per-wait (PPSSPP processCallbacks param)
      this.saveContext(t, regs);
      t.context.gpr[2] = 0;
      if (!this.reschedule(regs)) this.idleBreak = true;
    } else {
      regs.setGpr(2, 0);
    }
  }

  /**
   * Block the current thread until an async IO op completes (sceIoWaitAsync*).
   * hle-io.ts wakes it from the IoAsyncNotify timing event (PPSSPP
   * __IoAsyncNotify), writing the result and setting $v0 = 0 there.
   */
  blockCurrentThreadOnAsyncIo(regs: AllegrexRegisters): void {
    const t = this.threads.get(this.currentThreadId);
    if (t) {
      t.state    = ThreadState.WAITING;
      t.waitType = WaitType.ASYNC_IO;
      t.isProcessingCallbacks = false; // per-wait; sceIoWaitAsyncCB re-enables
      this.saveContext(t, regs);
      t.context.gpr[2] = 0;
      if (!this.reschedule(regs)) this.idleBreak = true;
    } else {
      regs.setGpr(2, 0);
    }
  }

  /**
   * Block the current thread waiting for controller data (sceCtrlReadBuffer*).
   * The thread will be woken on the next VBlank when new ctrl samples arrive.
   * $v0 is set to `returnValue` in the saved context (typically 1 = number of buffers read).
   */
  blockCurrentThreadOnCtrl(regs: AllegrexRegisters, returnValue: number): void {
    const t = this.threads.get(this.currentThreadId);
    if (t) {
      t.state    = ThreadState.WAITING;
      t.waitType = WaitType.CTRL;
      t.isProcessingCallbacks = false; // per-wait (PPSSPP processCallbacks param)
      this.saveContext(t, regs);
      t.context.gpr[2] = returnValue;
      if (!this.reschedule(regs)) this.idleBreak = true;
    } else {
      regs.setGpr(2, returnValue);
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
      t.isProcessingCallbacks = false; // per-wait (PPSSPP processCallbacks param)
      if (this.coreTiming) {
        // Block for the EMULATED-time duration of the samples (PPSSPP
        // __AudioOutSampleQueue model). Wall-clock deadlines wake the game's
        // mixer thread too often when emulation runs slower than real time,
        // letting it eat the entire frame's cycle budget.
        t.waitWakeTimeMs = Number.POSITIVE_INFINITY;
        this.coreTiming.scheduleEvent(
          Math.max(1, this.coreTiming.msToCycles(durationMs)),
          this.wakeThreadEventId,
          this.currentThreadId,
        );
      } else {
        // No CoreTiming (unit tests) — fall back to wall clock via wakeAudioThreads
        t.waitWakeTimeMs = performance.now() + durationMs;
      }
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
      t.isProcessingCallbacks = false; // per-wait (PPSSPP processCallbacks param)
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
    // Process pending GE lists at VBlank (headless deferred processing)
    if (!this.geDispatcher) this._processGeQueue();
    this._firePendingGeInterrupts();
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
        if (t.pendingWakeCallback) {
          t.pendingWakeCallback();
          t.pendingWakeCallback = undefined;
        }
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0;
        woke = true;
      }
    }
    // Sample the controller once per vblank (PPSSPP __CtrlUpdateLatch timing)
    this.onCtrlVblankSample?.();
    // Wake threads waiting on controller data (sceCtrlReadBuffer*)
    for (const t of this.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.CTRL) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
        woke = true;
      }
    }
    // Invoke VBlank sub-interrupt handlers (PSP_VBLANK_INT = 30)
    const PSP_VBLANK_INT = 30;
    if (this.interruptsEnabled) {
      for (let sub = 0; sub < 32; sub++) {
        const entry = this.subIntrs.get(PSP_VBLANK_INT * 32 + sub);
        if (entry && entry.enabled && entry.handler !== 0) {
          // Handler signature: void handler(int subIntrNumber, void* handlerArg)
          this._invokeGeCb(entry.handler, sub, entry.arg);
        }
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
  processThreadCallbacks(regs: AllegrexRegisters, force: boolean = false): boolean {
    if (this.activeMipsCall) return false; // already in a callback

    const t = this.threads.get(this.currentThreadId);
    if (!t || (!t.isProcessingCallbacks && !force)) return false;

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
          forceCallbacks: force,
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

      // Restore thread wait state if the callback was dispatched on a WAITING thread
      // (PPSSPP: __KernelCallAddress saves status+waitType, ActionAfterMipsCall restores them)
      if (call.savedThreadState === ThreadState.WAITING) {
        t.state = ThreadState.WAITING;
        t.waitType = call.savedWaitType;
        // Reschedule to pick another thread since this one is waiting again.
        // If no READY threads, break out of CPU loop so the emulator can
        // advance timers and wake sleeping threads.
        if (!this.reschedule(regs)) {
          this.idleBreak = true;
        }
        return;
      }

      // Check for more pending callbacks (PPSSPP ActionAfterCallback::run line 3269)
      // Use force if the original dispatch was forced (e.g. sceKernelCheckCallback)
      if (t.isProcessingCallbacks || call.forceCallbacks) {
        this.processThreadCallbacks(regs, call.forceCallbacks);
      }
    }
  }

  // ── Save-state serialization ───────────────────────────────────────────────

  /** Register a per-module save-state port. Called once by each HLE register
   *  function so the kernel can save and restore that module's closure state. */
  registerStateModule(name: string, port: StateModulePort): void {
    this.stateModules.set(name, port);
  }

  /** Reasons the kernel is NOT safe to snapshot right now. Empty = safe.
   *  Covers threads mid-ATRAC-decode (a JS callback we can't serialize) plus
   *  whatever each registered module reports through its blockers(). */
  snapshotBlockers(): string[] {
    const reasons: string[] = [];
    for (const t of this.threads.values()) {
      if (t.pendingWakeCallback) {
        reasons.push(`thread ${t.id} has a pending wake callback (ATRAC decode in flight)`);
      }
    }
    for (const [name, port] of this.stateModules) {
      const moduleReasons = port.blockers?.();
      if (moduleReasons) {
        for (const r of moduleReasons) reasons.push(`${name}: ${r}`);
      }
    }
    return reasons;
  }

  /** Capture a single thread's restorable state. The CPU context's typed arrays
   *  become plain number arrays; pendingWakeCallback is intentionally dropped. */
  private _serializeThread(t: Thread): ThreadStateV1 {
    const c = t.context;
    return {
      id: t.id, entry: t.entry,
      stackSize: t.stackSize, stackBase: t.stackBase, stackTop: t.stackTop,
      k0: t.k0, priority: t.priority, state: t.state, waitType: t.waitType,
      context: {
        gpr: Array.from(c.gpr), hi: c.hi, lo: c.lo, pc: c.pc,
        fpr: Array.from(c.fpr), fcr31: c.fcr31,
        // vfpr is float, but store its raw bits so NaN/-0 in uninitialized VFPU
        // registers survive JSON (NaN would otherwise become null then 0).
        vfpr: Array.from(new Uint32Array(c.vfpr.buffer, c.vfpr.byteOffset, c.vfpr.length)),
        vfpuCtrl: Array.from(c.vfpuCtrl), vfpuCc: c.vfpuCc,
        vpfxs: c.vpfxs, vpfxt: c.vpfxt, vpfxd: c.vpfxd,
        vpfxsEnabled: c.vpfxsEnabled, vpfxtEnabled: c.vpfxtEnabled, vpfxdEnabled: c.vpfxdEnabled,
      },
      wakeupCount: t.wakeupCount,
      callbacks: t.callbacks.slice(),
      isProcessingCallbacks: t.isProcessingCallbacks,
      waitSemaId: t.waitSemaId, waitSemaCount: t.waitSemaCount,
      waitEvfId: t.waitEvfId, waitEvfBits: t.waitEvfBits, waitEvfMode: t.waitEvfMode, waitEvfOutPtr: t.waitEvfOutPtr,
      waitGeListId: t.waitGeListId, waitDeadlineVbl: t.waitDeadlineVbl, waitWakeTimeMs: t.waitWakeTimeMs,
      waitThreadEndId: t.waitThreadEndId,
      waitMutexId: t.waitMutexId, waitMutexCount: t.waitMutexCount,
      waitFplId: t.waitFplId, waitFplDataPtr: t.waitFplDataPtr,
      waitVplId: t.waitVplId, waitVplSize: t.waitVplSize, waitVplAddrPtr: t.waitVplAddrPtr,
      cbPromotedFromWaitType: t.cbPromotedFromWaitType,
    };
  }

  /** Rebuild a live Thread from its saved form, restoring the typed-array context. */
  private _deserializeThread(s: ThreadStateV1): Thread {
    const c = s.context;
    const context: ThreadContext = {
      gpr: Uint32Array.from(c.gpr), hi: c.hi, lo: c.lo, pc: c.pc,
      fpr: Uint32Array.from(c.fpr), fcr31: c.fcr31,
      vfpr: new Float32Array(Uint32Array.from(c.vfpr).buffer), vfpuCtrl: Uint32Array.from(c.vfpuCtrl), vfpuCc: c.vfpuCc,
      vpfxs: c.vpfxs, vpfxt: c.vpfxt, vpfxd: c.vpfxd,
      vpfxsEnabled: c.vpfxsEnabled, vpfxtEnabled: c.vpfxtEnabled, vpfxdEnabled: c.vpfxdEnabled,
    };
    return {
      id: s.id, entry: s.entry,
      stackSize: s.stackSize, stackBase: s.stackBase, stackTop: s.stackTop,
      k0: s.k0, priority: s.priority, state: s.state, waitType: s.waitType,
      context,
      wakeupCount: s.wakeupCount,
      callbacks: s.callbacks.slice(),
      isProcessingCallbacks: s.isProcessingCallbacks,
      waitSemaId: s.waitSemaId, waitSemaCount: s.waitSemaCount,
      waitEvfId: s.waitEvfId, waitEvfBits: s.waitEvfBits, waitEvfMode: s.waitEvfMode, waitEvfOutPtr: s.waitEvfOutPtr,
      waitGeListId: s.waitGeListId, waitDeadlineVbl: s.waitDeadlineVbl, waitWakeTimeMs: s.waitWakeTimeMs,
      waitThreadEndId: s.waitThreadEndId,
      waitMutexId: s.waitMutexId, waitMutexCount: s.waitMutexCount,
      waitFplId: s.waitFplId, waitFplDataPtr: s.waitFplDataPtr,
      waitVplId: s.waitVplId, waitVplSize: s.waitVplSize, waitVplAddrPtr: s.waitVplAddrPtr,
      pendingWakeCallback: undefined,
      cbPromotedFromWaitType: s.cbPromotedFromWaitType,
    };
  }

  /** Snapshot the whole kernel into a JSON-round-trippable object. Maps become
   *  entry arrays, typed arrays become number arrays, and each registered module
   *  port contributes its own closure state under `modules`. The mounted game
   *  files (fileData) and host objects are not captured; a normal boot rebuilds
   *  them. Check snapshotBlockers() first if you need a consistent point. */
  serialize(): KernelStateV1 {
    const modules: Record<string, unknown> = {};
    for (const [name, port] of this.stateModules) {
      modules[name] = port.save();
    }
    return {
      version: 1,
      threads: Array.from(this.threads.values(), t => this._serializeThread(t)),
      nextThreadId: this.nextThreadId,
      currentThreadId: this.currentThreadId,
      pendingThreadEntry: this.pendingThreadEntry ? { ...this.pendingThreadEntry } : null,
      pendingAtracWakes: Array.from(this.pendingAtracWakes),
      pspCallbacks: Array.from(this.pspCallbacks, ([k, v]) => [k, { ...v }]),
      nextPspCallbackId: this.nextPspCallbackId,
      activeMipsCall: this.activeMipsCall ? { ...this.activeMipsCall } : null,
      userMemory: this.userMemory.serialize(),
      ramSize: this.ramSize,
      memBlocks: Array.from(this.memBlocks, ([k, v]) => [k, { ...v }]),
      nextBlockId: this.nextBlockId,
      fplPools: Array.from(this.fplPools, ([k, v]) => [k, { ...v }]),
      semaphores: Array.from(this.semaphores, ([k, v]) => [k, { ...v }]),
      eventFlags: Array.from(this.eventFlags, ([k, v]) => [k, { ...v }]),
      subIntrs: Array.from(this.subIntrs, ([k, v]) => [k, { ...v }]),
      sasGrainSize: this.sasGrainSize,
      nextGeListSlot: this.nextGeListSlot,
      geLists: Array.from(this.geLists, ([k, v]) => [k, this._cloneGeListEntry(v)]),
      geListQueue: this.geListQueue.slice(),
      geCallbacks: Array.from(this.geCallbacks, ([k, v]) => [k, { ...v }]),
      activeGeCbId: this.activeGeCbId,
      geCommandMem: Array.from(this.geCommandMem),
      geCommandMemReady: this.geCommandMemReady,
      geVertexAddr: this.geVertexAddr,
      geIndexAddr: this.geIndexAddr,
      geOffsetAddr: this.geOffsetAddr,
      gePendingSignalCb: this.gePendingSignalCb ? { ...this.gePendingSignalCb } : null,
      gePendingInterrupts: this.gePendingInterrupts.map(i => ({ ...i })),
      geEdramTranslation: this.geEdramTranslation,
      geIsBreak: this.geIsBreak,
      suppressReschedule: this.suppressReschedule,
      vblankCount: this.vblankCount,
      cycleCount: this.cycleCount,
      ioOpsCount: this.ioOpsCount,
      geTimeMs: this.geTimeMs,
      currentButtons: this.currentButtons,
      framebufAddr: this.framebufAddr,
      framebufWidth: this.framebufWidth,
      framebufFormat: this.framebufFormat,
      stubCalls: Array.from(this.stubCalls),
      idleBreak: this.idleBreak,
      compiledSdkVersion: this.compiledSdkVersion,
      interruptsEnabled: this.interruptsEnabled,
      dispatchEnabled: this.dispatchEnabled,
      pendingAlarmFires: this.pendingAlarmFires.slice(),
      displayHasSetMode: this.displayHasSetMode,
      displayMode: this.displayMode,
      displayWidth: this.displayWidth,
      displayHeight: this.displayHeight,
      isVblank: this.isVblank,
      frameStartTicks: this.frameStartTicks,
      hCountBase: this.hCountBase,
      displayResumeMode: this.displayResumeMode,
      displayHoldMode: this.displayHoldMode,
      displayBrightnessLevel: this.displayBrightnessLevel,
      loadedModules: Array.from(this.loadedModules, ([k, v]) => [k, { ...v }]),
      nextSyscallCode: this.nextSyscallCode,
      fontHandleMap: Array.from(this.fontHandleMap),
      nextFontHandle: this.nextFontHandle,
      threadReturnAddr: this.threadReturnAddr,
      cbReturnTrampolineWritten: this.cbReturnTrampolineWritten,
      modules,
    };
  }

  /** Deep-copy a GE list entry (the callStack holds plain objects). */
  private _cloneGeListEntry(e: GeListEntry): GeListEntry {
    return { ...e, callStack: e.callStack.map(s => ({ ...s })) };
  }

  /** Restore the whole kernel from a snapshot made by serialize(). Replaces
   *  current state: Maps are rebuilt from entry arrays, typed arrays from their
   *  stored form, the BlockAllocator from its own flat form, and each registered
   *  module port is handed its matching saved data (a missing entry is tolerated). */
  deserialize(s: KernelStateV1): void {
    this.threads.clear();
    for (const ts of s.threads) this.threads.set(ts.id, this._deserializeThread(ts));
    this.nextThreadId = s.nextThreadId;
    this.currentThreadId = s.currentThreadId;
    this.pendingThreadEntry = s.pendingThreadEntry ? { ...s.pendingThreadEntry } : null;

    this.pendingAtracWakes.clear();
    for (const tid of s.pendingAtracWakes) this.pendingAtracWakes.add(tid);

    this.pspCallbacks.clear();
    for (const [k, v] of s.pspCallbacks) this.pspCallbacks.set(k, { ...v });
    this.nextPspCallbackId = s.nextPspCallbackId;
    this.activeMipsCall = s.activeMipsCall ? { ...s.activeMipsCall } : null;

    this.userMemory.deserialize(s.userMemory);
    this.ramSize = s.ramSize;

    this.memBlocks.clear();
    for (const [k, v] of s.memBlocks) this.memBlocks.set(k, { ...v });
    this.nextBlockId = s.nextBlockId;

    this.fplPools.clear();
    for (const [k, v] of s.fplPools) this.fplPools.set(k, { ...v });

    this.semaphores.clear();
    for (const [k, v] of s.semaphores) this.semaphores.set(k, { ...v });

    this.eventFlags.clear();
    for (const [k, v] of s.eventFlags) this.eventFlags.set(k, { ...v });

    this.subIntrs.clear();
    for (const [k, v] of s.subIntrs) this.subIntrs.set(k, { ...v });

    this.sasGrainSize = s.sasGrainSize;

    this.nextGeListSlot = s.nextGeListSlot;
    this.geLists.clear();
    for (const [k, v] of s.geLists) this.geLists.set(k, this._cloneGeListEntry(v));
    this.geListQueue = s.geListQueue.slice();

    this.geCallbacks.clear();
    for (const [k, v] of s.geCallbacks) this.geCallbacks.set(k, { ...v });
    this.activeGeCbId = s.activeGeCbId;

    this.geCommandMem.set(s.geCommandMem);
    this.geCommandMemReady = s.geCommandMemReady;
    this.geVertexAddr = s.geVertexAddr;
    this.geIndexAddr = s.geIndexAddr;
    this.geOffsetAddr = s.geOffsetAddr;
    this.gePendingSignalCb = s.gePendingSignalCb ? { ...s.gePendingSignalCb } : null;
    this.gePendingInterrupts = s.gePendingInterrupts.map(i => ({ ...i }));
    this.geEdramTranslation = s.geEdramTranslation;
    this.geIsBreak = s.geIsBreak;
    this.suppressReschedule = s.suppressReschedule;

    this.vblankCount = s.vblankCount;
    this.cycleCount = s.cycleCount;
    this.ioOpsCount = s.ioOpsCount;
    this.geTimeMs = s.geTimeMs;
    this.currentButtons = s.currentButtons;
    this.framebufAddr = s.framebufAddr;
    this.framebufWidth = s.framebufWidth;
    this.framebufFormat = s.framebufFormat;

    this.stubCalls.clear();
    for (const [k, v] of s.stubCalls) this.stubCalls.set(k, v);
    this.idleBreak = s.idleBreak;
    this.compiledSdkVersion = s.compiledSdkVersion;
    this.interruptsEnabled = s.interruptsEnabled;
    this.dispatchEnabled = s.dispatchEnabled;
    this.pendingAlarmFires.length = 0;
    this.pendingAlarmFires.push(...s.pendingAlarmFires);

    this.displayHasSetMode = s.displayHasSetMode;
    this.displayMode = s.displayMode;
    this.displayWidth = s.displayWidth;
    this.displayHeight = s.displayHeight;
    this.isVblank = s.isVblank;
    this.frameStartTicks = s.frameStartTicks;
    this.hCountBase = s.hCountBase;
    this.displayResumeMode = s.displayResumeMode;
    this.displayHoldMode = s.displayHoldMode;
    this.displayBrightnessLevel = s.displayBrightnessLevel;

    this.loadedModules.clear();
    for (const [k, v] of s.loadedModules) this.loadedModules.set(k, { ...v });
    this.nextSyscallCode = s.nextSyscallCode;

    this.fontHandleMap.clear();
    for (const [k, v] of s.fontHandleMap) this.fontHandleMap.set(k, v);
    this.nextFontHandle = s.nextFontHandle;
    // pgfFonts (the loaded PGF objects) aren't serialized; they're large and
    // deterministic. If the game had fonts open, reload the standard flash0 set
    // so the restored fontHandleMap indices resolve again. Fonts opened from a
    // game path via sceFontOpenUserFile are not recovered (rare).
    if (this.fontHandleMap.size > 0) this._loadStandardFonts();

    this.threadReturnAddr = s.threadReturnAddr;
    this.cbReturnTrampolineWritten = s.cbReturnTrampolineWritten;

    // Hand each registered module its saved data. A module with no saved entry
    // (e.g. state written by an older build) is left at its current state.
    for (const [name, port] of this.stateModules) {
      if (Object.prototype.hasOwnProperty.call(s.modules, name)) {
        port.load(s.modules[name]);
      }
    }
  }

  /** Load the standard flash0 PGF fonts into pgfFonts (idempotent). Shared by the
   *  sceFontNewLib handler and save-state restore. */
  private _loadStandardFonts(): void {
    if (this.pgfFonts.length > 0) return;
    const names = [
      "ltn0.pgf","ltn1.pgf","ltn2.pgf","ltn3.pgf","ltn4.pgf","ltn5.pgf",
      "ltn6.pgf","ltn7.pgf","ltn8.pgf","ltn9.pgf","ltn10.pgf","ltn11.pgf",
      "ltn12.pgf","ltn13.pgf","ltn14.pgf",
    ];
    for (const name of names) {
      const data = this.pspFs.getFileData(`flash0:/font/${name}`, 0);
      this.pgfFonts.push(data ? new PGF(data.buffer as ArrayBuffer) : null);
    }
    const loaded = this.pgfFonts.filter(Boolean).length;
    log.info(`Font system: ${loaded}/${names.length} PGF fonts loaded`);
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

      const cbId = regs.getGpr(6); // 3rd arg: callback ID from sceGeSetCallback
      const optParamAddr = regs.getGpr(7); // 4th arg: PspGeListArgs pointer

      // GPUCommon.cpp:362-369 — read args fields based on size
      let stackAddr = 0;
      let contextPtr = 0;
      if (optParamAddr !== 0) {
        const argsSize = this.bus.readU32(optParamAddr); // offset 0 = size
        // GPUCommon.cpp:433-436 — context pointer always read (offset 4)
        const ctxPtr = this.bus.readU32(optParamAddr + 4);
        if (ctxPtr !== 0) contextPtr = ctxPtr;
        if (argsSize >= 16) {
          // GPUCommon.cpp:362-364 — numStacks >= 256 → INVALID_SIZE
          const numStacks = this.bus.readU32(optParamAddr + 8);
          if (numStacks >= 256) {
            regs.setGpr(2, 0x80000104); // SCE_KERNEL_ERROR_INVALID_SIZE
            return;
          }
          stackAddr = this.bus.readU32(optParamAddr + 12); // offset 12 = stacks pointer
        }
      }

      // GPUCommon.cpp:371-388 — SDK > 0x01FFFFFF: duplicate listpc/stackAddr check.
      // Real PSP rejects by the list START address — a list halted partway
      // (pc advanced) still blocks re-enqueueing the same address
      // (gpu/signals/simple, 6.60 "Unknown" section).
      if (this.compiledSdkVersion > 0x01FFFFFF) {
        const maskedPc = listAddr & 0x0FFFFFFF;
        for (const existing of this.geLists.values()) {
          if (existing.state !== GeListState.NONE && existing.state !== GeListState.COMPLETED) {
            if ((existing.listAddr & 0x0FFFFFFF) === maskedPc) {
              regs.setGpr(2, 0x80000021); // SCE_KERNEL_ERROR_BUSY
              return;
            }
            if (stackAddr !== 0 && existing.stackAddr === stackAddr) {
              regs.setGpr(2, 0x80000021); // SCE_KERNEL_ERROR_BUSY
              return;
            }
          }
        }
      }

      const listId = this._allocGeListId();
      if (listId < 0) {
        regs.setGpr(2, 0x80000022); // SCE_KERNEL_ERROR_OUT_OF_MEMORY
        return;
      }
      // Determine initial state:
      // - If stall == start (ring-buffer pattern), start STALLING so the worker
      //   isn't sent the list until UpdateStallAddr advances past the start.
      // - If another list is queued, this one is QUEUED.
      // - Otherwise DRAWING.
      let initialState: GeListState;
      if (stallAddr !== 0 && stallAddr === listAddr) {
        initialState = GeListState.STALLING;
      } else if (this.geListQueue.length > 0) {
        initialState = GeListState.QUEUED;
      } else {
        initialState = GeListState.DRAWING;
      }
      const entry: GeListEntry = {
        id: listId, listAddr, pc: listAddr, stallAddr,
        state: initialState,
        cbId: cbId < 0 ? -1 : cbId,
        signal: GeSignalBehavior.NONE,
        subIntrToken: 0,
        callStack: [],
        offsetAddr: 0,
        baseAddr: 0,
        interruptsEnabled: true,
        started: false,
        stackAddr,
        contextPtr,
        signalHalted: false,
      };
      this.geLists.set(listId, entry);
      this.geListQueue.push(listId);
      // Set the caller's return value BEFORE processing — the inline scan can
      // fire GE callbacks which must not see a stale $v0.
      regs.setGpr(2, GE_LIST_ID_MAGIC ^ listId);
      if (this.geDispatcher) {
        // Worker mode: only send to GPU worker when list is at the front (DRAWING)
        if (initialState === GeListState.DRAWING) {
          this.geDispatcher.enqueue(listId, listAddr, stallAddr);
        }
      } else {
        // Headless: run the queue now. The real GE executes in parallel and a
        // short list finishes (firing its interrupts) before the CPU's next
        // instruction — gpu/signals/simple checks this ordering.
        this._processGeQueue();
      }
    });

    // sceGeListUpdateStallAddr(listId, stallAddr) — advance stall for ring buffer
    this.register(GE.sceGeListUpdateStallAddr, (regs) => {
      const listId = regs.getGpr(4) ^ GE_LIST_ID_MAGIC;
      const newStall = regs.getGpr(5);
      // Drain Worker completions so we see the current list state
      if (this.geDispatcher) {
        const done = this.geDispatcher.drainCompletions();
        for (const id of done) this._completeGeList(id);
      }
      const entry = this.geLists.get(listId);
      // GPUCommon.cpp:492-493 — validate list exists and is not NONE
      if (listId < 0 || listId >= HLEKernel.GE_MAX_LISTS || !entry || entry.state === GeListState.NONE) {
        regs.setGpr(2, 0x80000100); // SCE_KERNEL_ERROR_INVALID_ID
        return;
      }
      // GPUCommon.cpp:495-496 — completed list can't update stall
      if (entry.state === GeListState.COMPLETED) {
        regs.setGpr(2, 0x80000020); // SCE_KERNEL_ERROR_ALREADY
        return;
      }
      // GPUCommon.cpp:498-501 — update stall, run list
      entry.stallAddr = newStall;
      // Process queue first (list may not have started yet in deferred mode)
      if (!this.geDispatcher) this._processGeQueue();
      if (entry.state === GeListState.STALLING) {
        // First unstall: send list to worker now that we have real commands to process.
        // (List started with stall==start, so worker was deferred until here.)
        entry.state = GeListState.DRAWING;
        if (this.geDispatcher) {
          this.geDispatcher.enqueue(listId, entry.pc, newStall);
        } else if (!this.geScanningActive) {
          this._scanAndCompleteGeList(listId, entry);
        }
      } else {
        if (this.geDispatcher) {
          this.geDispatcher.updateStall(newStall);
        } else if (entry.state === GeListState.DRAWING && !this.geScanningActive) {
          this._scanAndCompleteGeList(listId, entry);
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
        // Poll mode: return current state WITHOUT processing (GPU runs async)
        // PPSSPP GPUCommon.cpp:234-254
        // PSP_GE_LIST_*: COMPLETED=0, QUEUED=1, DRAWING=2, STALLING=3, PAUSED=4
        if (!entry || entry.state === GeListState.NONE) {
          regs.setGpr(2, 0x80000100); // SCE_KERNEL_ERROR_INVALID_ID
          return;
        }
        let status: number;
        switch (entry.state) {
          case GeListState.QUEUED: status = 1; break;
          case GeListState.DRAWING:
            status = (entry.stallAddr !== 0 && entry.pc === entry.stallAddr) ? 3 : 2;
            break;
          case GeListState.STALLING: status = 3; break;
          case GeListState.COMPLETED: status = 0; break;
          case GeListState.PAUSED: status = 4; break;
          default: status = 0; break;
        }
        regs.setGpr(2, status);
        return;
      }

      // Wait mode (syncType=0): process lists then fire pending interrupts
      if (!this.geDispatcher) this._processGeQueue();
      this._firePendingGeInterrupts();

      // Re-check entry state after processing
      const entryAfter = this.geLists.get(listId);
      if (!entryAfter || entryAfter.state === GeListState.COMPLETED || entryAfter.state === GeListState.NONE) {
        regs.setGpr(2, 0);
        return;
      }

      // Block until this list finishes
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.GE_LIST_SYNC;
        t.waitGeListId = listId;
        t.isProcessingCallbacks = false; // per-wait (PPSSPP processCallbacks param)
        this.saveContext(t, regs);
        t.context.gpr[2] = 0;
        if (!this.reschedule(regs)) {
          this.idleBreak = true;
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
        // Poll mode — PPSSPP GPUCommon.cpp:200-215 peeks while the async GPU
        // thread makes progress in the background. Our GPU "progress" is the
        // synchronous queue scan, so process pending lists here too; otherwise
        // a game polling DrawSync in a tight loop (Burnout Legends) spins
        // forever on a list nothing else will ever run.
        if (!this.geDispatcher) this._processGeQueue();
        // PSP_GE_LIST_*: COMPLETED=0, QUEUED=1, DRAWING=2, STALLING=3, PAUSED=4
        // Find first non-completed list in queue
        let topEntry: GeListEntry | undefined;
        for (const id of this.geListQueue) {
          const e = this.geLists.get(id);
          if (e && e.state !== GeListState.COMPLETED) { topEntry = e; break; }
        }
        if (!topEntry) {
          regs.setGpr(2, 0); // PSP_GE_LIST_COMPLETED
          return;
        }
        // Check if stalled
        if (topEntry.stallAddr !== 0 && topEntry.pc === topEntry.stallAddr) {
          regs.setGpr(2, 3); // PSP_GE_LIST_STALLING
        } else if (topEntry.state === GeListState.STALLING) {
          regs.setGpr(2, 3);
        } else {
          regs.setGpr(2, 2); // PSP_GE_LIST_DRAWING
        }
        return;
      }

      // Wait mode (syncType=0): process all lists then fire pending interrupts
      if (!this.geDispatcher) this._processGeQueue();
      this._firePendingGeInterrupts();

      if (!this.hasActiveGeLists()) {
        // PPSSPP GPUCommon.cpp:191-195 — reset COMPLETED → NONE when all done
        for (const e of this.geLists.values()) {
          if (e.state === GeListState.COMPLETED) e.state = GeListState.NONE;
        }
        this._wakeGeDrawSyncWaiters();
        regs.setGpr(2, 0);
        return;
      }

      // Block calling thread until all GE work completes
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.GE_DRAW_SYNC;
        t.isProcessingCallbacks = false; // per-wait (PPSSPP processCallbacks param)
        this.saveContext(t, regs);
        t.context.gpr[2] = 0;
        if (!this.reschedule(regs)) {
          // No other threads — idle-break so the frame loop advances
          // CoreTiming to VBlank → drainGeCompletions wakes us when
          // the GE worker finishes. Matches PPSSPP: no timeout.
          this.idleBreak = true;
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
      // Process pending lists so we see the correct state
      if (!this.geDispatcher) this._processGeQueue();
      const mode = regs.getGpr(4);
      const unknownPtr = regs.getGpr(5);
      if (mode > 1) {
        regs.setGpr(2, 0x80000107); // SCE_KERNEL_ERROR_INVALID_MODE
        return;
      }
      // PPSSPP sceGe.cpp:458-460 — pointer validation
      // (int)unknownPtr < 0 || (int)(unknownPtr + 16) < 0 → PRIV_REQUIRED
      if (unknownPtr !== 0) {
        const signed = unknownPtr | 0;
        const signedPlus16 = (unknownPtr + 16) | 0;
        if (signed < 0 || signedPlus16 < 0) {
          regs.setGpr(2, 0x80000023); // SCE_KERNEL_ERROR_PRIV_REQUIRED
          return;
        }
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
          entry.signal = GeSignalBehavior.NONE;
          entry.started = false;
        }
        this.geListQueue.length = 0;
        this.nextGeListSlot = 0;
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
          entry.signal = GeSignalBehavior.NONE;
        } else {
          // GPUCommon.cpp:524-525 — set queued after break
          entry.state = GeListState.QUEUED;
          entry.signal = GeSignalBehavior.NONE;
        }
        this.geIsBreak = false;
        // Re-enqueue to worker for processing / scan inline
        if (this.geDispatcher) {
          this.geDispatcher.enqueue(listId, entry.pc, entry.stallAddr);
        } else if (!this.geScanningActive) {
          entry.state = GeListState.DRAWING;
          this._processGeQueue();
        }
        regs.setGpr(2, 0);
      } else if (entry.state === GeListState.DRAWING || entry.state === GeListState.STALLING) {
        // GPUCommon.cpp:528-532 — SDK version check. A stalled list is state
        // RUNNING in PPSSPP (the stall lives in gpuState), so same branch.
        regs.setGpr(2, this.compiledSdkVersion >= 0x02000000 ? 0x80000020 : (-1 >>> 0));
      } else {
        // GPUCommon.cpp:534-538 — SDK version check
        regs.setGpr(2, this.compiledSdkVersion >= 0x02000000 ? 0x80000004 : (-1 >>> 0));
      }
    });

    // sceGeGetStack(index, stackPtr) — PPSSPP GPUCommon.cpp:270-293
    // Returns the GE call stack depth; writes one stack entry if index >= 0.
    this.register(GE.sceGeGetStack, (regs, bus) => {
      // Process pending lists before checking stack
      if (!this.geDispatcher) this._processGeQueue();
      const index = regs.getGpr(4) | 0;
      const stackPtr = regs.getGpr(5);
      const currentId = this.geListQueue.length > 0 ? this.geListQueue[0]! : -1;
      const entry = currentId >= 0 ? this.geLists.get(currentId) : undefined;
      if (!entry) {
        // GPUCommon.cpp:271-274 — no currentList: 0, not an error
        regs.setGpr(2, 0);
        return;
      }
      const depth = entry.callStack.length;
      if (depth <= index) {
        regs.setGpr(2, 0x80000102); // SCE_KERNEL_ERROR_INVALID_INDEX
        return;
      }
      if (index >= 0 && stackPtr !== 0) {
        const e = entry.callStack[index]!;
        bus.writeU32(stackPtr, 0);
        bus.writeU32(stackPtr + 4, e.pc + 4);
        bus.writeU32(stackPtr + 8, e.offsetAddr);
        bus.writeU32(stackPtr + 28, e.baseAddr);
      }
      regs.setGpr(2, depth);
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

      const cbId = regs.getGpr(6);
      const optParamAddr = regs.getGpr(7);

      // Parse args (same as EnQueue)
      let stackAddr = 0;
      let contextPtr = 0;
      if (optParamAddr !== 0) {
        const argsSize = this.bus.readU32(optParamAddr);
        const ctxPtr = this.bus.readU32(optParamAddr + 4);
        if (ctxPtr !== 0) contextPtr = ctxPtr;
        if (argsSize >= 16) {
          const numStacks = this.bus.readU32(optParamAddr + 8);
          if (numStacks >= 256) {
            regs.setGpr(2, 0x80000104); // SCE_KERNEL_ERROR_INVALID_SIZE
            return;
          }
          stackAddr = this.bus.readU32(optParamAddr + 12);
        }
      }

      const listId = this._allocGeListId();
      if (listId < 0) {
        regs.setGpr(2, 0x80000022); // SCE_KERNEL_ERROR_OUT_OF_MEMORY
        return;
      }
      const entry: GeListEntry = {
        id: listId, listAddr, pc: listAddr, stallAddr,
        state: GeListState.PAUSED, // GPUCommon.cpp:447 — head list starts PAUSED
        cbId: cbId < 0 ? -1 : cbId,
        signal: GeSignalBehavior.NONE,
        subIntrToken: 0,
        callStack: [],
        offsetAddr: 0,
        baseAddr: 0,
        interruptsEnabled: true,
        started: false,
        stackAddr,
        contextPtr,
        signalHalted: false,
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
      if (this.geDispatcher) {
        this.geDispatcher.enqueue(listId, listAddr, stallAddr);
      } else if (!this.geScanningActive) {
        this._scanAndCompleteGeList(listId, entry);
      }
      regs.setGpr(2, GE_LIST_ID_MAGIC ^ listId);
    });

    // sceGeListDeQueue(listId) — PPSSPP sceGe.cpp:397-402, GPUCommon.cpp:468-488
    // Removes a queued (not yet started) display list.
    this.register(GE.sceGeListDeQueue, (regs) => {
      // Process pending lists so started flag is set correctly
      if (!this.geDispatcher) this._processGeQueue();
      const listId = regs.getGpr(4) ^ GE_LIST_ID_MAGIC;
      const entry = this.geLists.get(listId);
      if (!entry || entry.state === GeListState.NONE) {
        regs.setGpr(2, 0x80000100); // SCE_KERNEL_ERROR_INVALID_ID
        return;
      }
      // GPUCommon.cpp:473-474 — if started, return BUSY
      if (entry.started) {
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
    this.register(GE.sceGeSaveContext, (regs, _bus) => {
      const ctxAddr = regs.getGpr(4);
      // Headless mode: process pending lists to update cmdmem/addresses
      if (!this.geDispatcher) this._processGeQueue();

      // PPSSPP sceGe.cpp:532-534 — if GPU is busy (BusyDrawing), return -1
      // BusyDrawing is true when lists are actively being processed (DRAWING/QUEUED),
      // NOT when paused or stalled.
      const gpuBusy = this.geDispatcher ? this.geDispatcher.hasActive() :
        [...this.geLists.values()].some(e =>
          e.state === GeListState.DRAWING || e.state === GeListState.QUEUED ||
          e.state === GeListState.STALLING);
      if (ctxAddr === 0 || gpuBusy) {
        regs.setGpr(2, (-1 >>> 0));
        return;
      }
      this._initGeCommandMem();

      this._saveGeContextTo(ctxAddr);

      regs.setGpr(2, 0);
    });

    // sceGeRestoreContext(ctxAddr) — PPSSPP sceGe.cpp:547-558, GPUState.cpp:205-239
    // If GPU busy → SCE_KERNEL_ERROR_BUSY. If valid addr, restores gstate from memory.
    // Since our GE state is in the worker, we accept the call and skip the actual restore.
    // PPSSPP only guards with BusyDrawing() and Memory::IsValidAddress(), not null check.
    this.register(GE.sceGeRestoreContext, (regs) => {
      // PPSSPP sceGe.cpp:548-549 — if GPU is busy (BusyDrawing), return BUSY
      const gpuBusy = this.geDispatcher ? this.geDispatcher.hasActive() :
        [...this.geLists.values()].some(e =>
          e.state === GeListState.DRAWING || e.state === GeListState.QUEUED ||
          e.state === GeListState.STALLING);
      if (gpuBusy) {
        regs.setGpr(2, 0x80000021); // SCE_KERNEL_ERROR_BUSY
        return;
      }
      const ctxAddr = regs.getGpr(4);
      if (ctxAddr !== 0) {
        this._restoreGeContextFrom(ctxAddr);
      }
      regs.setGpr(2, 0);
    });

    // sceGeGetCmd(cmd) — PPSSPP sceGe.cpp:575-605
    // Returns gstate.cmdmem[cmd]. Matrix data commands are masked.
    this.register(GE.sceGeGetCmd, (regs) => {
      const cmd = regs.getGpr(4);
      if (cmd < 0 || cmd >= 256) {
        regs.setGpr(2, 0x80000102); // SCE_KERNEL_ERROR_INVALID_INDEX (ErrorCodes.h:14)
        return;
      }
      // cmdmem is always updated during scanning, no need to re-process here
      this._initGeCommandMem();
      regs.setGpr(2, this.geCommandMem[cmd]!);
    });

    // sceGeGetMtx(type, matrixPtr) — PPSSPP sceGe.cpp:560-573, GPUCommon.cpp:302-330
    // Reads a matrix as raw 24-bit values (float32 bits >> 8, PPSSPP toFloat24).
    this.register(GE.sceGeGetMtx, (regs, bus) => {
      const type = regs.getGpr(4) | 0;
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
      // Process pending lists so matrix uploads are visible
      if (!this.geDispatcher) this._processGeQueue();
      const size = type === 10 ? 16 : 12; // GE_MTX_PROJECTION (10) is 4×4, others are 3×4
      const mtx = this.ensureGeProcessor().getMatrixFloats(type);
      const conv = new DataView(new ArrayBuffer(4));
      for (let i = 0; i < size; i++) {
        conv.setFloat32(0, mtx ? mtx[i]! : 0, true);
        bus.writeU32(matrixPtr + i * 4, conv.getUint32(0, true) >>> 8);
      }
      regs.setGpr(2, 0);
    });
  }


  // ── GE signal callback invoker ───────────────────────────────────────────

  /** Allocate a GE list ID from the 64-slot pool. Returns -1 if full.
   *  PPSSPP GPUCommon.cpp:392-406 — prefers NONE (breaks), falls back to COMPLETED. */
  private _allocGeListId(): number {
    const MAX = HLEKernel.GE_MAX_LISTS;
    let fallbackId = -1;
    for (let i = 0; i < MAX; i++) {
      const slot = (this.nextGeListSlot + i) % MAX;
      const existing = this.geLists.get(slot);
      if (!existing || existing.state === GeListState.NONE) {
        this.nextGeListSlot = (slot + 1) % MAX;
        return slot;
      }
      // PPSSPP: COMPLETED with waitUntilTicks < currentTicks → fallback (no
      // break, so a later candidate in scan order overwrites an earlier one)
      if (existing.state === GeListState.COMPLETED) {
        fallbackId = slot;
      }
    }
    if (fallbackId >= 0) {
      this.nextGeListSlot = (fallbackId + 1) % MAX;
      return fallbackId;
    }
    return -1; // all 64 slots in use
  }

  // ── Headless GE command scanner ─────────────────────────────────────────
  // In headless mode (no Web Worker), we scan GE display list commands to
  // track state (cmdmem[]), handle control flow, and process SIGNAL/FINISH/END.
  // This mirrors PPSSPP GPUCommon::ProcessDLQueue + SlowRunLoop + Execute_End.

  /** GE command opcodes used by the scanner (subset of ge-commands.ts GE_CMD) */
  private static readonly GE_OPCODE = {
    NOP: 0x00, VADDR: 0x01, IADDR: 0x02,
    JUMP: 0x08, BJUMP: 0x09, CALL: 0x0A, RET: 0x0B,
    END: 0x0C, SIGNAL: 0x0E, FINISH: 0x0F, BASE: 0x10, OFFSET_ADDR: 0x13,
    ORIGIN_ADDR: 0x14,
  } as const;

  private static readonly GE_CALL_STACK_DEPTH = 8;

  /** Initialize geCommandMem to PPSSPP reset defaults: cmdmem[i] = i << 24 */
  private _initGeCommandMem(): void {
    if (this.geCommandMemReady) return;
    for (let i = 0; i < 256; i++) this.geCommandMem[i] = i << 24;
    this.geCommandMemReady = true;
  }

  /** PPSSPP contextCmdRanges — specific command index ranges saved in context */
  private static readonly CONTEXT_CMD_RANGES: readonly [number, number][] = [
    [0x00, 0x02], [0x10, 0x10], [0x12, 0x28], [0x2c, 0x33],
    [0x36, 0x38], [0x42, 0x4D], [0x50, 0x51], [0x53, 0x58],
    [0x5B, 0xB5], [0xB8, 0xC3], [0xC5, 0xD0], [0xD2, 0xE9],
    [0xEB, 0xEC], [0xEE, 0xEE], [0xF0, 0xF6], [0xF8, 0xF9],
  ];

  /** Save GE context to memory (PPSSPP gstate.Save / GPUState.cpp:122-168) */
  private _saveGeContextTo(ctxAddr: number): void {
    const bus = this.bus;
    this._initGeCommandMem();
    // Header (zeroed except addresses)
    for (let i = 0; i < 17; i++) bus.writeU32(ctxAddr + i * 4, 0);
    bus.writeU32(ctxAddr + 5 * 4, this.geVertexAddr);
    bus.writeU32(ctxAddr + 6 * 4, this.geIndexAddr);
    bus.writeU32(ctxAddr + 7 * 4, this.geOffsetAddr);
    // Command values using PPSSPP's contextCmdRanges mapping
    let offset = 17;
    for (const [start, end] of HLEKernel.CONTEXT_CMD_RANGES) {
      for (let cmd = start; cmd <= end; cmd++) {
        bus.writeU32(ctxAddr + offset * 4, this.geCommandMem[cmd]!);
        offset++;
      }
    }
    // Remaining (clut + mtxnums + matrix floats) zeroed
    for (let i = offset; i < 380; i++) {
      bus.writeU32(ctxAddr + i * 4, 0);
    }
  }

  /** Restore GE context from memory (PPSSPP gstate.Restore / GPUState.cpp:205-239) */
  private _restoreGeContextFrom(ctxAddr: number): void {
    const bus = this.bus;
    this._initGeCommandMem();
    this.geVertexAddr = bus.readU32(ctxAddr + 5 * 4);
    this.geIndexAddr = bus.readU32(ctxAddr + 6 * 4);
    this.geOffsetAddr = bus.readU32(ctxAddr + 7 * 4);
    let offset = 17;
    for (const [start, end] of HLEKernel.CONTEXT_CMD_RANGES) {
      for (let cmd = start; cmd <= end; cmd++) {
        this.geCommandMem[cmd] = bus.readU32(ctxAddr + offset * 4);
        offset++;
      }
    }
    // Reapply the restored state to the GE processor (PPSSPP ReapplyGfxState):
    // without this the processor keeps state from the finished list (e.g. a
    // 16bpp FRAMEBUFPIXFMT leaking into the game's 32bpp main rendering).
    const proc = this.ensureGeProcessor();
    for (const [start, end] of HLEKernel.CONTEXT_CMD_RANGES) {
      for (let cmd = start; cmd <= end; cmd++) {
        const op = this.geCommandMem[cmd]!;
        proc.executeCommand(op >>> 24, op & 0x00FFFFFF);
      }
    }
  }

  /** Fire a deferred HANDLER_CONTINUE signal callback, if one is pending. */
  private _fireDeferredGeSignalCb(): void {
    if (!this.gePendingSignalCb) return;
    const { token, cbId, a2 } = this.gePendingSignalCb;
    this.gePendingSignalCb = null;
    const cb = this.geCallbacks.get(cbId);
    if (cb && cb.signalFunc !== 0) {
      this._invokeGeCb(cb.signalFunc, token, cb.signalArg, a2);
    }
  }

  /** PPSSPP GPUCommon Execute_End: when a list that saved a context completes,
   *  the context is restored before the next list runs. */
  private _restoreListContext(entry: GeListEntry): void {
    if (!entry.started || entry.contextPtr === 0) return;
    this._restoreGeContextFrom(entry.contextPtr);
    entry.started = false; // PPSSPP: don't restore again
  }

  /** Compute relative address from offset + base, matching PPSSPP gstate_c.getRelativeAddress */
  private _geRelativeAddr(list: GeListEntry, param: number): number {
    return ((list.baseAddr | param) + list.offsetAddr) & 0x0FFFFFFF;
  }

  /**
   * Headless GE display list scanner — processes commands from a display list
   * without rendering. Updates geCommandMem[] for every command, handles
   * JUMP/CALL/RET control flow, and processes SIGNAL+END / FINISH+END pairs.
   *
   * Returns the resulting list state after scanning.
   *
   * Models PPSSPP GPUCommon::ProcessDLQueue + SlowRunLoop + Execute_End.
   */
  private _scanGeListHeadless(entry: GeListEntry): GeListState {
    const { GE_OPCODE, GE_CALL_STACK_DEPTH } = HLEKernel;
    const bus = this.bus;
    this._initGeCommandMem();

    // The GE processor executes state/draw commands (rasterization, block
    // transfers, WebGL draws) while this scanner owns control flow, signals,
    // and kernel-visible list state.
    const proc = this.ensureGeProcessor();

    // PPSSPP GPUCommon.cpp:769-771: save context on first start
    if (!entry.started && entry.contextPtr !== 0) {
      this._saveGeContextTo(entry.contextPtr);
    }

    if (!entry.started) proc.noteListStart();

    // Mark as started (PPSSPP GPUCommon.cpp:772: list.started = true)
    entry.started = true;

    // Sync global GE state from the list being processed
    // (PPSSPP GPUCommon.cpp:774: gstate_c.offsetAddr = list.offsetAddr)
    this.geOffsetAddr = entry.offsetAddr;

    const MAX_COMMANDS = 1_000_000; // safety limit — auto-completes if budget exceeded
    let pc = entry.pc;
    this.gePendingSignalCb = null;
    let count = 0;
    let consecutiveNops = 0;

    while (count < MAX_COMMANDS) {
      // Stall check
      if (entry.stallAddr !== 0 && pc === entry.stallAddr) {
        entry.pc = pc;
        entry.state = GeListState.STALLING;
        // A deferred HANDLER_CONTINUE callback fires once the GPU stops at the
        // stall (the handler then observes listsync 3 STALL — gpu/signals/simple)
        this._fireDeferredGeSignalCb();
        return GeListState.STALLING;
      }

      const op = bus.readU32(pc);
      const cmd = op >>> 24;
      const param = op & 0x00FFFFFF;

      // Store in cmdmem (PPSSPP: gstate.cmdmem[cmd] = op)
      this.geCommandMem[cmd] = op;

      switch (cmd) {
        case GE_OPCODE.NOP:
          consecutiveNops++;
          // If we've seen 5000+ consecutive NOPs, we're likely in uninitialized
          // memory. Auto-complete so waiting threads aren't stuck.
          if (consecutiveNops > 5000) {
            entry.pc = pc;
            entry.state = GeListState.COMPLETED;
            this._restoreListContext(entry);
            return GeListState.COMPLETED;
          }
          break;

        case GE_OPCODE.VADDR:
          // PPSSPP: gstate_c.vertexAddr = getRelativeAddress(param)
          this.geVertexAddr = this._geRelativeAddr(entry, param);
          proc.setVertexAddr(this.geVertexAddr);
          break;

        case GE_OPCODE.IADDR:
          // PPSSPP: gstate_c.indexAddr = getRelativeAddress(param)
          this.geIndexAddr = this._geRelativeAddr(entry, param);
          proc.setIndexAddr(this.geIndexAddr);
          break;

        case GE_OPCODE.BASE:
          // PPSSPP: gstate.base = op; (the full op including cmd byte)
          entry.baseAddr = (param & 0x000F0000) << 8;
          break;

        case GE_OPCODE.OFFSET_ADDR:
          // PPSSPP: gstate_c.offsetAddr = op << 8
          entry.offsetAddr = param << 8;
          this.geOffsetAddr = entry.offsetAddr;
          break;

        case GE_OPCODE.ORIGIN_ADDR:
          // PPSSPP: gstate_c.offsetAddr = currentList->pc
          entry.offsetAddr = pc;
          this.geOffsetAddr = pc;
          break;

        case GE_OPCODE.JUMP: {
          const target = this._geRelativeAddr(entry, param & 0xFFFFFC);
          pc = target - 4; // main loop adds +4
          break;
        }

        case GE_OPCODE.CALL: {
          const target = this._geRelativeAddr(entry, param & 0xFFFFFC);
          if (entry.callStack.length < GE_CALL_STACK_DEPTH) {
            entry.callStack.push({
              pc: pc + 4,
              offsetAddr: entry.offsetAddr,
              baseAddr: entry.baseAddr,
            });
          }
          pc = target - 4;
          break;
        }

        case GE_OPCODE.RET:
          if (entry.callStack.length > 0) {
            const stackEntry = entry.callStack.pop()!;
            entry.offsetAddr = stackEntry.offsetAddr;
            // PPSSPP Execute_Ret: does NOT restore baseAddr (only SIGNAL RET does)
            pc = (stackEntry.pc & 0x0FFFFFFF) - 4;
          }
          break;

        case GE_OPCODE.FINISH:
          // FINISH alone just records subIntrToken — actual completion is in END.
          // Skip: pc advances normally, END follows.
          break;

        case GE_OPCODE.END: {
          // END is the list terminator. Check what preceded it.
          // PPSSPP Execute_End reads the previous command from (pc - 4).
          const prevOp = bus.readU32(pc - 4);
          const prevCmd = prevOp >>> 24;

          if (prevCmd === GE_OPCODE.SIGNAL) {
            // SIGNAL+END pair
            const behaviour = (prevOp >>> 16) & 0xFF;
            const signalData = prevOp & 0xFFFF;
            const endData = op & 0xFFFF;
            entry.subIntrToken = signalData;
            let trigger = true;

            switch (behaviour) {
              case GeSignalBehavior.HANDLER_SUSPEND:
                // Suspend list, trigger interrupt
                entry.signal = GeSignalBehavior.HANDLER_SUSPEND;
                break;

              case GeSignalBehavior.HANDLER_CONTINUE:
                // Continue list, trigger interrupt
                entry.signal = GeSignalBehavior.HANDLER_CONTINUE;
                break;

              case GeSignalBehavior.HANDLER_PAUSE:
                // Don't trigger now — wait for FINISH to pause
                trigger = false;
                entry.signal = GeSignalBehavior.HANDLER_PAUSE;
                break;

              case GeSignalBehavior.SYNC:
                // Memory barrier, no handler
                trigger = false;
                entry.signal = GeSignalBehavior.SYNC;
                break;

              case GeSignalBehavior.JUMP:
              case GeSignalBehavior.RJUMP:
              case GeSignalBehavior.OJUMP: {
                // Jump (absolute/relative/origin). The -4 counteracts the
                // loop-bottom pc += 4 (PPSSPP: "pc will be increased after we return").
                trigger = false;
                entry.signal = behaviour;
                let target = (((signalData << 16) | endData) & 0xFFFFFFFC) >>> 0;
                if (behaviour === GeSignalBehavior.RJUMP) target = (target + pc - 4) >>> 0;
                else if (behaviour === GeSignalBehavior.OJUMP) target = this._geRelativeAddr(entry, target);
                pc = (target - 4) >>> 0;
                break;
              }

              case GeSignalBehavior.CALL:
              case GeSignalBehavior.RCALL:
              case GeSignalBehavior.OCALL: {
                // Subroutine call (saves offsetAddr + baseAddr + raw cmd regs)
                trigger = false;
                entry.signal = behaviour;
                if (entry.callStack.length < GE_CALL_STACK_DEPTH) {
                  entry.callStack.push({
                    pc: pc + 4,
                    offsetAddr: entry.offsetAddr,
                    baseAddr: entry.baseAddr,
                    baseCmd: this.geCommandMem[GE_OPCODE.BASE]!,
                    offsetCmd: this.geCommandMem[GE_OPCODE.OFFSET_ADDR]!,
                  });
                }
                let target = (((signalData << 16) | endData) & 0xFFFFFFFC) >>> 0;
                if (behaviour === GeSignalBehavior.RCALL) target = (target + pc - 4) >>> 0;
                else if (behaviour === GeSignalBehavior.OCALL) target = this._geRelativeAddr(entry, target);
                pc = (target - 4) >>> 0;
                break;
              }

              case GeSignalBehavior.RET: {
                // Return from subroutine (restores offsetAddr + baseAddr)
                trigger = false;
                entry.signal = GeSignalBehavior.RET;
                if (entry.callStack.length > 0) {
                  const stackEntry = entry.callStack.pop()!;
                  entry.offsetAddr = stackEntry.offsetAddr;
                  entry.baseAddr = stackEntry.baseAddr;
                  if (stackEntry.baseCmd !== undefined) this.geCommandMem[GE_OPCODE.BASE] = stackEntry.baseCmd;
                  if (stackEntry.offsetCmd !== undefined) this.geCommandMem[GE_OPCODE.OFFSET_ADDR] = stackEntry.offsetCmd;
                  pc = ((stackEntry.pc & 0x0FFFFFFF) - 4) >>> 0;
                }
                break;
              }

              case GeSignalBehavior.BREAK1:
              case GeSignalBehavior.BREAK2:
                // Breakpoint signals: no-ops without a debugger on real PSP —
                // no handler call, execution continues past the END.
                trigger = false;
                entry.signal = behaviour;
                break;

              default:
                // Unknown signal behavior (e.g. 0x00, 0xEE): real PSP fires no
                // handler and the GE stops at the END while the list stays
                // DRAWING forever (gpu/signals/simple "Unknown" sections).
                // PPSSPP triggers the callback here instead — one reason it
                // fails gpu/signals/simple.
                entry.signal = behaviour;
                entry.pc = pc + 4;
                entry.signalHalted = true;
                return entry.state;
            }

            // HANDLER_SUSPEND: list pauses for the duration of the handler.
            // PPSSPP GPUCommon.cpp:1019-1026 — only SDK <= 0x02000010 makes the
            // pause visible as state PAUSED; newer SDKs keep RUNNING (listsync 2).
            if (behaviour === GeSignalBehavior.HANDLER_SUSPEND) {
              if (this.compiledSdkVersion <= 0x02000010) {
                entry.state = GeListState.PAUSED;
              }
              entry.pc = pc + 4;
            }

            // Trigger signal interrupt/callback if needed
            if (trigger && entry.interruptsEnabled) {
              if (behaviour === GeSignalBehavior.HANDLER_CONTINUE) {
                // HANDLER_CONTINUE: defer callback — list continues scanning first.
                // In PPSSPP, the interrupt is async; the GPU continues while interrupt is pending.
                // Store pending signal info; will be fired after scan completes.
                this.gePendingSignalCb = {
                  token: entry.subIntrToken & 0xFFFF,
                  cbId: entry.cbId >= 0 ? entry.cbId : this.activeGeCbId,
                  a2: this.compiledSdkVersion <= 0x02000010 ? 0 : pc + 4,
                };
              } else {
                const cbId = entry.cbId >= 0 ? entry.cbId : this.activeGeCbId;
                const cb = this.geCallbacks.get(cbId);
                if (cb && cb.signalFunc !== 0) {
                  // a2: PPSSPP sceGe.cpp:127 — 0 for SDK <= 0x02000010, else END pc+4
                  const a2 = this.compiledSdkVersion <= 0x02000010 ? 0 : pc + 4;
                  this._invokeGeCb(cb.signalFunc, entry.subIntrToken & 0xFFFF, cb.signalArg, a2);
                }
              }
            }

            // HANDLER_SUSPEND: auto-resume after the handler returns, for ALL SDKs.
            // PPSSPP sceGe.cpp handleResult → InterruptEnd → ProcessDLQueue: old SDK
            // sets state QUEUED first; new SDK never left RUNNING. Either way the
            // list continues right after the interrupt completes.
            if (behaviour === GeSignalBehavior.HANDLER_SUSPEND) {
              entry.state = GeListState.DRAWING;
              pc = entry.pc - 4; // continue scanning (will be incremented by pc += 4)
            }
            // HANDLER_CONTINUE: keep scanning (list was never paused).
          } else if (prevCmd === GE_OPCODE.FINISH) {
            // FINISH+END — list completion (or pause if signal was HANDLER_PAUSE)
            const finishData = prevOp & 0xFFFF;

            switch (entry.signal) {
              case GeSignalBehavior.HANDLER_PAUSE:
                // Pause the list and trigger interrupt with the signal token
                // PPSSPP: FINISH+END with HANDLER_PAUSE → PAUSED, trigger signal callback
                entry.state = GeListState.PAUSED;
                if (entry.interruptsEnabled) {
                  const cbId = entry.cbId >= 0 ? entry.cbId : this.activeGeCbId;
                  const cb = this.geCallbacks.get(cbId);
                  if (cb && cb.signalFunc !== 0) {
                    const a2 = this.compiledSdkVersion <= 0x02000010 ? 0 : pc + 4;
                    this._invokeGeCb(cb.signalFunc, entry.subIntrToken & 0xFFFF, cb.signalArg, a2);
                  }
                }
                entry.pc = pc + 4;
                return GeListState.PAUSED;

              case GeSignalBehavior.SYNC:
                // Clear signal, continue
                entry.signal = GeSignalBehavior.NONE;
                break;

              default: {
                // Normal list completion — PPSSPP: FINISH+END with no PAUSE signal
                entry.subIntrToken = finishData;
                entry.pc = pc + 4;

                // Fire deferred HANDLER_CONTINUE signal callback BEFORE finish
                if (this.gePendingSignalCb) {
                  const { token, cbId: sCbId, a2: sA2 } = this.gePendingSignalCb;
                  this.gePendingSignalCb = null;
                  entry.state = GeListState.DRAWING; // signal sees DRAWING
                  const sCb = this.geCallbacks.get(sCbId);
                  if (sCb && sCb.signalFunc !== 0) {
                    this._invokeGeCb(sCb.signalFunc, token, sCb.signalArg, sA2);
                  }
                }

                entry.state = GeListState.COMPLETED;

                // Fire finish callback inline
                if (entry.interruptsEnabled) {
                  const cbId = entry.cbId >= 0 ? entry.cbId : this.activeGeCbId;
                  const cb = this.geCallbacks.get(cbId);
                  if (cb && cb.finishFunc !== 0) {
                    // a2: 0 for SDK <= 0x02000010, else END pc+4 (sceGe.cpp:127)
                    const a2 = this.compiledSdkVersion <= 0x02000010 ? 0 : pc + 4;
                    this._invokeGeCb(cb.finishFunc, entry.subIntrToken & 0xFFFF, cb.finishArg, a2);
                  }
                }

                entry.state = GeListState.COMPLETED;
                this._restoreListContext(entry);
                return GeListState.COMPLETED;
              }
            }
          } else {
            // Standalone END without FINISH or SIGNAL preceding — shouldn't happen
            // in well-formed lists, but treat as completion for safety.
            entry.state = GeListState.COMPLETED;
            entry.pc = pc + 4;
            this._restoreListContext(entry);
            return GeListState.COMPLETED;
          }
          break;
        }

        case GE_OPCODE.SIGNAL:
          // SIGNAL is always followed by END — we process the pair when we hit END.
          // Just record it in cmdmem and advance.
          break;

        default:
          // All other commands: stored in cmdmem above; the GE processor
          // executes the state update / draw (PRIM, CLEAR, block transfer, ...).
          proc.executeCommand(cmd, param);
          consecutiveNops = 0;
          break;
      }

      pc += 4;
      count++;
    }

    // Safety: ran out of budget without hitting END.
    // Auto-complete the list so threads waiting on DrawSync aren't stuck forever.
    // This matches the pre-scanner headless behaviour (instant completion).
    entry.pc = pc;
    entry.state = GeListState.COMPLETED;
    this._restoreListContext(entry);
    return GeListState.COMPLETED;
  }

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
  /** Invoke GE signal callback for the given cbId (used by GE worker signal handling). */
  _invokeGeSignalForCb(cbId: number, signalId: number): void {
    const cb = this.geCallbacks.get(cbId >= 0 ? cbId : this.activeGeCbId);
    if (!cb || cb.signalFunc === 0) return;
    this._invokeGeCb(cb.signalFunc, signalId, cb.signalArg, 0);
  }

  /** Are there any GE lists still being processed? */
  hasActiveGeLists(): boolean {
    if (this.geDispatcher) return this.geDispatcher.hasActive();

    // Check if any list in the queue is still active (not completed/none)
    for (const id of this.geListQueue) {
      const e = this.geLists.get(id);
      if (e && e.state !== GeListState.COMPLETED && e.state !== GeListState.NONE) return true;
    }
    return false;
  }

  /**
   * Mark a GE list as completed, remove from queue, fire callbacks, and wake waiters.
   * @param skipCallbacks — when true, callbacks are not fired (scanner already handled them)
   */
  private _completeGeList(listId: number, skipCallbacks = false): void {
    const entry = this.geLists.get(listId);
    if (!entry) return;
    entry.state = GeListState.COMPLETED;
    const idx = this.geListQueue.indexOf(listId);
    if (idx >= 0) this.geListQueue.splice(idx, 1);

    // PPSSPP GPUCommon.cpp InterruptEnd: restore context if list had one
    if (entry.started && entry.contextPtr !== 0) {
      this._restoreGeContextFrom(entry.contextPtr);
    }

    if (!skipCallbacks) {
      // Fire finish callback (PPSSPP: FINISH cmd → subintr FINISH)
      // Signal callbacks are fired during list execution, not at completion.
      const cbId = entry.cbId >= 0 ? entry.cbId : this.activeGeCbId;
      const cb = this.geCallbacks.get(cbId);
      if (cb && cb.finishFunc !== 0) {
        this._invokeGeCb(cb.finishFunc, entry.subIntrToken & 0xFFFF, cb.finishArg, 0);
      }
    }
    this._wakeGeListWaiters(listId);

    // In dispatcher mode, promote next QUEUED list to DRAWING and send to worker
    if (this.geDispatcher && this.geListQueue.length > 0) {
      const nextId = this.geListQueue[0]!;
      const next = this.geLists.get(nextId);
      if (next && next.state === GeListState.QUEUED) {
        next.state = GeListState.DRAWING;
        this.geDispatcher.enqueue(nextId, next.pc, next.stallAddr);
      }
    }
  }

  drainGeCompletions(regs: AllegrexRegisters): void {
    if (this.geDispatcher) {
      const done = this.geDispatcher.drainCompletions();
      for (const id of done) this._completeGeList(id);
    }

    // Wake GE waiters when no active lists remain.
    if (!this.hasActiveGeLists()) {
      let woke = false;
      for (const t of this.threads.values()) {
        if (t.state === ThreadState.WAITING &&
            (t.waitType === WaitType.GE_DRAW_SYNC || t.waitType === WaitType.GE_LIST_SYNC)) {
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
      this._invokeGeSignalForCb(-1, signalId);
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
    // Validate: callback must be in RAM or scratchpad.
    const phys = funcAddr & 0x1FFFFFFF;
    const validCode = (phys >= MemoryRegion.RAM_START && phys < MemoryRegion.RAM_START + 0x04000000) ||
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
    // Suppress rescheduling during callback (matches PPSSPP interrupt context)
    const prevSuppress = this.suppressReschedule;
    this.suppressReschedule = true;
    const MAX_CALLBACK_STEPS = 200_000;
    let steps = 0;
    while (!returned && !cpu.stepFaulted && steps < MAX_CALLBACK_STEPS) {
      cpu.step();
      steps++;
    }
    this.suppressReschedule = prevSuppress;

    if (steps >= MAX_CALLBACK_STEPS) {
      log.warn(`GE callback exceeded step limit (funcAddr=0x${funcAddr.toString(16)})`);
    }
    // Capture the callback's return value ($v0) before restoring registers
    this.lastGuestCallReturnValue = regs.getGpr(2);
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
    // Standard flash0 fonts; hoisted to _loadStandardFonts so save-state restore
    // can reload them too (the PGF objects themselves aren't serialized).
    const loadPgfFonts = () => this._loadStandardFonts();

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
