/**
 * Shared helpers for the headless tools: mount an ISO into the emulator's
 * filesystem and pull out the EBOOT. Kept separate so a tool can import them
 * without running another tool's main().
 */

import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";

/** Extract disc0:/PSP_GAME/SYSDIR/EBOOT.BIN as raw bytes. */
export function extractEboot(isoBuffer: ArrayBuffer): Uint8Array {
  const volume = parseIso(isoBuffer);
  const pspGame = volume.root.children!.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "PSP_GAME",
  )!;
  const sysdir = pspGame.children!.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "SYSDIR",
  )!;
  const eboot = sysdir.children!.find(
    (f) => !f.isDirectory && f.name.toUpperCase() === "EBOOT.BIN",
  )!;
  return readFile(isoBuffer, eboot).slice();
}

/** Mount every file in the ISO under disc0: into the given fileData map. */
export function mountIso(isoBuffer: ArrayBuffer, fileData: Map<string, Uint8Array>): void {
  const volume = parseIso(isoBuffer);
  function walk(node: IsoFile, path: string): void {
    if (node.isDirectory) {
      for (const child of node.children ?? []) {
        walk(child, path + "/" + child.name.replace(/;1$/, "").toLowerCase());
      }
    } else {
      fileData.set("disc0:" + path, readFile(isoBuffer, node));
    }
  }
  walk(volume.root, "");
}
