import type { MemoryBus } from "../memory/memory-bus.js";
import { color5650to8888, color5551to8888, color4444to8888 } from "./ge-types.js";

export interface GETextureState {
  texAddr0: number;
  texBufWidth0: number;
  texWidth0: number;
  texHeight0: number;
  texFormat: number;
  texSwizzle: boolean;
  texWrapU: number;
  texWrapV: number;
  texMinFilter: number;
  texMagFilter: number;
  texMapMode: number;
  texScaleU: number;
  texScaleV: number;
  texOffsetU: number;
  texOffsetV: number;
  vtypeRaw: number;
  clutAddr: number;
  clutFormat: number;
  clutShift: number;
  clutMask: number;
  clutStart: number;
}

/**
 * Check if bilinear filtering is active.
 * PPSSPP: mag filter = (texfilter >> 8) & 1; min filter bit 0 = linear.
 * Simplified: use linear if mag filter is 1, or min filter has bit 0 set.
 */
export function useLinearFilter(state: GETextureState): boolean {
  return state.texMagFilter === 1 || (state.texMinFilter & 1) !== 0;
}

/** Wrap a texel coordinate according to current wrap mode. */
export function wrapTexCoord(coord: number, size: number, wrapMode: number): number {
  if (wrapMode === 1) { // clamp
    return Math.max(0, Math.min(coord, size - 1));
  }
  // repeat
  return ((coord % size) + size) % size;
}

/** Sample a texel from the level-0 texture. Returns ABGR8888.
 *  Formats 0-3 = direct color (5650/5551/4444/8888)
 *  Formats 4-7 = indexed (CLUT) T4/T8/T16/T32
 *  Formats 8-10 = DXT compressed (DXT1/DXT3/DXT5)
 */
export function sampleTexture(state: GETextureState, bus: MemoryBus, u: number, v: number): number {
  const tw = state.texWidth0 || 1;
  const th = state.texHeight0 || 1;

  // In through mode: UV is raw texel coordinates — do NOT apply the texture matrix.
  // In transform mode: UV is prescaled (u8/128, u16/32768) and games set texScaleU
  // to bring it back to texel space; texOffsetU shifts to the correct sprite sheet region.
  const throughMode = (state.vtypeRaw >>> 23) & 1;
  let rawU: number, rawV: number;
  if (throughMode) {
    rawU = u;
    rawV = v;
  } else if (state.texMapMode === 1) {
    // TEXTURE_MATRIX mode: UVs already transformed by tgenMatrix, no scale/offset
    // PPSSPP TransformUnit.cpp:447 "Note that UV scale/offset are not used in this mode."
    rawU = u * tw;
    rawV = v * th;
  } else {
    rawU = u * state.texScaleU + state.texOffsetU;
    rawV = v * state.texScaleV + state.texOffsetV;
  }

  // Bilinear filtering: interpolate 2x2 neighborhood
  if (useLinearFilter(state)) {
    // Sample centered at (rawU - 0.5, rawV - 0.5) to match hardware behavior
    const fu = rawU - 0.5;
    const fv = rawV - 0.5;
    const u0 = Math.floor(fu);
    const v0 = Math.floor(fv);
    const fracU = fu - u0;
    const fracV = fv - v0;

    const tu00 = wrapTexCoord(u0, tw, state.texWrapU);
    const tu10 = wrapTexCoord(u0 + 1, tw, state.texWrapU);
    const tv00 = wrapTexCoord(v0, th, state.texWrapV);
    const tv01 = wrapTexCoord(v0 + 1, th, state.texWrapV);

    const c00 = sampleTexelNearest(state, bus, tu00, tv00);
    const c10 = sampleTexelNearest(state, bus, tu10, tv00);
    const c01 = sampleTexelNearest(state, bus, tu00, tv01);
    const c11 = sampleTexelNearest(state, bus, tu10, tv01);

    return bilinearBlend(c00, c10, c01, c11, fracU, fracV);
  }

  // Nearest-neighbor: floor + wrap
  const fuU = Math.floor(rawU + 1e-4);
  const fuV = Math.floor(rawV + 1e-4);
  const tu = wrapTexCoord(fuU, tw, state.texWrapU);
  const tv = wrapTexCoord(fuV, th, state.texWrapV);

  const bw = state.texBufWidth0 || tw;
  const fmt = state.texFormat;
  const addr = state.texAddr0;

  // Handle swizzled textures (formats 0-3: direct color; 4/5: CLUT indexed)
  if (state.texSwizzle) {
    if (fmt <= 3) return sampleSwizzled(bus, tu, tv, bw, fmt, addr);
    if (fmt === 4) { // T4 swizzled
      const byteCol = tu >> 1;
      const rowBytes = bw >> 1;
      const blockX = byteCol >> 4;
      const blockY = tv >> 3;
      const blocksPerRow = rowBytes >> 4;
      const byteOff = (blockY * blocksPerRow + blockX) * 128 + (tv & 7) * 16 + (byteCol & 0xF);
      const b = bus.readU8(addr + byteOff);
      return lookupCLUT(state, bus, (tu & 1) ? (b >> 4) : (b & 0xF));
    }
    if (fmt === 5) { // T8 swizzled
      const blockX = tu >> 4;
      const blockY = tv >> 3;
      const blocksPerRow = bw >> 4;
      const byteOff = (blockY * blocksPerRow + blockX) * 128 + (tv & 7) * 16 + (tu & 0xF);
      return lookupCLUT(state, bus, bus.readU8(addr + byteOff));
    }
  }

  switch (fmt) {
    case 0: { // BGR5650
      const off = (tv * bw + tu) * 2;
      return color5650to8888(bus.readU16(addr + off));
    }
    case 1: { // ABGR5551
      const off = (tv * bw + tu) * 2;
      return color5551to8888(bus.readU16(addr + off));
    }
    case 2: { // ABGR4444
      const off = (tv * bw + tu) * 2;
      return color4444to8888(bus.readU16(addr + off));
    }
    case 3: { // ABGR8888
      const off = (tv * bw + tu) * 4;
      return bus.readU32(addr + off);
    }
    case 4: { // T4 — 4-bit indexed (CLUT)
      const byteOff = tv * (bw >> 1) + (tu >> 1);
      const nibble = (tu & 1) ? (bus.readU8(addr + byteOff) >> 4) : (bus.readU8(addr + byteOff) & 0xF);
      return lookupCLUT(state, bus, nibble);
    }
    case 5: { // T8 — 8-bit indexed (CLUT)
      const idx = bus.readU8(addr + tv * bw + tu);
      return lookupCLUT(state, bus, idx);
    }
    case 6: { // T16 — 16-bit indexed (CLUT)
      const idx = bus.readU16(addr + (tv * bw + tu) * 2);
      return lookupCLUT(state, bus, idx);
    }
    case 7: { // T32 — 32-bit indexed (CLUT)
      const idx = bus.readU32(addr + (tv * bw + tu) * 4);
      return lookupCLUT(state, bus, idx & 0xFF); // CLUT max 256 entries
    }
    case 8: // DXT1
      return sampleDXT1(bus, tu, tv, bw, addr);
    case 9: // DXT3
      return sampleDXT3(bus, tu, tv, bw, addr);
    case 10: // DXT5
      return sampleDXT5(bus, tu, tv, bw, addr);
    default:
      return 0xFFFFFFFF;
  }
}

/** Sample a single texel at integer coordinates (already wrapped). Used by bilinear filter. */
export function sampleTexelNearest(state: GETextureState, bus: MemoryBus, tu: number, tv: number): number {
  const bw = state.texBufWidth0 || state.texWidth0 || 1;
  const fmt = state.texFormat;
  const addr = state.texAddr0;

  // Swizzled textures
  if (state.texSwizzle) {
    if (fmt <= 3) return sampleSwizzled(bus, tu, tv, bw, fmt, addr);
    if (fmt === 4) {
      const byteCol = tu >> 1;
      const rowBytes = bw >> 1;
      const blockX = byteCol >> 4;
      const blockY = tv >> 3;
      const blocksPerRow = rowBytes >> 4;
      const byteOff = (blockY * blocksPerRow + blockX) * 128 + (tv & 7) * 16 + (byteCol & 0xF);
      const b = bus.readU8(addr + byteOff);
      return lookupCLUT(state, bus, (tu & 1) ? (b >> 4) : (b & 0xF));
    }
    if (fmt === 5) {
      const blockX = tu >> 4;
      const blockY = tv >> 3;
      const blocksPerRow = bw >> 4;
      const byteOff = (blockY * blocksPerRow + blockX) * 128 + (tv & 7) * 16 + (tu & 0xF);
      return lookupCLUT(state, bus, bus.readU8(addr + byteOff));
    }
  }

  switch (fmt) {
    case 0: return color5650to8888(bus.readU16(addr + (tv * bw + tu) * 2));
    case 1: return color5551to8888(bus.readU16(addr + (tv * bw + tu) * 2));
    case 2: return color4444to8888(bus.readU16(addr + (tv * bw + tu) * 2));
    case 3: return bus.readU32(addr + (tv * bw + tu) * 4);
    case 4: {
      const byteOff = tv * (bw >> 1) + (tu >> 1);
      const nibble = (tu & 1) ? (bus.readU8(addr + byteOff) >> 4) : (bus.readU8(addr + byteOff) & 0xF);
      return lookupCLUT(state, bus, nibble);
    }
    case 5: return lookupCLUT(state, bus, bus.readU8(addr + tv * bw + tu));
    case 6: return lookupCLUT(state, bus, bus.readU16(addr + (tv * bw + tu) * 2));
    case 7: return lookupCLUT(state, bus, bus.readU32(addr + (tv * bw + tu) * 4) & 0xFF);
    case 8: return sampleDXT1(bus, tu, tv, bw, addr);
    case 9: return sampleDXT3(bus, tu, tv, bw, addr);
    case 10: return sampleDXT5(bus, tu, tv, bw, addr);
    default: return 0xFFFFFFFF;
  }
}

/** Bilinear blend of 4 ABGR8888 texels with fractional weights. */
export function bilinearBlend(c00: number, c10: number, c01: number, c11: number, fu: number, fv: number): number {
  const iu = (fu * 256) | 0;
  const iv = (fv * 256) | 0;
  const niu = 256 - iu;
  const niv = 256 - iv;

  const w00 = niu * niv;
  const w10 = iu * niv;
  const w01 = niu * iv;
  const w11 = iu * iv;

  const r = ((c00 & 0xFF) * w00 + (c10 & 0xFF) * w10 + (c01 & 0xFF) * w01 + (c11 & 0xFF) * w11) >> 16;
  const g = (((c00 >>> 8) & 0xFF) * w00 + ((c10 >>> 8) & 0xFF) * w10 + ((c01 >>> 8) & 0xFF) * w01 + ((c11 >>> 8) & 0xFF) * w11) >> 16;
  const b = (((c00 >>> 16) & 0xFF) * w00 + ((c10 >>> 16) & 0xFF) * w10 + ((c01 >>> 16) & 0xFF) * w01 + ((c11 >>> 16) & 0xFF) * w11) >> 16;
  const a = (((c00 >>> 24) & 0xFF) * w00 + ((c10 >>> 24) & 0xFF) * w10 + ((c01 >>> 24) & 0xFF) * w01 + ((c11 >>> 24) & 0xFF) * w11) >> 16;

  return (r & 0xFF) | ((g & 0xFF) << 8) | ((b & 0xFF) << 16) | ((a & 0xFF) << 24);
}

/** Sample a texel from a swizzled texture (formats 0-3). */
export function sampleSwizzled(bus: MemoryBus, u: number, v: number, bw: number, fmt: number, addr: number): number {
  const bpp = (fmt === 3) ? 4 : 2;
  const rowBytes = bw * bpp;
  // PSP swizzle: 16-byte-wide by 8-row blocks
  const blockX = (u * bpp) >> 4;        // which 16-byte column block
  const blockY = v >> 3;                 // which 8-row block
  const blocksPerRow = rowBytes >> 4;    // 16-byte blocks per texture row
  const blockIdx = blockY * blocksPerRow + blockX;
  const inBlockX = (u * bpp) & 0xF;     // byte offset within 16-byte block
  const inBlockY = v & 7;               // row within 8-row block

  const byteOff = blockIdx * 128 + inBlockY * 16 + inBlockX;

  if (fmt === 3) {
    return bus.readU32(addr + byteOff);
  } else {
    const px = bus.readU16(addr + byteOff);
    switch (fmt) {
      case 0: return color5650to8888(px);
      case 1: return color5551to8888(px);
      case 2: return color4444to8888(px);
      default: return 0xFFFFFFFF;
    }
  }
}

/** Lookup a color in the CLUT. PPSSPP GPUState.h:319-323 transformClutIndex */
export function lookupCLUT(state: GETextureState, bus: MemoryBus, index: number): number {
  // Wrap mask: 1024 bytes / bytesPerEntry → max entries
  // 32-bit (format 3): 1024/4 = 256 → mask 0xFF
  // 16-bit (format 0-2): 1024/2 = 512 → mask 0x1FF
  const wrapMask = state.clutFormat === 3 ? 0xFF : 0x1FF;
  const idx = (((index >> state.clutShift) & state.clutMask) | (state.clutStart & wrapMask)) & wrapMask;
  const base = state.clutAddr;
  switch (state.clutFormat) {
    case 0: return color5650to8888(bus.readU16(base + idx * 2));
    case 1: return color5551to8888(bus.readU16(base + idx * 2));
    case 2: return color4444to8888(bus.readU16(base + idx * 2));
    case 3: return bus.readU32(base + idx * 4);
    default: return 0xFFFFFFFF;
  }
}

// ── DXT compressed texture support ───────────────────────────────────────

/** Sample DXT1 compressed texture. */
export function sampleDXT1(bus: MemoryBus, u: number, v: number, bw: number, addr: number): number {
  const blockX = u >> 2, blockY = v >> 2;
  const blocksPerRow = (bw + 3) >> 2;
  const blockAddr = addr + (blockY * blocksPerRow + blockX) * 8;

  const c0raw = bus.readU16(blockAddr);
  const c1raw = bus.readU16(blockAddr + 2);
  const bits = bus.readU32(blockAddr + 4);

  const c0 = color5650to8888(c0raw);
  const c1 = color5650to8888(c1raw);

  const px = u & 3, py = v & 3;
  const code = (bits >> ((py * 4 + px) * 2)) & 3;

  const r0 = c0 & 0xFF, g0 = (c0 >> 8) & 0xFF, b0 = (c0 >> 16) & 0xFF;
  const r1 = c1 & 0xFF, g1 = (c1 >> 8) & 0xFF, b1 = (c1 >> 16) & 0xFF;

  let r: number, g: number, b: number, a = 255;
  if (code === 0) { r = r0; g = g0; b = b0; }
  else if (code === 1) { r = r1; g = g1; b = b1; }
  else if (c0raw > c1raw) {
    if (code === 2) { r = (2*r0+r1)/3|0; g = (2*g0+g1)/3|0; b = (2*b0+b1)/3|0; }
    else { r = (r0+2*r1)/3|0; g = (g0+2*g1)/3|0; b = (b0+2*b1)/3|0; }
  } else {
    if (code === 2) { r = (r0+r1)/2|0; g = (g0+g1)/2|0; b = (b0+b1)/2|0; }
    else { r = 0; g = 0; b = 0; a = 0; } // transparent
  }

  return (a << 24) | (b << 16) | (g << 8) | r;
}

/** Sample DXT3 compressed texture (explicit alpha). */
export function sampleDXT3(bus: MemoryBus, u: number, v: number, bw: number, addr: number): number {
  const blockX = u >> 2, blockY = v >> 2;
  const blocksPerRow = (bw + 3) >> 2;
  const blockAddr = addr + (blockY * blocksPerRow + blockX) * 16;

  // Alpha: 8 bytes of 4-bit alpha per pixel
  const px = u & 3, py = v & 3;
  const alphaWord = bus.readU16(blockAddr + py * 2);
  const alpha = ((alphaWord >> (px * 4)) & 0xF) * 17; // expand 4-bit to 8-bit

  // Color: same as DXT1 at offset +8
  const color = sampleDXT1(bus, u, v, bw, addr + 8);
  return (color & 0x00FFFFFF) | (alpha << 24);
}

/** Sample DXT5 compressed texture (interpolated alpha). */
export function sampleDXT5(bus: MemoryBus, u: number, v: number, bw: number, addr: number): number {
  const blockX = u >> 2, blockY = v >> 2;
  const blocksPerRow = (bw + 3) >> 2;
  const blockAddr = addr + (blockY * blocksPerRow + blockX) * 16;

  const a0 = bus.readU8(blockAddr);
  const a1 = bus.readU8(blockAddr + 1);

  // 6 bytes of 3-bit alpha indices
  const px = u & 3, py = v & 3;
  const bitIdx = (py * 4 + px) * 3;
  const byteOff = blockAddr + 2 + (bitIdx >> 3);
  const bitShift = bitIdx & 7;
  const rawBits = bus.readU8(byteOff) | (bus.readU8(byteOff + 1) << 8);
  const code = (rawBits >> bitShift) & 7;

  let alpha: number;
  if (code === 0) alpha = a0;
  else if (code === 1) alpha = a1;
  else if (a0 > a1) alpha = ((8 - code) * a0 + (code - 1) * a1) / 7 | 0;
  else if (code <= 5) alpha = ((6 - code) * a0 + (code - 1) * a1) / 5 | 0;
  else alpha = code === 6 ? 0 : 255;

  // Color: DXT1 at offset +8 (but always 4-color mode)
  const c0raw = bus.readU16(blockAddr + 8);
  const c1raw = bus.readU16(blockAddr + 10);
  const bits = bus.readU32(blockAddr + 12);
  const c0 = color5650to8888(c0raw);
  const c1 = color5650to8888(c1raw);
  const colorCode = (bits >> ((py * 4 + px) * 2)) & 3;

  const r0 = c0 & 0xFF, g0 = (c0>>8)&0xFF, b0 = (c0>>16)&0xFF;
  const r1 = c1 & 0xFF, g1 = (c1>>8)&0xFF, b1 = (c1>>16)&0xFF;

  let r: number, g: number, b: number;
  if (colorCode === 0) { r = r0; g = g0; b = b0; }
  else if (colorCode === 1) { r = r1; g = g1; b = b1; }
  else if (colorCode === 2) { r = (2*r0+r1)/3|0; g = (2*g0+g1)/3|0; b = (2*b0+b1)/3|0; }
  else { r = (r0+2*r1)/3|0; g = (g0+2*g1)/3|0; b = (b0+2*b1)/3|0; }

  return (alpha << 24) | (b << 16) | (g << 8) | r;
}
