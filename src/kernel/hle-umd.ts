/**
 * HLE sceUmd handlers — the UMD (disc) drive. In our HLE the disc is always
 * present, ready and readable, so most calls just report that state.
 */

import { Logger } from "../utils/logger.js";
import type { HLEKernel } from "./hle-kernel.js";
import { UMD } from "./nids.js";

const log = Logger.get("HLE-UMD");

export function registerUmdHLE(kernel: HLEKernel): void {

  // sceUmdGetDriveStat — PSP_UMD_PRESENT|PSP_UMD_READY|PSP_UMD_READABLE
  kernel.register(UMD.sceUmdGetDriveStat, (regs) => {
    regs.setGpr(2, 0x02 | 0x10 | 0x20);
  });

  // sceUmdCheckMedium — disc always present in HLE
  kernel.register(UMD.sceUmdCheckMedium, (regs) => { regs.setGpr(2, 1); });

  // sceUmdWaitDriveStat — disc always ready, stat always met
  kernel.register(UMD.sceUmdWaitDriveStat, (regs) => { regs.setGpr(2, 0); });
  kernel.register(UMD.sceUmdWaitDriveStatCB, (regs) => { regs.setGpr(2, 0); });
  // sceUmdWaitDriveStatWithTimer — PPSSPP sceUmd.cpp:404-426: when the stat is
  // already met (always, in our HLE: disc present/ready/readable) it calls
  // hleReSchedule rather than returning straight away. A game that busy-polls
  // this (God of War's loader does, ~372x/frame) otherwise never yields, so its
  // worker threads sit READY and starve. Set v0 before yielding (the yielding
  // thread resumes with this return value).
  kernel.register(UMD.sceUmdWaitDriveStatWithTimer, (regs) => {
    regs.setGpr(2, 0);
    kernel.yieldToOtherThread(regs);
  });

  // Notify the registered UMD drive callback (PPSSPP __KernelNotifyCallback).
  // Games pump sceKernelCheckCallback waiting for this after sceUmdActivate —
  // without the notification their loading state machines hang forever.
  let umdDriveCBId = 0;
  function notifyUmdCallback(notifyArg: number): void {
    if (umdDriveCBId === 0) return;
    const cb = kernel.pspCallbacks.get(umdDriveCBId);
    if (!cb) return;
    cb.notifyCount++;
    cb.notifyArg = notifyArg;
  }

  // sceUmdActivate — PPSSPP sceUmd.cpp:284-294 + __KernelUmdActivate:
  // validates mode 1-2, notifies the drive callback PRESENT|READY|READABLE.
  kernel.register(UMD.sceUmdActivate, (regs) => {
    const mode = regs.getGpr(4);
    if (mode < 1 || mode > 2) { regs.setGpr(2, 0x80010016); return; }
    notifyUmdCallback(0x02 | 0x10 | 0x20); // PSP_UMD_PRESENT | READY | READABLE
    regs.setGpr(2, 0);
  });

  // sceUmdRegisterUMDCallBack — store cbId (PPSSPP sceUmd.cpp:311-323)
  kernel.register(UMD.sceUmdRegisterUMDCallBack, (regs) => {
    umdDriveCBId = regs.getGpr(4);
    regs.setGpr(2, 0);
  });

  // sceUmdDeactivate(mode, name) — PPSSPP sceUmd.cpp:296-307 + __KernelUmdDeactivate:
  // validates mode <= 18, notifies the drive callback PRESENT|READY.
  kernel.register(UMD.sceUmdDeactivate, (regs) => {
    const mode = regs.getGpr(4);
    if (mode > 18) {
      regs.setGpr(2, 0x80010016); // SCE_KERNEL_ERROR_ERRNO_INVALID_ARGUMENT
      return;
    }
    notifyUmdCallback(0x02 | 0x10); // PSP_UMD_PRESENT | READY
    regs.setGpr(2, 0);
  });

  // sceUmdGetDiscInfo(infoAddr) — PPSSPP sceUmd.cpp:269-282.
  // The struct is PspUmdInfo { u32 size; u32 type; }. The caller fills in size=8
  // before the call; we validate it, then write type = PSP_UMD_TYPE_GAME (0x10).
  kernel.register(UMD.sceUmdGetDiscInfo, (regs, bus) => {
    const infoAddr = regs.getGpr(4);
    if (!bus.isValidAddress(infoAddr)) {
      regs.setGpr(2, 0x80010016); // SCE_KERNEL_ERROR_ERRNO_INVALID_ARGUMENT
      return;
    }
    const size = bus.readU32(infoAddr);
    if (size !== 8) {
      regs.setGpr(2, 0x80010016);
      return;
    }
    bus.writeU32(infoAddr + 4, 0x10); // PSP_UMD_TYPE_GAME
    regs.setGpr(2, 0);
  });

  // sceUmdReplacePermit / sceUmdReplaceProhibit — PPSSPP sceUmd.cpp:486-505 toggle
  // the UMD-disc-swap state and return 0. We never swap discs, so just return 0.
  kernel.register(UMD.sceUmdReplacePermit, (regs) => { regs.setGpr(2, 0); });
  kernel.register(UMD.sceUmdReplaceProhibit, (regs) => { regs.setGpr(2, 0); });

  // ── Stubs: UMD ──────────────────────────────────────────────────────────
  kernel.stub(UMD.sceUmdCancelWaitDriveStat);
  kernel.stub(UMD.sceUmdGetErrorStat);
  kernel.stub(UMD.sceUmdUnRegisterUMDCallBack);
  kernel.stub(UMD.sceUmdUnuseUMDInMsUsbWlan);
  kernel.stub(UMD.sceUmdUseUMDInMsUsbWlan);

  log.info("UMD HLE handlers registered");
}
