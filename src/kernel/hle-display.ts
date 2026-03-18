/**
 * HLE display handlers for sceDisplay.
 *
 * Reference: PPSSPP Core/HLE/sceDisplay.cpp, Core/HW/Display.cpp
 */

import { Logger } from "../utils/logger.js";
import type { HLEKernel } from "./hle-kernel.js";
import { ThreadState, WaitType } from "./hle-kernel.js";
import { DISPLAY } from "./nids.js";

const log = Logger.get("HLE-DISPLAY");


export function registerDisplayHLE(kernel: HLEKernel): void {

  // ── sceDisplaySetMode(mode, width, height) ─────────────────────────────
  // PPSSPP sceDisplay.cpp:805-824
  // Validates mode == 0 (LCD), size == 480×272, stores state, waits for vblank.
  kernel.register(DISPLAY.sceDisplaySetMode, (regs) => {
    const mode   = regs.getGpr(4);
    const width  = regs.getGpr(5);
    const height = regs.getGpr(6);

    if (mode !== 0) {
      // SCE_KERNEL_ERROR_INVALID_MODE (sceDisplay.cpp:810)
      regs.setGpr(2, 0x80000107);
      return;
    }
    if (width !== 480 || height !== 272) {
      // SCE_KERNEL_ERROR_INVALID_SIZE (sceDisplay.cpp:812)
      regs.setGpr(2, 0x80000104);
      return;
    }

    kernel.displayHasSetMode = true;
    kernel.displayMode   = mode;
    kernel.displayWidth  = width;
    kernel.displayHeight = height;
    log.info(`sceDisplaySetMode(${mode}, ${width}, ${height})`);

    // PPSSPP sceDisplay.cpp:822 — on success, waits for vblank.
    // For simplicity we return immediately (most games don't depend on the wait).
    regs.setGpr(2, 0);
  });

  // ── sceDisplaySetFrameBuf(topaddr, bufferwidth, pixelformat, sync) ─────
  let _fbBufA = 0, _fbBufB = 0;
  kernel.register(DISPLAY.sceDisplaySetFrameBuf, (regs) => {
    const addr   = regs.getGpr(4);
    const width  = regs.getGpr(5);
    const format = regs.getGpr(6);

    if (_fbBufA === 0) {
      _fbBufA = addr;
    } else if (_fbBufB === 0 && addr !== _fbBufA) {
      _fbBufB = addr;
    }

    kernel.framebufAddr   = addr;
    kernel.framebufWidth  = width;
    kernel.framebufFormat = format;
    regs.setGpr(2, 0);
  });

  // ── sceDisplayWaitVblank* ──────────────────────────────────────────────
  // Helper: block current thread until next VBlank.
  const waitForVblank = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) {
      t.state = ThreadState.WAITING;
      t.waitType = WaitType.VBLANK;
      kernel.saveContext(t, regs);
      t.context.gpr[2] = 0;
      if (!kernel.reschedule(regs)) kernel.idleBreak = true;
    } else {
      regs.setGpr(2, 0);
    }
  };

  // CB wrapper: set isProcessingCallbacks before waiting
  const waitForVblankCB = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) t.isProcessingCallbacks = true;
    waitForVblank(regs);
  };

  // sceDisplayWaitVblankStart / sceDisplayWaitVblankStartCB — always wait
  // PPSSPP sceDisplay.cpp:965-967, 1005-1008
  kernel.register(DISPLAY.sceDisplayWaitVblankStart,   waitForVblank);
  kernel.register(DISPLAY.sceDisplayWaitVblankStartCB, waitForVblankCB);

  // sceDisplayWaitVblank / sceDisplayWaitVblankCB — if already in VBlank, return 1 immediately
  // PPSSPP sceDisplay.cpp:970-978, 994-1002
  // Important: PPSSPP calls hleReSchedule even in the early-return path (line 976),
  // yielding to other threads. Without this, a game looping on WaitVblank during the
  // 0.7ms VBlank window would spin without giving other threads CPU time.
  const waitVblankIfNotAlready = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    if (kernel.isVblank) {
      // Already in VBlank — return 1, yield to other threads (sceDisplay.cpp:976-977)
      regs.setGpr(2, 1);
      kernel.yieldToOtherThread(regs);
      return;
    }
    waitForVblank(regs);
  };
  const waitVblankIfNotAlreadyCB = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) t.isProcessingCallbacks = true;
    waitVblankIfNotAlready(regs);
  };
  kernel.register(DISPLAY.sceDisplayWaitVblank,   waitVblankIfNotAlready);
  kernel.register(DISPLAY.sceDisplayWaitVblankCB, waitVblankIfNotAlreadyCB);

  // ── sceDisplayWaitVblankStartMulti(vblanks) ────────────────────────────
  // PPSSPP sceDisplay.cpp:981-992 — wait for N vblanks.
  // We simplify to a single vblank wait (sufficient for most games).
  kernel.register(DISPLAY.sceDisplayWaitVblankStartMulti, (regs) => {
    const vblanks = regs.getGpr(4);
    if (vblanks <= 0) {
      regs.setGpr(2, 0x800001fe); // SCE_KERNEL_ERROR_INVALID_VALUE
      return;
    }
    waitForVblank(regs);
  });

  // sceDisplayWaitVblankStartMultiCB(vblanks) — PPSSPP sceDisplay.cpp:1010-1021
  kernel.register(DISPLAY.sceDisplayWaitVblankStartMultiCB, (regs) => {
    const vblanks = regs.getGpr(4);
    if (vblanks <= 0) {
      regs.setGpr(2, 0x800001fe); // SCE_KERNEL_ERROR_INVALID_VALUE
      return;
    }
    waitForVblank(regs);
  });

  // ── sceDisplayGetVcount ────────────────────────────────────────────────
  // PPSSPP sceDisplay.cpp:1023-1027
  kernel.register(DISPLAY.sceDisplayGetVcount, (regs) => {
    regs.setGpr(2, kernel.vblankCount);
  });

  // ── sceDisplayIsVblank ─────────────────────────────────────────────────
  // PPSSPP sceDisplay.cpp:787-789, Display.cpp:147-148
  // Returns 1 if currently in the VBlank period, 0 otherwise.
  kernel.register(DISPLAY.sceDisplayIsVblank, (regs) => {
    regs.setGpr(2, kernel.isVblank ? 1 : 0);
  });

  // ── sceDisplayGetFrameBuf ──────────────────────────────────────────────
  // PPSSPP sceDisplay.cpp:948-958
  kernel.register(DISPLAY.sceDisplayGetFrameBuf, (regs, bus) => {
    const addrPtr   = regs.getGpr(4);
    const widthPtr  = regs.getGpr(5);
    const formatPtr = regs.getGpr(6);
    if (addrPtr   !== 0) bus.writeU32(addrPtr,   kernel.framebufAddr);
    if (widthPtr  !== 0) bus.writeU32(widthPtr,  kernel.framebufWidth);
    if (formatPtr !== 0) bus.writeU32(formatPtr, kernel.framebufFormat);
    regs.setGpr(2, 0);
  });

  // ── sceDisplayGetMode(modeAddr, widthAddr, heightAddr) ─────────────────
  // PPSSPP sceDisplay.cpp:1063-1071
  kernel.register(DISPLAY.sceDisplayGetMode, (regs, bus) => {
    const modeAddr   = regs.getGpr(4);
    const widthAddr  = regs.getGpr(5);
    const heightAddr = regs.getGpr(6);
    if (modeAddr   !== 0) bus.writeU32(modeAddr,   kernel.displayMode);
    if (widthAddr  !== 0) bus.writeU32(widthAddr,  kernel.displayWidth);
    if (heightAddr !== 0) bus.writeU32(heightAddr, kernel.displayHeight);
    regs.setGpr(2, 0);
  });

  // ── sceDisplayGetCurrentHcount ─────────────────────────────────────────
  // PPSSPP Display.cpp:155-160
  // Formula: 1 + (ticksIntoFrame / ticksPerHline)
  // ticksPerHline = CPU_HZ / 60 / 286
  // "Can't seem to produce a 0 on real hardware, offsetting by 1" — Display.cpp:158
  kernel.register(DISPLAY.sceDisplayGetCurrentHcount, (regs) => {
    const ct = kernel.coreTiming;
    if (!ct) {
      regs.setGpr(2, 1);
      return;
    }
    // Display.cpp:156 casts to int; clamp to 0 to avoid negative hcount before first vblank
    const ticksIntoFrame = Math.max(0, ct.getTicks() - kernel.frameStartTicks);
    const ticksPerHline = Math.floor(ct.CPU_HZ / 60 / 286);
    regs.setGpr(2, 1 + Math.floor(ticksIntoFrame / ticksPerHline));
  });

  // ── sceDisplayGetAccumulatedHcount ─────────────────────────────────────
  // PPSSPP Display.cpp:162-166
  // (hCountBase + currentHcount) & 0x7FFFFFFF
  kernel.register(DISPLAY.sceDisplayGetAccumulatedHcount, (regs) => {
    const ct = kernel.coreTiming;
    let currentH = 1;
    if (ct) {
      const ticksIntoFrame = Math.max(0, ct.getTicks() - kernel.frameStartTicks);
      const ticksPerHline = Math.floor(ct.CPU_HZ / 60 / 286);
      currentH = 1 + Math.floor(ticksIntoFrame / ticksPerHline);
    }
    regs.setGpr(2, (kernel.hCountBase + currentH) & 0x7FFFFFFF);
  });

  // ── sceDisplayAdjustAccumulatedHcount(value) ───────────────────────────
  // PPSSPP sceDisplay.cpp:1034-1045
  // Adjusts hCountBase by the diff between requested value and current accumulated.
  kernel.register(DISPLAY.sceDisplayAdjustAccumulatedHcount, (regs) => {
    const value = regs.getGpr(4) | 0; // treat as signed
    if (value < 0) {
      regs.setGpr(2, 0x800001fe); // SCE_KERNEL_ERROR_INVALID_VALUE
      return;
    }
    // Compute current accumulated hcount
    const ct = kernel.coreTiming;
    let currentH = 1;
    if (ct) {
      const ticksIntoFrame = Math.max(0, ct.getTicks() - kernel.frameStartTicks);
      const ticksPerHline = Math.floor(ct.CPU_HZ / 60 / 286);
      currentH = 1 + Math.floor(ticksIntoFrame / ticksPerHline);
    }
    const accumHCount = (kernel.hCountBase + currentH) & 0x7FFFFFFF;
    const diff = value - accumHCount;
    kernel.hCountBase += diff;
    regs.setGpr(2, 0);
  });

  // ── sceDisplayGetFramePerSec ───────────────────────────────────────────
  // PPSSPP sceDisplay.cpp:1053-1056 — returns float 59.9400599f
  // Formula: (9MHz * 1) / (525 * 286)
  kernel.register(DISPLAY.sceDisplayGetFramePerSec, (regs) => {
    regs.setFpr(0, 59.9400599); // float return in $f0
  });

  // ── sceDisplayIsForeground ─────────────────────────────────────────────
  // PPSSPP sceDisplay.cpp:1058-1061
  // Returns 1 if hasSetMode && framebuf.topaddr != 0
  kernel.register(DISPLAY.sceDisplayIsForeground, (regs) => {
    regs.setGpr(2, (kernel.displayHasSetMode && kernel.framebufAddr !== 0) ? 1 : 0);
  });

  // ── sceDisplayIsVsync ──────────────────────────────────────────────────
  // PPSSPP sceDisplay.cpp:1073-1078
  // Returns 1 if current tick is within the vsync window [0.5925ms, 0.7265ms] into frame.
  kernel.register(DISPLAY.sceDisplayIsVsync, (regs) => {
    const ct = kernel.coreTiming;
    if (!ct) {
      regs.setGpr(2, 0);
      return;
    }
    const ticks = ct.getTicks();
    const start = kernel.frameStartTicks + ct.msToCycles(0.5925);
    const end   = kernel.frameStartTicks + ct.msToCycles(0.7265);
    regs.setGpr(2, (ticks >= start && ticks <= end) ? 1 : 0);
  });

  // ── sceDisplayGetBrightness(levelAddr, otherAddr) ──────────────────────
  // PPSSPP sceDisplay.cpp:1093-1103 — standard levels: 44, 60, 72, 84 (AC)
  kernel.register(DISPLAY.sceDisplayGetBrightness, (regs, bus) => {
    const levelAddr = regs.getGpr(4);
    const otherAddr = regs.getGpr(5);
    if (levelAddr !== 0) bus.writeU32(levelAddr, kernel.displayBrightnessLevel);
    if (otherAddr !== 0) bus.writeU32(otherAddr, 0); // always zero per PPSSPP
    regs.setGpr(2, 0);
  });

  // ── sceDisplaySetBrightness(level, other) ──────────────────────────────
  // PPSSPP sceDisplay.cpp:1106-1109 — kernel-mode only, stores level.
  kernel.register(DISPLAY.sceDisplaySetBrightness, (regs) => {
    kernel.displayBrightnessLevel = regs.getGpr(4);
    regs.setGpr(2, 0);
  });

  // ── sceDisplaySetHoldMode(hMode) ───────────────────────────────────────
  // PPSSPP sceDisplay.cpp:1112-1116 — no-op, stores value.
  kernel.register(DISPLAY.sceDisplaySetHoldMode, (regs) => {
    kernel.displayHoldMode = regs.getGpr(4);
    regs.setGpr(2, 0);
  });

  // ── sceDisplaySetResumeMode(rMode) ─────────────────────────────────────
  // PPSSPP sceDisplay.cpp:1087-1091 — no-op, stores value.
  kernel.register(DISPLAY.sceDisplaySetResumeMode, (regs) => {
    kernel.displayResumeMode = regs.getGpr(4);
    regs.setGpr(2, 0);
  });

  // ── sceDisplayGetResumeMode(resumeModeAddr) ────────────────────────────
  // PPSSPP sceDisplay.cpp:1081-1085
  kernel.register(DISPLAY.sceDisplayGetResumeMode, (regs, bus) => {
    const addr = regs.getGpr(4);
    if (addr !== 0) bus.writeU32(addr, kernel.displayResumeMode);
    regs.setGpr(2, 0);
  });

  log.info("Display HLE handlers registered");
}
