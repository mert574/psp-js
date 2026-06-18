/**
 * Restore a save state headless and continue running it.
 * Usage: npx tsx tools/savestate.ts <state-file> <iso-path> [extra-frames=0]
 *
 * This is the path for "someone exported a .pspstate in the browser, hands me
 * the file plus the matching ISO, and I continue from exactly that point."
 *
 * It boots the game normally (so all handlers/trampolines are wired), overlays
 * the saved state, then runs `extra-frames` more frames and prints diagnostics.
 */

import { readFileSync, existsSync } from "node:fs";
import { PSPEmulator } from "../src/emulator.js";
import { unpackContainer } from "../src/state/state-container.js";
import { extractEboot, mountIso } from "./iso-mount.js";
import { Logger } from "../src/utils/logger.js";

const stateFile = process.argv[2];
const isoPath = process.argv[3];
const extraFrames = parseInt(process.argv[4] ?? "0", 10);

if (!stateFile || !existsSync(stateFile) || !isoPath || !existsSync(isoPath)) {
  console.error("Usage: npx tsx tools/savestate.ts <state-file> <iso-path> [extra-frames]");
  process.exit(1);
}

async function main(): Promise<void> {
  const blob = new Uint8Array(readFileSync(stateFile));
  const header = await unpackContainer(blob);
  console.log(`\n=== Save state: ${stateFile} ===`);
  console.log(`Format:   v${header.formatVersion}`);
  console.log(`Game id:  ${header.gameId || "(homebrew)"}`);
  console.log(`EBOOT hash: 0x${header.contentHash.toString(16).padStart(8, "0")}`);
  if (Object.keys(header.meta).length > 0) console.log(`Meta:     ${JSON.stringify(header.meta)}`);

  const isoBuffer = readFileSync(isoPath).buffer as ArrayBuffer;
  const eboot = extractEboot(isoBuffer);

  const emu = new PSPEmulator();
  mountIso(isoBuffer, emu.hle.fileData);

  const errors: string[] = [];
  Logger.setErrorHook((ns, msg) => errors.push(`[${ns}] ${msg}`));

  await emu.loadElfBinary(eboot);
  if (emu.gameId !== header.gameId) {
    console.warn(`\nWARNING: booted game id "${emu.gameId}" differs from the state's "${header.gameId}".`);
  }

  // Overlay the saved state. Throws on a game/build mismatch unless --force is
  // passed (which allows a different EBOOT build of the same game).
  const force = process.argv.includes("--force");
  await emu.loadState(blob, { allowBuildMismatch: force });
  console.log(`\n--- Restored ---`);
  console.log(`PC: 0x${emu.cpu.regs.pc.toString(16)}`);
  console.log(`VBlank count: ${emu.hle.vblankCount}`);
  console.log(`Threads: ${emu.hle.threads.size}`);

  if (extraFrames > 0) {
    let frames = 0;
    const start = Date.now();
    for (; frames < extraFrames; frames++) {
      emu.runFrame();
      if (emu.halted || emu.cpu.stepFaulted) break;
    }
    const elapsed = Date.now() - start;
    console.log(`\n--- Ran ${frames}/${extraFrames} more frames in ${elapsed}ms ---`);
    console.log(`PC: 0x${emu.cpu.regs.pc.toString(16)}`);
    console.log(`Halted: ${emu.halted}, Faulted: ${emu.cpu.stepFaulted}`);
    console.log(`VBlank count: ${emu.hle.vblankCount}`);
    console.log(`GE lists: ${emu.hle.geListCount}, prims: ${emu.hle.gePrimCount}`);
  }

  if (errors.length > 0) {
    console.log(`\nERRORS (${errors.length}):`);
    for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
  }
  console.log("");
}

main().catch((err) => { console.error(err); process.exit(1); });
