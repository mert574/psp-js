import { Logger } from "../utils/logger.js";
const log = Logger.get("GE-D");

const CTRL_STALL_ADDR     = 0;
const CTRL_DONE_SEQ       = 1;
const CTRL_SIGNAL_ID      = 3;
const CTRL_SIGNAL_PENDING = 4;
const CTRL_SAB_INTS       = 5;

export class GeDispatcher {
  private worker: Worker;
  private ctrl: Int32Array;
  private pending: number[] = [];
  private lastDoneSeq = 0;

  private _fbAddr  = 0;   private _fbWidth  = 512; private _fbFormat = 3;
  private _listCount = 0; private _primCount = 0;
  private _clearCount = 0; private _skipCount = 0;

  get geFbAddr():   number { return this._fbAddr; }
  get geFbWidth():  number { return this._fbWidth; }
  get geFbFormat(): number { return this._fbFormat; }
  get listCount():  number { return this._listCount; }
  get primCount():  number { return this._primCount; }
  get clearCount(): number { return this._clearCount; }
  get skipCount():  number { return this._skipCount; }

  constructor(ramSab: SharedArrayBuffer, vramSab: SharedArrayBuffer, scratchpadSab: SharedArrayBuffer) {
    const ctrlSab = new SharedArrayBuffer(CTRL_SAB_INTS * 4);
    this.ctrl = new Int32Array(ctrlSab);

    this.worker = new Worker(new URL("./ge-worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror   = (e) => log.error("Worker error:", String(e.message));
    this.worker.postMessage({ type: "init", ramSab, vramSab, scratchpadSab, ctrlSab });
  }

  private _onMessage(msg: any): void {
    if (msg.type === "log") {
      log.info(msg.text);
      return;
    }
    if (msg.type === "state") {
      this._fbAddr   = msg.fbAddr;    this._fbWidth  = msg.fbWidth;
      this._fbFormat = msg.fbFormat;  this._listCount = msg.listCount;
      this._primCount = msg.primCount; this._clearCount = msg.clearCount;
      this._skipCount = msg.skipCount;
    }
  }

  enqueue(listId: number, listAddr: number, stallAddr: number): void {
    this.pending.push(listId);
    Atomics.store(this.ctrl, CTRL_STALL_ADDR, stallAddr);
    this.worker.postMessage({ type: "enqueue", id: listId, listAddr, stallAddr });
  }

  updateStall(newStall: number): void {
    Atomics.store(this.ctrl, CTRL_STALL_ADDR, newStall);
    Atomics.notify(this.ctrl, CTRL_STALL_ADDR, 1);
  }

  drainCompletions(): number[] {
    const seq = Atomics.load(this.ctrl, CTRL_DONE_SEQ);
    if (seq === this.lastDoneSeq) return [];
    const n = seq - this.lastDoneSeq;
    this.lastDoneSeq = seq;
    return this.pending.splice(0, n);
  }

  handlePendingSignal(invoke: (signalId: number) => void): void {
    if (Atomics.load(this.ctrl, CTRL_SIGNAL_PENDING) !== 1) return;
    const signalId = Atomics.load(this.ctrl, CTRL_SIGNAL_ID);
    invoke(signalId);
    Atomics.store(this.ctrl, CTRL_SIGNAL_PENDING, 0);
    Atomics.notify(this.ctrl, CTRL_SIGNAL_PENDING, 1);
  }

  hasActive(): boolean { return this.pending.length > 0; }

  terminate(): void { this.worker.terminate(); }
}
