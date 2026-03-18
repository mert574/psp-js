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

  // scePowerRegisterCallback — PPSSPP scePower.cpp: slot-based (16 slots)
  const powerCbSlots = new Array<number>(16).fill(0);
  kernel.register(POWER.scePowerRegisterCallback, (regs) => {
    const slot = regs.getGpr(4) | 0;
    const cbId = regs.getGpr(5);
    if (cbId === 0) { regs.setGpr(2, 0x80000107); return; } // PSP_POWER_ERROR_INVALID_CB
    if (slot === -1) {
      for (let i = 0; i < 16; i++) {
        if (powerCbSlots[i] === 0) { powerCbSlots[i] = cbId; regs.setGpr(2, i); return; }
      }
      regs.setGpr(2, 0x80000025); return; // no free slot
    }
    if (slot < 0 || slot >= 16) { regs.setGpr(2, 0x80000107); return; }
    powerCbSlots[slot] = cbId;
    regs.setGpr(2, slot);
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
    // PPSSPP: numberOfCBPowerSlotsPrivate=32, numberOfCBPowerSlots=16
    if (slotId < 0 || slotId >= 32) {
      regs.setGpr(2, 0x80000107); // PSP_POWER_ERROR_INVALID_SLOT
      return;
    }
    if (slotId >= 16) {
      regs.setGpr(2, 0x80000004); // SCE_KERNEL_ERROR_PRIV_REQUIRED
      return;
    }
    if (powerCbSlots[slotId] !== 0) {
      powerCbSlots[slotId] = 0;
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x80000025); // PSP_POWER_ERROR_EMPTY_SLOT
    }
  });

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
  kernel.stub(POWER.scePowerIsBatteryCharging);
  kernel.stub(POWER.scePowerIsBatteryExist);
  kernel.stub(POWER.scePowerIsLowBattery);
  kernel.stub(POWER.scePowerIsPowerOnline, 1);
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

  // sceUmdActivate — PPSSPP sceUmd.cpp: validate mode 1-2
  kernel.register(UMD.sceUmdActivate, (regs) => {
    const mode = regs.getGpr(4);
    regs.setGpr(2, (mode < 1 || mode > 2) ? 0x80010016 : 0);
  });

  // sceUmdRegisterUMDCallBack — store cbId
  let umdDriveCBId = 0;
  kernel.register(UMD.sceUmdRegisterUMDCallBack, (regs) => {
    umdDriveCBId = regs.getGpr(4);
    regs.setGpr(2, 0);
  });

  // sceUmdDeactivate(mode, name) — PPSSPP sceUmd.cpp:296-307
  // Validates mode <= 18, deactivates disc access. No-op in HLE (disc always present).
  kernel.register(UMD.sceUmdDeactivate, (regs) => {
    const mode = regs.getGpr(4);
    if (mode > 18) {
      regs.setGpr(2, 0x80010016); // SCE_KERNEL_ERROR_ERRNO_INVALID_ARGUMENT
      return;
    }
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
