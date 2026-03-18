import type { MemoryBus } from "../memory/memory-bus.js";
import { Logger } from "../utils/logger.js";

const log = Logger.get("PGF");

export enum FontPixelFormat {
  PSP_FONT_PIXELFORMAT_4     = 0,
  PSP_FONT_PIXELFORMAT_4_REV = 1,
  PSP_FONT_PIXELFORMAT_8     = 2,
  PSP_FONT_PIXELFORMAT_24    = 3,
  PSP_FONT_PIXELFORMAT_32    = 4,
}

// Glyph flag bits (from PPSSPP PGF.h)
const FONT_PGF_BMP_H_ROWS             = 0x01;
const FONT_PGF_BMP_V_ROWS             = 0x02;
const FONT_PGF_BMP_OVERLAY            = 0x03;
const FONT_PGF_METRIC_DIMENSION_INDEX = 0x04;
const FONT_PGF_METRIC_BEARING_X_INDEX = 0x08;
const FONT_PGF_METRIC_BEARING_Y_INDEX = 0x10;
const FONT_PGF_METRIC_ADVANCE_INDEX   = 0x20;

export interface PGFHeader {
  revision: number;
  version: number;
  charMapLength: number;
  charPointerLength: number;
  charMapBpe: number;
  charPointerBpe: number;
  bpp: number;
  hSize: number;
  vSize: number;
  hResolution: number;
  vResolution: number;
  fontName: string;
  fontType: string;
  firstGlyph: number;
  lastGlyph: number;
  maxAscender: number;
  maxDescender: number;
  maxLeftXAdjust: number;
  maxBaseYAdjust: number;
  minCenterXAdjust: number;
  maxTopYAdjust: number;
  maxAdvanceH: number;
  maxAdvanceV: number;
  maxSizeH: number;
  maxSizeV: number;
  maxGlyphWidth: number;
  maxGlyphHeight: number;
  dimTableLength: number;
  xAdjustTableLength: number;
  yAdjustTableLength: number;
  advanceTableLength: number;
  shadowMapLength: number;
  shadowMapBpe: number;
}

export interface Glyph {
  w: number; h: number;
  left: number; top: number;
  advanceH: number; advanceV: number;
  dimensionWidth: number; dimensionHeight: number;
  xAdjustH: number; xAdjustV: number;
  yAdjustH: number; yAdjustV: number;
  shadowID: number;
  shadowFlags: number;
  flags: number;
  ptr: number; // byte offset of pixel bitstream in fontData
}

export class PGF {
  header!: PGFHeader;
  dimensionTable: number[][] = [[], []];
  xAdjustTable:   number[][] = [[], []];
  yAdjustTable:   number[][] = [[], []];
  advanceTable:   number[][] = [[], []];
  charMap:        number[] = [];
  charPointers:   number[] = [];
  glyphs:         (Glyph | null)[] = [];
  fontData:       Uint8Array | null = null;

  constructor(data?: ArrayBuffer) {
    if (data) this.decode(data);
  }

  decode(data: ArrayBuffer): boolean {
    const view = new DataView(data);
    const magic = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));
    if (magic !== "PGF0") {
      const offset = view.getUint32(0, true);
      if (offset < data.byteLength - 8) {
        const magic2 = String.fromCharCode(view.getUint8(offset+4), view.getUint8(offset+5), view.getUint8(offset+6), view.getUint8(offset+7));
        if (magic2 === "PGF0") return this.decodeAt(data, offset);
      }
      log.error(`Invalid PGF magic: ${magic}`);
      return false;
    }
    return this.decodeAt(data, 0);
  }

  private decodeAt(data: ArrayBuffer, base: number): boolean {
    const view = new DataView(data);

    // Exact offsets from PPSSPP PGF.h (struct PGFHeader)
    const h = base + 8; // magic is at +4, so struct members start at +8
    this.header = {
      revision:           view.getInt32(h + 0, true),
      version:            view.getInt32(h + 4, true),
      charMapLength:      view.getInt32(h + 8, true),
      charPointerLength:  view.getInt32(h + 12, true),
      charMapBpe:         view.getInt32(h + 16, true),
      charPointerBpe:     view.getInt32(h + 20, true),
      // pad1[2] at h+24
      bpp:                view.getUint8(h + 26),
      // pad2[1] at h+27
      hSize:              view.getInt32(h + 28, true),
      vSize:              view.getInt32(h + 32, true),
      hResolution:        view.getInt32(h + 36, true),
      vResolution:        view.getInt32(h + 40, true),
      // pad3[1] at h+44
      fontName:           this.readString(view, h + 45, 64),
      fontType:           this.readString(view, h + 109, 64),
      // pad4[1] at h+173
      firstGlyph:         view.getUint16(h + 174, true),
      lastGlyph:          view.getUint16(h + 176, true),
      // pad5[26] at h+178
      maxAscender:        view.getInt32(h + 204, true),
      maxDescender:       view.getInt32(h + 208, true),
      maxLeftXAdjust:     view.getInt32(h + 212, true),
      maxBaseYAdjust:     view.getInt32(h + 216, true),
      minCenterXAdjust:   view.getInt32(h + 220, true),
      maxTopYAdjust:      view.getInt32(h + 224, true),
      maxAdvanceH:        view.getInt32(h + 228, true),
      maxAdvanceV:        view.getInt32(h + 232, true),
      maxSizeH:           view.getInt32(h + 236, true),
      maxSizeV:           view.getInt32(h + 240, true),
      maxGlyphWidth:      view.getUint16(h + 244, true),
      maxGlyphHeight:     view.getUint16(h + 246, true),
      dimTableLength:     view.getUint8(h + 250),
      xAdjustTableLength: view.getUint8(h + 251),
      yAdjustTableLength: view.getUint8(h + 252),
      advanceTableLength: view.getUint8(h + 253),
      shadowMapLength:    view.getInt32(h + 356, true),
      shadowMapBpe:       view.getInt32(h + 360, true),
    };

    let ptr = h + 384; // sizeof(PGFHeader) = 392, minus 8 for headerOffset+headerSize+magic
    if (this.header.revision === 3) {
      ptr += 20; // rev3extra
    }

    ptr = this.readTable(view, ptr, this.header.dimTableLength, this.dimensionTable);
    ptr = this.readTable(view, ptr, this.header.xAdjustTableLength, this.xAdjustTable);
    ptr = this.readTable(view, ptr, this.header.yAdjustTableLength, this.yAdjustTable);
    ptr = this.readTable(view, ptr, this.header.advanceTableLength, this.advanceTable);

    const shadowMapSize = ((this.header.shadowMapLength * this.header.shadowMapBpe + 31) & ~31) / 8;
    ptr += shadowMapSize;

    const charMapData = new Uint8Array(data, ptr);
    this.charMap = this.readBitTable(charMapData, this.header.charMapBpe, this.header.charMapLength);
    // Clamp invalid charmap entries (like PPSSPP does)
    for (let i = 0; i < this.charMap.length; i++) {
      if (this.charMap[i]! >= this.header.charPointerLength) this.charMap[i] = 65535;
    }
    ptr += ((this.header.charMapLength * this.header.charMapBpe + 31) & ~31) / 8;

    const charPtrData = new Uint8Array(data, ptr);
    this.charPointers = this.readBitTable(charPtrData, this.header.charPointerBpe, this.header.charPointerLength);
    ptr += ((this.header.charPointerLength * this.header.charPointerBpe + 31) & ~31) / 8;

    this.fontData = new Uint8Array(data.slice(ptr));

    // Pre-parse all glyphs (as PPSSPP does during ReadPtr)
    this.glyphs = new Array(this.header.charPointerLength).fill(null);
    for (let i = 0; i < this.header.charPointerLength; i++) {
      this.glyphs[i] = this.readCharGlyph(this.charPointers[i]! * 4 * 8);
    }

    log.info(`PGF Loaded: "${this.header.fontName}" (${this.header.fontType})`);
    log.info(`  Glyphs: ${this.header.firstGlyph} to ${this.header.lastGlyph}, count=${this.header.charPointerLength}`);
    return true;
  }

  private readTable(view: DataView, ptr: number, length: number, out: number[][]): number {
    out[0] = []; out[1] = [];
    for (let i = 0; i < length; i++) {
      out[0].push(view.getInt32(ptr, true));
      ptr += 4;
      out[1].push(view.getInt32(ptr, true));
      ptr += 4;
    }
    return ptr;
  }

  private readString(view: DataView, offset: number, max: number): string {
    let s = "";
    for (let i = 0; i < max; i++) {
      const b = view.getUint8(offset + i);
      if (b === 0) break;
      s += String.fromCharCode(b);
    }
    return s;
  }

  private readBitTable(data: Uint8Array, bpe: number, length: number): number[] {
    const res: number[] = [];
    let bitPos = 0;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < length; i++) {
      res.push(this.getBits(view, bitPos, bpe));
      bitPos += bpe;
    }
    return res;
  }

  private getBits(view: DataView, pos: number, numBits: number): number {
    if (numBits === 0) return 0;
    const wordPos = (pos >>> 5) << 2;
    const bitOff  = pos & 31;
    if (wordPos + 4 > view.byteLength) return 0;
    let val = view.getUint32(wordPos, true) >>> bitOff;
    if (bitOff + numBits > 32) {
      const remaining = numBits - (32 - bitOff);
      const nextWord = (wordPos + 8 <= view.byteLength) ? view.getUint32(wordPos + 4, true) : 0;
      val |= (nextWord & ((1 << remaining) - 1)) << (32 - bitOff);
    }
    return (numBits < 32 ? val & ((1 << numBits) - 1) : val) >>> 0;
  }

  /** Read glyph metrics from the bitstream. charBitPtr = charPointers[i] * 4 * 8. */
  private readCharGlyph(charBitPtr: number): Glyph | null {
    if (!this.fontData) return null;
    const fd = this.fontData;
    const fdBits = fd.byteLength * 8;
    // Minimum 96 bits for fixed fields; worst-case with all inline metrics ~320 bits.
    // getBits itself is bounds-safe, so just guard against clearly invalid pointers.
    if (charBitPtr >= fdBits) return null;

    const view = new DataView(fd.buffer, fd.byteOffset, fd.byteLength);
    let pos = charBitPtr;

    const consume = (n: number): number => {
      const v = this.getBits(view, pos, n);
      pos += n;
      return v;
    };

    // Skip 14-bit size field
    pos += 14;

    const w    = consume(7);
    const h    = consume(7);
    let left   = consume(7); if (left  >= 64) left  -= 128;
    let top    = consume(7); if (top   >= 64) top   -= 128;
    const flags = consume(6);

    const sf0 = consume(2);
    const sf1 = consume(2);
    const sf2 = consume(3);
    const shadowFlags = (sf0 << (2 + 3)) | (sf1 << 3) | sf2;
    const shadowID = consume(9);

    const tbl = (t: number[][], row: number, idx: number): number => (t[row] as number[])[idx] ?? 0;

    let dimensionWidth = 0, dimensionHeight = 0;
    if (flags & FONT_PGF_METRIC_DIMENSION_INDEX) {
      const idx = consume(8);
      dimensionWidth  = tbl(this.dimensionTable, 0, idx);
      dimensionHeight = tbl(this.dimensionTable, 1, idx);
    } else {
      dimensionWidth  = consume(32);
      dimensionHeight = consume(32);
    }

    let xAdjustH = 0, xAdjustV = 0;
    if (flags & FONT_PGF_METRIC_BEARING_X_INDEX) {
      const idx = consume(8);
      xAdjustH = tbl(this.xAdjustTable, 0, idx);
      xAdjustV = tbl(this.xAdjustTable, 1, idx);
    } else {
      xAdjustH = consume(32);
      xAdjustV = consume(32);
    }

    let yAdjustH = 0, yAdjustV = 0;
    if (flags & FONT_PGF_METRIC_BEARING_Y_INDEX) {
      const idx = consume(8);
      yAdjustH = tbl(this.yAdjustTable, 0, idx);
      yAdjustV = tbl(this.yAdjustTable, 1, idx);
    } else {
      yAdjustH = consume(32);
      yAdjustV = consume(32);
    }

    let advanceH = 0, advanceV = 0;
    if (flags & FONT_PGF_METRIC_ADVANCE_INDEX) {
      const idx = consume(8);
      advanceH = tbl(this.advanceTable, 0, idx);
      advanceV = tbl(this.advanceTable, 1, idx);
    } else {
      advanceH = consume(32);
      advanceV = consume(32);
    }

    return {
      w, h, left, top,
      advanceH, advanceV,
      dimensionWidth, dimensionHeight,
      xAdjustH, xAdjustV,
      yAdjustH, yAdjustV,
      shadowID, shadowFlags, flags,
      ptr: Math.floor(pos / 8),
    };
  }

  getGlyph(charCode: number): Glyph | null {
    if (!this.header) return null;
    if (charCode < this.header.firstGlyph || charCode > this.header.lastGlyph) return null;
    const mapIdx = charCode - this.header.firstGlyph;
    const glyphIdx = this.charMap[mapIdx];
    if (glyphIdx === undefined || glyphIdx >= this.glyphs.length) return null;
    return this.glyphs[glyphIdx] ?? null;
  }

  /**
   * Draw a character into the GlyphImage buffer (PSP memory via bus).
   * GlyphImage struct layout (from PPSSPP sceFont.h):
   *   pixelFormat(4) xPos64(4) yPos64(4) bufWidth(2) bufHeight(2) bytesPerLine(2) pad(2) bufferPtr(4)
   */
  drawCharacter(bus: MemoryBus, glyphImagePtr: number, charCode: number, altCharCode: number): void {
    if (!glyphImagePtr || !this.fontData) return;

    let glyph = this.getGlyph(charCode);
    if (!glyph) {
      if (charCode < this.header.firstGlyph) return;
      glyph = this.getGlyph(altCharCode);
      if (!glyph) return;
    }

    if (glyph.w <= 0 || glyph.h <= 0) return;

    const bmpFlag = glyph.flags & FONT_PGF_BMP_OVERLAY;
    if (bmpFlag !== FONT_PGF_BMP_H_ROWS && bmpFlag !== FONT_PGF_BMP_V_ROWS) return;

    // Read GlyphImage struct
    const pixelFormat  = bus.readU32(glyphImagePtr + 0) as FontPixelFormat;
    const xPos64       = bus.readU32(glyphImagePtr + 4);
    const yPos64       = bus.readU32(glyphImagePtr + 8);
    const bufWidth     = bus.readU16(glyphImagePtr + 12);
    const bufHeight    = bus.readU16(glyphImagePtr + 14);
    const bytesPerLine = bus.readU16(glyphImagePtr + 16);
    const bufferPtr    = bus.readU32(glyphImagePtr + 20);
    if (!bufferPtr || bufWidth === 0 || bufHeight === 0) return;

    const x = xPos64 >> 6;
    const y = yPos64 >> 6;

    // Decode pixels with nibble RLE
    const fd = this.fontData;
    const fdView = new DataView(fd.buffer, fd.byteOffset, fd.byteLength);
    const numberPixels = glyph.w * glyph.h;
    const decodedPixels = new Uint8Array(numberPixels);

    let bitPtr = glyph.ptr * 8;
    let pixelIndex = 0;
    const fdBits = fd.byteLength * 8;

    while (pixelIndex < numberPixels && bitPtr + 8 < fdBits) {
      const nibble = this.getBits(fdView, bitPtr, 4); bitPtr += 4;
      let count: number, value = 0;
      if (nibble < 8) {
        value = this.getBits(fdView, bitPtr, 4); bitPtr += 4;
        count = nibble + 1;
      } else {
        count = 16 - nibble;
      }
      for (let i = 0; i < count && pixelIndex < numberPixels; i++) {
        if (nibble >= 8) {
          value = this.getBits(fdView, bitPtr, 4); bitPtr += 4;
        }
        decodedPixels[pixelIndex++] = value | (value << 4);
      }
    }

    // Write pixels to PSP memory
    const hRows = bmpFlag === FONT_PGF_BMP_H_ROWS;
    for (let yy = 0; yy < glyph.h; yy++) {
      for (let xx = 0; xx < glyph.w; xx++) {
        const idx = hRows ? (yy * glyph.w + xx) : (xx * glyph.h + yy);
        const pixelColor = decodedPixels[idx]!;
        this.setFontPixel(bus, bufferPtr, bytesPerLine, bufWidth, bufHeight, x + xx, y + yy, pixelColor, pixelFormat);
      }
    }
  }

  private setFontPixel(
    bus: MemoryBus,
    base: number, bpl: number, bufWidth: number, bufHeight: number,
    x: number, y: number, pixelColor: number, fmt: FontPixelFormat,
  ): void {
    if (x < 0 || x >= bufWidth || y < 0 || y >= bufHeight) return;

    // fontPixelSizeInBytes: 0=nibble(2/byte), 0, 1, 3, 4
    const pixelBytes = fmt <= 1 ? 0 : fmt === 2 ? 1 : fmt === 3 ? 3 : 4;
    const bufMaxWidth = pixelBytes === 0 ? bpl * 2 : Math.floor(bpl / pixelBytes);
    if (x >= bufMaxWidth) return;

    const addr = base + y * bpl + (pixelBytes === 0 ? Math.floor(x / 2) : x * pixelBytes);

    switch (fmt) {
      case FontPixelFormat.PSP_FONT_PIXELFORMAT_4:
      case FontPixelFormat.PSP_FONT_PIXELFORMAT_4_REV: {
        const pix4 = pixelColor >> 4;
        const old = bus.readU8(addr);
        const newColor = ((x & 1) !== (fmt as number))
          ? (pix4 << 4) | (old & 0xF)
          : (old & 0xF0) | pix4;
        bus.writeU8(addr, newColor);
        break;
      }
      case FontPixelFormat.PSP_FONT_PIXELFORMAT_8:
        bus.writeU8(addr, pixelColor);
        break;
      case FontPixelFormat.PSP_FONT_PIXELFORMAT_24:
        bus.writeU8(addr + 0, pixelColor);
        bus.writeU8(addr + 1, pixelColor);
        bus.writeU8(addr + 2, pixelColor);
        break;
      case FontPixelFormat.PSP_FONT_PIXELFORMAT_32: {
        const p = pixelColor | (pixelColor << 8) | (pixelColor << 16) | (pixelColor << 24);
        bus.writeU32(addr, p >>> 0);
        break;
      }
    }
  }
}
