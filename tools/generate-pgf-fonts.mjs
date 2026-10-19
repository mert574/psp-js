// SPDX-License-Identifier: MIT
// Original PGF writer for the emulator's documented binary font interface.
// Glyph outlines come only from the bundled OFL fonts, never from firmware PGFs.
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "public/flash0/font");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = [
  { family: "Sans", file: "Saira.ttf", notice: "OFL.txt" },
  { family: "Mono", file: "Inconsolata.ttf", notice: "Inconsolata-OFL.txt" },
].map(source => {
  const relative = `src/frontend/fonts/${source.file}`;
  const bytes = readFileSync(path.join(root, relative));
  return { ...source, relative, bytes, sha256: sha256(bytes) };
});

// A cmap lookup prevents browser fallback fonts from entering generated bitmaps.
function supportedCharacters(font) {
  let cmap = 0;
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const entry = 12 + i * 16;
    if (font.toString("ascii", entry, entry + 4) === "cmap") cmap = font.readUInt32BE(entry + 8);
  }
  if (!cmap) throw new Error("Source font has no cmap");
  const subtables = [];
  for (let i = 0; i < font.readUInt16BE(cmap + 2); i++) {
    const table = cmap + font.readUInt32BE(cmap + 8 + i * 8);
    if ([4, 12].includes(font.readUInt16BE(table))) subtables.push(table);
  }
  function glyph(code) {
    for (const table of subtables) {
      if (font.readUInt16BE(table) === 12) {
        for (let g = 0; g < font.readUInt32BE(table + 12); g++) {
          const group = table + 16 + g * 12;
          const first = font.readUInt32BE(group), last = font.readUInt32BE(group + 4);
          if (code >= first && code <= last) return font.readUInt32BE(group + 8) + code - first;
        }
      } else {
        const segments = font.readUInt16BE(table + 6) / 2;
        for (let s = 0; s < segments; s++) {
          const last = font.readUInt16BE(table + 14 + s * 2);
          const first = font.readUInt16BE(table + 16 + segments * 2 + s * 2);
          if (code < first || code > last) continue;
          const delta = font.readInt16BE(table + 16 + segments * 4 + s * 2);
          const rangeAt = table + 16 + segments * 6 + s * 2;
          const range = font.readUInt16BE(rangeAt);
          if (!range) return (code + delta) & 0xffff;
          const index = font.readUInt16BE(rangeAt + range + 2 * (code - first));
          return index ? (index + delta) & 0xffff : 0;
        }
      }
    }
    return 0;
  }
  const codes = [];
  for (let code = 32; code <= 0x2122; code++) {
    const candidate = code <= 0x024f || (code >= 0x2000 && code <= 0x206f) || [0x20ac, 0x2122].includes(code);
    if (candidate && !(code >= 0x7f && code <= 0x9f) && glyph(code)) codes.push(code);
  }
  return codes;
}

class Bits {
  bytes = [];
  length = 0;
  put(value, count) {
    for (let i = 0; i < count; i++, this.length++) {
      const byte = this.length >>> 3;
      this.bytes[byte] = (this.bytes[byte] || 0) | (((value >>> i) & 1) << (this.length & 7));
    }
  }
}

function encodeGlyph(glyph) {
  const bits = new Bits();
  bits.put(0, 14); // Patched with the aligned record length below.
  for (const value of [glyph.width, glyph.height, glyph.left, glyph.top]) bits.put(value, 7);
  bits.put(1, 6); // Horizontal rows, inline metrics.
  bits.put(0, 7); // Shadow flags.
  bits.put(0, 9); // Shadow id.
  for (const value of [glyph.width * 64, glyph.height * 64, glyph.left * 64, 0,
    glyph.top * 64, (glyph.top - glyph.height) * 64, glyph.advance, 0]) bits.put(value, 32);
  for (let index = 0; index < glyph.pixels.length;) {
    const value = glyph.pixels[index];
    let run = 1;
    while (run < 8 && index + run < glyph.pixels.length && glyph.pixels[index + run] === value) run++;
    bits.put(run - 1, 4);
    bits.put(value, 4);
    index += run;
  }
  // Word alignment also leaves a safe trailing word for the decoder's bit reads.
  const bytes = Buffer.alloc(Math.ceil(bits.bytes.length / 4) * 4 + 4);
  Buffer.from(bits.bytes).copy(bytes);
  if (bytes.length >= 0x4000) throw new Error("PGF glyph record exceeds size field");
  bytes.writeUInt16LE((bytes.readUInt16LE(0) & 0xc000) | bytes.length, 0);
  return bytes;
}

function encodeFont(glyphs, variant) {
  const header = Buffer.alloc(392);
  header.writeUInt16LE(392, 2);
  header.write("PGF0", 4, "ascii");
  const first = glyphs[0].code, last = glyphs.at(-1).code;
  const set = (offset, value) => header.writeInt32LE(value, 8 + offset);
  set(0, 2); set(4, 6);
  set(8, last - first + 1); set(12, glyphs.length);
  set(16, 16); set(20, 32);
  header[34] = 4;
  set(28, variant.size * 36); set(32, variant.size * 36);
  set(36, 128 * 64); set(40, 128 * 64);
  header.write(`PSP.js ${variant.family}`, 53, "ascii");
  header.write(variant.style, 117, "ascii");
  header.writeUInt16LE(first, 182); header.writeUInt16LE(last, 184);
  const maxWidth = Math.max(...glyphs.map(g => g.width));
  const maxHeight = Math.max(...glyphs.map(g => g.height));
  const ascender = Math.max(...glyphs.map(g => g.top));
  const descender = Math.min(...glyphs.map(g => g.top - g.height));
  for (const [offset, value] of [[204, ascender * 64], [208, descender * 64],
    [212, Math.min(...glyphs.map(g => g.left)) * 64], [216, descender * 64],
    [224, ascender * 64], [228, Math.max(...glyphs.map(g => g.advance))],
    [236, maxWidth * 64], [240, maxHeight * 64]]) set(offset, value);
  header.writeUInt16LE(maxWidth, 252); header.writeUInt16LE(maxHeight, 254);
  const charMap = Buffer.alloc(Math.ceil((last - first + 1) * 2 / 4) * 4, 0xff);
  const pointers = Buffer.alloc(glyphs.length * 4);
  const records = [];
  let bytes = 0;
  glyphs.forEach((glyph, index) => {
    charMap.writeUInt16LE(index, (glyph.code - first) * 2);
    pointers.writeUInt32LE(bytes / 4, index * 4);
    const record = encodeGlyph(glyph);
    records.push(record);
    bytes += record.length;
  });
  return Buffer.concat([header, charMap, pointers, ...records]);
}

const variants = Array.from({ length: 16 }, (_, slot) => {
  const small = slot >= 8;
  const style = small ? ["Regular", "Regular", "Regular", "Regular", "Bold", "Bold", "Italic", "Italic"][slot - 8]
    : ["Regular", "Regular", "Italic", "Italic", "Bold", "Bold", "Bold Italic", "Bold Italic"][slot];
  return { slot, size: small ? 13 : 18, family: slot % 2 ? "Mono" : "Sans", style };
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
const generated = [];
try {
  const page = await browser.newPage();
  for (const source of sources) {
    await page.evaluate(async ({ family, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const font = new FontFace(`PGFSource${family}`, bytes);
      await font.load();
      document.fonts.add(font);
    }, { family: source.family, base64: source.bytes.toString("base64") });
  }
  mkdirSync(directory, { recursive: true });
  for (const variant of variants) {
    const source = sources.find(s => s.family === variant.family);
    const glyphs = await page.evaluate(({ variant, codes }) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 96;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.font = `${variant.style.includes("Italic") ? "italic" : "normal"} ${variant.style.includes("Bold") ? "700" : "400"} ${variant.size}px PGFSource${variant.family}`;
      context.fillStyle = "white";
      const glyphs = [];
      for (const code of codes) {
        context.clearRect(0, 0, 96, 96);
        const text = String.fromCodePoint(code);
        context.fillText(text, 32, 48);
        const rgba = context.getImageData(0, 0, 96, 96).data;
        let x0 = 96, y0 = 96, x1 = -1, y1 = -1;
        for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
          if (Math.round(rgba[(y * 96 + x) * 4 + 3] / 17) > 0) {
            x0 = Math.min(x0, x); y0 = Math.min(y0, y);
            x1 = Math.max(x1, x); y1 = Math.max(y1, y);
          }
        }
        const pixels = [];
        const empty = x1 < 0;
        if (!empty) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          pixels.push(Math.round(rgba[(y * 96 + x) * 4 + 3] / 17));
        }
        glyphs.push({ code, width: empty ? 0 : x1 - x0 + 1, height: empty ? 0 : y1 - y0 + 1,
          left: empty ? 0 : x0 - 32, top: empty ? 0 : 48 - y0,
          advance: Math.round(context.measureText(text).width * 64), pixels });
      }
      return glyphs;
    }, { variant, codes: supportedCharacters(source.bytes) });
    const bytes = encodeFont(glyphs, variant);
    const file = `ltn${variant.slot}.pgf`;
    writeFileSync(path.join(directory, file), bytes);
    generated.push({ file, ...variant, glyphs: glyphs.length, source: source.relative,
      sourceSha256: source.sha256, sha256: sha256(bytes) });
  }
  for (const source of sources) {
    const notice = readFileSync(path.join(root, "src/frontend/fonts", source.notice), "utf8");
    writeFileSync(path.join(directory, `OFL-${source.family}.txt`), notice.replace(/[ \t]+(?=\r?$)/gm, ""));
  }
  const provenance = { generator: "tools/generate-pgf-fonts.mjs", renderer: browser.version(),
    license: "OFL-1.1", modifiedNames: ["PSP.js Sans", "PSP.js Mono"], fonts: generated };
  const provenanceBytes = Buffer.from(JSON.stringify(provenance, null, 2) + "\n");
  writeFileSync(path.join(directory, "provenance.json"), provenanceBytes);
  const manifestPath = path.join(root, "assets.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.assets = manifest.assets.filter(a => !a.path.startsWith("public/flash0/font/"));
  for (const font of generated) manifest.assets.push({ path: `public/flash0/font/${font.file}`,
    sha256: font.sha256, source: `${font.source} via tools/generate-pgf-fonts.mjs`, license: "OFL-1.1",
    notice: `public/flash0/font/OFL-${font.family}.txt` });
  manifest.assets.push({ path: "public/flash0/font/provenance.json", sha256: sha256(provenanceBytes),
    source: "Generated source and conversion record", license: "OFL-1.1", notice: "public/flash0/font/OFL-Sans.txt" });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Generated ${generated.length} OFL replacement fonts with provenance.`);
} finally {
  await browser.close();
}
