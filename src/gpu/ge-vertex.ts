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

  // Component alignments (PPSSPP VertexDecoderCommon.cpp:41-45)
  const wtAlign  = [0, 1, 2, 4][weightFmt]!;
  const tcAlign  = [0, 1, 2, 4][texFmt]!;
  const colAlign = [0, 0, 0, 0, 2, 2, 2, 4][colorFmt]!;
  const nrmAlign = [0, 1, 2, 4][normFmt]!;
  const posAlign = [1, 1, 2, 4][posFmt]!;

  // Track the largest component alignment for final stride alignment
  let biggest = 0;
  let s = 0;

  if (weightFmt === 1) { s += weightCount; }
  else if (weightFmt === 2) { s = (s + 1) & ~1; s += weightCount * 2; }
  else if (weightFmt === 3) { s = (s + 3) & ~3; s += weightCount * 4; }
  if (wtAlign > biggest) biggest = wtAlign;

  if (texFmt === 1) s += 2;
  else if (texFmt === 2) { s = (s + 1) & ~1; s += 4; }
  else if (texFmt === 3) { s = (s + 3) & ~3; s += 8; }
  if (tcAlign > biggest) biggest = tcAlign;

  if (colorFmt >= 4 && colorFmt <= 6) { s = (s + 1) & ~1; s += 2; }
  else if (colorFmt === 7) { s = (s + 3) & ~3; s += 4; }
  if (colAlign > biggest) biggest = colAlign;

  if (normFmt === 1) s += 3;
  else if (normFmt === 2) { s = (s + 1) & ~1; s += 6; }
  else if (normFmt === 3) { s = (s + 3) & ~3; s += 12; }
  if (nrmAlign > biggest) biggest = nrmAlign;

  if (posFmt === 1) s += 3;
  else if (posFmt === 2) { s = (s + 1) & ~1; s += 6; }
  else if (posFmt === 3) { s = (s + 3) & ~3; s += 12; }
  if (posAlign > biggest) biggest = posAlign;

  // PPSSPP VertexDecoderCommon.cpp:1408: align final stride to largest component alignment
  if (biggest > 0) s = (s + biggest - 1) & ~(biggest - 1);
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

  // Always compute stride — PSP reads vertices at fixed stride offsets.
  // Field alignment within each vertex is relative to the vertex start (offset 0),
  // NOT to the absolute memory address. Using a running addr caused alignment drift
  // when stride wasn't a multiple of the largest alignment (e.g. stride=14 with u32 color).
  const vertexStride = computeVertexStride(vtype);

  for (let i = 0; i < count; i++) {
    // Compute vertex base address
    let vAddr: number;
    if (indexFmt === 1) { // u8 indices
      const idx = bus.readU8(indexAddr + i);
      vAddr = vertexAddr + idx * vertexStride;
    } else if (indexFmt === 2) { // u16 indices
      const idx = bus.readU16(indexAddr + i * 2);
      vAddr = vertexAddr + idx * vertexStride;
    } else {
      vAddr = vertexAddr + i * vertexStride;
    }
    // Track offset within vertex (0-based) for alignment, then read at vAddr + off.
    // PSP hardware aligns fields relative to vertex start, NOT absolute address.
    // Using absolute addr caused alignment drift when stride isn't a multiple of 4.
    let off = 0;
    const align2 = () => { off = (off + 1) & ~1; };
    const align4 = () => { off = (off + 3) & ~3; };

    const defaultColor = ((materialAlpha & 0xFF) * 0x1000000) | (materialAmbient & 0xFFFFFF);
    const v: Vertex = { x: 0, y: 0, z: 0, u: 0, v: 0, color: defaultColor, nx: 0, ny: 0, nz: 1, clipw: 1.0, fogCoef: 1.0 };

    // Read bone weights (appear before UV in PSP vertex layout)
    if (weightFmt === 1) {
      const ws: number[] = [];
      for (let wi = 0; wi < weightCount; wi++) ws.push(bus.readU8(vAddr + off++) / 128.0);
      v.weights = ws;
    } else if (weightFmt === 2) {
      align2();
      const ws: number[] = [];
      for (let wi = 0; wi < weightCount; wi++) { ws.push(bus.readU16(vAddr + off) / 32768.0); off += 2; }
      v.weights = ws;
    } else if (weightFmt === 3) {
      align4();
      const ws: number[] = [];
      for (let wi = 0; wi < weightCount; wi++) { ws.push(readFloat(bus, vAddr + off)); off += 4; }
      v.weights = ws;
    }

    // Texture coords
    const through = (vtypeRaw >>> 23) & 1;
    if (texFmt === 1) { // u8
      const raw_u = bus.readU8(vAddr + off); off++;
      const raw_v = bus.readU8(vAddr + off); off++;
      v.u = through ? raw_u : raw_u / 128.0;
      v.v = through ? raw_v : raw_v / 128.0;
    } else if (texFmt === 2) { // u16
      align2();
      const raw_u = bus.readU16(vAddr + off); off += 2;
      const raw_v = bus.readU16(vAddr + off); off += 2;
      v.u = through ? raw_u : raw_u / 32768.0;
      v.v = through ? raw_v : raw_v / 32768.0;
    } else if (texFmt === 3) { // float
      align4();
      v.u = readFloat(bus, vAddr + off); off += 4;
      v.v = readFloat(bus, vAddr + off); off += 4;
    }

    // Color
    if (colorFmt === 4) { // 16-bit 5650 (GE_VTYPE_COL_565 = 4)
      align2();
      v.color = color5650to8888(bus.readU16(vAddr + off)); off += 2;
    } else if (colorFmt === 5) { // 16-bit 5551 (GE_VTYPE_COL_5551 = 5)
      align2();
      v.color = color5551to8888(bus.readU16(vAddr + off)); off += 2;
    } else if (colorFmt === 6) { // 16-bit 4444
      align2();
      v.color = color4444to8888(bus.readU16(vAddr + off)); off += 2;
    } else if (colorFmt === 7) { // 32-bit 8888
      align4();
      v.color = bus.readU32(vAddr + off); off += 4;
    }

    // Normals
    if (normFmt === 1) { // s8
      v.nx = ((bus.readU8(vAddr + off) << 24) >> 24) / 127.0; off++;
      v.ny = ((bus.readU8(vAddr + off) << 24) >> 24) / 127.0; off++;
      v.nz = ((bus.readU8(vAddr + off) << 24) >> 24) / 127.0; off++;
    } else if (normFmt === 2) { // s16
      align2();
      v.nx = ((bus.readU16(vAddr + off) << 16) >> 16) / 32767.0; off += 2;
      v.ny = ((bus.readU16(vAddr + off) << 16) >> 16) / 32767.0; off += 2;
      v.nz = ((bus.readU16(vAddr + off) << 16) >> 16) / 32767.0; off += 2;
    } else if (normFmt === 3) { // float
      align4();
      v.nx = readFloat(bus, vAddr + off); off += 4;
      v.ny = readFloat(bus, vAddr + off); off += 4;
      v.nz = readFloat(bus, vAddr + off); off += 4;
    }

    // Position. Through-mode (raster) coords are NOT the same as transform-mode
    // model coords: PPSSPP Step_Pos*Through + ReadPosThrough keep x,y as signed
    // screen pixels but treat z as an UNSIGNED 0..65535 screen depth normalized
    // to [0,1]. We used to sign-extend z like a model coord, turning a far-plane
    // 0xFFFF into -1; the renderer's z*2-1 then sent it to clip-space -3 and the
    // whole quad got clipped away (black in WebGL, fine in software which ignores
    // through-mode z). Match PPSSPP so through z lands in [0,1] like transform z.
    if (posFmt === 1) { // s8
      if (through) {
        // PPSSPP Step_PosS8Through: 8-bit through positions always decode to 0.
        v.x = 0; v.y = 0; v.z = 0; off += 3;
      } else {
        // Transform mode: PPSSPP Step_PosS8 normalizes by 1/128 (the model/world
        // matrix carries the real scale). Reading raw makes s8 models 128x too big.
        v.x = ((bus.readU8(vAddr + off) << 24) >> 24) / 128.0; off++;
        v.y = ((bus.readU8(vAddr + off) << 24) >> 24) / 128.0; off++;
        v.z = ((bus.readU8(vAddr + off) << 24) >> 24) / 128.0; off++;
      }
    } else if (posFmt === 2) { // s16
      align2();
      if (through) {
        v.x = (bus.readU16(vAddr + off) << 16) >> 16; off += 2; // raw screen pixels
        v.y = (bus.readU16(vAddr + off) << 16) >> 16; off += 2;
        v.z = bus.readU16(vAddr + off) / 65535.0; off += 2; // unsigned u16 → [0,1]
      } else {
        // Transform mode: PPSSPP Step_PosS16 normalizes by 1/32768 (the model/world
        // matrix carries the real scale). Reading raw made s16 models 32768x too big,
        // e.g. Burnout/Ridge Racer cars (s16 verts + a ~600x world matrix) blew up into
        // screen-filling blobs that occluded the scene.
        v.x = ((bus.readU16(vAddr + off) << 16) >> 16) / 32768.0; off += 2;
        v.y = ((bus.readU16(vAddr + off) << 16) >> 16) / 32768.0; off += 2;
        v.z = ((bus.readU16(vAddr + off) << 16) >> 16) / 32768.0; off += 2;
      }
    } else if (posFmt === 3) { // float
      align4();
      v.x = readFloat(bus, vAddr + off); off += 4;
      v.y = readFloat(bus, vAddr + off); off += 4;
      const fz = readFloat(bus, vAddr + off); off += 4;
      // PPSSPP Step_PosFloatThrough clamps z to [0,65535]; ReadPosThrough → [0,1].
      v.z = through ? Math.max(0, Math.min(65535, fz)) / 65535.0 : fz;
    }

    vertices.push(v);
  }

  return { vertices, newVertexAddr: indexFmt === 0 ? vertexAddr + count * vertexStride : vertexAddr };
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
