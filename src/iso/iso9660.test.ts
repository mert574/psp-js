import { describe, it, expect } from "vitest";
import { parseIso } from "./iso9660.js";

const SECTOR_SIZE = 2048;

/**
 * Build a minimal synthetic ISO 9660 image in memory.
 *
 * Layout:
 *   Sector 16 (offset 32768): Primary Volume Descriptor (PVD)
 *   Sector 17 (offset 34816): Root directory sector containing one file entry "TEST.BIN"
 */
function buildMinimalIso(): ArrayBuffer {
  // We need at least 18 sectors (0-17)
  const numSectors = 18;
  const buf = new ArrayBuffer(numSectors * SECTOR_SIZE);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);

  // ---- PVD at sector 16 ----
  const pvdOff = 16 * SECTOR_SIZE;

  // type = 1
  bytes[pvdOff + 0] = 1;
  // identifier "CD001"
  bytes[pvdOff + 1] = 0x43; // C
  bytes[pvdOff + 2] = 0x44; // D
  bytes[pvdOff + 3] = 0x30; // 0
  bytes[pvdOff + 4] = 0x30; // 0
  bytes[pvdOff + 5] = 0x31; // 1
  // version = 1
  bytes[pvdOff + 6] = 1;

  // Volume identifier at offset 40, 32 bytes ASCII, space-padded
  const volId = "TEST_VOLUME";
  for (let i = 0; i < 32; i++) {
    bytes[pvdOff + 40 + i] = i < volId.length ? volId.charCodeAt(i) : 0x20;
  }

  // Root directory record at PVD offset 156 (length 34)
  const rootRecOff = pvdOff + 156;
  // record length = 34
  bytes[rootRecOff + 0] = 34;
  // extended attr length = 0
  bytes[rootRecOff + 1] = 0;
  // LBA LE (sector 17) at offset 2
  view.setUint32(rootRecOff + 2, 17, true);
  // LBA BE at offset 6
  view.setUint32(rootRecOff + 6, 17, false);

  // Directory data length: one entry for "TEST.BIN"
  // Entry size for "TEST.BIN" (8 chars): 33 + 8 = 41, padded to even = 42
  const dirDataLen = 42 + 34 + 34; // TEST.BIN + dot + dotdot entries
  view.setUint32(rootRecOff + 10, dirDataLen, true); // LE
  view.setUint32(rootRecOff + 14, dirDataLen, false); // BE

  // flags = 0x02 (directory)
  bytes[rootRecOff + 25] = 0x02;
  // volume sequence number both-byte-order at offset 28 (4 bytes)
  view.setUint16(rootRecOff + 28, 1, true);
  view.setUint16(rootRecOff + 30, 1, false);
  // identifier length = 1
  bytes[rootRecOff + 32] = 1;
  // identifier = 0x00 (dot entry)
  bytes[rootRecOff + 33] = 0x00;

  // ---- Directory sector at sector 17 ----
  const dirOff = 17 * SECTOR_SIZE;

  // Entry 0: "." (identifier 0x00, length 34)
  const dotOff = dirOff;
  bytes[dotOff + 0] = 34;
  bytes[dotOff + 1] = 0;
  view.setUint32(dotOff + 2, 17, true);
  view.setUint32(dotOff + 6, 17, false);
  view.setUint32(dotOff + 10, dirDataLen, true);
  view.setUint32(dotOff + 14, dirDataLen, false);
  bytes[dotOff + 25] = 0x02;
  view.setUint16(dotOff + 28, 1, true);
  view.setUint16(dotOff + 30, 1, false);
  bytes[dotOff + 32] = 1;
  bytes[dotOff + 33] = 0x00;

  // Entry 1: ".." (identifier 0x01, length 34)
  const dotdotOff = dirOff + 34;
  bytes[dotdotOff + 0] = 34;
  bytes[dotdotOff + 1] = 0;
  view.setUint32(dotdotOff + 2, 17, true);
  view.setUint32(dotdotOff + 6, 17, false);
  view.setUint32(dotdotOff + 10, dirDataLen, true);
  view.setUint32(dotdotOff + 14, dirDataLen, false);
  bytes[dotdotOff + 25] = 0x02;
  view.setUint16(dotdotOff + 28, 1, true);
  view.setUint16(dotdotOff + 30, 1, false);
  bytes[dotdotOff + 32] = 1;
  bytes[dotdotOff + 33] = 0x01;

  // Entry 2: "TEST.BIN;1" file entry
  // identifier = "TEST.BIN;1" (10 chars), record length = 33 + 10 = 43, padded to even = 44
  const fileEntryOff = dirOff + 34 + 34;
  const fileName = "TEST.BIN;1";
  const fileIdentLen = fileName.length;
  const fileRecordLen = 33 + fileIdentLen;
  const filePaddedLen = fileRecordLen % 2 === 0 ? fileRecordLen : fileRecordLen + 1;
  bytes[fileEntryOff + 0] = filePaddedLen;
  bytes[fileEntryOff + 1] = 0;
  // File data at sector 0 (doesn't matter for this test)
  view.setUint32(fileEntryOff + 2, 0, true);
  view.setUint32(fileEntryOff + 6, 0, false);
  // File size = 100 bytes
  view.setUint32(fileEntryOff + 10, 100, true);
  view.setUint32(fileEntryOff + 14, 100, false);
  // flags = 0x00 (file)
  bytes[fileEntryOff + 25] = 0x00;
  view.setUint16(fileEntryOff + 28, 1, true);
  view.setUint16(fileEntryOff + 30, 1, false);
  bytes[fileEntryOff + 32] = fileIdentLen;
  for (let i = 0; i < fileIdentLen; i++) {
    bytes[fileEntryOff + 33 + i] = fileName.charCodeAt(i);
  }

  return buf;
}

describe("parseIso", () => {
  it("parses volumeId correctly", () => {
    const buf = buildMinimalIso();
    const vol = parseIso(buf);
    expect(vol.volumeId).toBe("TEST_VOLUME");
  });

  it("root is a directory", () => {
    const buf = buildMinimalIso();
    const vol = parseIso(buf);
    expect(vol.root.isDirectory).toBe(true);
  });

  it("root.children contains TEST.BIN (stripped of version suffix)", () => {
    const buf = buildMinimalIso();
    const vol = parseIso(buf);
    const children = vol.root.children ?? [];
    const names = children.map((f) => f.name);
    expect(names).toContain("TEST.BIN");
  });

  it("TEST.BIN is not a directory", () => {
    const buf = buildMinimalIso();
    const vol = parseIso(buf);
    const testBin = (vol.root.children ?? []).find((f) => f.name === "TEST.BIN");
    expect(testBin).toBeDefined();
    expect(testBin!.isDirectory).toBe(false);
  });

  it("TEST.BIN has correct size", () => {
    const buf = buildMinimalIso();
    const vol = parseIso(buf);
    const testBin = (vol.root.children ?? []).find((f) => f.name === "TEST.BIN");
    expect(testBin!.size).toBe(100);
  });

  it("throws on invalid PVD type", () => {
    const buf = buildMinimalIso();
    const bytes = new Uint8Array(buf);
    bytes[16 * SECTOR_SIZE] = 0; // corrupt PVD type
    expect(() => parseIso(buf)).toThrow("Expected PVD type 1");
  });

  it("throws on invalid ISO identifier", () => {
    const buf = buildMinimalIso();
    const bytes = new Uint8Array(buf);
    bytes[16 * SECTOR_SIZE + 1] = 0x58; // corrupt "CD001" to "XD001"
    expect(() => parseIso(buf)).toThrow("Invalid ISO 9660 identifier");
  });
});
