import { describe, it, expect } from "vitest";
import { parseSfo, extractGameInfo } from "./sfo.js";

/**
 * Build a synthetic SFO buffer with a TITLE key and a DISC_ID key.
 *
 * SFO binary layout:
 *   0x00: magic "\x00PSF" (4 bytes)
 *   0x04: version 0x00000101 LE (4 bytes)
 *   0x08: keyTableOffset LE (4 bytes)
 *   0x0C: dataTableOffset LE (4 bytes)
 *   0x10: entryCount LE (4 bytes) = 2
 *   0x14: index table (2 entries x 16 bytes = 32 bytes)
 *   key table follows index table
 *   data table follows key table
 */
function buildSfoBuffer(entries: Array<{ key: string; value: string }>): ArrayBuffer {
  // Build key table bytes
  const keyStrings = entries.map((e) => e.key + "\x00");
  const keyTableBytes: number[] = [];
  const keyOffsets: number[] = [];
  for (const ks of keyStrings) {
    keyOffsets.push(keyTableBytes.length);
    for (let i = 0; i < ks.length; i++) {
      keyTableBytes.push(ks.charCodeAt(i));
    }
  }
  // Pad key table to 4-byte boundary
  while (keyTableBytes.length % 4 !== 0) keyTableBytes.push(0);

  // Build data table bytes (null-terminated UTF-8 strings, padded to 4-byte multiples)
  const dataStrings = entries.map((e) => e.value + "\x00");
  const dataTableBytes: number[] = [];
  const dataOffsets: number[] = [];
  const dataLengths: number[] = [];
  for (const ds of dataStrings) {
    dataOffsets.push(dataTableBytes.length);
    const len = ds.length;
    dataLengths.push(len);
    for (let i = 0; i < ds.length; i++) {
      dataTableBytes.push(ds.charCodeAt(i));
    }
    // Pad data entry to 4-byte boundary
    while (dataTableBytes.length % 4 !== 0) dataTableBytes.push(0);
  }

  const headerSize = 20; // 5 x uint32
  const indexTableSize = entries.length * 16;
  const keyTableOffset = headerSize + indexTableSize;
  const dataTableOffset = keyTableOffset + keyTableBytes.length;
  const totalSize = dataTableOffset + dataTableBytes.length;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // Magic: "\x00PSF" = 0x00, 0x50, 0x53, 0x46
  bytes[0] = 0x00;
  bytes[1] = 0x50; // P
  bytes[2] = 0x53; // S
  bytes[3] = 0x46; // F

  // Version
  view.setUint32(4, 0x00000101, true);
  // Key table offset
  view.setUint32(8, keyTableOffset, true);
  // Data table offset
  view.setUint32(12, dataTableOffset, true);
  // Entry count
  view.setUint32(16, entries.length, true);

  // Index table entries
  for (let i = 0; i < entries.length; i++) {
    const base = headerSize + i * 16;
    view.setUint16(base + 0, keyOffsets[i]!, true);  // key offset
    view.setUint16(base + 2, 0x0204, true);           // format: UTF-8 null-term
    view.setUint32(base + 4, dataLengths[i]!, true);  // data length
    view.setUint32(base + 8, dataLengths[i]!, true);  // data max length
    view.setUint32(base + 12, dataOffsets[i]!, true); // data offset
  }

  // Key table
  for (let i = 0; i < keyTableBytes.length; i++) {
    bytes[keyTableOffset + i] = keyTableBytes[i]!;
  }

  // Data table
  for (let i = 0; i < dataTableBytes.length; i++) {
    bytes[dataTableOffset + i] = dataTableBytes[i]!;
  }

  return buf;
}

describe("parseSfo", () => {
  it("parses a single TITLE entry", () => {
    const buf = buildSfoBuffer([{ key: "TITLE", value: "My Game" }]);
    const data = parseSfo(buf);
    expect(data["TITLE"]).toBe("My Game");
  });

  it("parses multiple entries", () => {
    const buf = buildSfoBuffer([
      { key: "TITLE", value: "My Game" },
      { key: "DISC_ID", value: "ULUS-12345" },
    ]);
    const data = parseSfo(buf);
    expect(data["TITLE"]).toBe("My Game");
    expect(data["DISC_ID"]).toBe("ULUS-12345");
  });

  it("throws on invalid magic", () => {
    const buf = buildSfoBuffer([{ key: "TITLE", value: "Test" }]);
    const bytes = new Uint8Array(buf);
    bytes[0] = 0xff; // corrupt magic
    expect(() => parseSfo(buf)).toThrow("Invalid SFO magic");
  });
});

describe("extractGameInfo", () => {
  it("extracts title and discId from SFO data", () => {
    const buf = buildSfoBuffer([
      { key: "TITLE", value: "My Awesome Game" },
      { key: "DISC_ID", value: "ULUS-12345" },
      { key: "CATEGORY", value: "UG" },
      { key: "APP_VER", value: "01.00" },
    ]);
    const data = parseSfo(buf);
    const info = extractGameInfo(data);
    expect(info.title).toBe("My Awesome Game");
    expect(info.discId).toBe("ULUS-12345");
    expect(info.category).toBe("UG");
    expect(info.version).toBe("01.00");
  });

  it("provides defaults for missing keys", () => {
    const buf = buildSfoBuffer([]);
    const data = parseSfo(buf);
    const info = extractGameInfo(data);
    expect(info.title).toBe("Unknown");
    expect(info.discId).toBe("");
  });
});
