/**
 * HLE power/UMD handlers for scePower, sceUmd, sceSuspendForUser.
 */

import { Logger } from "../utils/logger.js";
import type { HLEKernel } from "./hle-kernel.js";
import { POWER, UMD, KERNEL } from "./nids.js";

const log = Logger.get("HLE-POWER");

export function registerPowerHLE(kernel: HLEKernel): void {

  // PSP-2000/3000 defaults (PPSSPP: pll=222, bus=111 at boot; games ramp via scePowerSetClockFrequency)
  let cpuFreqMhz = 222;
  let busFreqMhz = 111;
  let pllFreqMhz = 222;

  // Volatile RAM lock state (PPSSPP scePower.cpp: KernelVolatileMemLock)
  // Base: 0x08400000, size: 0x00400000 (4 MB) — always available in HLE
  let volatileMemLocked = false;
  const VOLATILE_MEM_BASE = 0x08400000;
  const VOLATILE_MEM_SIZE = 0x00400000;
  const SCE_KERNEL_ERROR_POWER_VMEM_IN_USE = 0x80000310;

  const volatileTryLock = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0], bus: Parameters<Parameters<typeof kernel.register>[1]>[1]): void => {
    if (volatileMemLocked) {
      regs.setGpr(2, SCE_KERNEL_ERROR_POWER_VMEM_IN_USE);
      return;
    }
    volatileMemLocked = true;
    const paddr = regs.getGpr(5);
    const psize = regs.getGpr(6);
    if (paddr !== 0) bus.writeU32(paddr, VOLATILE_MEM_BASE);
    if (psize !== 0) bus.writeU32(psize, VOLATILE_MEM_SIZE);
    regs.setGpr(2, 0);
  };

  const volatileLock = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0], bus: Parameters<Parameters<typeof kernel.register>[1]>[1]): void => {
    // Blocking version — always succeeds in HLE
    volatileMemLocked = true;
    const paddr = regs.getGpr(5);
    const psize = regs.getGpr(6);
    if (paddr !== 0) bus.writeU32(paddr, VOLATILE_MEM_BASE);
    if (psize !== 0) bus.writeU32(psize, VOLATILE_MEM_SIZE);
    regs.setGpr(2, 0);
  };

  const volatileUnlock = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    volatileMemLocked = false;
    regs.setGpr(2, 0);
  };

  const setClock = (pll: number, cpu: number, bus: number): void => {
    if (pll < 1 || pll > 333 || cpu < 1 || cpu > 333 || bus < 1 || bus > 166) return;
    pllFreqMhz = pll;
    cpuFreqMhz = cpu;
    busFreqMhz = bus;
    kernel.coreTiming?.setClockHz(cpu * 1_000_000);
  };

  // scePowerGetBatteryLifePercent → 100%
  kernel.register(POWER.scePowerGetBatteryLifePercent, (regs) => {
    regs.setGpr(2, 100);
  });

  // scePowerGetBusClockFrequency
  kernel.register(POWER.scePowerGetBusClockFrequency, (regs) => {
    regs.setGpr(2, busFreqMhz);
  });

  // scePowerGetCpuClockFrequency
  kernel.register(POWER.scePowerGetCpuClockFrequency, (regs) => {
    regs.setGpr(2, cpuFreqMhz);
  });

  // scePowerGetCpuClockFrequencyInt
  kernel.register(POWER.scePowerGetCpuClockFrequencyInt, (regs) => {
    regs.setGpr(2, cpuFreqMhz);
  });

  // scePowerGetBusClockFrequencyInt
  kernel.register(POWER.scePowerGetBusClockFrequencyInt, (regs) => {
    regs.setGpr(2, busFreqMhz);
  });

  // scePowerSetClockFrequency(pllfreq, cpufreq, busfreq)
  kernel.register(POWER.scePowerSetClockFrequency, (regs) => {
    setClock(regs.getGpr(4), regs.getGpr(5), regs.getGpr(6));
    regs.setGpr(2, 0);
  });

  // scePowerSetClockFrequencyAlt / Alt2 — same signature, alias NIDs
  // PPSSPP scePower.cpp:600,603
  kernel.register(POWER.scePowerSetClockFrequencyAlt, (regs) => {
    setClock(regs.getGpr(4), regs.getGpr(5), regs.getGpr(6));
    regs.setGpr(2, 0);
  });
  kernel.register(POWER.scePowerSetClockFrequencyAlt2, (regs) => {
    setClock(regs.getGpr(4), regs.getGpr(5), regs.getGpr(6));
    regs.setGpr(2, 0);
  });

  // scePowerVolatileMemLock(mode, ptr, sizePtr) — blocking, always succeeds in HLE
  kernel.register(POWER.scePowerVolatileMemLock, volatileLock);

  // scePowerVolatileMemTryLock(mode, ptr, sizePtr) — non-blocking
  kernel.register(POWER.scePowerVolatileMemTryLock, volatileTryLock);

  // scePowerVolatileMemUnlock(mode)
  kernel.register(POWER.scePowerVolatileMemUnlock, volatileUnlock);

  // sceKernelVolatileMemLock — same semantics as scePowerVolatileMemLock
  kernel.register(POWER.sceKernelVolatileMemLock, volatileLock);

  // sceKernelVolatileMemTryLock (0xa14f40b2) — non-blocking kernel variant
  // PPSSPP scePower.cpp: same impl as scePowerVolatileMemTryLock
  kernel.register(KERNEL.sceKernelVolatileMemTryLock, volatileTryLock);

  // sceKernelVolatileMemUnlock (0xa569e425)
  kernel.register(POWER.sceKernelVolatileMemUnlock, volatileUnlock);

  // ── sceUmd handlers ──────────────────────────────────────────────────────

  // sceUmdGetDriveStat — PSP_UMD_PRESENT|PSP_UMD_READY|PSP_UMD_READABLE
  const umdDriveStat = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    regs.setGpr(2, 0x02 | 0x10 | 0x20);
  };
  kernel.register(UMD.sceUmdGetDriveStat, umdDriveStat);

  // sceKernelPowerLock / sceKernelPowerUnlock — PPSSPP scePower.cpp: lockType must be 0
  kernel.register(POWER.sceKernelPowerLock, (regs) => {
    regs.setGpr(2, regs.getGpr(4) === 0 ? 0 : 0x80000107);
  });
  kernel.register(POWER.sceKernelPowerUnlock, (regs) => {
    regs.setGpr(2, regs.getGpr(4) === 0 ? 0 : 0x80000107);
  });

  // scePowerRegisterCallback — PPSSPP scePower.cpp:207-244
  // 16 user slots (0-15), 32 total (16-31 = kernel-only)
  const PSP_POWER_ERROR_INVALID_CB   = 0x80000100;
  const PSP_POWER_ERROR_INVALID_SLOT = 0x80000102;
  const PSP_POWER_ERROR_TAKEN_SLOT   = 0x80000020;
  const PSP_POWER_ERROR_SLOTS_FULL   = 0x80000022;
  const PSP_POWER_ERROR_EMPTY_SLOT   = 0x80000025;
  const SCE_KERNEL_ERROR_PRIV_REQUIRED = 0x80000023;
  const numberOfCBPowerSlots = 16;
  const numberOfCBPowerSlotsPrivate = 32;
  const PSP_POWER_CB_AC_POWER       = 0x00001000;
  const PSP_POWER_CB_BATTERY_EXIST  = 0x00000080;
  const PSP_POWER_CB_BATTERY_FULL   = 0x00000064;

  const powerCbSlots = new Array<number>(numberOfCBPowerSlots).fill(0);
  kernel.register(POWER.scePowerRegisterCallback, (regs) => {
    const slot = regs.getGpr(4) | 0;
    const cbId = regs.getGpr(5);

    // Validation — PPSSPP scePower.cpp:208-216
    if (slot < -1 || slot >= numberOfCBPowerSlotsPrivate) {
      regs.setGpr(2, PSP_POWER_ERROR_INVALID_SLOT); return;
    }
    if (slot >= numberOfCBPowerSlots) {
      regs.setGpr(2, SCE_KERNEL_ERROR_PRIV_REQUIRED); return;
    }
    if (cbId === 0) {
      regs.setGpr(2, PSP_POWER_ERROR_INVALID_CB); return;
    }

    let retval = -1;
    if (slot === -1) {
      // Auto-select first empty slot
      for (let i = 0; i < numberOfCBPowerSlots; i++) {
        if (powerCbSlots[i] === 0 && retval === -1) {
          powerCbSlots[i] = cbId;
          retval = i;
        }
      }
      if (retval === -1) {
        regs.setGpr(2, PSP_POWER_ERROR_SLOTS_FULL); return;
      }
    } else {
      if (powerCbSlots[slot] === 0) {
        powerCbSlots[slot] = cbId;
        retval = 0;
      } else {
        regs.setGpr(2, PSP_POWER_ERROR_TAKEN_SLOT); return;
      }
    }

    // Notify the callback with initial power state — PPSSPP scePower.cpp:240-241
    if (retval >= 0) {
      const arg = PSP_POWER_CB_AC_POWER | PSP_POWER_CB_BATTERY_EXIST | PSP_POWER_CB_BATTERY_FULL;
      const cb = kernel.pspCallbacks.get(cbId);
      if (cb) {
        cb.notifyCount++;
        cb.notifyArg = arg;
      }
    }
    regs.setGpr(2, retval);
  });

  // sceUmdCheckMedium — disc always present in HLE
  kernel.register(UMD.sceUmdCheckMedium, (regs) => { regs.setGpr(2, 1); });

  // sceUmdWaitDriveStat — disc always ready, stat always met
  kernel.register(UMD.sceUmdWaitDriveStat, (regs) => { regs.setGpr(2, 0); });
  kernel.register(UMD.sceUmdWaitDriveStatCB, (regs) => { regs.setGpr(2, 0); });
  kernel.register(UMD.sceUmdWaitDriveStatWithTimer, (regs) => { regs.setGpr(2, 0); });

  // sceKernelPowerTick(tickType) — PPSSPP scePower.cpp: just returns 0
  kernel.register(POWER.sceKernelPowerTick, (regs) => {
    regs.setGpr(2, 0);
  });

  // scePowerUnregisterCallback(slotId) — PPSSPP scePower.cpp:246-262
  kernel.register(POWER.scePowerUnregisterCallback, (regs) => {
    const slotId = regs.getGpr(4) | 0;
    if (slotId < 0 || slotId >= numberOfCBPowerSlotsPrivate) {
      regs.setGpr(2, PSP_POWER_ERROR_INVALID_SLOT); return;
    }
    if (slotId >= numberOfCBPowerSlots) {
      regs.setGpr(2, SCE_KERNEL_ERROR_PRIV_REQUIRED); return;
    }
    if (powerCbSlots[slotId] !== 0) {
      powerCbSlots[slotId] = 0;
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, PSP_POWER_ERROR_EMPTY_SLOT);
    }
  });

  // scePowerIsBatteryExist — battery always present in HLE
  kernel.register(POWER.scePowerIsBatteryExist, (regs) => { regs.setGpr(2, 1); });
  // scePowerIsPowerOnline — always on AC power
  kernel.register(POWER.scePowerIsPowerOnline, (regs) => { regs.setGpr(2, 1); });
  // scePowerIsLowBattery — never low
  kernel.register(POWER.scePowerIsLowBattery, (regs) => { regs.setGpr(2, 0); });
  // scePowerIsBatteryCharging — not charging (on AC)
  kernel.register(POWER.scePowerIsBatteryCharging, (regs) => { regs.setGpr(2, 0); });

  // ── Stubs: POWER ──────────────────────────────────────────────────────────
  kernel.stub(POWER.scePowerBatteryUpdateInfo);
  kernel.stub(POWER.scePowerCancelRequest);
  kernel.stub(POWER.scePowerGetBacklightMaximum);
  kernel.stub(POWER.scePowerGetBatteryChargeCycle);
  kernel.stub(POWER.scePowerGetBatteryChargingStatus);
  kernel.stub(POWER.scePowerGetBatteryElec);
  kernel.stub(POWER.scePowerGetBatteryFullCapacity);
  kernel.stub(POWER.scePowerGetBatteryLifeTime);
  kernel.stub(POWER.scePowerGetBatteryRemainCapacity);
  kernel.stub(POWER.scePowerGetBatteryTemp);
  kernel.stub(POWER.scePowerGetBatteryVolt);
  kernel.stub(POWER.scePowerGetBusClockFrequencyFloat);
  kernel.stub(POWER.scePowerGetCallbackMode);
  kernel.stub(POWER.scePowerGetCpuClockFrequencyFloat);
  kernel.stub(POWER.scePowerGetForceSuspendCapacity);
  kernel.stub(POWER.scePowerGetIdleTimer);
  kernel.stub(POWER.scePowerGetInnerTemp);
  kernel.stub(POWER.scePowerGetLowBatteryCapacity);
  kernel.stub(POWER.scePowerGetPllClockFrequencyFloat);
  kernel.stub(POWER.scePowerGetPllClockFrequencyInt);
  kernel.stub(POWER.scePowerGetPowerSwMode);
  kernel.stub(POWER.scePowerGetResumeCount);
  kernel.stub(POWER.scePowerIdleTimerDisable);
  kernel.stub(POWER.scePowerIdleTimerEnable);
  kernel.stub(POWER.scePowerIsRequest);
  kernel.stub(POWER.scePowerIsSuspendRequired);
  kernel.stub(POWER.scePowerLock);
  kernel.stub(POWER.scePowerRequestColdReset);
  kernel.stub(POWER.scePowerRequestSuspend);
  kernel.stub(POWER.scePowerSetBusClockFrequency);
  kernel.stub(POWER.scePowerSetCallbackMode);
  kernel.stub(POWER.scePowerSetClockFrequency350);
  kernel.stub(POWER.scePowerSetCpuClockFrequency);
  kernel.stub(POWER.scePowerSetPowerSwMode);
  kernel.stub(POWER.scePowerTick);
  kernel.stub(POWER.scePowerUnlock);
  kernel.stub(POWER.scePowerWaitRequestCompletion);
  kernel.stub(POWER.scePower_2875994B);
  kernel.stub(POWER.scePower_2B51FE2F);
  kernel.stub(POWER.scePower_545A7F3C);
  kernel.stub(POWER.scePower_A4E93389);
  kernel.stub(POWER.scePower_a85880d0_IsPSPNonFat);

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

  // ── Stubs: UMD ──────────────────────────────────────────────────────────
  kernel.stub(UMD.sceUmdCancelWaitDriveStat);
  kernel.stub(UMD.sceUmdGetDiscInfo);
  kernel.stub(UMD.sceUmdGetErrorStat);
  kernel.stub(UMD.sceUmdReplacePermit);
  kernel.stub(UMD.sceUmdReplaceProhibit);
  kernel.stub(UMD.sceUmdUnRegisterUMDCallBack);
  kernel.stub(UMD.sceUmdUnuseUMDInMsUsbWlan);
  kernel.stub(UMD.sceUmdUseUMDInMsUsbWlan);

  log.info("Power/UMD HLE handlers registered");
}
