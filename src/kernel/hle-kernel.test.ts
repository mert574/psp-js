import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBus } from "../memory/memory-bus.js";
import { AllegrexRegisters } from "../cpu/registers.js";
import { HLEKernel, ThreadState, WaitType, type Thread } from "./hle-kernel.js";

describe("HLEKernel — Thread Scheduler", () => {
  let bus: MemoryBus;
  let hle: HLEKernel;
  let regs: AllegrexRegisters;

  beforeEach(() => {
    bus = MemoryBus.create();
    hle = new HLEKernel(bus);
    regs = new AllegrexRegisters();
  });

  it("saveContext + restoreContext round-trip preserves GPRs", () => {
    const thread = createDummyThread(hle);
    regs.setGpr(4, 0xdeadbeef);
    regs.setGpr(29, 0x09000000);
    regs.pc = 0x08800000;
    regs.hi = 100;
    regs.lo = 200;

    hle.saveContext(thread, regs);

    // Clear regs
    regs.setGpr(4, 0);
    regs.pc = 0;
    regs.hi = 0;
    regs.lo = 0;

    hle.restoreContext(thread, regs);
    expect(regs.getGpr(4)).toBe(0xdeadbeef);
    expect(regs.pc).toBe(0x08800000);
    expect(regs.hi).toBe(100);
    expect(regs.lo).toBe(200);
  });

  it("saveContext preserves FPU state", () => {
    const thread = createDummyThread(hle);
    regs.setFpr(0, 3.14);
    regs.fcr31 = 0x42;

    hle.saveContext(thread, regs);
    regs.setFpr(0, 0);
    regs.fcr31 = 0;

    hle.restoreContext(thread, regs);
    expect(regs.getFpr(0)).toBeCloseTo(3.14);
    expect(regs.fcr31).toBe(0x42);
  });

  it("reschedule picks highest priority READY thread", () => {
    const t1 = createDummyThread(hle, 1, 0x30); // lower priority (higher number)
    const t2 = createDummyThread(hle, 2, 0x10); // higher priority (lower number)
    t1.state = ThreadState.READY;
    t1.context.pc = 0x08000100;
    t2.state = ThreadState.READY;
    t2.context.pc = 0x08000200;

    const switched = hle.reschedule(regs);
    expect(switched).toBe(true);
    expect(regs.pc).toBe(0x08000200); // t2 wins (priority 0x10 < 0x30)
    expect(hle.currentThreadId).toBe(2);
  });

  it("reschedule returns false when no READY threads", () => {
    const t = createDummyThread(hle, 1);
    t.state = ThreadState.WAITING;
    expect(hle.reschedule(regs)).toBe(false);
  });

  it("onVblank wakes VBLANK-waiting threads", () => {
    const t = createDummyThread(hle, 1, 0x20);
    t.state = ThreadState.WAITING;
    t.waitType = WaitType.VBLANK;
    t.context.pc = 0x08000100;

    hle.onVblank(regs);

    expect(t.state).toBe(ThreadState.RUNNING); // woke up and was scheduled
    expect(hle.vblankCount).toBe(1);
  });

  it("onVblank does NOT wake DELAY-waiting threads (woken by CoreTiming instead)", () => {
    const t = createDummyThread(hle, 1, 0x20);
    t.state = ThreadState.WAITING;
    t.waitType = WaitType.DELAY;
    t.context.pc = 0x08000100;

    hle.onVblank(regs);

    // DELAY threads are now woken via CoreTiming WakeThread events, not VBlank.
    expect(t.state).toBe(ThreadState.WAITING);
  });
});

// Helper to create a thread directly in the HLE kernel's internal state
function createDummyThread(hle: HLEKernel, id: number = 1, priority: number = 0x20) {
  const thread: Thread = {
    id,
    entry: 0x08000000,
    stackSize: 4096,
    stackBase: 0x09000000,
    stackTop: 0x09000F00,
    k0: 0x09001000,
    priority,
    state: ThreadState.DORMANT,
    waitType: WaitType.NONE,
    context: {
      gpr: new Uint32Array(32),
      hi: 0, lo: 0, pc: 0,
      fpr: new Uint32Array(32),
      fcr31: 0,
      vfpr: new Float32Array(128),
      vfpuCtrl: new Uint32Array(16),
      vfpuCc: 0,
      vpfxs: 0, vpfxt: 0, vpfxd: 0,
      vpfxsEnabled: false, vpfxtEnabled: false, vpfxdEnabled: false,
    },
    wakeupCount: 0,
    waitSemaId: 0,
    waitSemaCount: 0,
    waitEvfId: 0,
    waitEvfBits: 0,
    waitEvfMode: 0,
    waitEvfOutPtr: 0,
    callbacks: [],
    isProcessingCallbacks: false,
    waitGeListId: 0,
    waitDeadlineVbl: 0,
    waitWakeTimeMs: 0,
    waitThreadEndId: 0,
    waitMutexId: 0,
    waitMutexCount: 0,
    pendingWakeCallback: undefined,
  };
  hle.addThreadForTest(thread);
  return thread;
}
