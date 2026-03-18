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
      bus.writeU32(padDataPtr + 0, 0);
      bus.writeU32(padDataPtr + 4, snap.buttons);
      bus.writeU8(padDataPtr + 8, lx);
      bus.writeU8(padDataPtr + 9, ly);
    }
  }

  // sceCtrlReadBufferPositive(pad_data*, count)
  kernel.register(CTRL.sceCtrlReadBufferPositive, (regs, bus) => {
    writePadData(bus, regs.getGpr(4));
    regs.setGpr(2, 1);
  });

  // sceCtrlPeekBufferPositive(pad_data*, count)
  kernel.register(CTRL.sceCtrlPeekBufferPositive, (regs, bus) => {
    writePadData(bus, regs.getGpr(4));
    regs.setGpr(2, 1);
  });

  // sceCtrlReadBufferNegative(pad_data*, count) — buttons field inverted
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
    regs.setGpr(2, 1);
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

  // ── Stubs: CTRL ──────────────────────────────────────────────────────────
  kernel.stub(CTRL.sceCtrlSetIdleCancelThreshold);
  kernel.stub(CTRL.sceCtrlClearRapidFire);
  kernel.stub(CTRL.sceCtrlGetIdleCancelThreshold);
  kernel.stub(CTRL.sceCtrlGetSuspendingExtraSamples);
  kernel.stub(CTRL.sceCtrlInit, 1);
  kernel.stub(CTRL.sceCtrlPeekLatch);
  kernel.stub(CTRL.sceCtrlReadLatch);
  kernel.stub(CTRL.sceCtrlSetRapidFire);
  kernel.stub(CTRL.sceCtrlSetSuspendingExtraSamples);

  log.info("Ctrl HLE handlers registered");
}
