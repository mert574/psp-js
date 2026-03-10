import { GE_CMD } from "./ge-commands.js";
import type { MemoryBus } from "../memory/memory-bus.js";
import { Logger } from "../utils/logger.js";

const log = Logger.get("GE");

const MAX_COMMANDS = 1_000_000;
const CALL_STACK_DEPTH = 8;

/**
 * Minimal PSP Graphics Engine command list processor.
 *
 * Processes GE display lists submitted via sceGeListEnQueue.
 * Supports: clear, block transfer, basic PRIM sprite rendering,
 * jump/call/ret, and framebuffer setup.
 */
export class GEProcessor {
  private bus: MemoryBus;

  // GE state registers
  private baseAddr = 0;
  private offsetAddr = 0;

  // Framebuffer state (draw target)
  private fbPtr = 0;
  private fbWidth = 512;
  private fbFormat = 3; // pixel format (0-3)

  // Vertex state
  private vtypeRaw = 0;
  private vertexAddr = 0;

  // Clear color
  private clearColorRgb = 0;
  private clearColorA = 0;
  private clearMode = false;

  // Texture state
  private texAddr0 = 0;
  private texBufWidth0 = 0;
  private texWidth0 = 0;
  private texHeight0 = 0;
  private texFormat = 0;
  private texEnable = false;

  // Block transfer registers
  private trSrc = 0;
  private trSrcW = 0;
  private trDst = 0;
  private trDstW = 0;
  private trSrcPos = 0;
  private trDstPos = 0;
  private trSize = 0;

  // Call stack for CALL/RET
  private callStack: number[] = [];

  constructor(bus: MemoryBus) {
    this.bus = bus;
  }

  // Debug: track unique opcodes across all lists
  private _dbgListCount = 0;
  private _dbgOpcodes = new Set<number>();
  private _dbgPrimCount = 0;
  private _dbgClearCount = 0;
  private _dbgSkipCount = 0;

  /** Process a GE command list starting at listAddr. Returns the PC where execution stopped. */
  executeList(listAddr: number, stallAddr: number): number {
    this._dbgListCount++;
    this._dbgPrimCount = 0;
    this._dbgClearCount = 0;
    this._dbgSkipCount = 0;
    this._dbgOpcodes.clear();
    const traceThis = this._dbgListCount === 1;
    let pc = listAddr;
    let count = 0;

    while (count < MAX_COMMANDS) {
      if (stallAddr !== 0 && pc === stallAddr) break;

      const cmd = this.bus.readU32(pc);
      const opcode = cmd >>> 24;
      const param = cmd & 0x00FFFFFF;
      this._dbgOpcodes.add(opcode);
      if (traceThis && (opcode === GE_CMD.JUMP || opcode === GE_CMD.CALL || opcode === GE_CMD.RET || opcode === GE_CMD.PRIM || opcode === GE_CMD.CLEAR || opcode === GE_CMD.FINISH || opcode === GE_CMD.END || opcode === GE_CMD.SIGNAL)) {
        log.info(`TRACE @0x${pc.toString(16)} op=0x${opcode.toString(16)} param=0x${param.toString(16)}`);
      }

      switch (opcode) {
        case GE_CMD.NOP:
          break;

        case GE_CMD.BASE:
          this.baseAddr = (param << 8) & 0xFF000000;
          break;

        case GE_CMD.OFFSET_ADDR:
          this.offsetAddr = param << 8;
          break;

        case GE_CMD.ORIGIN_ADDR:
          this.offsetAddr = pc;
          break;

        case GE_CMD.FRAMEBUFPTR:
          this.fbPtr = (this.fbPtr & 0xFF000000) | param;
          break;

        case GE_CMD.FRAMEBUFWIDTH:
          this.fbPtr = (this.fbPtr & 0x00FFFFFF) | ((param & 0xFF0000) << 8);
          this.fbWidth = param & 0x07FF;
          break;

        case GE_CMD.FRAMEBUFPIXFMT:
          this.fbFormat = param & 3;
          break;

        // Vertex type
        case GE_CMD.VTYPE:
          this.vtypeRaw = param;
          break;

        // Vertex address
        case GE_CMD.VADDR:
          this.vertexAddr = (this.baseAddr | param);
          break;

        // Draw primitives
        case GE_CMD.PRIM:
          this._dbgPrimCount++;
          if (this._dbgListCount <= 5) {
            const pt = (param >>> 16) & 7;
            const vc = param & 0xFFFF;
            const vt = this.vtypeRaw;
            log.info(`PRIM type=${pt} count=${vc} vtype=0x${vt.toString(16)} clearMode=${this.clearMode} vaddr=0x${this.vertexAddr.toString(16)} fb=0x${this.fbPtr.toString(16)} fmt=${this.fbFormat} clearRgb=0x${this.clearColorRgb.toString(16)} clearA=${this.clearColorA}`);
          }
          this.doPrim(param);
          break;

        // Clear color (opcode 0xD0) — RGB in low 24 bits, stencil in CLEARDEPTH
        case GE_CMD.CLEARCOLOR:
          this.clearColorRgb = param;
          break;

        // Clear depth/stencil (opcode 0xD1) — bits 0-7 = stencil/alpha
        case GE_CMD.CLEARDEPTH:
          this.clearColorA = param & 0xFF;
          break;

        // Ambient color — also store as clear color fallback for older homebrew
        case GE_CMD.AMBIENT_COLOR:
          break;

        case GE_CMD.AMBIENT_ALPHA:
          break;

        case GE_CMD.CLEAR:
          if (this._dbgListCount <= 5) {
            log.info(`CLEAR param=0x${param.toString(16)} clearRgb=0x${this.clearColorRgb.toString(16)} clearA=${this.clearColorA} fbFmt=${this.fbFormat}`);
          }
          if (param & 1) {
            this.clearMode = true;
            this._dbgClearCount++;
            // If color clear flag (bit 8) set, do immediate full-screen clear
            if (param & 0x100) {
              this.doClear();
            }
          } else {
            this.clearMode = false;
          }
          break;

        // Texture enable
        case 0x1E:
          this.texEnable = (param & 1) !== 0;
          break;

        // Texture address (level 0)
        case 0xA0:
          this.texAddr0 = (this.texAddr0 & 0xFF000000) | param;
          break;

        // Texture buffer width (level 0)
        case 0xA8:
          this.texAddr0 = (this.texAddr0 & 0x00FFFFFF) | ((param & 0xFF0000) << 8);
          this.texBufWidth0 = param & 0x07FF;
          break;

        // Texture size (level 0)
        case 0xB8:
          this.texWidth0 = 1 << (param & 0xF);
          this.texHeight0 = 1 << ((param >>> 8) & 0xF);
          break;

        // Texture pixel format
        case 0xC7:
          this.texFormat = param & 0xF;
          break;

        // Block transfer registers
        case GE_CMD.TRANSFERSRC:
          this.trSrc = (this.trSrc & 0xFF000000) | param;
          break;

        case GE_CMD.TRANSFERSRCW:
          this.trSrc = (this.trSrc & 0x00FFFFFF) | ((param & 0xFF0000) << 8);
          this.trSrcW = param & 0x07FF;
          break;

        case GE_CMD.TRANSFERDST:
          this.trDst = (this.trDst & 0xFF000000) | param;
          break;

        case GE_CMD.TRANSFERDSTW:
          this.trDst = (this.trDst & 0x00FFFFFF) | ((param & 0xFF0000) << 8);
          this.trDstW = param & 0x07FF;
          break;

        case GE_CMD.TRANSFERSRCPOS:
          this.trSrcPos = param;
          break;

        case GE_CMD.TRANSFERDSTPOS:
          this.trDstPos = param;
          break;

        case GE_CMD.TRANSFERSIZE:
          this.trSize = param;
          break;

        case GE_CMD.TRANSFERSTART:
          this.doBlockTransfer();
          break;

        case GE_CMD.JUMP: {
          const target = this.baseAddr | param;
          pc = target - 4;
          break;
        }

        case GE_CMD.CALL: {
          if (this.callStack.length < CALL_STACK_DEPTH) {
            this.callStack.push(pc + 4);
          }
          const target = this.baseAddr | param;
          pc = target - 4;
          break;
        }

        case GE_CMD.RET:
          if (this.callStack.length > 0) {
            pc = this.callStack.pop()! - 4;
          }
          break;

        case GE_CMD.FINISH:
          pc += 4;
          count++;
          continue;

        case GE_CMD.END: {
          const nonClearPrims = this._dbgPrimCount - this._dbgClearCount;
          // Log only every 500 lists or first 5
          if (this._dbgListCount <= 5 || this._dbgListCount % 500 === 0) {
            log.info(`GE list #${this._dbgListCount}: ${count+1} cmds, draw=${nonClearPrims}, clear=${this._dbgClearCount}, skip=${this._dbgSkipCount}, fb=0x${this.fbPtr.toString(16)}:${this.fbWidth}`);
          }
          return -1; // completed
        }

        case GE_CMD.SIGNAL:
          break;

        default:
          // Ignore unknown commands — there are hundreds of GE state commands
          break;
      }

      pc += 4;
      count++;
    }

    if (count >= MAX_COMMANDS) {
      log.warn(`GE list exceeded ${MAX_COMMANDS} commands at PC=0x${pc.toString(16)}`);
    }
    return pc; // stalled at this PC
  }

  /** Draw primitives. */
  private doPrim(param: number): void {
    const primType = (param >>> 16) & 7;
    const vertCount = param & 0xFFFF;
    if (vertCount === 0) return;

    // Parse vertex type
    const vtype = this.vtypeRaw;
    const throughMode = (vtype >>> 23) & 1; // bit 23 = through (no transform)
    const texFmt  = (vtype >>> 0) & 3;  // 0=none, 1=u8, 2=u16, 3=float
    const colorFmt = (vtype >>> 2) & 7; // 0=none, ...
    const posFmt  = (vtype >>> 7) & 3;  // 1=s8, 2=s16, 3=float

    if (!throughMode) {
      this._dbgSkipCount++;
      return;
    }

    // Read vertices
    const vertices = this.readVertices(vertCount, texFmt, colorFmt, posFmt);
    if (!vertices) return;

    // For clear mode with PRIM, fill rectangles with clear color (all pairs)
    if (this.clearMode && primType === 6 && vertCount >= 2) {
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        this.doClearRect(vertices[i], vertices[i + 1]);
      }
      return;
    }

    // SPRITES (type 6): pairs of vertices define axis-aligned rectangles
    if (primType === 6) {
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        this.drawSprite(vertices[i], vertices[i + 1]);
      }
    }
    // TRIANGLES (type 3), TRIANGLE_STRIP (type 4), TRIANGLE_FAN (type 5)
    // could be added later for more complex 2D rendering
  }

  /** Read vertices from memory based on vertex format. */
  private readVertices(
    count: number, texFmt: number, colorFmt: number, posFmt: number,
  ): Vertex[] | null {
    if (posFmt === 0) return null; // no position = invalid

    const vertices: Vertex[] = [];
    let addr = this.vertexAddr;

    for (let i = 0; i < count; i++) {
      const v: Vertex = { x: 0, y: 0, z: 0, u: 0, v: 0, color: 0xFFFFFFFF };

      // Texture coords
      if (texFmt === 1) { // u8
        v.u = this.bus.readU8(addr); addr++;
        v.v = this.bus.readU8(addr); addr++;
      } else if (texFmt === 2) { // u16
        addr = (addr + 1) & ~1; // align to 2
        v.u = this.bus.readU16(addr); addr += 2;
        v.v = this.bus.readU16(addr); addr += 2;
      } else if (texFmt === 3) { // float
        addr = (addr + 3) & ~3; // align to 4
        v.u = this.readFloat(addr); addr += 4;
        v.v = this.readFloat(addr); addr += 4;
      }

      // Color
      if (colorFmt === 4) { // 16-bit 5551
        addr = (addr + 1) & ~1;
        const c = this.bus.readU16(addr); addr += 2;
        v.color = this.color5551to8888(c);
      } else if (colorFmt === 5) { // 16-bit 5650
        addr = (addr + 1) & ~1;
        const c = this.bus.readU16(addr); addr += 2;
        v.color = this.color5650to8888(c);
      } else if (colorFmt === 6) { // 16-bit 4444
        addr = (addr + 1) & ~1;
        const c = this.bus.readU16(addr); addr += 2;
        v.color = this.color4444to8888(c);
      } else if (colorFmt === 7) { // 32-bit 8888
        addr = (addr + 3) & ~3;
        v.color = this.bus.readU32(addr); addr += 4;
      }

      // Position (through mode = screen coords)
      if (posFmt === 1) { // s8
        v.x = (this.bus.readU8(addr) << 24) >> 24; addr++;
        v.y = (this.bus.readU8(addr) << 24) >> 24; addr++;
        v.z = (this.bus.readU8(addr) << 24) >> 24; addr++;
      } else if (posFmt === 2) { // s16
        addr = (addr + 1) & ~1;
        v.x = (this.bus.readU16(addr) << 16) >> 16; addr += 2;
        v.y = (this.bus.readU16(addr) << 16) >> 16; addr += 2;
        v.z = (this.bus.readU16(addr) << 16) >> 16; addr += 2;
      } else if (posFmt === 3) { // float
        addr = (addr + 3) & ~3;
        v.x = this.readFloat(addr); addr += 4;
        v.y = this.readFloat(addr); addr += 4;
        v.z = this.readFloat(addr); addr += 4;
      }

      vertices.push(v);
    }

    this.vertexAddr = addr; // advance for next PRIM
    return vertices;
  }

  /** Draw a sprite (axis-aligned rectangle) from two corner vertices. */
  private drawSprite(v0: Vertex, v1: Vertex): void {
    const x0 = Math.min(v0.x, v1.x) | 0;
    const y0 = Math.min(v0.y, v1.y) | 0;
    const x1 = Math.max(v0.x, v1.x) | 0;
    const y1 = Math.max(v0.y, v1.y) | 0;

    if (x0 >= x1 || y0 >= y1) return;

    const vram = this.bus.vramBuffer;
    const fbOff = this.toVramOffset(this.fbPtr);
    if (fbOff < 0 || fbOff >= vram.length) return;
    const stride = this.fbWidth || 512;
    const bpp = this.bpp;

    // Texture sampling coordinates
    const u0 = Math.min(v0.u, v1.u);
    const v0t = Math.min(v0.v, v1.v);
    const du = (x1 > x0) ? (Math.max(v0.u, v1.u) - u0) / (x1 - x0) : 0;
    const dv = (y1 > y0) ? (Math.max(v0.v, v1.v) - v0t) / (y1 - y0) : 0;

    const useTexture = this.texEnable && this.texAddr0 !== 0;

    for (let y = y0; y < y1; y++) {
      if (y < 0 || y >= 272) continue;
      for (let x = x0; x < x1; x++) {
        if (x < 0 || x >= 480) continue;

        let r: number, g: number, b: number, a: number;

        if (useTexture) {
          const tu = (u0 + (x - x0) * du) | 0;
          const tv = (v0t + (y - y0) * dv) | 0;
          const texel = this.sampleTexture(tu, tv);
          r = texel & 0xFF;
          g = (texel >>> 8) & 0xFF;
          b = (texel >>> 16) & 0xFF;
          a = (texel >>> 24) & 0xFF;
        } else {
          // Use vertex color (from v1 for sprites — PSP uses second vertex color)
          const c = v1.color;
          r = c & 0xFF;
          g = (c >>> 8) & 0xFF;
          b = (c >>> 16) & 0xFF;
          a = (c >>> 24) & 0xFF;
        }

        const i = fbOff + (y * stride + x) * bpp;
        this.writePixel(vram, i, r, g, b, a);
      }
    }
  }

  /** Sample a texel from the level-0 texture. Returns ABGR8888. */
  private sampleTexture(u: number, v: number): number {
    const tw = this.texWidth0 || 1;
    const th = this.texHeight0 || 1;
    const tu = ((u % tw) + tw) % tw;
    const tv = ((v % th) + th) % th;
    const bw = this.texBufWidth0 || tw;

    const fmt = this.texFormat;
    const addr = this.texAddr0;

    if (fmt === 3) {
      // ABGR8888
      const off = (tv * bw + tu) * 4;
      return this.bus.readU32(addr + off);
    } else if (fmt === 0) {
      // BGR5650
      const off = (tv * bw + tu) * 2;
      return this.color5650to8888(this.bus.readU16(addr + off));
    } else if (fmt === 1) {
      // ABGR5551
      const off = (tv * bw + tu) * 2;
      return this.color5551to8888(this.bus.readU16(addr + off));
    } else if (fmt === 2) {
      // ABGR4444
      const off = (tv * bw + tu) * 2;
      return this.color4444to8888(this.bus.readU16(addr + off));
    }

    return 0xFFFFFFFF; // white fallback
  }

  /** Fill a rectangle with clear color (used when clear mode + PRIM). */
  private doClearRect(v0: Vertex, v1: Vertex): void {
    const x0 = Math.max(0, Math.min(v0.x, v1.x) | 0);
    const y0 = Math.max(0, Math.min(v0.y, v1.y) | 0);
    const x1 = Math.min(480, Math.max(v0.x, v1.x) | 0);
    const y1 = Math.min(272, Math.max(v0.y, v1.y) | 0);

    const r = this.clearColorRgb & 0xFF;
    const g = (this.clearColorRgb >>> 8) & 0xFF;
    const b = (this.clearColorRgb >>> 16) & 0xFF;
    const a = this.clearColorA;

    const vram = this.bus.vramBuffer;
    const fbOff = this.toVramOffset(this.fbPtr);
    if (fbOff < 0 || fbOff >= vram.length) return;
    const stride = this.fbWidth || 512;

    const bpp = this.bpp;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = fbOff + (y * stride + x) * bpp;
        this.writePixel(vram, i, r, g, b, a);
      }
    }
  }

  /**
   * Convert a GE framebuffer/texture address to a VRAM byte offset.
   * PSP GE addresses may be absolute (0x04xxxxxx) or VRAM-relative (< 0x04000000).
   */
  private toVramOffset(addr: number): number {
    const phys = addr & 0x1FFFFFFF;
    if (phys >= 0x04000000) return phys - 0x04000000;
    // Treat as VRAM-relative offset (common in GE commands)
    return phys;
  }

  /** Clear the current framebuffer with the stored clear color. */
  private doClear(): void {
    const stride = this.fbWidth || 512;

    const r = this.clearColorRgb & 0xFF;
    const g = (this.clearColorRgb >>> 8) & 0xFF;
    const b = (this.clearColorRgb >>> 16) & 0xFF;
    const a = this.clearColorA;

    const vram = this.bus.vramBuffer;
    const offset = this.toVramOffset(this.fbPtr);
    if (offset < 0 || offset >= vram.length) return;

    const bpp = this.bpp;
    for (let y = 0; y < 272; y++) {
      const rowBase = offset + y * stride * bpp;
      for (let x = 0; x < stride; x++) {
        const i = rowBase + x * bpp;
        this.writePixel(vram, i, r, g, b, a);
      }
    }
  }

  /** Execute a block transfer (pixel copy between memory regions). */
  private doBlockTransfer(): void {
    const srcAddr = this.trSrc;
    const srcStride = this.trSrcW || 512;
    const dstAddr = this.trDst;
    const dstStride = this.trDstW || 512;

    const srcX = this.trSrcPos & 0x3FF;
    const srcY = (this.trSrcPos >>> 10) & 0x3FF;
    const dstX = this.trDstPos & 0x3FF;
    const dstY = (this.trDstPos >>> 10) & 0x3FF;

    const width = (this.trSize & 0x3FF) + 1;
    const height = ((this.trSize >>> 10) & 0x3FF) + 1;

    const bpp = 4;

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const srcOff = ((srcY + row) * srcStride + (srcX + col)) * bpp;
        const dstOff = ((dstY + row) * dstStride + (dstX + col)) * bpp;

        for (let b = 0; b < bpp; b++) {
          const val = this.bus.readU8(srcAddr + srcOff + b);
          this.bus.writeU8(dstAddr + dstOff + b, val);
        }
      }
    }
  }

  // ── Pixel write helpers ─────────────────────────────────────────────────

  /** Bytes per pixel for the current framebuffer format. */
  private get bpp(): number {
    return this.fbFormat === 3 ? 4 : 2;
  }

  /** Write a pixel (r,g,b,a in 0-255) to VRAM at byte offset, respecting fbFormat. */
  private writePixel(vram: Uint8Array, off: number, r: number, g: number, b: number, a: number): void {
    if (this.fbFormat === 3) {
      // ABGR8888
      if (off + 3 < vram.length) {
        vram[off]     = r;
        vram[off + 1] = g;
        vram[off + 2] = b;
        vram[off + 3] = a;
      }
    } else if (off + 1 < vram.length) {
      let px: number;
      switch (this.fbFormat) {
        case 0: // BGR5650
          px = ((r >>> 3) & 0x1F) | (((g >>> 2) & 0x3F) << 5) | (((b >>> 3) & 0x1F) << 11);
          break;
        case 1: // ABGR5551
          px = ((r >>> 3) & 0x1F) | (((g >>> 3) & 0x1F) << 5) | (((b >>> 3) & 0x1F) << 10) | ((a >= 128 ? 1 : 0) << 15);
          break;
        case 2: // ABGR4444
          px = ((r >>> 4) & 0xF) | (((g >>> 4) & 0xF) << 4) | (((b >>> 4) & 0xF) << 8) | (((a >>> 4) & 0xF) << 12);
          break;
        default:
          return;
      }
      vram[off]     = px & 0xFF;
      vram[off + 1] = (px >>> 8) & 0xFF;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private readFloat(addr: number): number {
    const bits = this.bus.readU32(addr);
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, bits, false);
    return new DataView(buf).getFloat32(0, false);
  }

  private color5650to8888(c: number): number {
    const r = ((c) & 0x1F) << 3;
    const g = ((c >>> 5) & 0x3F) << 2;
    const b = ((c >>> 11) & 0x1F) << 3;
    return (0xFF << 24) | (b << 16) | (g << 8) | r;
  }

  private color5551to8888(c: number): number {
    const r = ((c) & 0x1F) << 3;
    const g = ((c >>> 5) & 0x1F) << 3;
    const b = ((c >>> 10) & 0x1F) << 3;
    const a = (c >>> 15) ? 0xFF : 0;
    return (a << 24) | (b << 16) | (g << 8) | r;
  }

  private color4444to8888(c: number): number {
    const r = ((c) & 0xF) << 4;
    const g = ((c >>> 4) & 0xF) << 4;
    const b = ((c >>> 8) & 0xF) << 4;
    const a = ((c >>> 12) & 0xF) << 4;
    return (a << 24) | (b << 16) | (g << 8) | r;
  }
}

interface Vertex {
  x: number; y: number; z: number;
  u: number; v: number;
  color: number; // ABGR8888
}
