/**
 * ISO metadata extraction — shared between game library and preview screen.
 *
 * Two modes:
 * - Partial reads (File handle) — for library scanning without loading full ISO
 * - Full buffer (ArrayBuffer) — for preview after ISO is already loaded
 */

import type { IsoFile, IsoVolume } from "./iso9660.js";
import { readFile } from "./iso9660.js";
import { parseSfo, extractGameInfo } from "./sfo.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface IsoMetadata {
  title: string;
  discId: string;
  region: string;
  version: string;
  parentalLevel: number;
  category: string;
  saveTitle: string;
  saveDetail: string;
  iconUrl: string | null;
  bgUrl: string | null;
  logoUrl: string | null;
}

// ── Full-buffer extraction (for preview screen after ISO is loaded) ──────────

/**
 * Extract all metadata from an already-parsed ISO volume + buffer.
 * Returns URLs for icon/bg/logo (caller must revoke when done).
 */
export function extractFromBuffer(
  buffer: ArrayBuffer,
  volume: IsoVolume,
): IsoMetadata & { pspGameDir: IsoFile | undefined } {
  const meta: IsoMetadata = {
    title: volume.volumeId,
    discId: "", region: "", version: "",
    parentalLevel: 0, category: "",
    saveTitle: "", saveDetail: "",
    iconUrl: null, bgUrl: null, logoUrl: null,
  };

  const pspGame = volume.root.children?.find(
    f => f.isDirectory && f.name.toUpperCase() === "PSP_GAME"
  );

  if (pspGame) {
    // PARAM.SFO
    const sfoEntry = pspGame.children?.find(f => !f.isDirectory && f.name.toUpperCase() === "PARAM.SFO");
    if (sfoEntry) {
      try {
        const sfoData = parseSfo(readFile(buffer, sfoEntry).slice().buffer as ArrayBuffer);
        const info = extractGameInfo(sfoData);
        meta.title = info.title || meta.title;
        meta.discId = info.discId;
        meta.region = info.region;
        meta.version = info.version;
        meta.parentalLevel = info.parentalLevel;
        meta.category = info.category;
        meta.saveTitle = info.saveTitle;
        meta.saveDetail = info.saveDetail;
      } catch { /* non-fatal */ }
    }

    // Images
    meta.iconUrl = fileToObjectUrl(buffer, pspGame, "ICON0.PNG");
    meta.bgUrl = fileToObjectUrl(buffer, pspGame, "PIC1.PNG");
    meta.logoUrl = fileToObjectUrl(buffer, pspGame, "PIC0.PNG");
  }

  return { ...meta, pspGameDir: pspGame };
}

function fileToObjectUrl(buffer: ArrayBuffer, dir: IsoFile, name: string): string | null {
  const entry = dir.children?.find(f => !f.isDirectory && f.name.toUpperCase() === name);
  if (!entry) return null;
  try {
    const data = readFile(buffer, entry).slice();
    return URL.createObjectURL(new Blob([data.buffer as ArrayBuffer], { type: "image/png" }));
  } catch {
    return null;
  }
}

// ── Partial-read extraction (for library scan without loading full ISO) ──────

const SECTOR = 2048;
const PVD_SECTOR_NUM = 16;

async function readSlice(file: File, offset: number, length: number): Promise<ArrayBuffer> {
  return file.slice(offset, offset + length).arrayBuffer();
}

function parseDirRecord(buf: ArrayBuffer, off: number): IsoFile | null {
  const v = new DataView(buf, off);
  const len = v.getUint8(0);
  if (len === 0) return null;
  const lba = v.getUint32(2, true);
  const size = v.getUint32(10, true);
  const isDir = (v.getUint8(25) & 0x02) !== 0;
  const idLen = v.getUint8(32);
  const idBytes = new Uint8Array(buf, off + 33, idLen);
  let name: string;
  if (idLen === 1 && (idBytes[0] === 0x00 || idBytes[0] === 0x01)) {
    name = idBytes[0] === 0x00 ? "." : "..";
  } else {
    name = new TextDecoder("ascii").decode(idBytes);
    const sc = name.indexOf(";");
    if (sc !== -1) name = name.slice(0, sc);
  }
  return { name, isDirectory: isDir, lba, size };
}

async function readDirEntries(file: File, lba: number, size: number): Promise<IsoFile[]> {
  const buf = await readSlice(file, lba * SECTOR, size);
  const entries: IsoFile[] = [];
  let pos = 0;
  while (pos < size) {
    const rl = new DataView(buf, pos).getUint8(0);
    if (rl === 0) {
      const next = (Math.floor(pos / SECTOR) + 1) * SECTOR;
      if (next >= size) break;
      pos = next;
      continue;
    }
    const entry = parseDirRecord(buf, pos);
    if (entry && entry.name !== "." && entry.name !== "..") entries.push(entry);
    pos += rl;
  }
  return entries;
}

async function readIsoFilePartial(file: File, entry: IsoFile): Promise<Uint8Array> {
  const buf = await readSlice(file, entry.lba * SECTOR, entry.size);
  return new Uint8Array(buf);
}

export interface PartialIsoMetadata {
  title: string;
  discId: string;
  iconDataUrl: string | null;
}

/**
 * Extract title, disc ID, and icon from an ISO file using partial reads.
 * Only reads ~30KB per ISO instead of the full file.
 */
export async function extractFromFile(file: File): Promise<PartialIsoMetadata> {
  const fallbackTitle = file.name.replace(/\.[^.]+$/, "");
  const result: PartialIsoMetadata = { title: fallbackTitle, discId: "", iconDataUrl: null };

  try {
    // Read PVD
    const pvdBuf = await readSlice(file, PVD_SECTOR_NUM * SECTOR, SECTOR);
    const pvdView = new DataView(pvdBuf);
    if (pvdView.getUint8(0) !== 1) return result;
    const ident = new TextDecoder("ascii").decode(new Uint8Array(pvdBuf, 1, 5));
    if (ident !== "CD001") return result;

    const rootEntry = parseDirRecord(pvdBuf, 156);
    if (!rootEntry) return result;

    // Find PSP_GAME
    const rootEntries = await readDirEntries(file, rootEntry.lba, rootEntry.size);
    const pspGame = rootEntries.find(e => e.isDirectory && e.name.toUpperCase() === "PSP_GAME");
    if (!pspGame) return result;

    // Read PSP_GAME directory
    const gameEntries = await readDirEntries(file, pspGame.lba, pspGame.size);

    // PARAM.SFO
    const sfoEntry = gameEntries.find(e => !e.isDirectory && e.name.toUpperCase() === "PARAM.SFO");
    if (sfoEntry) {
      const sfoData = await readIsoFilePartial(file, sfoEntry);
      const sfo = parseSfo(sfoData.buffer as ArrayBuffer);
      const info = extractGameInfo(sfo);
      result.title = info.title || fallbackTitle;
      result.discId = info.discId || "";
    }

    // ICON0.PNG
    const iconEntry = gameEntries.find(e => !e.isDirectory && e.name.toUpperCase() === "ICON0.PNG");
    if (iconEntry) {
      const iconData = await readIsoFilePartial(file, iconEntry);
      const blob = new Blob([iconData.slice()], { type: "image/png" });
      result.iconDataUrl = await blobToDataUrl(blob);
    }
  } catch {
    // Failed — return what we have
  }

  return result;
}

/**
 * Extract media files (ICON1.PMF, SND0.AT3) from an ISO via partial reads.
 * Returns raw Uint8Array data for each found file.
 */
export async function extractMediaFromFile(file: File): Promise<{ pmf: Uint8Array | null; at3: Uint8Array | null }> {
  try {
    const pvdBuf = await readSlice(file, PVD_SECTOR_NUM * SECTOR, SECTOR);
    if (new DataView(pvdBuf).getUint8(0) !== 1) return { pmf: null, at3: null };
    const ident = new TextDecoder("ascii").decode(new Uint8Array(pvdBuf, 1, 5));
    if (ident !== "CD001") return { pmf: null, at3: null };

    const rootEntry = parseDirRecord(pvdBuf, 156);
    if (!rootEntry) return { pmf: null, at3: null };

    const rootEntries = await readDirEntries(file, rootEntry.lba, rootEntry.size);
    const pspGame = rootEntries.find(e => e.isDirectory && e.name.toUpperCase() === "PSP_GAME");
    if (!pspGame) return { pmf: null, at3: null };

    const gameEntries = await readDirEntries(file, pspGame.lba, pspGame.size);

    const pmfEntry = gameEntries.find(e => !e.isDirectory && e.name.toUpperCase() === "ICON1.PMF");
    const at3Entry = gameEntries.find(e => !e.isDirectory && e.name.toUpperCase() === "SND0.AT3");

    const pmf = pmfEntry ? await readIsoFilePartial(file, pmfEntry) : null;
    const at3 = at3Entry ? await readIsoFilePartial(file, at3Entry) : null;

    return { pmf, at3 };
  } catch {
    return { pmf: null, at3: null };
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
