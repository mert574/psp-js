import { describe, expect, it } from "vitest";
import { readLocalFonts } from "./local-fonts.js";

function file(name: string, magicOffset = 4) {
  const bytes = new Uint8Array(24);
  if (magicOffset !== 4) new DataView(bytes.buffer).setUint32(0, magicOffset - 4, true);
  bytes.set([0x50, 0x47, 0x46, 0x30], magicOffset);
  return { name, arrayBuffer: async () => bytes.buffer };
}

describe("session-local font files", () => {
  it("maps standard and offset PGF headers to guest filesystem paths", async () => {
    const result = await readLocalFonts([file("LTN0.PGF"), file("ltn15.pgf", 12)]);
    expect([...result.keys()]).toEqual(["flash0:/font/ltn0.pgf", "flash0:/font/ltn15.pgf"]);
  });

  it("rejects unexpected names and malformed or truncated data", async () => {
    await expect(readLocalFonts([file("../ltn0.pgf")])).rejects.toThrow("named");
    await expect(readLocalFonts([{ name: "ltn0.pgf", arrayBuffer: async () => new ArrayBuffer(2) }]))
      .rejects.toThrow("not a PGF");
    const invalid = new Uint8Array(16).fill(0xff);
    await expect(readLocalFonts([{ name: "ltn0.pgf", arrayBuffer: async () => invalid.buffer }]))
      .rejects.toThrow("not a PGF");
  });
});
