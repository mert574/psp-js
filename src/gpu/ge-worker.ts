import { MemoryBus } from "../memory/memory-bus.js";
import { GEProcessor } from "./ge-processor.js";

const CTRL_STALL_ADDR     = 0;
const CTRL_DONE_SEQ       = 1;
const CTRL_LAST_DONE_ID   = 2;
const CTRL_SIGNAL_ID      = 3;
const CTRL_SIGNAL_PENDING = 4;

interface InitMsg  { type: "init";    ramSab: SharedArrayBuffer; vramSab: SharedArrayBuffer; scratchpadSab: SharedArrayBuffer; ctrlSab: SharedArrayBuffer; }
interface EnqueueMsg { type: "enqueue"; id: number; listAddr: number; stallAddr: number; }
type WorkerMsg = InitMsg | EnqueueMsg;

let ge: GEProcessor;
let ctrl: Int32Array;
const queue: EnqueueMsg[] = [];
let processing = false;

self.onmessage = (e: MessageEvent<WorkerMsg>) => {
  const msg = e.data;
  if (msg.type === "init") {
    const bus = MemoryBus.fromShared(msg.ramSab, msg.vramSab, msg.scratchpadSab);
    ctrl = new Int32Array(msg.ctrlSab);
    ge = new GEProcessor(bus);
    ge.signalCallback = handleSignal;
    return;
  }
  if (msg.type === "enqueue") {
    queue.push(msg);
    if (!processing) processNext();
  }
};

function handleSignal(signalId: number): void {
  Atomics.store(ctrl, CTRL_SIGNAL_ID, signalId);
  Atomics.store(ctrl, CTRL_SIGNAL_PENDING, 1);
  Atomics.notify(ctrl, CTRL_SIGNAL_PENDING, 1);
  Atomics.wait(ctrl, CTRL_SIGNAL_PENDING, 1);
}

function processNext(): void {
  if (queue.length === 0) { processing = false; return; }
  processing = true;
  processItem(queue.shift()!);
}

function processItem(item: EnqueueMsg): void {
  Atomics.store(ctrl, CTRL_STALL_ADDR, item.stallAddr);
  let pc = item.listAddr;

  while (true) {
    const stallAddr = Atomics.load(ctrl, CTRL_STALL_ADDR);
    const result = ge.executeListBudgeted(pc, stallAddr, 500_000);
    pc = result.stoppedPc;

    if (pc < 0) {
      Atomics.store(ctrl, CTRL_LAST_DONE_ID, item.id);
      Atomics.add(ctrl, CTRL_DONE_SEQ, 1);
      Atomics.notify(ctrl, CTRL_DONE_SEQ, 1);
      (self as any).postMessage({
        type: "state", id: item.id,
        fbAddr:     ge.currentFbAddr,
        fbWidth:    ge.currentFbWidth,
        fbFormat:   ge.currentFbFormat,
        listCount:  ge.totalListCount,
        primCount:  ge.totalPrimCount,
        clearCount: ge.totalClearCount,
        skipCount:  ge.totalSkipCount,
      });
      processNext();
      return;
    }

    const curStall = Atomics.load(ctrl, CTRL_STALL_ADDR);
    if (curStall === stallAddr) {
      Atomics.wait(ctrl, CTRL_STALL_ADDR, curStall);
    }
  }
}
