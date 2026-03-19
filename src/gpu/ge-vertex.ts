import type { MemoryBus } from "../memory/memory-bus.js";
import { color5650to8888, color5551to8888, color4444to8888, readFloat } from "./ge-types.js";
import type { Vertex } from "./ge-types.js";

/**
 * Compute vertex stride from a raw vtype word.
 * This is the size in bytes of one vertex in memory.
 */
export function computeVertexStride(vtype: number): number {
  const weightFmt   = (vtype >>> 9)  & 3;
  const weightCount = weightFmt ? (((vtype >>> 14) & 7) + 1) : 0;
  const texFmt  = (vtype >>> 0) & 3;
  const colorFmt = (vtype >>> 2) & 7;
  const normFmt  = (vtype >>> 5)  & 3;
  const posFmt  = (vtype >>> 7) & 3;

  let s = 0;
  if (weightFmt === 1) s += weightCount;
  else if (weightFmt === 2) { s = (s + 1) & ~1; s += weightCount * 2; }
  else if (weightFmt === 3) { s = (s + 3) & ~3; s += weightCount * 4; }
  if (texFmt === 1) s += 2;
  else if (texFmt === 2) { s = (s + 1) & ~1; s += 4; }
  else if (texFmt === 3) { s = (s + 3) & ~3; s += 8; }
  if (colorFmt >= 4 && colorFmt <= 6) { s = (s + 1) & ~1; s += 2; }
  else if (colorFmt === 7) { s = (s + 3) & ~3; s += 4; }
  if (normFmt === 1) s += 3;
  else if (normFmt === 2) { s = (s + 1) & ~1; s += 6; }
  else if (normFmt === 3) { s = (s + 3) & ~3; s += 12; }
  if (posFmt === 1) s += 3;
  else if (posFmt === 2) { s = (s + 1) & ~1; s += 6; }
  else if (posFmt === 3) { s = (s + 3) & ~3; s += 12; }

  return s;
}

/** Read vertices from memory based on vertex format. Supports indexed drawing. */
export function readVertices(
  bus: MemoryBus,
  vertexAddr: number,
  indexAddr: number,
  vtypeRaw: number,
  materialAmbient: number,
  materialAlpha: number,
  count: number,
  texFmt: number,
  colorFmt: number,
  posFmt: number,
  indexFmt: number = 0,
): { vertices: Vertex[]; newVertexAddr: number } | null {
  if (posFmt === 0) return null;

  const vtype = vtypeRaw;
  const weightFmt   = (vtype >>> 9)  & 3;  // 0=none,1=u8,2=u16,3=float
  const weightCount = weightFmt ? (((vtype >>> 14) & 7) + 1) : 0;
  const normFmt     = (vtype >>> 5)  & 3;  // 0=none,1=s8,2=s16,3=float

  const vertices: Vertex[] = [];
  let addr = vertexAddr;

  // Calculate vertex stride for indexed access
  let vertexStride = 0;
  if (indexFmt !== 0) {
    vertexStride = computeVertexStride(vtype);
  }

  for (let i = 0; i < count; i++) {
    // For indexed drawing, read index and compute vertex address
    let vAddr: number;
    if (indexFmt === 1) { // u8 indices
      const idx = bus.readU8(indexAddr + i);
      vAddr = vertexAddr + idx * vertexStride;
    } else if (indexFmt === 2) { // u16 indices
      const idx = bus.readU16(indexAddr + i * 2);
      vAddr = vertexAddr + idx * vertexStride;
    } else {
      vAddr = addr;
    }
    addr = vAddr; // for non-indexed, addr advances below

    // Default vertex color: when no per-vertex color in vtype, use material ambient.
    // PSP hardware: getMaterialAmbientRGBA() = (materialambient & 0xFFFFFF) | (materialalpha << 24)
    const defaultColor = ((materialAlpha & 0xFF) * 0x1000000) | (materialAmbient & 0xFFFFFF);
    const v: Vertex = { x: 0, y: 0, z: 0, u: 0, v: 0, color: defaultColor, nx: 0, ny: 0, nz: 1, clipw: 1.0 };

    // Read bone weights (appear before UV in PSP vertex layout)
    if (weightFmt === 1) {
      const ws: number[] = [];
      for (let wi = 0; wi < weightCount; wi++) ws.push(bus.readU8(addr++) / 128.0);
      v.weights = ws;
    } else if (weightFmt === 2) {
      addr = (addr + 1) & ~1;
      const ws: number[] = [];
      for (let wi = 0; wi < weightCount; wi++) { ws.push(bus.readU16(addr) / 32768.0); addr += 2; }
      v.weights = ws;
    } else if (weightFmt === 3) {
      addr = (addr + 3) & ~3;
      const ws: number[] = [];
      for (let wi = 0; wi < weightCount; wi++) { ws.push(readFloat(bus, addr)); addr += 4; }
      v.weights = ws;
    }

    // Texture coords:
    // Through mode (bit 23 of vtype): UV is raw texel coordinates (no prescaling).
    // Transform mode: u8 -> /128, u16 -> /32768, float -> as-is (PPSSPP convention).
    // sampleTexture applies texScaleU/V and uses the result directly as texel coords.
    const through = (vtypeRaw >>> 23) & 1;
    if (texFmt === 1) { // u8
      const raw_u = bus.readU8(addr); addr++;
      const raw_v = bus.readU8(addr); addr++;
      v.u = through ? raw_u : raw_u / 128.0;
      v.v = through ? raw_v : raw_v / 128.0;
    } else if (texFmt === 2) { // u16
      addr = (addr + 1) & ~1; // align to 2
      const raw_u = bus.readU16(addr); addr += 2;
      const raw_v = bus.readU16(addr); addr += 2;
      v.u = through ? raw_u : raw_u / 32768.0;
      v.v = through ? raw_v : raw_v / 32768.0;
    } else if (texFmt === 3) { // float
      addr = (addr + 3) & ~3; // align to 4
      v.u = readFloat(bus, addr); addr += 4;
      v.v = readFloat(bus, addr); addr += 4;
    }

    // Color
    if (colorFmt === 4) { // 16-bit 5551
      addr = (addr + 1) & ~1;
      const c = bus.readU16(addr); addr += 2;
      v.color = color5551to8888(c);
    } else if (colorFmt === 5) { // 16-bit 5650
      addr = (addr + 1) & ~1;
      const c = bus.readU16(addr); addr += 2;
      v.color = color5650to8888(c);
    } else if (colorFmt === 6) { // 16-bit 4444
      addr = (addr + 1) & ~1;
      const c = bus.readU16(addr); addr += 2;
      v.color = color4444to8888(c);
    } else if (colorFmt === 7) { // 32-bit 8888
      addr = (addr + 3) & ~3;
      v.color = bus.readU32(addr); addr += 4;
    }

    // Read normals (between color and position in PSP vertex layout)
    // PPSSPP VertexDecoderCommon.h:162-185 ReadNrm:
    //   s8: / 127.0, s16: / 32767.0, float: as-is
    if (normFmt === 1) { // s8
      v.nx = ((bus.readU8(addr) << 24) >> 24) / 127.0; addr++;
      v.ny = ((bus.readU8(addr) << 24) >> 24) / 127.0; addr++;
      v.nz = ((bus.readU8(addr) << 24) >> 24) / 127.0; addr++;
    } else if (normFmt === 2) { // s16
      addr = (addr + 1) & ~1;
      v.nx = ((bus.readU16(addr) << 16) >> 16) / 32767.0; addr += 2;
      v.ny = ((bus.readU16(addr) << 16) >> 16) / 32767.0; addr += 2;
      v.nz = ((bus.readU16(addr) << 16) >> 16) / 32767.0; addr += 2;
    } else if (normFmt === 3) { // float
      addr = (addr + 3) & ~3;
      v.nx = readFloat(bus, addr); addr += 4;
      v.ny = readFloat(bus, addr); addr += 4;
      v.nz = readFloat(bus, addr); addr += 4;
    }

    // Position (through mode = screen coords)
    if (posFmt === 1) { // s8
      v.x = (bus.readU8(addr) << 24) >> 24; addr++;
      v.y = (bus.readU8(addr) << 24) >> 24; addr++;
      v.z = (bus.readU8(addr) << 24) >> 24; addr++;
    } else if (posFmt === 2) { // s16
      addr = (addr + 1) & ~1;
      v.x = (bus.readU16(addr) << 16) >> 16; addr += 2;
      v.y = (bus.readU16(addr) << 16) >> 16; addr += 2;
      v.z = (bus.readU16(addr) << 16) >> 16; addr += 2;
    } else if (posFmt === 3) { // float
      addr = (addr + 3) & ~3;
      v.x = readFloat(bus, addr); addr += 4;
      v.y = readFloat(bus, addr); addr += 4;
      v.z = readFloat(bus, addr); addr += 4;
    }

    vertices.push(v);
  }

  return { vertices, newVertexAddr: indexFmt === 0 ? addr : vertexAddr };
}

/**
 * Skip `count` vertices by advancing vertexAddr past them.
 * Used for BEZIER/SPLINE/BOUNDINGBOX where we parse the command but
 * don't tessellate/render — we still need to consume the vertex data
 * so subsequent commands see the correct vertex pointer.
 */
export function skipVertices(
  vtypeRaw: number,
  vertexAddr: number,
  indexAddr: number,
  count: number,
): { newVertexAddr: number; newIndexAddr: number } {
  const vtype = vtypeRaw;
  const indexFmt = (vtype >>> 11) & 3;

  // PPSSPP GPUCommon.h:306-313 AdvanceVerts:
  // For indexed mode, advance indexAddr by count * indexSize.
  // For non-indexed, advance vertexAddr by count * vertexStride.
  if (indexFmt !== 0) {
    // indexFmt: 1=u8(1 byte), 2=u16(2 bytes)
    const indexSize = indexFmt; // 1 or 2
    return { newVertexAddr: vertexAddr, newIndexAddr: indexAddr + count * indexSize };
  }

  const stride = computeVertexStride(vtype);
  return { newVertexAddr: vertexAddr + stride * count, newIndexAddr: indexAddr };
}
