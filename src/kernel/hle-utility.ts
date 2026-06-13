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
  // PPSSPP PSPDialog.h: 0=NONE, 1=INITIALIZE, 2=RUNNING, 3=FINISHED, 4=SHUTDOWN.
  // Games poll GetStatus for 3 (FINISHED), then call ShutdownStart → 4 → 0.
  let savedataStatus = 0;
  let savedataParamAddr = 0;
  let savedataResult = 0;
  let savedataIoComplete = false;
  let savedataMode = 0;

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
    savedataUpdateCount = 0;
    // Clear common.result in PSP memory so the game doesn't read a stale value
    bus.writeU32(paramAddr + 28, 0);

    const mode = bus.readU32(paramAddr + 48);
    savedataMode = mode;
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

    savedataStatus = 1; // INITIALIZE — first GetStatus returns 1, then auto-advances to RUNNING

    // Notify UI overlay
    kernel.onSavedataEvent?.(action, gameName, saveName, false, false);

    if (!store) {
      // No store: return LOAD_NO_DATA for load modes, success for everything else
      if (isLoad) savedataResult = 0x80110305;
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
      function applyLoad(entry: import("../storage/savedata-store.js").SaveEntry | null): void {
        if (entry && entry.data.byteLength > 0) {
          const copySize = Math.min(entry.data.byteLength, dataBufSize);
          for (let i = 0; i < copySize; i++) {
            bus.writeU8(dataBuf + i, entry.data[i]!);
          }
          bus.writeU32(paramAddr + 124, entry.dataSize);
          bus.writeU32(paramAddr + 52, 1021); // bind
          savedataResult = 0;
        } else {
          savedataResult = (mode === 15 || mode === 16) ? 0x80110327 : 0x80110305;
        }
        savedataIoComplete = true;
      }
      if (store!.loadSync) {
        applyLoad(store!.loadSync(key));
      } else {
        store!.load(key).then(applyLoad).catch(() => {
          savedataResult = 0x80110305;
          savedataIoComplete = true;
        });
      }
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
      const entry = { key, data: saveData, dataSize: saveSize, title, detail, timestamp: Date.now() };

      if (store!.saveSync) {
        store!.saveSync(key, entry);
        savedataResult = 0;
        savedataIoComplete = true;
      } else {
        store!.save(key, entry).then(() => {
          savedataResult = 0;
          savedataIoComplete = true;
        }).catch(() => {
          savedataResult = 0;
          savedataIoComplete = true;
        });
      }
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

  // sceUtilitySavedataGetStatus — PPSSPP PSPDialog::GetStatus (auto-status):
  // returns the current status, then INITIALIZE→RUNNING and SHUTDOWN→NONE.
  // FINISHED stays until the game calls ShutdownStart.
  kernel.register(UTILITY.sceUtilitySavedataGetStatus, (regs) => {
    const prev = savedataStatus;
    if (savedataStatus === 1) {
      savedataStatus = 2; // INITIALIZE → RUNNING
    } else if (savedataStatus === 4) {
      savedataStatus = 0; // SHUTDOWN → NONE
    }
    regs.setGpr(2, prev);
  });

  // sceUtilitySavedataShutdownStart
  kernel.register(UTILITY.sceUtilitySavedataShutdownStart, (regs, bus) => {
    // Write result to common.result (offset 28)
    if (savedataParamAddr !== 0) {
      bus.writeU32(savedataParamAddr + 28, savedataResult);
    }
    savedataStatus = 4; // SHUTDOWN — next GetStatus returns 4, then NONE
    // Notify UI that operation completed
    kernel.onSavedataEvent?.("", "", "", true, savedataResult !== 0);
    regs.setGpr(2, 0);
  });

  // sceUtilitySavedataUpdate(drawSpeed)
  // PPSSPP PSPSaveDialog.cpp:672-1101
  // For non-visible actions (AUTOLOAD, AUTOSAVE, etc.), Update performs IO
  // and transitions directly to FINISHED, skipping the dialog UI.
  // For visible actions (LOAD, SAVE with UI), it waits for user input.
  let savedataUpdateCount = 0;
  const NON_VISIBLE_MODES = new Set([0,1,6,7,8,11,12,13,14,15,16,17,18,19,20,21]);
  kernel.register(UTILITY.sceUtilitySavedataUpdate, (regs, bus) => {
    if (savedataStatus === 2) {
      savedataUpdateCount++;
      if (savedataIoComplete) {
        if (NON_VISIBLE_MODES.has(savedataMode)) {
          // PPSSPP DS_NONE path: IO done → FINISHED; game polls 3 then calls ShutdownStart
          savedataStatus = 3;
          if (savedataParamAddr !== 0) bus.writeU32(savedataParamAddr + 28, savedataResult);
        } else if (savedataUpdateCount >= 3) {
          // Visible dialog: auto-dismiss after a few frames (simulates user pressing X)
          savedataStatus = 3; // FINISHED
          if (savedataParamAddr !== 0) bus.writeU32(savedataParamAddr + 28, savedataResult);
        }
      }
    }
    regs.setGpr(2, 0);
  });

  // MsgDialog — PPSSPP dialog state machine (PSPDialog.cpp / PSPMsgDialog.cpp).
  // 0=NONE 1=INITIALIZE 2=RUNNING 3=FINISHED 4=SHUTDOWN. InitStart sets INITIALIZE;
  // GetStatus auto-advances INITIALIZE→RUNNING and SHUTDOWN→NONE (UseAutoStatus);
  // the RUNNING→FINISHED transition is driven by Update (a real PSP shows the
  // dialog and waits for a button — we have no UI, so Update confirms it).
  let msgDialogStatus = 0;
  let msgDialogParamAddr = 0;
  kernel.register(UTILITY.sceUtilityMsgDialogInitStart, (regs, bus) => {
    msgDialogParamAddr = regs.getGpr(4) >>> 0;
    msgDialogStatus = 1; // INITIALIZE
    // string[512] (UTF-8) lives at offset 60 in pspMessageDialog (PSPMsgDialog.h).
    const msg = msgDialogParamAddr !== 0 ? kernel.readCString(bus, msgDialogParamAddr + 60) : "";
    log.info(`[dialog] MsgDialog opened: "${msg}"`);
    regs.setGpr(2, 0);
  });
  kernel.register(UTILITY.sceUtilityMsgDialogGetStatus, (regs) => {
    const ret = msgDialogStatus;
    if (msgDialogStatus === 1) msgDialogStatus = 2;      // INITIALIZE → RUNNING
    else if (msgDialogStatus === 4) msgDialogStatus = 0; // SHUTDOWN → NONE
    regs.setGpr(2, ret);
  });
  // sceUtilityMsgDialogUpdate(animSpeed) — PPSSPP sceUtility.cpp:717 / PSPMsgDialog::
  // Update: error unless RUNNING; otherwise advance the dialog. With no UI we
  // confirm immediately: write common.result=0 and buttonPressed=YES/OK (offset
  // 576, only on V2+ params where common.size >= 580), then go to FINISHED so the
  // game's GetStatus poll sees 3 and calls ShutdownStart.
  kernel.register(UTILITY.sceUtilityMsgDialogUpdate, (regs, bus) => {
    if (msgDialogStatus !== 2) { regs.setGpr(2, 0x80110001); return; } // SCE_ERROR_UTILITY_INVALID_STATUS
    if (msgDialogParamAddr !== 0) {
      bus.writeU32(msgDialogParamAddr + 28, 0); // pspUtilityDialogCommon.result = success
      const size = bus.readU32(msgDialogParamAddr) >>> 0; // common.size
      if (size >= 580) bus.writeU32(msgDialogParamAddr + 576, 1); // buttonPressed = YES/OK
    }
    msgDialogStatus = 3; // FINISHED
    log.info(`[dialog] MsgDialog dismissed (button=OK)`);
    regs.setGpr(2, 0);
  });
  kernel.register(UTILITY.sceUtilityMsgDialogShutdownStart, (regs) => {
    msgDialogStatus = 4; // SHUTDOWN
    regs.setGpr(2, 0);
  });

  // OSK (on-screen keyboard) — same dialog state machine (PSPOskDialog.cpp).
  // We have no keyboard UI, so Update returns a fixed string ("PSPjs") as the
  // entered text — written to outtext with field result = CHANGED, like PPSSPP's
  // finish path (PSPOskDialog.cpp:849-863).
  // SceUtilityOskParams: base(common,48) result@28, fieldCount@48, fields ptr@52,
  // state@56. SceUtilityOskData field: intext@32, outtextlength@36, outtext@40,
  // result@44 (0=UNCHANGED 1=CANCELLED 2=CHANGED). state: 5=FINISHED.
  const OSK_TEXT = "PSPjs";
  let oskStatus = 0;
  let oskParamAddr = 0;
  kernel.register(UTILITY.sceUtilityOskInitStart, (regs) => {
    oskParamAddr = regs.getGpr(4) >>> 0;
    oskStatus = 1; // INITIALIZE
    log.info(`[dialog] OSK opened`);
    regs.setGpr(2, 0);
  });
  kernel.register(UTILITY.sceUtilityOskGetStatus, (regs) => {
    const ret = oskStatus;
    if (oskStatus === 1) oskStatus = 2;      // INITIALIZE → RUNNING
    else if (oskStatus === 4) oskStatus = 0; // SHUTDOWN → NONE
    regs.setGpr(2, ret);
  });
  kernel.register(UTILITY.sceUtilityOskUpdate, (regs, bus) => {
    if (oskStatus !== 2) { regs.setGpr(2, 0x80110001); return; } // SCE_ERROR_UTILITY_INVALID_STATUS
    const inRam = (a: number): boolean => a >= 0x08000000 && a < 0x0c000000;
    if (inRam(oskParamAddr)) {
      const fieldsPtr = bus.readU32(oskParamAddr + 52) >>> 0;
      if (inRam(fieldsPtr)) {
        const outLen = bus.readU32(fieldsPtr + 36) >>> 0; // u16 count incl. terminator
        const outtextPtr = bus.readU32(fieldsPtr + 40) >>> 0;
        if (inRam(outtextPtr) && outLen > 0) {
          const max = outLen - 1; // leave room for the terminator
          let i = 0;
          for (; i < OSK_TEXT.length && i < max; i++) {
            bus.writeU16(outtextPtr + i * 2, OSK_TEXT.charCodeAt(i));
          }
          bus.writeU16(outtextPtr + i * 2, 0); // null terminator
        }
        bus.writeU32(fieldsPtr + 44, 2); // field result = CHANGED (text was entered)
        log.info(`[dialog] OSK confirmed: "${OSK_TEXT}"`);
      }
      bus.writeU32(oskParamAddr + 28, 0); // common.result = success
      bus.writeU32(oskParamAddr + 56, 5); // params.state = FINISHED
    }
    oskStatus = 3; // FINISHED
    regs.setGpr(2, 0);
  });
  kernel.register(UTILITY.sceUtilityOskShutdownStart, (regs) => {
    oskStatus = 4; // SHUTDOWN
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

  // sceImposeGetLanguageMode(languagePtr, btnPtr) — PPSSPP sceImpose.cpp:82 writes
  // the system language and the enter-button assignment to the out pointers (a
  // no-op stub leaves the game reading garbage, which can flip a language branch —
  // gow loads DATA/<language>/GAME.BIN). Keep these consistent with
  // sceUtilityGetSystemParamInt: language English=1, enter button X/Cross=1.
  kernel.register(IMPOSE.sceImposeGetLanguageMode, (regs, bus) => {
    const languagePtr = regs.getGpr(4);
    const btnPtr = regs.getGpr(5);
    if (languagePtr !== 0) bus.writeU32(languagePtr, 1); // PSP_SYSTEMPARAM_LANGUAGE_ENGLISH
    if (btnPtr !== 0) bus.writeU32(btnPtr, 1);           // PSP_SYSTEMPARAM_BUTTON_CROSS
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

  // sceUtilityUnloadModule(module) — PPSSPP sceUtility.cpp:637. Mirror of
  // LoadModule: modules are HLE'd and never really loaded, so unload always
  // succeeds. Returning the not-loaded error would contradict LoadModule's 0.
  kernel.register(UTILITY.sceUtilityUnloadModule, (regs) => {
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
  kernel.stub(UTILITY.sceUtilityNpSigninGetStatus);
  kernel.stub(UTILITY.sceUtilityNpSigninInitStart, 1);
  kernel.stub(UTILITY.sceUtilityNpSigninShutdownStart, 1);
  kernel.stub(UTILITY.sceUtilityNpSigninUpdate);
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
  // PPSSPP sceHeap.cpp — user-space heap allocator wrapping partition memory.
  // Uses a simple block allocator: doubly-linked list of blocks sorted by address.

  const SCE_KERNEL_ERROR_INVALID_ID      = 0x80000100 >>> 0;
  const SCE_KERNEL_ERROR_INVALID_POINTER = 0x80000103 >>> 0;
  const PSP_HEAP_ATTR_HIGHMEM = 0x4000;

  interface HeapBlock { start: number; size: number; taken: boolean; }

  interface HeapState {
    address: number;     // base address (also the heap handle)
    size: number;        // total allocated size
    fromtop: boolean;
    poolStart: number;   // address + 128
    poolSize: number;    // size - 128
    blocks: HeapBlock[]; // sorted by start address
    memBlockId: number;  // kernel memBlock ID for cleanup
  }

  const heaps = new Map<number, HeapState>();

  const HEAP_MIN_GRAIN = 4; // PPSSPP BlockAllocator constructed with grain=4

  /** Allocate within a heap's block list. fromTop=true scans from high end. */
  function heapAlloc(heap: HeapState, size: number, grain: number, fromTop: boolean): number {
    if (size === 0 || size > heap.poolSize) return -1;
    // Clamp grain to allocator minimum — PPSSPP AllocAligned lines 65-66
    if (grain < HEAP_MIN_GRAIN) grain = HEAP_MIN_GRAIN;
    // Align size up to grain
    size = (size + grain - 1) & ~(grain - 1);

    if (fromTop) {
      // Scan from high to low
      for (let i = heap.blocks.length - 1; i >= 0; i--) {
        const b = heap.blocks[i]!;
        if (b.taken || b.size < size) continue;
        // Align allocation to end of block
        const offset = (b.start + b.size - size) % grain;
        const needed = offset + size;
        if (b.size < needed) continue;
        const allocStart = b.start + b.size - size; // aligned to end
        // Split block
        if (allocStart === b.start && b.size === size) {
          b.taken = true;
          return b.start;
        }
        // Free space before
        const newBlocks: HeapBlock[] = [];
        if (allocStart > b.start) {
          newBlocks.push({ start: b.start, size: allocStart - b.start, taken: false });
        }
        newBlocks.push({ start: allocStart, size, taken: true });
        // Free space after (shouldn't happen with fromTop alignment, but be safe)
        const afterEnd = allocStart + size;
        const blockEnd = b.start + b.size;
        if (afterEnd < blockEnd) {
          newBlocks.push({ start: afterEnd, size: blockEnd - afterEnd, taken: false });
        }
        heap.blocks.splice(i, 1, ...newBlocks);
        return allocStart;
      }
    } else {
      // Scan from low to high
      for (let i = 0; i < heap.blocks.length; i++) {
        const b = heap.blocks[i]!;
        if (b.taken || b.size < size) continue;
        // Align start up
        const alignedStart = (b.start + grain - 1) & ~(grain - 1);
        const needed = alignedStart - b.start + size;
        if (b.size < needed) continue;
        const newBlocks: HeapBlock[] = [];
        if (alignedStart > b.start) {
          newBlocks.push({ start: b.start, size: alignedStart - b.start, taken: false });
        }
        newBlocks.push({ start: alignedStart, size, taken: true });
        const afterEnd = alignedStart + size;
        const blockEnd = b.start + b.size;
        if (afterEnd < blockEnd) {
          newBlocks.push({ start: afterEnd, size: blockEnd - afterEnd, taken: false });
        }
        heap.blocks.splice(i, 1, ...newBlocks);
        return alignedStart;
      }
    }
    return -1;
  }

  /** Free an exact address. Returns true on success. */
  function heapFreeExact(heap: HeapState, addr: number): boolean {
    const idx = heap.blocks.findIndex(b => b.taken && b.start === addr);
    if (idx === -1) return false;
    heap.blocks[idx]!.taken = false;
    // Merge adjacent free blocks
    heapMergeFree(heap);
    return true;
  }

  /** Merge adjacent free blocks in the list. */
  function heapMergeFree(heap: HeapState): void {
    for (let i = heap.blocks.length - 2; i >= 0; i--) {
      const a = heap.blocks[i]!;
      const b = heap.blocks[i + 1]!;
      if (!a.taken && !b.taken) {
        a.size = (b.start + b.size) - a.start;
        heap.blocks.splice(i + 1, 1);
      }
    }
  }

  /** Get total free bytes in heap. */
  function heapTotalFree(heap: HeapState): number {
    let total = 0;
    for (const b of heap.blocks) { if (!b.taken) total += b.size; }
    return total;
  }

  // sceHeapCreateHeap(name, heapSize, attr, paramsPtr)
  // PPSSPP sceHeap.cpp:179-204
  kernel.register(HEAP.sceHeapCreateHeap, (regs, bus) => {
    const namePtr  = regs.getGpr(4);
    const heapSize = regs.getGpr(5);
    const attr     = regs.getGpr(6);

    if (namePtr === 0) { regs.setGpr(2, 0); return; }
    let name = "";
    for (let i = 0; i < 31; i++) { const b = bus.readU8(namePtr + i); if (b === 0) break; name += String.fromCharCode(b); }

    const allocSize = (heapSize + 3) & ~3;
    const fromtop = (attr & PSP_HEAP_ATTR_HIGHMEM) !== 0;

    const addr = kernel.userMemory.alloc(allocSize, fromtop, `Heap/${name}`);
    if (addr === -1) { regs.setGpr(2, 0); return; }
    const blockId = kernel.nextBlockId++;

    const poolStart = addr + 128;
    const poolSize = allocSize - 128;
    const heap: HeapState = {
      address: addr, size: allocSize, fromtop,
      poolStart, poolSize,
      blocks: [{ start: poolStart, size: poolSize, taken: false }],
      memBlockId: blockId,
    };
    heaps.set(addr, heap);
    log.debug(`sceHeapCreateHeap("${name}", size=0x${heapSize.toString(16)}, attr=0x${attr.toString(16)}) → 0x${addr.toString(16)}`);
    regs.setGpr(2, addr);
  });

  // sceHeapDeleteHeap(heapAddr) — PPSSPP sceHeap.cpp:168-177
  // Note: PPSSPP does NOT free the underlying partition memory — just deletes the heap object.
  kernel.register(HEAP.sceHeapDeleteHeap, (regs) => {
    const heapAddr = regs.getGpr(4);
    const heap = heaps.get(heapAddr);
    if (!heap) { regs.setGpr(2, SCE_KERNEL_ERROR_INVALID_ID); return; }
    heaps.delete(heapAddr);
    regs.setGpr(2, 0);
  });

  // sceHeapAllocHeapMemory(heapAddr, memSize) — PPSSPP sceHeap.cpp:206-218
  kernel.register(HEAP.sceHeapAllocHeapMemory, (regs) => {
    const heapAddr = regs.getGpr(4);
    const memSize  = regs.getGpr(5);
    const heap = heaps.get(heapAddr);
    if (!heap) { regs.setGpr(2, SCE_KERNEL_ERROR_INVALID_ID); return; }
    const addr = heapAlloc(heap, memSize + 8, 4, true); // +8 overhead, fromTop, grain=4
    regs.setGpr(2, addr === -1 ? 0xFFFFFFFF : addr);
  });

  // sceHeapAllocHeapMemoryWithOption(heapAddr, memSize, paramsPtr) — PPSSPP sceHeap.cpp:116-139
  kernel.register(HEAP.sceHeapAllocHeapMemoryWithOption, (regs, bus) => {
    const heapAddr  = regs.getGpr(4);
    const memSize   = regs.getGpr(5);
    const paramsPtr = regs.getGpr(6);
    const heap = heaps.get(heapAddr);
    if (!heap) { regs.setGpr(2, 0); return; } // returns 0, not error
    let grain = 4;
    if (paramsPtr !== 0) {
      const pSize = bus.readU32(paramsPtr);
      if (pSize < 8) { regs.setGpr(2, 0); return; }
      grain = bus.readU32(paramsPtr + 4) || 4;
    }
    const addr = heapAlloc(heap, memSize + 8, grain, true);
    regs.setGpr(2, addr === -1 ? 0xFFFFFFFF : addr);
  });

  // sceHeapFreeHeapMemory(heapAddr, memAddr) — PPSSPP sceHeap.cpp:94-109
  kernel.register(HEAP.sceHeapFreeHeapMemory, (regs) => {
    const heapAddr = regs.getGpr(4);
    const memAddr  = regs.getGpr(5);
    const heap = heaps.get(heapAddr);
    if (!heap) { regs.setGpr(2, SCE_KERNEL_ERROR_INVALID_ID); return; }
    if (memAddr === 0) { regs.setGpr(2, 0); return; } // null free is OK
    if (!heapFreeExact(heap, memAddr)) { regs.setGpr(2, SCE_KERNEL_ERROR_INVALID_POINTER); return; }
    regs.setGpr(2, 0);
  });

  // sceHeapGetTotalFreeSize(heapAddr) — PPSSPP sceHeap.cpp:141-153
  kernel.register(HEAP.sceHeapGetTotalFreeSize, (regs) => {
    const heapAddr = regs.getGpr(4);
    const heap = heaps.get(heapAddr);
    if (!heap) { regs.setGpr(2, SCE_KERNEL_ERROR_INVALID_ID); return; }
    let free = heapTotalFree(heap);
    if (free >= 8) free -= 8; // reserve overhead for next alloc
    regs.setGpr(2, free);
  });

  // sceHeapIsAllocatedHeapMemory(heapPtr, memPtr) — PPSSPP sceHeap.cpp:155-166
  kernel.register(HEAP.sceHeapIsAllocatedHeapMemory, (regs) => {
    const heapPtr = regs.getGpr(4);
    const memPtr  = regs.getGpr(5);
    if (memPtr === 0) { regs.setGpr(2, SCE_KERNEL_ERROR_INVALID_POINTER); return; }
    const heap = heaps.get(heapPtr);
    if (!heap) { regs.setGpr(2, 0); return; } // not found in any heap
    const found = heap.blocks.some(b => b.taken && b.start === memPtr);
    regs.setGpr(2, found ? 1 : 0);
  });

  // Unimplemented in PPSSPP too — return 0
  kernel.register(HEAP.sceHeapGetMallinfo, (regs) => { regs.setGpr(2, 0); });
  kernel.register(HEAP.sceHeapReallocHeapMemory, (regs) => { regs.setGpr(2, 0); });
  kernel.register(HEAP.sceHeapReallocHeapMemoryWithOption, (regs) => { regs.setGpr(2, 0); });
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
