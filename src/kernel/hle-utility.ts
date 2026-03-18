/**
 * HLE utility handlers for sceUtility.
 */

import { Logger } from "../utils/logger.js";
import type { MemoryBus } from "../memory/memory-bus.js";
import type { HLEKernel } from "./hle-kernel.js";
import { UTILITY, DMAC, GAME_UPDATE, HEAP, HPRM, IMPOSE, SIRCS } from "./nids.js";

const log = Logger.get("HLE-UTILITY");

export function registerUtilityHLE(kernel: HLEKernel): void {

  // ── Real handlers ─────────────────────────────────────────────────────

  // ── Savedata dialog ────────────────────────────────────────────────────
  // SceUtilitySavedataParam layout (from PPSSPP SavedataParam.h):
  //   0:   pspUtilityDialogCommon (48 bytes)
  //     28: common.result (u32)
  //   48:  mode (u32)
  //   52:  bind (u32)
  //   60:  gameName[13]
  //   76:  saveName[20]
  //  100:  fileName[13]
  //  116:  dataBuf (PSP pointer)
  //  120:  dataBufSize (u32)
  //  124:  dataSize (u32)
  let savedataStatus = 0; // 0=NONE, 2=VISIBLE, 3=QUIT, 4=FINISHED
  let savedataParamAddr = 0;
  let savedataResult = 0;
  let savedataIoComplete = false;

  /** Read a fixed-length null-terminated string from PSP memory */
  function readFixedStr(bus: MemoryBus, addr: number, maxLen: number): string {
    const bytes: number[] = [];
    for (let i = 0; i < maxLen; i++) {
      const b = bus.readU8(addr + i);
      if (b === 0) break;
      bytes.push(b);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  // sceUtilitySavedataInitStart(paramAddr)
  kernel.register(UTILITY.sceUtilitySavedataInitStart, (regs, bus) => {
    const paramAddr = regs.getGpr(4);
    savedataParamAddr = paramAddr;
    savedataIoComplete = false;
    savedataResult = 0;

    const mode = bus.readU32(paramAddr + 48);
    const gameName = readFixedStr(bus, paramAddr + 60, 13);
    const saveName = readFixedStr(bus, paramAddr + 76, 20);
    const fileName = readFixedStr(bus, paramAddr + 100, 13);
    const dataBuf = bus.readU32(paramAddr + 116);
    const dataBufSize = bus.readU32(paramAddr + 120);
    const dataSize = bus.readU32(paramAddr + 124);

    const store = kernel.savedataStore;
    // PPSSPP SavedataParam.cpp:277: "<>" means any/empty save name
    const effectiveSaveName = saveName === "<>" ? "" : saveName;
    const saveKey = `${gameName}/${effectiveSaveName}`;

    // Determine user-friendly action name
    const isLoad = mode === 0 || mode === 2 || mode === 4 || mode === 15 || mode === 16;
    const isSave = mode === 1 || mode === 3 || mode === 5 || mode === 13 || mode === 14 || mode === 17 || mode === 18;
    const isDel  = mode === 9 || mode === 10 || mode === 19 || mode === 20 || mode === 21;
    const action = isLoad ? "Loading" : isSave ? "Saving" : isDel ? "Deleting" : "Save data";

    log.info(`sceUtilitySavedataInitStart: mode=${mode} game=${gameName} save=${saveName} file=${fileName} buf=0x${dataBuf.toString(16)} bufSize=${dataBufSize} dataSize=${dataSize}`);

    savedataStatus = 2; // VISIBLE

    // Notify UI overlay
    kernel.onSavedataEvent?.(action, gameName, saveName, false, false);

    if (!store) {
      // No store available — report no data for loads, success for saves
      if (mode === 0 || mode === 2 || mode === 4 || mode === 15 || mode === 16) {
        savedataResult = 0x80110305; // LOAD_NO_DATA
      }
      savedataIoComplete = true;
      regs.setGpr(2, 0);
      return;
    }

    // Helper: read saveNameList from PSP memory (array of char[20], empty-string terminated)
    function readSaveNameList(): string[] {
      const listPtr = bus.readU32(paramAddr + 96);
      if (listPtr === 0) return [];
      const names: string[] = [];
      for (let i = 0; i < 64; i++) { // safety cap
        const name = readFixedStr(bus, listPtr + i * 20, 20);
        if (name.length === 0) break;
        names.push(name);
      }
      return names;
    }

    // Helper: perform a load from a given save key
    function doLoad(key: string): void {
      store!.load(key).then(entry => {
        if (entry && entry.data.byteLength > 0) {
          const copySize = Math.min(entry.data.byteLength, dataBufSize);
          for (let i = 0; i < copySize; i++) {
            bus.writeU8(dataBuf + i, entry.data[i]!);
          }
          bus.writeU32(paramAddr + 124, entry.dataSize);
          bus.writeU32(paramAddr + 52, 1021); // bind (PPSSPP SavedataParam.cpp:190)
          savedataResult = 0;
        } else {
          savedataResult = (mode === 15 || mode === 16) ? 0x80110327 : 0x80110305;
        }
        savedataIoComplete = true;
      }).catch(() => {
        savedataResult = 0x80110305;
        savedataIoComplete = true;
      });
    }

    // Helper: perform a save to a given save key
    function doSave(key: string): void {
      const saveSize = dataSize > 0 ? dataSize : dataBufSize;
      const saveData = new Uint8Array(saveSize);
      for (let i = 0; i < saveSize; i++) {
        saveData[i] = bus.readU8(dataBuf + i);
      }
      const title = readFixedStr(bus, paramAddr + 128, 128);
      const detail = readFixedStr(bus, paramAddr + 384, 1024);

      store!.save(key, {
        key, data: saveData, dataSize: saveSize, title, detail, timestamp: Date.now(),
      }).then(() => {
        savedataResult = 0;
        savedataIoComplete = true;
      }).catch(() => {
        savedataResult = 0;
        savedataIoComplete = true;
      });
    }

    // Helper: show slot selection UI or auto-select first valid slot
    function selectSlotThen(
      action: "Load" | "Save",
      slotNames: string[],
      onSelect: (selectedKey: string) => void,
    ): void {
      // Query which slots have data
      Promise.all(slotNames.map(n => {
        const k = `${gameName}/${n}`;
        return store!.load(k).then(e => ({
          name: n,
          hasData: e !== null && e.data.byteLength > 0,
          sizeKB: e ? e.data.byteLength / 1024 : 0,
          title: e?.title ?? "",
        }));
      })).then(slots => {
        if (kernel.onSavedataListSelect) {
          // Show UI — wait for user selection
          kernel.onSavedataListSelect(action, slots).then(selected => {
            if (selected) {
              // Write selected name back to saveName in param struct (PPSSPP behavior)
              const enc = new TextEncoder().encode(selected);
              for (let i = 0; i < 20; i++) {
                bus.writeU8(paramAddr + 76 + i, i < enc.length ? enc[i]! : 0);
              }
              onSelect(`${gameName}/${selected}`);
            } else {
              // User cancelled
              savedataResult = 0x80110308; // SCE_UTILITY_SAVEDATA_ERROR_RW_BAD_STATUS
              savedataIoComplete = true;
            }
          });
        } else {
          // No UI handler — auto-select first slot (with data for load, any for save)
          const pick = action === "Load"
            ? slots.find(s => s.hasData)
            : slots[0];
          if (pick) {
            onSelect(`${gameName}/${pick.name}`);
          } else {
            savedataResult = action === "Load" ? 0x80110305 : 0;
            savedataIoComplete = true;
          }
        }
      }).catch(() => {
        savedataResult = 0x80110305;
        savedataIoComplete = true;
      });
    }

    // Dispatch based on mode
    switch (mode) {
      case 0:  // AUTOLOAD
      case 2:  // LOAD
      case 15: // READDATASECURE
      case 16: // READDATA
      {
        doLoad(saveKey);
        break;
      }
      case 4:  // LISTLOAD
      {
        const names = readSaveNameList();
        if (names.length === 0) { doLoad(saveKey); break; }
        selectSlotThen("Load", names, doLoad);
        break;
      }
      case 1:  // AUTOSAVE
      case 3:  // SAVE
      case 13: // MAKEDATASECURE
      case 14: // MAKEDATA
      case 17: // WRITEDATASECURE
      case 18: // WRITEDATA
      {
        doSave(saveKey);
        break;
      }
      case 5:  // LISTSAVE
      {
        const names = readSaveNameList();
        if (names.length === 0) { doSave(saveKey); break; }
        selectSlotThen("Save", names, doSave);
        break;
      }
      case 8:  // SIZES
      case 22: // GETSIZE
      {
        // PPSSPP SavedataParam.cpp:1105-1200 — GetSizes()
        // Write msFree info (fake large free space: ~1.5 GB)
        const msFreePtr = bus.readU32(paramAddr + 1488);
        if (msFreePtr !== 0) {
          const SECTOR = 32768;       // 32 KB cluster size (matches PPSSPP MemoryStick_SectorSize)
          const FREE_BYTES = 1536 * 1024 * 1024; // 1.5 GB
          bus.writeU32(msFreePtr + 0, SECTOR);                             // clusterSize
          bus.writeU32(msFreePtr + 4, Math.floor(FREE_BYTES / SECTOR));    // freeClusters
          bus.writeU32(msFreePtr + 8, Math.floor(FREE_BYTES / 1024));      // freeSpaceKB
          // freeSpaceStr[8] at +12
          const freeStr = new TextEncoder().encode("1536 MB");
          for (let i = 0; i < 8; i++) bus.writeU8(msFreePtr + 12 + i, i < freeStr.length ? freeStr[i]! : 0);
        }

        // Write msData info (existing save size)
        const msDataPtr = bus.readU32(paramAddr + 1492);
        if (msDataPtr !== 0) {
          // SceUtilitySavedataMsDataInfo: gameName[13]+pad[3]+saveName[20]+UsedDataInfo
          // UsedDataInfo starts at msDataPtr + 36
          const infoOff = msDataPtr + 36;
          // Check if save exists
          const msGameName = readFixedStr(bus, msDataPtr, 13);
          const msSaveName = readFixedStr(bus, msDataPtr + 16, 20);
          const msKey = `${msGameName}/${msSaveName}`;
          store.load(msKey).then(entry => {
            if (entry && entry.data.byteLength > 0) {
              const SECTOR = 32768;
              const clusters = Math.ceil(entry.data.byteLength / SECTOR);
              const usedKB = Math.ceil(clusters * SECTOR / 1024);
              bus.writeU32(infoOff + 0, clusters);  // usedClusters
              bus.writeU32(infoOff + 4, usedKB);    // usedSpaceKB
              const usedStr = new TextEncoder().encode(`${usedKB} KB`);
              for (let i = 0; i < 8; i++) bus.writeU8(infoOff + 8 + i, i < usedStr.length ? usedStr[i]! : 0);
              bus.writeU32(infoOff + 16, usedKB);   // usedSpace32KB
              for (let i = 0; i < 8; i++) bus.writeU8(infoOff + 24 + i, i < usedStr.length ? usedStr[i]! : 0);
            } else {
              // No data — zero everything
              for (let i = 0; i < 32; i++) bus.writeU8(infoOff + i, 0);
              savedataResult = 0x80110326; // SCE_UTILITY_SAVEDATA_ERROR_SIZES_NO_DATA
            }
            // Write utilityData (estimated save size)
            const utilDataPtr = bus.readU32(paramAddr + 1496);
            if (utilDataPtr !== 0) {
              const SECTOR = 32768;
              const estSize = SECTOR + SECTOR + (dataSize > 0 ? dataSize : dataBufSize); // dir + SFO + data
              const estClusters = Math.ceil(estSize / SECTOR);
              const estKB = Math.ceil(estClusters * SECTOR / 1024);
              bus.writeU32(utilDataPtr + 0, estClusters);
              bus.writeU32(utilDataPtr + 4, estKB);
              const estStr = new TextEncoder().encode(`${estKB} KB`);
              for (let i = 0; i < 8; i++) bus.writeU8(utilDataPtr + 8 + i, i < estStr.length ? estStr[i]! : 0);
              bus.writeU32(utilDataPtr + 16, estKB);
              for (let i = 0; i < 8; i++) bus.writeU8(utilDataPtr + 24 + i, i < estStr.length ? estStr[i]! : 0);
            }
            savedataIoComplete = true;
          }).catch(() => {
            savedataResult = 0x80110326;
            savedataIoComplete = true;
          });
          break; // async — doSave above handles the rest
        }

        // No msData pointer — still fill utilityData if present
        const utilDataPtr = bus.readU32(paramAddr + 1496);
        if (utilDataPtr !== 0) {
          const SECTOR = 32768;
          const estSize = SECTOR + SECTOR + (dataSize > 0 ? dataSize : dataBufSize);
          const estClusters = Math.ceil(estSize / SECTOR);
          const estKB = Math.ceil(estClusters * SECTOR / 1024);
          bus.writeU32(utilDataPtr + 0, estClusters);
          bus.writeU32(utilDataPtr + 4, estKB);
          const estStr = new TextEncoder().encode(`${estKB} KB`);
          for (let i = 0; i < 8; i++) bus.writeU8(utilDataPtr + 8 + i, i < estStr.length ? estStr[i]! : 0);
          bus.writeU32(utilDataPtr + 16, estKB);
          for (let i = 0; i < 8; i++) bus.writeU8(utilDataPtr + 24 + i, i < estStr.length ? estStr[i]! : 0);
        }
        savedataResult = 0;
        savedataIoComplete = true;
        break;
      }
      case 9:  // AUTODELETE
      case 10: // DELETE
      case 21: // DELETEDATA
      {
        store.delete(saveKey).then(found => {
          savedataResult = found ? 0 : 0x80110347; // DELETE_NO_DATA
          savedataIoComplete = true;
        }).catch(() => {
          savedataResult = 0x80110347;
          savedataIoComplete = true;
        });
        break;
      }
      case 11: // LIST
      {
        // List saves for this game — report 0 saves for simplicity
        savedataResult = 0;
        savedataIoComplete = true;
        break;
      }
      case 19: // ERASESECURE
      case 20: // ERASE
      {
        store.delete(saveKey).then(found => {
          savedataResult = found ? 0 : 0x80110347;
          savedataIoComplete = true;
        }).catch(() => {
          savedataResult = 0x80110347;
          savedataIoComplete = true;
        });
        break;
      }
      default:
      {
        log.warn(`sceUtilitySavedataInitStart: unknown mode ${mode}`);
        savedataResult = 0;
        savedataIoComplete = true;
        break;
      }
    }
    regs.setGpr(2, 0);
  });

  // sceUtilitySavedataGetStatus
  kernel.register(UTILITY.sceUtilitySavedataGetStatus, (regs) => {
    const prev = savedataStatus;
    if (savedataStatus === 2 && savedataIoComplete) {
      savedataStatus = 3; // QUIT
    } else if (savedataStatus === 3) {
      savedataStatus = 4; // FINISHED
    } else if (savedataStatus === 4) {
      savedataStatus = 0; // NONE
    }
    regs.setGpr(2, prev);
  });

  // sceUtilitySavedataShutdownStart
  kernel.register(UTILITY.sceUtilitySavedataShutdownStart, (regs, bus) => {
    // Write result to common.result (offset 28)
    if (savedataParamAddr !== 0) {
      bus.writeU32(savedataParamAddr + 28, savedataResult);
    }
    savedataStatus = 3; // force to QUIT so next GetStatus → FINISHED
    // Notify UI that operation completed
    kernel.onSavedataEvent?.("", "", "", true, savedataResult !== 0);
    regs.setGpr(2, 0);
  });

  // sceUtilitySavedataUpdate(drawSpeed)
  kernel.register(UTILITY.sceUtilitySavedataUpdate, (regs) => {
    regs.setGpr(2, 0);
  });

  // MsgDialog — same state machine as savedata
  let msgDialogStatus = 0;
  kernel.register(UTILITY.sceUtilityMsgDialogInitStart, (regs) => {
    msgDialogStatus = 2;
    regs.setGpr(2, 0);
  });
  kernel.register(UTILITY.sceUtilityMsgDialogGetStatus, (regs) => {
    const ret = msgDialogStatus;
    if (msgDialogStatus === 2) msgDialogStatus = 3;
    else if (msgDialogStatus === 3) msgDialogStatus = 4;
    else if (msgDialogStatus === 4) msgDialogStatus = 0;
    regs.setGpr(2, ret);
  });
  kernel.register(UTILITY.sceUtilityMsgDialogShutdownStart, (regs) => {
    if (msgDialogStatus === 3) msgDialogStatus = 4;
    regs.setGpr(2, 0);
  });

  kernel.register(UTILITY.sceUtilityGetSystemParamInt, (regs, bus) => {
    const id  = regs.getGpr(4);
    const ptr = regs.getGpr(5);
    let val = 0;
    switch (id) {
      case 1: val = 1; break;   // language: English
      case 5: val = 0; break;   // date format: YYYYMMDD
      case 6: val = 1; break;   // time format: 12hr
      case 7: val = 0; break;   // timezone: UTC
      case 8: val = 0; break;   // daylight savings: off
      case 9: val = 1; break;   // button preference: X=confirm
    }
    if (ptr !== 0) bus.writeU32(ptr, val);
    regs.setGpr(2, 0);
  });

  kernel.register(UTILITY.sceUtilityGetSystemParamString, (regs, bus) => {
    const ptr = regs.getGpr(5);
    if (ptr !== 0) bus.writeU8(ptr, 0);
    regs.setGpr(2, 0);
  });

  // NetconfDialog — same state machine
  let netconfStatus = 0;
  kernel.register(UTILITY.sceUtilityNetconfInitStart, (regs) => {
    netconfStatus = 2;
    regs.setGpr(2, 0);
  });
  kernel.register(UTILITY.sceUtilityNetconfGetStatus, (regs) => {
    const ret = netconfStatus;
    if (netconfStatus === 2) netconfStatus = 3;
    else if (netconfStatus === 3) netconfStatus = 4;
    else if (netconfStatus === 4) netconfStatus = 0;
    regs.setGpr(2, ret);
  });
  kernel.register(UTILITY.sceUtilityNetconfShutdownStart, (regs) => {
    if (netconfStatus === 3) netconfStatus = 4;
    regs.setGpr(2, 0);
  });
  kernel.register(UTILITY.sceUtilityNetconfShutdownStartAlt, (regs) => {
    if (netconfStatus === 3) netconfStatus = 4;
    regs.setGpr(2, 0);
  });

  // sceUtilityLoadAvModule(module) — PPSSPP sceUtility.cpp:607-621
  // AV modules 0-7, all HLE'd so just return 0
  kernel.register(UTILITY.sceUtilityLoadAvModule, (regs) => {
    const module = regs.getGpr(4);
    if (module > 7) {
      regs.setGpr(2, 0x80110F01 >>> 0); // SCE_ERROR_AV_MODULE_BAD_ID
    } else {
      regs.setGpr(2, 0);
    }
  });

  // sceUtilityLoadModule(module) — PPSSPP sceUtility.cpp:627-635
  // All modules are HLE'd so just return 0 (module code never loaded).
  kernel.register(UTILITY.sceUtilityLoadModule, (regs) => {
    regs.setGpr(2, 0);
  });

  // ── Stubs: UTILITY ──────────────────────────────────────────────────────
  kernel.stub(UTILITY.__UtilityFinishDialog);
  kernel.stub(UTILITY.__UtilityInitDialog, 1);
  kernel.stub(UTILITY.__UtilityWorkUs);
  kernel.stub(UTILITY.sceNetplayDialogGetStatus);
  kernel.stub(UTILITY.sceNetplayDialogInitStart, 1);
  kernel.stub(UTILITY.sceNetplayDialogUpdate);
  kernel.stub(UTILITY.sceUtilityAuthDialogGetStatus);
  kernel.stub(UTILITY.sceUtilityAuthDialogInitStart, 1);
  kernel.stub(UTILITY.sceUtilityAuthDialogShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityAuthDialogUpdate);
  kernel.stub(UTILITY.sceUtilityAutoConnectAbort, 1);
  kernel.stub(UTILITY.sceUtilityAutoConnectGetStatus, 1);
  kernel.stub(UTILITY.sceUtilityAutoConnectInitStart, 1);
  kernel.stub(UTILITY.sceUtilityAutoConnectShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityAutoConnectUpdate, 1);
  kernel.stub(UTILITY.sceUtilityCheckNetParam);
  kernel.stub(UTILITY.sceUtilityDNASGetStatus);
  kernel.stub(UTILITY.sceUtilityDNASInitStart, 1);
  kernel.stub(UTILITY.sceUtilityDNASShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityDNASUpdate);
  kernel.stub(UTILITY.sceUtilityGameSharingGetStatus);
  kernel.stub(UTILITY.sceUtilityGameSharingInitStart, 1);
  kernel.stub(UTILITY.sceUtilityGameSharingShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityGameSharingUpdate);
  kernel.stub(UTILITY.sceUtilityGamedataInstallAbort);
  kernel.stub(UTILITY.sceUtilityGamedataInstallGetStatus);
  kernel.stub(UTILITY.sceUtilityGamedataInstallInitStart, 1);
  kernel.stub(UTILITY.sceUtilityGamedataInstallShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityGamedataInstallUpdate);
  kernel.stub(UTILITY.sceUtilityGetNetParam);
  kernel.stub(UTILITY.sceUtilityGetNetParamLatestID);
  kernel.stub(UTILITY.sceUtilityHtmlViewerGetStatus);
  kernel.stub(UTILITY.sceUtilityHtmlViewerInitStart, 1);
  kernel.stub(UTILITY.sceUtilityHtmlViewerShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityHtmlViewerUpdate);
  kernel.stub(UTILITY.sceUtilityInstallGetStatus);
  kernel.stub(UTILITY.sceUtilityInstallInitStart, 1);
  kernel.stub(UTILITY.sceUtilityInstallShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityInstallUpdate);
  kernel.stub(UTILITY.sceUtilityLoadUsbModule);
  kernel.stub(UTILITY.sceUtilityMsgDialogAbort);
  kernel.stub(UTILITY.sceUtilityMsgDialogUpdate);
  kernel.stub(UTILITY.sceUtilityNpSigninGetStatus);
  kernel.stub(UTILITY.sceUtilityNpSigninInitStart, 1);
  kernel.stub(UTILITY.sceUtilityNpSigninShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityNpSigninUpdate);
  kernel.stub(UTILITY.sceUtilityOskGetStatus);
  kernel.stub(UTILITY.sceUtilityOskInitStart, 1);
  kernel.stub(UTILITY.sceUtilityOskShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityOskUpdate);
  kernel.stub(UTILITY.sceUtilityPS3ScanGetStatus);
  kernel.stub(UTILITY.sceUtilityPS3ScanInitStart, 1);
  kernel.stub(UTILITY.sceUtilityPS3ScanShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityPS3ScanUpdate);
  kernel.stub(UTILITY.sceUtilityPsnGetStatus);
  kernel.stub(UTILITY.sceUtilityPsnInitStart, 1);
  kernel.stub(UTILITY.sceUtilityPsnShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityPsnUpdate);
  kernel.stub(UTILITY.sceUtilityRssReaderContStart, 1);
  kernel.stub(UTILITY.sceUtilityRssReaderGetStatus);
  kernel.stub(UTILITY.sceUtilityRssReaderInitStart, 1);
  kernel.stub(UTILITY.sceUtilityRssReaderShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityRssReaderUpdate);
  kernel.stub(UTILITY.sceUtilityRssSubscriberGetStatus);
  kernel.stub(UTILITY.sceUtilityRssSubscriberInitStart, 1);
  kernel.stub(UTILITY.sceUtilityRssSubscriberShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityRssSubscriberUpdate);
  kernel.stub(UTILITY.sceUtilitySavedataErrGetStatus);
  kernel.stub(UTILITY.sceUtilitySavedataErrInitStart, 1);
  kernel.stub(UTILITY.sceUtilitySavedataErrShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilitySavedataErrUpdate);
  kernel.stub(UTILITY.sceUtilityScreenshotContStart, 1);
  kernel.stub(UTILITY.sceUtilityScreenshotGetStatus);
  kernel.stub(UTILITY.sceUtilityScreenshotInitStart, 1);
  kernel.stub(UTILITY.sceUtilityScreenshotShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityScreenshotUpdate);
  kernel.stub(UTILITY.sceUtilitySetSystemParamInt);
  kernel.stub(UTILITY.sceUtilitySetSystemParamString);
  kernel.stub(UTILITY.sceUtilityStoreCheckoutGetStatus);
  kernel.stub(UTILITY.sceUtilityStoreCheckoutInitStart, 1);
  kernel.stub(UTILITY.sceUtilityStoreCheckoutShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityStoreCheckoutUpdate);
  kernel.stub(UTILITY.sceUtilityUnloadAvModule, 1);
  kernel.stub(UTILITY.sceUtilityUnloadModule, 1);
  kernel.stub(UTILITY.sceUtilityLoadNetModule);
  kernel.stub(UTILITY.sceUtilityUnloadNetModule);
  kernel.stub(UTILITY.sceUtilityUnloadUsbModule);
  kernel.stub(UTILITY.sceUtility_28D35634);
  kernel.stub(UTILITY.sceUtility_43E521B7);
  kernel.stub(UTILITY.sceUtility_70267ADF);
  kernel.stub(UTILITY.sceUtility_CFE7C460);
  kernel.stub(UTILITY.sceUtility_DB4149EE);
  kernel.stub(UTILITY.sceUtility_E1BC175E);
  kernel.stub(UTILITY.sceUtility_ECE1D3E5);
  kernel.stub(UTILITY.sceUtility_EF3582B2);

  // ── HEAP ──────────────────────────────────────────────────────────
  kernel.stub(HEAP.sceHeapAllocHeapMemory, 1);
  kernel.stub(HEAP.sceHeapAllocHeapMemoryWithOption, 1);
  kernel.stub(HEAP.sceHeapCreateHeap, 1);
  kernel.stub(HEAP.sceHeapDeleteHeap);
  kernel.stub(HEAP.sceHeapFreeHeapMemory);
  kernel.stub(HEAP.sceHeapGetMallinfo);
  kernel.stub(HEAP.sceHeapGetTotalFreeSize);
  kernel.stub(HEAP.sceHeapIsAllocatedHeapMemory, 1);
  kernel.stub(HEAP.sceHeapReallocHeapMemory, 1);
  kernel.stub(HEAP.sceHeapReallocHeapMemoryWithOption, 1);
  // ── HPRM ──────────────────────────────────────────────────────────
  kernel.stub(HPRM.sceHprmIsHeadphoneExist);
  kernel.stub(HPRM.sceHprmIsMicrophoneExist);
  kernel.stub(HPRM.sceHprmIsRemoteExist);
  kernel.stub(HPRM.sceHprmPeekCurrentKey);
  kernel.stub(HPRM.sceHprmPeekLatch);
  kernel.stub(HPRM.sceHprmReadLatch);
  kernel.stub(HPRM.sceHprmRegisterCallback, 1);
  kernel.stub(HPRM.sceHprmUnregisterCallback, 1);
  kernel.stub(HPRM.sceHprmUnregitserCallback);
  kernel.stub(HPRM.sceHprm_089fdfa4);
  // ── IMPOSE ──────────────────────────────────────────────────────────
  kernel.stub(IMPOSE.sceImposeGetBacklightOffTime);
  kernel.stub(IMPOSE.sceImposeGetBatteryIconStatus);
  kernel.stub(IMPOSE.sceImposeGetHomePopup);
  kernel.stub(IMPOSE.sceImposeGetLanguageMode);
  kernel.stub(IMPOSE.sceImposeGetUMDPopup);
  kernel.stub(IMPOSE.sceImposeHomeButton);
  kernel.stub(IMPOSE.sceImposeSetBacklightOffTime);
  kernel.stub(IMPOSE.sceImposeSetHomePopup);
  kernel.stub(IMPOSE.sceImposeSetUMDPopup);
  kernel.stub(IMPOSE.sceImpose_9BA61B49);
  kernel.stub(IMPOSE.sceImpose_A9884B00);
  kernel.stub(IMPOSE.sceImpose_BB3F5DEC);
  kernel.stub(IMPOSE.sceImpose_FCD44963);
  kernel.stub(IMPOSE.sceImpose_FF1A2F07);
  // ── DMAC ──────────────────────────────────────────────────────────
  kernel.stub(DMAC.sceDmacMemcpy);
  kernel.stub(DMAC.sceDmacTryMemcpy);
  // ── GAME_UPDATE ──────────────────────────────────────────────────────────
  kernel.stub(GAME_UPDATE.sceGameUpdateAbort);
  kernel.stub(GAME_UPDATE.sceGameUpdateInit, 1);
  kernel.stub(GAME_UPDATE.sceGameUpdateRun);
  kernel.stub(GAME_UPDATE.sceGameUpdateTerm);
  // ── SIRCS ──────────────────────────────────────────────────────────
  kernel.stub(SIRCS.sceSircsEnd);
  kernel.stub(SIRCS.sceSircsInit, 1);
  kernel.stub(SIRCS.sceSircsReceive);
  kernel.stub(SIRCS.sceSircsSend);

  log.info("Utility HLE handlers registered");
}
