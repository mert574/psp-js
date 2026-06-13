/**
 * HLE controller handlers for sceCtrl.
 */

import { Logger } from "../utils/logger.js";
import type { HLEKernel } from "./hle-kernel.js";
import { CTRL } from "./nids.js";

const log = Logger.get("HLE-CTRL");

export function registerCtrlHLE(kernel: HLEKernel): void {

  let analogEnabled = true;  // PPSSPP default
  let ctrlCycle = 0;

  // Latch state — PPSSPP sceCtrl.cpp __CtrlUpdateLatch (113-162). The latch
  // accumulates button edges across samples; games poll Peek/ReadLatch for
  // "newly pressed" (btnMake) instead of diffing pad buffers themselves.
  let latchMake = 0, latchBreak = 0, latchPress = 0, latchRelease = 0;
  let latchBufs = 0;
  let oldButtons = 0;

  // Sampled once per vblank, like PPSSPP's ctrl sample event.
  kernel.onCtrlVblankSample = () => {
    const buttons = kernel.inputSnapshot ? kernel.inputSnapshot().buttons : 0;
    const changed = (buttons ^ oldButtons) >>> 0;
    latchMake = (latchMake | (buttons & changed)) >>> 0;
    latchBreak = (latchBreak | (oldButtons & changed)) >>> 0;
    latchPress = (latchPress | buttons) >>> 0;
    latchRelease = (latchRelease | ~buttons) >>> 0;
    latchBufs++;
    oldButtons = buttons;
  };

  function writeLatch(bus: Parameters<Parameters<typeof kernel.register>[1]>[1], ptr: number): void {
    // Our input only produces user-mode buttons, so no CTRL_MASK_USER needed.
    if (ptr === 0) return;
    bus.writeU32(ptr + 0, latchMake);
    bus.writeU32(ptr + 4, latchBreak);
    bus.writeU32(ptr + 8, latchPress);
    bus.writeU32(ptr + 12, latchRelease);
  }

  // sceCtrlGetSamplingCycle(cyclePtr)
  kernel.register(CTRL.sceCtrlGetSamplingCycle, (regs, bus) => {
    const ptr = regs.getGpr(4);
    if (ptr !== 0) bus.writeU32(ptr, 0);
    regs.setGpr(2, 0);
  });

  // sceCtrlGetSamplingMode(modePtr)
  kernel.register(CTRL.sceCtrlGetSamplingMode, (regs, bus) => {
    const ptr = regs.getGpr(4);
    if (ptr !== 0) bus.writeU32(ptr, 1); // CTRL_MODE_ANALOG
    regs.setGpr(2, 0);
  });

  // Shared pad-data write helper
  function writePadData(bus: Parameters<Parameters<typeof kernel.register>[1]>[1], padDataPtr: number): void {
    if (padDataPtr !== 0) {
      const snap = kernel.inputSnapshot ? kernel.inputSnapshot() : { buttons: 0, analog: { x: 0, y: 0 } };
      const lx = Math.round((snap.analog.x + 1) * 127.5);
      const ly = Math.round((snap.analog.y + 1) * 127.5);
      bus.writeU32(padDataPtr + 0, kernel.vblankCount);
      bus.writeU32(padDataPtr + 4, snap.buttons);
      bus.writeU8(padDataPtr + 8, lx);
      bus.writeU8(padDataPtr + 9, ly);
    }
  }

  // sceCtrlReadBufferPositive(pad_data*, count) — blocks until next VBlank
  kernel.register(CTRL.sceCtrlReadBufferPositive, (regs, bus) => {
    writePadData(bus, regs.getGpr(4));
    kernel.blockCurrentThreadOnCtrl(regs, 1);
  });

  // sceCtrlPeekBufferPositive(pad_data*, count)
  kernel.register(CTRL.sceCtrlPeekBufferPositive, (regs, bus) => {
    writePadData(bus, regs.getGpr(4));
    regs.setGpr(2, 1);
  });

  // sceCtrlReadBufferNegative(pad_data*, count) — blocks until next VBlank, buttons inverted
  kernel.register(CTRL.sceCtrlReadBufferNegative, (regs, bus) => {
    const padDataPtr = regs.getGpr(4);
    if (padDataPtr !== 0) {
      const snap = kernel.inputSnapshot ? kernel.inputSnapshot() : { buttons: 0, analog: { x: 0, y: 0 } };
      const lx = Math.round((snap.analog.x + 1) * 127.5);
      const ly = Math.round((snap.analog.y + 1) * 127.5);
      bus.writeU32(padDataPtr + 0, 0);
      bus.writeU32(padDataPtr + 4, ~snap.buttons >>> 0);
      bus.writeU8(padDataPtr + 8, lx);
      bus.writeU8(padDataPtr + 9, ly);
    }
    kernel.blockCurrentThreadOnCtrl(regs, 1);
  });

  // sceCtrlPeekBufferNegative(pad_data*, count)
  kernel.register(CTRL.sceCtrlPeekBufferNegative, (regs, bus) => {
    const padDataPtr = regs.getGpr(4);
    if (padDataPtr !== 0) {
      const snap = kernel.inputSnapshot ? kernel.inputSnapshot() : { buttons: 0, analog: { x: 0, y: 0 } };
      const lx = Math.round((snap.analog.x + 1) * 127.5);
      const ly = Math.round((snap.analog.y + 1) * 127.5);
      bus.writeU32(padDataPtr + 0, 0);
      bus.writeU32(padDataPtr + 4, ~snap.buttons >>> 0);
      bus.writeU8(padDataPtr + 8, lx);
      bus.writeU8(padDataPtr + 9, ly);
    }
    regs.setGpr(2, 1);
  });

  // sceCtrlSetSamplingMode — PPSSPP sceCtrl.cpp: mode > 1 → error
  kernel.register(CTRL.sceCtrlSetSamplingMode, (regs) => {
    const mode = regs.getGpr(4);
    if (mode > 1) { regs.setGpr(2, 0x80000107); return; }
    const prev = analogEnabled ? 1 : 0;
    analogEnabled = mode === 1;
    regs.setGpr(2, prev);
  });

  // sceCtrlSetSamplingCycle — PPSSPP sceCtrl.cpp: validate cycle range
  kernel.register(CTRL.sceCtrlSetSamplingCycle, (regs) => {
    const cycle = regs.getGpr(4) >>> 0;
    if ((cycle > 0 && cycle < 5555) || cycle > 20000) { regs.setGpr(2, 0x800001fe); return; }
    const prev = ctrlCycle;
    ctrlCycle = cycle;
    regs.setGpr(2, prev);
  });

  // sceCtrlPeekLatch(latchDataPtr) — returns latch without reset.
  // PPSSPP sceCtrl.cpp:555-561: v0 = ctrlLatchBufs (samples since last read).
  kernel.register(CTRL.sceCtrlPeekLatch, (regs, bus) => {
    writeLatch(bus, regs.getGpr(4));
    regs.setGpr(2, latchBufs);
  });

  // sceCtrlReadLatch(latchDataPtr) — returns latch and resets it.
  // PPSSPP sceCtrl.cpp:563-569 + __CtrlResetLatch.
  kernel.register(CTRL.sceCtrlReadLatch, (regs, bus) => {
    writeLatch(bus, regs.getGpr(4));
    const bufs = latchBufs;
    latchMake = 0; latchBreak = 0; latchPress = 0; latchRelease = 0;
    latchBufs = 0;
    regs.setGpr(2, bufs);
  });

  // ── Stubs: CTRL ──────────────────────────────────────────────────────────
  kernel.stub(CTRL.sceCtrlSetIdleCancelThreshold);
  kernel.stub(CTRL.sceCtrlClearRapidFire);
  kernel.stub(CTRL.sceCtrlGetIdleCancelThreshold);
  kernel.stub(CTRL.sceCtrlGetSuspendingExtraSamples);
  kernel.stub(CTRL.sceCtrlInit, 1);
  kernel.stub(CTRL.sceCtrlSetRapidFire);
  kernel.stub(CTRL.sceCtrlSetSuspendingExtraSamples);

  log.info("Ctrl HLE handlers registered");
}
