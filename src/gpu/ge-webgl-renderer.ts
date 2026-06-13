/**
 * WebGL-based PSP GE renderer.
 *
 * Replaces the software drawSprite/drawTriangle/drawLine rasterization
 * with GPU-accelerated WebGL draw calls. All vertex transforms are done
 * on CPU (matching PSP hardware), so vertices arrive in screen space.
 *
 * Uses twgl.js for WebGL boilerplate.
 */

import * as twgl from "twgl.js";
import type { MemoryBus } from "../memory/memory-bus.js";
import type { Vertex } from "./ge-types.js";
import type { GEFragmentState } from "./ge-fragment.js";
import type { GETextureState } from "./ge-texture.js";
import { decodeTexture } from "./ge-texture-upload.js";
import { VS_GE, FS_GE, VS_PRESENT, FS_PRESENT, FLOATS_PER_VERT } from "./ge-shaders.js";
import { Logger } from "../utils/logger.js";

const log = Logger.get("GE-GL");

const PSP_WIDTH = 480;
const PSP_HEIGHT = 272;
// FBO / render-target width = the VRAM framebuffer stride (512), not the 480
// visible width. Screen-space x maps 1:1 to FBO columns at this width.
const FBO_WIDTH = 512;

// Max vertices per batch before flush
const MAX_VERTS = 65536;

/** Snapshot of GE state needed for a draw call. */
export interface GEDrawState {
  throughMode: boolean;
  texEnable: boolean;
  texState: GETextureState;
  fragState: GEFragmentState;
  fbPtr: number;
  fbWidth: number;
  fbFormat: number;
  clearMode: boolean;
  clearColorWrite: boolean;
  clearAlphaWrite: boolean;
  clearDepthWrite: boolean;
  depthTestEnable: boolean;
  depthFunc: number;
  depthWriteDisable: boolean;
  cullEnable: boolean;
  cullCW: boolean;
  scissorX1: number;
  scissorY1: number;
  scissorX2: number;
  scissorY2: number;
  // Fog — PPSSPP FragmentShaderGenerator.cpp:854-860
  fogEnable: boolean;
  fogColor: number;   // 24-bit BGR
  fogEnd: number;     // float
  fogSlope: number;   // float 1/(end-start)
  // Color doubling — PPSSPP GPUState.h:301
  colorDoubling: boolean;
  // Flat shading — PPSSPP SoftwareTransformCommon.cpp:701-712
  shadeMode: number;  // 0=flat, 1=gouraud
}

/** Cache key for textures — identifies unique texture configurations. */
function texCacheKey(s: GETextureState): string {
  return `${s.texAddr0}:${s.texBufWidth0}:${s.texWidth0}:${s.texHeight0}:${s.texFormat}:${s.texSwizzle ? 1 : 0}:${s.clutAddr}:${s.clutFormat}:${s.clutShift}:${s.clutMask}:${s.clutStart}`;
}

/** Map PSP blend factor to WebGL constant. */
function mapBlendFactor(gl: WebGLRenderingContext, factor: number, isSrc: boolean): number {
  // PSP src: 0=DST_COLOR, 1=INV_DST_COLOR, 2=SRC_ALPHA, 3=INV_SRC_ALPHA,
  //          4=DST_ALPHA, 5=INV_DST_ALPHA, 6-9=2x variants, 10=FIX
  // PSP dst: 0=SRC_COLOR, 1=INV_SRC_COLOR, rest same
  switch (factor) {
    case 0: return isSrc ? gl.DST_COLOR : gl.SRC_COLOR;
    case 1: return isSrc ? gl.ONE_MINUS_DST_COLOR : gl.ONE_MINUS_SRC_COLOR;
    case 2: return gl.SRC_ALPHA;
    case 3: return gl.ONE_MINUS_SRC_ALPHA;
    case 4: return gl.DST_ALPHA;
    case 5: return gl.ONE_MINUS_DST_ALPHA;
    // 2x variants: approximate with regular version (most games don't use these)
    case 6: return gl.SRC_ALPHA;
    case 7: return gl.ONE_MINUS_SRC_ALPHA;
    case 8: return gl.DST_ALPHA;
    case 9: return gl.ONE_MINUS_DST_ALPHA;
    case 10: return gl.CONSTANT_COLOR; // FIX — set via blendColor
    default: return gl.ONE;
  }
}

/** Map PSP blend op to WebGL. `minEq`/`maxEq` are the real MIN/MAX equation
 *  enums when EXT_blend_minmax is available, else FUNC_ADD (PPSSPP keeps the
 *  same two tables: eqLookup vs eqLookupNoMinMax, GPUStateUtils.cpp:857-875). */
function mapBlendOp(gl: WebGLRenderingContext, op: number, minEq: number, maxEq: number): number {
  switch (op) {
    case 0: return gl.FUNC_ADD;
    case 1: return gl.FUNC_SUBTRACT;
    case 2: return gl.FUNC_REVERSE_SUBTRACT;
    case 3: return minEq;       // GE_BLENDMODE_MIN
    case 4: return maxEq;       // GE_BLENDMODE_MAX
    case 5: return maxEq;       // GE_BLENDMODE_ABSDIFF → MAX (PPSSPP GPUStateUtils.cpp:873)
    default: return gl.FUNC_ADD;
  }
}

/** Map PSP depth function (GEComparison) to WebGL. */
function mapDepthFunc(gl: WebGLRenderingContext, func: number): number {
  switch (func) {
    case 0: return gl.NEVER;
    case 1: return gl.ALWAYS;
    case 2: return gl.EQUAL;
    case 3: return gl.NOTEQUAL;
    case 4: return gl.LESS;
    case 5: return gl.LEQUAL;
    case 6: return gl.GREATER;
    case 7: return gl.GEQUAL;
    default: return gl.ALWAYS;
  }
}

/** Check if two 24-bit colors are close enough to unify.
 *  PPSSPP GPUStateUtils.cpp:912 — default margin is ~25 (0.1 * 255). */
function colorsClose(refColor: number, a: number, b: number): boolean {
  void refColor;
  for (let i = 0; i < 3; i++) {
    const ca = (a >>> (i * 8)) & 0xFF;
    const cb = (b >>> (i * 8)) & 0xFF;
    if (Math.abs(ca - cb) > 25) return false;
  }
  return true;
}

/** Approximate a 24-bit fixed color as a standard GL blend factor.
 *  PPSSPP GPUStateUtils.cpp:900-902 — thresholds ~0.01 and ~0.99 normalized. */
function blendColor2Func(gl: WebGLRenderingContext, color: number): number {
  const r = color & 0xFF, g = (color >>> 8) & 0xFF, b = (color >>> 16) & 0xFF;
  if (r <= 2 && g <= 2 && b <= 2) return gl.ZERO;
  if (r >= 253 && g >= 253 && b >= 253) return gl.ONE;
  return gl.CONSTANT_COLOR;
}

/** Map PSP stencil function (GEComparison) to WebGL. */
function mapStencilFunc(gl: WebGLRenderingContext, func: number): number {
  return mapDepthFunc(gl, func); // Same enum mapping
}

/** Map PSP stencil op to WebGL. */
function mapStencilOp(gl: WebGLRenderingContext, op: number): number {
  switch (op) {
    case 0: return gl.KEEP;
    case 1: return gl.ZERO;
    case 2: return gl.REPLACE;
    case 3: return gl.INVERT;
    case 4: return gl.INCR;
    case 5: return gl.DECR;
    default: return gl.KEEP;
  }
}

/** Decode one row of PSP framebuffer pixels (PSP layout, R in low bits) to RGBA8888. */
function decodeFbRowToRGBA(
  src: Uint8Array, srcOff: number, count: number, format: number,
  out: Uint8Array, outOff: number,
): void {
  if (format === 3) {
    // ABGR8888 bytes are [r,g,b,a] — exactly GL RGBA.
    out.set(src.subarray(srcOff, srcOff + count * 4), outOff);
    return;
  }
  for (let i = 0; i < count; i++) {
    const px = src[srcOff + i * 2]! | (src[srcOff + i * 2 + 1]! << 8);
    const di = outOff + i * 4;
    if (format === 0) { // BGR5650
      out[di] = (px & 0x1f) << 3;
      out[di + 1] = ((px >>> 5) & 0x3f) << 2;
      out[di + 2] = ((px >>> 11) & 0x1f) << 3;
      out[di + 3] = 255;
    } else if (format === 1) { // ABGR5551
      out[di] = (px & 0x1f) << 3;
      out[di + 1] = ((px >>> 5) & 0x1f) << 3;
      out[di + 2] = ((px >>> 10) & 0x1f) << 3;
      out[di + 3] = (px >>> 15) ? 255 : 0;
    } else { // ABGR4444
      out[di] = (px & 0xf) << 4;
      out[di + 1] = ((px >>> 4) & 0xf) << 4;
      out[di + 2] = ((px >>> 8) & 0xf) << 4;
      out[di + 3] = ((px >>> 12) & 0xf) << 4;
    }
  }
}

/** Pack one RGBA8888 pixel into PSP framebuffer bytes (inverse of decodeFbRowToRGBA). */
function packRGBAToFb(
  r: number, g: number, b: number, a: number, format: number,
  out: Uint8Array, off: number,
): void {
  if (format === 3) {
    out[off] = r; out[off + 1] = g; out[off + 2] = b; out[off + 3] = a;
    return;
  }
  let px: number;
  if (format === 0) {
    px = (r >>> 3) | ((g >>> 2) << 5) | ((b >>> 3) << 11);
  } else if (format === 1) {
    px = (r >>> 3) | ((g >>> 3) << 5) | ((b >>> 3) << 10) | (a >= 128 ? 0x8000 : 0);
  } else {
    px = (r >>> 4) | ((g >>> 4) << 4) | ((b >>> 4) << 8) | ((a >>> 4) << 12);
  }
  out[off] = px & 0xff;
  out[off + 1] = px >>> 8;
}

export class WebGLGERenderer {
  private gl: WebGLRenderingContext;
  private geProgram: twgl.ProgramInfo;
  private presentProgram: twgl.ProgramInfo;
  private presentBuffer: twgl.BufferInfo;

  // Virtual framebuffers — PPSSPP FramebufferManagerCommon.h VirtualFramebuffer
  // One FBO per unique normalized PSP framebuffer address.
  private vfbs = new Map<number, {
    fbo: WebGLFramebuffer;
    tex: WebGLTexture;
    depthRb: WebGLRenderbuffer;
    lastFrameUsed: number;
    format: number; // PSP fb format: 0=5650 1=5551 2=4444 3=8888
    stride: number; // fb width in pixels (VRAM row pitch), usually 512
  }>();
  private frameCount = 0;
  private currentRenderAddr = 0; // currently bound VFB address

  // Internal resolution multiplier. VFBs are allocated at scale*512 x scale*272
  // and the viewport/scissor scale with it, so 3D geometry rasterizes at higher
  // resolution. Vertex positions stay in PSP screen space (u_resolution is the
  // logical 512x272) — the bigger viewport stretches NDC to the scaled target.
  // PPSSPP's "rendering resolution" multiplier (GPUCommon, internal scale).
  private scale = 1;
  private get fbW(): number { return FBO_WIDTH * this.scale; }
  private get fbH(): number { return PSP_HEIGHT * this.scale; }

  // Display buffer tracking — PPSSPP FramebufferManagerCommon.h:displayFramebuf_
  private displayFbAddr = 0;
  private displayFbWidth = 512;
  private displayFbFormat = 3;

  // Fallback texture for presenting RAM/VRAM bytes when no VFB exists
  // PPSSPP FramebufferManagerCommon.cpp DrawFramebufferToOutput
  private vramFallbackTex: WebGLTexture | null = null;
  private vramRef: Uint8Array | null = null;
  private fallbackConvBuf: Uint8Array | null = null; // 16-bit→RGBA scratch

  // Debug info
  _dbgDisplayPath = "none";
  _dbgBlitCount = 0;
  _dbgReadbackCount = 0;
  private _dbgClearLog = 0;
  get dbgVFBCount(): number { return this.vfbs.size; }
  get dbgVFBKeys(): string { return [...this.vfbs.keys()].map(k => `0x${k.toString(16)}`).join(","); }

  // Dynamic vertex buffer
  private vertexData = new Float32Array(MAX_VERTS * FLOATS_PER_VERT);
  private vertexCount = 0;
  private glBuffer: WebGLBuffer;


  // Texture cache. hash is a sparse content sample — PPSSPP re-hashes texture
  // memory to catch CPU-animated textures (TextureCacheCommon); without it a
  // texture updated in place (no block transfer) stays frozen at first upload.
  private texCache = new Map<string, { tex: WebGLTexture; hash: number }>();
  private dummyTex: WebGLTexture;

  // Real MIN/MAX blend equation enums when EXT_blend_minmax is present, else
  // FUNC_ADD (matches PPSSPP's eqLookup vs eqLookupNoMinMax fallback).
  private blendMinEq = 0;
  private blendMaxEq = 0;

  // Track current GL state to minimize state changes
  private currentBlendEnabled = false;
  private currentDepthEnabled = false;
  private currentScissorEnabled = false;
  private currentCullEnabled = false;
  private currentStencilEnabled = false;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: true,
      stencil: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL not supported");
    this.gl = gl;

    // Real MIN/MAX blend equations need EXT_blend_minmax in WebGL1; without it
    // PPSSPP collapses MIN/MAX/ABSDIFF to ADD, so we do the same.
    const minMaxExt = gl.getExtension("EXT_blend_minmax");
    this.blendMinEq = minMaxExt ? minMaxExt.MIN_EXT : gl.FUNC_ADD;
    this.blendMaxEq = minMaxExt ? minMaxExt.MAX_EXT : gl.FUNC_ADD;

    // Compile shaders
    this.geProgram = twgl.createProgramInfo(gl, [VS_GE, FS_GE]);
    this.presentProgram = twgl.createProgramInfo(gl, [VS_PRESENT, FS_PRESENT]);

    // Fullscreen quad for presenting FBO
    this.presentBuffer = twgl.createBufferInfoFromArrays(gl, {
      a_position: { numComponents: 2, data: [-1, -1, 1, -1, -1, 1, 1, 1] },
      a_texcoord: {
        numComponents: 2,
        data: [0, 0, PSP_WIDTH / 512, 0, 0, PSP_HEIGHT / 272, PSP_WIDTH / 512, PSP_HEIGHT / 272],
      },
      indices: [0, 1, 2, 2, 1, 3],
    });

    // VFBs are created lazily per unique PSP framebuffer address.
    // PPSSPP FramebufferManagerCommon.cpp DoSetRenderFrameBuffer.

    // Dynamic vertex buffer
    this.glBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.byteLength, gl.DYNAMIC_DRAW);

    // 1x1 white dummy texture for when texturing is disabled
    this.dummyTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));

    log.info("WebGL GE renderer initialized");
  }

  /**
   * Draw decoded vertices with the given GE state.
   * Called from GEProcessor.doPrim() instead of software rasterization.
   */
  drawPrimitives(
    primType: number,
    vertices: Vertex[],
    state: GEDrawState,
    bus: MemoryBus,
  ): void {
    const gl = this.gl;

    // Bind the VFB for this draw's framebuffer address
    this.bindRenderTarget(state.fbPtr, state.fbFormat, state.fbWidth);
    gl.viewport(0, 0, this.fbW, this.fbH);

    // Set up per-draw-call state
    this.setupUVNormalization(state);
    this.flatColor = -1; // default gouraud

    // Apply GE state
    this.applyBlendState(gl, state.fragState);
    this.applyDepthState(gl, state);
    this.applyScissorState(gl, state);
    this.applyCullState(gl, state);
    this.applyStencilState(gl, state.fragState);
    this.applyColorMask(gl, state.fragState);

    // Texture
    let tex = this.dummyTex;
    if (state.texEnable) {
      tex = this.getOrUploadTexture(state.texState, bus);
    }

    // Build vertex data
    this.vertexCount = 0;
    const flat = state.shadeMode === 0; // PPSSPP SoftwareTransformCommon.cpp:701-712

    if (primType === 6) {
      // SPRITES: expand each pair to 2 triangles (sprites always use v1 color)
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        this.expandSprite(vertices[i]!, vertices[i + 1]!);
      }
    } else if (primType === 3) {
      // TRIANGLES — provoking vertex = last (index 2) per PPSSPP
      for (let i = 0; i + 2 < vertices.length; i += 3) {
        if (flat) this.flatColor = vertices[i + 2]!.color;
        this.pushVertex(vertices[i]!);
        this.pushVertex(vertices[i + 1]!);
        this.pushVertex(vertices[i + 2]!);
        this.flatColor = -1;
      }
    } else if (primType === 4) {
      // TRIANGLE_STRIP — provoking vertex = last (index i+2) per PPSSPP
      for (let i = 0; i + 2 < vertices.length; i++) {
        if (flat) this.flatColor = vertices[i + 2]!.color;
        if (i & 1) {
          this.pushVertex(vertices[i + 1]!);
          this.pushVertex(vertices[i]!);
          this.pushVertex(vertices[i + 2]!);
        } else {
          this.pushVertex(vertices[i]!);
          this.pushVertex(vertices[i + 1]!);
          this.pushVertex(vertices[i + 2]!);
        }
        this.flatColor = -1;
      }
    } else if (primType === 5) {
      // TRIANGLE_FAN — provoking vertex = last (index i+1) per PPSSPP
      for (let i = 1; i + 1 < vertices.length; i++) {
        if (flat) this.flatColor = vertices[i + 1]!.color;
        this.pushVertex(vertices[0]!);
        this.pushVertex(vertices[i]!);
        this.pushVertex(vertices[i + 1]!);
        this.flatColor = -1;
      }
    } else if (primType === 1) {
      // LINES — provoking vertex = last (index i+1)
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        if (flat) this.flatColor = vertices[i + 1]!.color;
        this.pushVertex(vertices[i]!);
        this.pushVertex(vertices[i + 1]!);
        this.flatColor = -1;
      }
    } else if (primType === 2) {
      // LINE_STRIP
      for (let i = 0; i + 1 < vertices.length; i++) {
        if (flat) this.flatColor = vertices[i + 1]!.color;
        this.pushVertex(vertices[i]!);
        this.pushVertex(vertices[i + 1]!);
        this.flatColor = -1;
      }
    } else if (primType === 0) {
      // POINTS
      for (const v of vertices) {
        this.pushVertex(v);
      }
    }

    if (this.vertexCount === 0) return;

    // Upload vertex data
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0,
      this.vertexData.subarray(0, this.vertexCount * FLOATS_PER_VERT));

    // Set up shader
    gl.useProgram(this.geProgram.program);

    // Bind attributes manually (interleaved buffer: x,y,z, u,v, r,g,b,a, fogCoef)
    const stride = FLOATS_PER_VERT * 4; // 10 floats * 4 bytes = 40 bytes
    const posLoc = gl.getAttribLocation(this.geProgram.program, "a_position");
    const uvLoc = gl.getAttribLocation(this.geProgram.program, "a_texcoord");
    const colLoc = gl.getAttribLocation(this.geProgram.program, "a_color");
    const fogLoc = gl.getAttribLocation(this.geProgram.program, "a_fogCoef");

    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, stride, 0);
    if (uvLoc >= 0) {
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, stride, 12);
    }
    if (colLoc >= 0) {
      gl.enableVertexAttribArray(colLoc);
      gl.vertexAttribPointer(colLoc, 4, gl.FLOAT, false, stride, 20);
    }
    if (fogLoc >= 0) {
      gl.enableVertexAttribArray(fogLoc);
      gl.vertexAttribPointer(fogLoc, 1, gl.FLOAT, false, stride, 36);
    }

    // Bind texture to unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);

    // Apply texture filtering from GE state
    if (state.texEnable) {
      const magFilter = state.texState.texMagFilter === 1 ? gl.LINEAR : gl.NEAREST;
      const minFilter = (state.texState.texMinFilter & 1) ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
      const wrapS = state.texState.texWrapU === 1 ? gl.CLAMP_TO_EDGE : gl.REPEAT;
      const wrapT = state.texState.texWrapV === 1 ? gl.CLAMP_TO_EDGE : gl.REPEAT;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
    }

    // Set sampler uniform manually (twgl expects WebGLTexture, not unit index)
    const texLoc = gl.getUniformLocation(this.geProgram.program, "u_texture");
    gl.uniform1i(texLoc, 0);

    const frag = state.fragState;
    const envR = (frag.texEnvColor & 0xFF) / 255;
    const envG = ((frag.texEnvColor >>> 8) & 0xFF) / 255;
    const envB = ((frag.texEnvColor >>> 16) & 0xFF) / 255;

    // Fog color — PPSSPP stores as BGR, convert to normalized RGB
    const fogR = (state.fogColor & 0xFF) / 255;
    const fogG = ((state.fogColor >>> 8) & 0xFF) / 255;
    const fogB = ((state.fogColor >>> 16) & 0xFF) / 255;

    // Color test ref/mask — convert from 24-bit integer to per-channel floats
    const ctRef = frag.colorTestRef;
    const ctMask = frag.colorTestMask;

    // Stencil-to-alpha: when stencil op is REPLACE (2), output alpha = stencilRef
    const stencilReplace = frag.stencilTestEnable && frag.stencilZPass === 2;

    twgl.setUniforms(this.geProgram, {
      // Divide screen-space x by the FBO width (512, the VRAM stride), NOT the
      // 480 visible width: the render target / viewport is 512 wide, so PSP x
      // must map 1:1 to FBO columns. Using 480 stretched everything ~6.7% wider
      // and pushed it right (rightmost pixels clipped past column 480 on present).
      u_resolution: [FBO_WIDTH, PSP_HEIGHT],
      u_texEnable: state.texEnable,
      u_texFunc: frag.texFunc,
      u_texFuncAlpha: frag.texFuncAlpha,
      u_texEnvColor: [envR, envG, envB],
      u_alphaTestEnable: frag.alphaTestEnable,
      u_alphaTestFunc: frag.alphaTestFunc,
      u_alphaTestRef: frag.alphaTestRef,
      u_colorDoubling: state.colorDoubling,
      u_fogEnable: state.fogEnable && !state.throughMode,
      u_fogColor: [fogR, fogG, fogB],
      u_colorTestEnable: frag.colorTestEnable,
      u_colorTestFunc: frag.colorTestFunc,
      u_colorTestRef: [ctRef & 0xFF, (ctRef >>> 8) & 0xFF, (ctRef >>> 16) & 0xFF],
      u_colorTestMask: [ctMask & 0xFF, (ctMask >>> 8) & 0xFF, (ctMask >>> 16) & 0xFF],
      u_stencilReplace: stencilReplace,
      u_stencilReplaceValue: frag.stencilRef / 255,
    });

    // Draw
    let glPrimType: number;
    if (primType === 1 || primType === 2) {
      glPrimType = gl.LINES;
    } else if (primType === 0) {
      glPrimType = gl.POINTS;
    } else {
      glPrimType = gl.TRIANGLES;
    }

    gl.drawArrays(glPrimType, 0, this.vertexCount);

    // Clean up
    if (fogLoc >= 0) gl.disableVertexAttribArray(fogLoc);
    if (uvLoc >= 0) gl.disableVertexAttribArray(uvLoc);
    if (colLoc >= 0) gl.disableVertexAttribArray(colLoc);
    gl.disableVertexAttribArray(posLoc);
  }

  /**
   * Clear a rectangle on the FBO (GE clear command).
   */
  clearRect(
    x0: number, y0: number, x1: number, y1: number,
    r: number, g: number, b: number, a: number,
    colorWrite: boolean, alphaWrite: boolean, depthWrite: boolean,
    fbPtr = 0,
    fbFormat = 3,
    fbStride = 512,
    clearDepth = 1,
  ): void {
    const gl = this.gl;
    const normAddr = this.normFb(fbPtr);
    if (this._dbgClearLog < 5) {
      this._dbgClearLog++;
      console.log(`[VFB] Clear 0x${normAddr.toString(16)} rgba(${r},${g},${b},${a})`);
    }
    this.bindRenderTarget(fbPtr, fbFormat, fbStride);
    gl.viewport(0, 0, this.fbW, this.fbH);

    // Use scissor to limit the clear to the requested rectangle
    gl.enable(gl.SCISSOR_TEST);
    // WebGL scissor Y is bottom-up, PSP is top-down. Scale to the render target.
    const s = this.scale;
    const glY0 = PSP_HEIGHT - y1;
    const glY1 = PSP_HEIGHT - y0;
    gl.scissor(x0 * s, glY0 * s, (x1 - x0) * s, (glY1 - glY0) * s);

    gl.colorMask(colorWrite, colorWrite, colorWrite, alphaWrite);
    gl.depthMask(depthWrite);
    gl.clearColor(r / 255, g / 255, b / 255, a / 255);
    // PSP clear mode writes the clear rectangle's own z to the depth buffer (it
    // draws a real quad with depth-test ALWAYS), NOT a fixed far value. Games
    // clear to 0 and draw with GEQUAL as an always-pass setup — clearing to the
    // default 1.0 would then reject everything. PPSSPP SoftwareTransformCommon.
    gl.clearDepth(clearDepth);

    let clearBits = 0;
    if (colorWrite || alphaWrite) clearBits |= gl.COLOR_BUFFER_BIT;
    if (depthWrite) clearBits |= gl.DEPTH_BUFFER_BIT;
    if (clearBits) gl.clear(clearBits);

    // Restore defaults and reset tracking flags (we modified GL state directly)
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.disable(gl.SCISSOR_TEST);
    this.currentScissorEnabled = false;
    // clearRect may be called between drawPrimitives calls, so mark all tracked
    // state as dirty so subsequent draws re-apply their state correctly.
    this.currentBlendEnabled = false;
    gl.disable(gl.BLEND);
    this.currentDepthEnabled = false;
    gl.disable(gl.DEPTH_TEST);
    this.currentCullEnabled = false;
    gl.disable(gl.CULL_FACE);
    this.currentStencilEnabled = false;
    gl.disable(gl.STENCIL_TEST);
  }

  /**
   * Present the GE FBO to the screen canvas.
   */
  presentToScreen(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // The GL framebuffer binding no longer matches any VFB; without this the
    // next draw to the same address early-returns in bindRenderTarget and
    // renders onto the canvas backbuffer (invisible — present overwrites it).
    this.currentRenderAddr = 0;
    gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);

    // Disable all state for fullscreen blit — and reset tracking flags so
    // the next frame's drawPrimitives re-applies all GE state correctly.
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    this.currentBlendEnabled = false;
    this.currentDepthEnabled = false;
    this.currentScissorEnabled = false;
    this.currentCullEnabled = false;
    this.currentStencilEnabled = false;

    gl.useProgram(this.presentProgram.program);
    twgl.setBuffersAndAttributes(gl, this.presentProgram, this.presentBuffer);

    // PPSSPP PrepareCopyDisplayToOutput: find VFB at display address.
    // If found, present FBO texture. If not, fall back to VRAM bytes.
    const displayAddr = this.displayFbAddr;
    const displayVfb = displayAddr ? this.vfbs.get(displayAddr) : null;
    this._dbgDisplayPath = displayVfb ? "vfb" : (displayAddr && this.vramRef ? "vram" : "none");

    gl.activeTexture(gl.TEXTURE0);
    const presTexLoc = gl.getUniformLocation(this.presentProgram.program, "u_texture");

    if (displayVfb) {
      gl.bindTexture(gl.TEXTURE_2D, displayVfb.tex);
    } else if (displayAddr && this.vramRef) {
      // No VFB — game uses block transfers / CPU writes to compose the display
      // buffer in VRAM. Upload VRAM bytes as a texture, decoding the display
      // format (16-bit formats must be converted; raw upload only works for 8888).
      const vram = this.vramRef;
      const offset = displayAddr - 0x04000000;
      const stride = this.displayFbWidth;
      const fmt = this.displayFbFormat;
      const srcBpp = fmt === 3 ? 4 : 2;
      if (offset < 0 || offset + stride * PSP_HEIGHT * srcBpp > vram.length) return;

      if (!this.vramFallbackTex) {
        this.vramFallbackTex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, this.vramFallbackTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 512, PSP_HEIGHT, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, null);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, this.vramFallbackTex);
      }

      let pixels: Uint8Array;
      if (fmt === 3) {
        pixels = new Uint8Array(vram.buffer, vram.byteOffset + offset, stride * PSP_HEIGHT * 4);
      } else {
        if (!this.fallbackConvBuf || this.fallbackConvBuf.length < stride * PSP_HEIGHT * 4) {
          this.fallbackConvBuf = new Uint8Array(stride * PSP_HEIGHT * 4);
        }
        for (let y = 0; y < PSP_HEIGHT; y++) {
          decodeFbRowToRGBA(vram, offset + y * stride * srcBpp, stride, fmt,
            this.fallbackConvBuf, y * stride * 4);
        }
        pixels = this.fallbackConvBuf.subarray(0, stride * PSP_HEIGHT * 4);
      }
      // Flip Y: VRAM is PSP-order (row 0 = top), WebGL texture is bottom-up
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Math.min(stride, 512), PSP_HEIGHT,
        gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    } else {
      return; // nothing to present
    }

    gl.uniform1i(presTexLoc, 0);
    twgl.drawBufferInfo(gl, this.presentBuffer);
  }



  /** Invalidate all cached textures (e.g., after block transfer to VRAM).
   *  PPSSPP uses hash-based invalidation with backoff; we invalidate per-frame for correctness.
   *  Games modify texture data in RAM between frames (animations, dynamic textures). */
  invalidateTextures(): void {
    const gl = this.gl;
    for (const entry of this.texCache.values()) {
      gl.deleteTexture(entry.tex);
    }
    this.texCache.clear();
  }

  /** Called at frame start. Textures are only invalidated on block transfers now,
   *  not per-frame — PPSSPP uses hash-based invalidation, not per-frame flush. */
  onFrameStart(): void {
    this.frameCount++;
    this.decimateVFBs(); // PPSSPP BeginFrame → DecimateFBOs
  }

  /** Normalize a PSP framebuffer address to an absolute VRAM address.
   *  GE uses VRAM-relative (0x0=VRAM base), sceDisplay uses absolute (0x04000000). */
  private normFb(addr: number): number {
    const p = addr & 0x1FFFFFFF;
    return p < 0x04000000 ? 0x04000000 + p : p;
  }

  /** Get or create a VFB for the given address. PPSSPP DoSetRenderFrameBuffer. */
  private getOrCreateVFB(addr: number, format = 3, stride = 512): { fbo: WebGLFramebuffer; tex: WebGLTexture; depthRb: WebGLRenderbuffer; lastFrameUsed: number; format: number; stride: number } {
    const key = this.normFb(addr);
    const existing = this.vfbs.get(key);
    if (existing) {
      existing.lastFrameUsed = this.frameCount;
      existing.format = format; // games can reinterpret a buffer's format
      existing.stride = stride || 512;
      return existing;
    }

    const gl = this.gl;
    const fbo = gl.createFramebuffer()!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.fbW, this.fbH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const depthRb = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, this.fbW, this.fbH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    gl.viewport(0, 0, this.fbW, this.fbH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const vfb = { fbo, tex, depthRb, lastFrameUsed: this.frameCount, format, stride: stride || 512 };
    this.vfbs.set(key, vfb);
    return vfb;
  }

  /** Bind the VFB for the given address as the render target. */
  private bindRenderTarget(addr: number, format = 3, stride = 512): void {
    const key = this.normFb(addr);
    if (key === this.currentRenderAddr) {
      const cur = this.vfbs.get(key);
      if (cur) { cur.format = format; cur.stride = stride || 512; }
      return;
    }
    const vfb = this.getOrCreateVFB(addr, format, stride);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, vfb.fbo);
    this.currentRenderAddr = key;
  }

  /** Find VFB at address, or null. PPSSPP GetVFBAt. */
  getVFBAt(addr: number): { fbo: WebGLFramebuffer; tex: WebGLTexture } | null {
    return this.vfbs.get(this.normFb(addr)) ?? null;
  }

  /** Find the VFB whose VRAM range contains addr (offset-tolerant, like PPSSPP
   *  FindTransferFramebuffer). Returns the VFB base address, or -1. */
  findVFBBaseContaining(addr: number): number {
    const norm = this.normFb(addr);
    for (const [base, vfb] of this.vfbs) {
      const bpp = vfb.format === 3 ? 4 : 2;
      if (norm >= base && norm < base + vfb.stride * PSP_HEIGHT * bpp) return base;
    }
    return -1;
  }

  /**
   * Upload a just-transferred rect from VRAM bytes into the VFB covering dstAddr.
   * PPSSPP NotifyBlockTransferAfter (FramebufferManagerCommon.cpp:2823): when a
   * block transfer writes from plain memory INTO a framebuffer, the pixels must
   * be drawn into the FBO or the transfer is invisible (FBO content never sees
   * CPU memory). This is how many games place backgrounds and video frames.
   * dstStride/dstX/dstY/width/height/bpp are in transfer units (bpp 2 or 4).
   */
  uploadRectFromVRAM(
    vram: Uint8Array, dstAddr: number,
    dstStride: number, dstX: number, dstY: number,
    width: number, height: number, bpp: number,
  ): boolean {
    const base = this.findVFBBaseContaining(dstAddr);
    if (base < 0) return false;
    const vfb = this.vfbs.get(base)!;
    const vfbBpp = vfb.format === 3 ? 4 : 2;
    const fbStride = vfb.stride;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, vfb.tex);
    // FBO textures store the PSP image bottom-up (present quad maps v=0 to the
    // bottom). FLIP_Y + flipped y offsets place rects correctly.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);

    // Each transferred row lives in VRAM at the TRANSFER's pitch; map it into
    // the VFB's own (stride, format) pixel space. When the pitches agree the
    // whole rect is one contiguous upload; otherwise upload row by row.
    const baseOff = this.normFb(dstAddr) - base;
    const rowFb = (r: number): { px: number; py: number } => {
      const byte = baseOff + ((dstY + r) * dstStride + dstX) * bpp;
      const p = Math.floor(byte / vfbBpp);
      return { px: p % fbStride, py: Math.floor(p / fbStride) };
    };
    const { px, py } = rowFb(0);
    const wpx = Math.min(Math.ceil((width * bpp) / vfbBpp), fbStride - px, 512 - px);
    if (wpx <= 0 || py < 0 || py >= PSP_HEIGHT) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      return false;
    }
    const vramBase = base - 0x04000000;

    // At scale > 1 the FBO is bigger than the PSP buffer, so each decoded PSP
    // pixel is nearest-upscaled into a scale×scale block. Upload row by row.
    const s = this.scale;
    if (s !== 1) {
      const row1x = new Uint8Array(wpx * 4);
      const rowBytes = wpx * s * 4;
      const outS = new Uint8Array(rowBytes * s); // s rows tall, wpx*s wide
      for (let r = 0; r < height; r++) {
        const pos = rowFb(r);
        if (pos.py < 0 || pos.py >= PSP_HEIGHT || pos.px + wpx > fbStride) continue;
        const src = vramBase + (pos.py * fbStride + pos.px) * vfbBpp;
        if (src < 0 || src + wpx * vfbBpp > vram.length) continue;
        decodeFbRowToRGBA(vram, src, wpx, vfb.format, row1x, 0);
        for (let x = 0; x < wpx; x++) {
          const r0 = row1x[x * 4]!, g0 = row1x[x * 4 + 1]!, b0 = row1x[x * 4 + 2]!, a0 = row1x[x * 4 + 3]!;
          for (let sx = 0; sx < s; sx++) {
            const di = (x * s + sx) * 4;
            outS[di] = r0; outS[di + 1] = g0; outS[di + 2] = b0; outS[di + 3] = a0;
          }
        }
        for (let sy = 1; sy < s; sy++) outS.copyWithin(sy * rowBytes, 0, rowBytes);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, pos.px * s, (PSP_HEIGHT - 1 - pos.py) * s,
          wpx * s, s, gl.RGBA, gl.UNSIGNED_BYTE, outS);
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      vfb.lastFrameUsed = this.frameCount;
      return true;
    }

    const samePitch = dstStride * bpp === fbStride * vfbBpp;

    if (samePitch) {
      const rows = Math.min(height, PSP_HEIGHT - py);
      const out = new Uint8Array(wpx * rows * 4);
      for (let y = 0; y < rows; y++) {
        const src = vramBase + ((py + y) * fbStride + px) * vfbBpp;
        if (src < 0 || src + wpx * vfbBpp > vram.length) { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0); return false; }
        decodeFbRowToRGBA(vram, src, wpx, vfb.format, out, y * wpx * 4);
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, px, PSP_HEIGHT - (py + rows), wpx, rows,
        gl.RGBA, gl.UNSIGNED_BYTE, out);
    } else {
      const out = new Uint8Array(wpx * 4);
      for (let r = 0; r < height; r++) {
        const pos = rowFb(r);
        if (pos.py < 0 || pos.py >= PSP_HEIGHT || pos.px + wpx > fbStride) continue;
        const src = vramBase + (pos.py * fbStride + pos.px) * vfbBpp;
        if (src < 0 || src + wpx * vfbBpp > vram.length) continue;
        decodeFbRowToRGBA(vram, src, wpx, vfb.format, out, 0);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, pos.px, PSP_HEIGHT - 1 - pos.py, wpx, 1,
          gl.RGBA, gl.UNSIGNED_BYTE, out);
      }
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    vfb.lastFrameUsed = this.frameCount;
    return true;
  }

  /** Read FBO pixels back to VRAM in the VFB's own pixel format and stride.
   *  PPSSPP ReadFramebufferToMemory. */
  readbackToVRAM(vram: Uint8Array, addr: number): void {
    const key = this.normFb(addr);
    const vfb = this.vfbs.get(key);
    if (!vfb) return;
    this._dbgReadbackCount++;
    const stride = vfb.stride;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, vfb.fbo);
    // The FBO is scale× bigger; read it all, then nearest-downsample one sample
    // per PSP pixel (pick the top-left subpixel of each scale×scale block).
    const s = this.scale;
    const readW = Math.min(stride, 512);
    const readWs = readW * s;
    const readHs = PSP_HEIGHT * s;
    const buf = new Uint8Array(readWs * readHs * 4);
    gl.readPixels(0, 0, readWs, readHs, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const phys = key - 0x04000000;
    if (phys < 0) return;
    const bpp = vfb.format === 3 ? 4 : 2;
    for (let y = 0; y < PSP_HEIGHT; y++) {
      const srcYs = readHs - 1 - y * s; // top-down logical row → bottom-up scaled row
      for (let x = 0; x < readW; x++) {
        const si = (srcYs * readWs + x * s) * 4;
        const di = phys + (y * stride + x) * bpp;
        if (di + bpp > vram.length) continue;
        packRGBAToFb(buf[si]!, buf[si + 1]!, buf[si + 2]!, buf[si + 3]!,
          vfb.format, vram, di);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.currentRenderAddr = 0; // binding no longer matches any VFB
  }

  /** Clean up old VFBs not used for 5+ frames. PPSSPP DecimateFBOs. */
  decimateVFBs(): void {
    const gl = this.gl;
    for (const [key, vfb] of this.vfbs) {
      if (key === this.displayFbAddr) continue; // protect display buffer
      if (this.frameCount - vfb.lastFrameUsed > 5) {
        gl.deleteFramebuffer(vfb.fbo);
        gl.deleteTexture(vfb.tex);
        gl.deleteRenderbuffer(vfb.depthRb);
        this.vfbs.delete(key);
      }
    }
  }

  /** GPU blit from one VFB to another. PPSSPP BlitFramebuffer.
   *  Used for block transfers where both src and dst are VFBs — no CPU roundtrip needed. */
  blitVFB(srcAddr: number, dstAddr: number): boolean {
    const srcKey = this.normFb(srcAddr);
    const dstKey = this.normFb(dstAddr);
    const srcVfb = this.vfbs.get(srcKey);
    const dstVfb = this.vfbs.get(dstKey);
    if (!srcVfb || !dstVfb || srcKey === dstKey) return false;
    this._dbgBlitCount++;
    if (this._dbgBlitCount <= 3) {
      console.log(`[VFB] Blit 0x${srcKey.toString(16)} → 0x${dstKey.toString(16)}`);
    }

    const gl = this.gl;
    // Draw source FBO texture into destination FBO as a fullscreen quad
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstVfb.fbo);
    gl.viewport(0, 0, this.fbW, this.fbH);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);

    gl.useProgram(this.presentProgram.program);
    twgl.setBuffersAndAttributes(gl, this.presentProgram, this.presentBuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcVfb.tex);
    const loc = gl.getUniformLocation(this.presentProgram.program, "u_texture");
    gl.uniform1i(loc, 0);
    twgl.drawBufferInfo(gl, this.presentBuffer);

    // Reset state tracking
    this.currentBlendEnabled = false;
    this.currentDepthEnabled = false;
    this.currentScissorEnabled = false;
    this.currentCullEnabled = false;
    this.currentStencilEnabled = false;
    this.currentRenderAddr = dstKey;

    return true;
  }

  setVRAM(vram: Uint8Array): void { this.vramRef = vram; }

  /** Set the internal resolution multiplier (1, 2, 3...). Resizes the canvas
   *  backing store to scale*480 x scale*272 and drops any existing VFBs so they
   *  get recreated at the new size. Call before booting (no VFBs exist yet). */
  setResolutionScale(scale: number): void {
    const n = Math.max(1, Math.min(4, Math.floor(scale)));
    const gl = this.gl;
    // Always size the canvas backing store — the DOM canvas persists across
    // boots, so a previous 2× run could leave it oversized for a fresh 1× run.
    const canvas = gl.canvas as HTMLCanvasElement;
    canvas.width = PSP_WIDTH * n;
    canvas.height = PSP_HEIGHT * n;
    if (n === this.scale) return;
    this.scale = n;
    for (const vfb of this.vfbs.values()) {
      gl.deleteFramebuffer(vfb.fbo);
      gl.deleteTexture(vfb.tex);
      gl.deleteRenderbuffer(vfb.depthRb);
    }
    this.vfbs.clear();
    this.currentRenderAddr = 0;
  }

  /** Set display buffer. PPSSPP displayFramebufPtr_. */
  setDisplayFramebuf(addr: number, width = 512, format = 3): void {
    this.displayFbAddr = this.normFb(addr);
    this.displayFbWidth = width || 512;
    this.displayFbFormat = format;
  }

  /** Get the WebGL context (shared with FramebufferRenderer if needed). */
  getGL(): WebGLRenderingContext {
    return this.gl;
  }

  destroy(): void {
    const gl = this.gl;
    for (const vfb of this.vfbs.values()) {
      gl.deleteFramebuffer(vfb.fbo);
      gl.deleteTexture(vfb.tex);
      gl.deleteRenderbuffer(vfb.depthRb);
    }
    this.vfbs.clear();
    if (this.vramFallbackTex) gl.deleteTexture(this.vramFallbackTex);
    gl.deleteBuffer(this.glBuffer);
    gl.deleteTexture(this.dummyTex);
    for (const entry of this.texCache.values()) {
      gl.deleteTexture(entry.tex);
    }
    this.texCache.clear();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  // Per-draw-call state
  private uvScaleU = 1;
  private uvScaleV = 1;
  private uvOffsetU = 0;
  private uvOffsetV = 0;
  private flatColor = -1;       // -1 = gouraud (use vertex color); >= 0 = flat shading color

  /** Configure UV normalization for the current draw call. */
  private setupUVNormalization(state: GEDrawState): void {
    if (!state.texEnable) {
      this.uvScaleU = 1; this.uvScaleV = 1;
      this.uvOffsetU = 0; this.uvOffsetV = 0;
      return;
    }

    const ts = state.texState;
    const tw = ts.texWidth0 || 1;
    const th = ts.texHeight0 || 1;
    // PPSSPP SoftwareTransformCommon.cpp:154-159: divides by curTextureWidth/Height
    // which is getTextureWidth(0) = texWidth, NOT texBufWidth.
    // The WebGL texture is uploaded at texWidth dimensions (matching the normalized UV space).

    if (state.throughMode) {
      // Through mode: UV is raw texel coords → normalize by dividing by texWidth/texHeight
      this.uvScaleU = 1 / tw;
      this.uvScaleV = 1 / th;
      this.uvOffsetU = 0;
      this.uvOffsetV = 0;
    } else if (ts.texMapMode === 1) {
      // TEXTURE_MATRIX mode: UVs already transformed, multiply by tex size → normalize
      // sampleTexture does: rawU = u * tw → texel coords. normalized = u * tw / tw = u
      this.uvScaleU = 1;
      this.uvScaleV = 1;
      this.uvOffsetU = 0;
      this.uvOffsetV = 0;
    } else {
      // Transform mode (texMapMode 0): PPSSPP TransformUnit computes
      // uv = tc * uvScale + uvOff in NORMALIZED space (the rasterizer then
      // multiplies by texture size). Normalized GL coords use it directly.
      this.uvScaleU = ts.texScaleU;
      this.uvScaleV = ts.texScaleV;
      this.uvOffsetU = ts.texOffsetU;
      this.uvOffsetV = ts.texOffsetV;
    }
  }

  private pushVertex(v: Vertex): void {
    if (this.vertexCount >= MAX_VERTS) return;
    const base = this.vertexCount * FLOATS_PER_VERT;
    const d = this.vertexData;
    d[base]     = v.x;
    d[base + 1] = v.y;
    d[base + 2] = v.z;

    // Normalize UVs to [0,1] for WebGL texture sampling
    d[base + 3] = v.u * this.uvScaleU + this.uvOffsetU;
    d[base + 4] = v.v * this.uvScaleV + this.uvOffsetV;

    // Unpack ABGR8888 vertex color to normalized RGBA floats
    const c = this.flatColor >= 0 ? this.flatColor : v.color;
    d[base + 5] = (c & 0xFF) / 255;              // R
    d[base + 6] = ((c >>> 8) & 0xFF) / 255;      // G
    d[base + 7] = ((c >>> 16) & 0xFF) / 255;     // B
    d[base + 8] = ((c >>> 24) & 0xFF) / 255;     // A

    // Fog coefficient (pre-computed per vertex, 1.0 = no fog, 0.0 = full fog)
    d[base + 9] = v.fogCoef;

    this.vertexCount++;
  }

  /** Expand a sprite (2 vertices) to 2 triangles (6 vertices).
   *  Matches PPSSPP SoftwareTransformCommon.cpp:636-658 ExpandRectangles:
   *  v0 = first vertex (TL), v1 = second vertex (BR).
   *  v1's color is used for all 4 corners.
   *  UV corners: TL=(v0.u, v0.v), BR=(v1.u, v1.v), TR=(v1.u, v0.v), BL=(v0.u, v1.v).
   *  Position does NOT affect UV assignment (no min/max swap). */
  private expandSprite(v0: Vertex, v1: Vertex): void {
    const col = v1.color;
    const z = v1.z;

    // Bottom-right corner = v1 as-is
    const br: Vertex = { x: v1.x, y: v1.y, z, u: v1.u, v: v1.v, color: col, nx: 0, ny: 0, nz: 1, clipw: 1, fogCoef: 1 };
    // Top-right: v1's X, v0's Y; v1's U, v0's V
    const tr: Vertex = { x: v1.x, y: v0.y, z, u: v1.u, v: v0.v, color: col, nx: 0, ny: 0, nz: 1, clipw: 1, fogCoef: 1 };
    // Top-left: v0's X and Y; v0's U and V
    const tl: Vertex = { x: v0.x, y: v0.y, z, u: v0.u, v: v0.v, color: col, nx: 0, ny: 0, nz: 1, clipw: 1, fogCoef: 1 };
    // Bottom-left: v0's X, v1's Y; v0's U, v1's V
    const bl: Vertex = { x: v0.x, y: v1.y, z, u: v0.u, v: v1.v, color: col, nx: 0, ny: 0, nz: 1, clipw: 1, fogCoef: 1 };

    // Two triangles: BR-TR-TL, TL-BL-BR (matching PPSSPP's index order)
    this.pushVertex(br);
    this.pushVertex(tr);
    this.pushVertex(tl);
    this.pushVertex(tl);
    this.pushVertex(bl);
    this.pushVertex(br);
  }

  /** Content hash of the texture bytes (+ CLUT). Samples a 2D grid over the
   *  actual width×height so in-place CPU updates anywhere are caught — used to
   *  invalidate the cache when a texture's pixels change. A plain linear stride
   *  is dangerous here: when it lands on a multiple of the row pitch (e.g. a
   *  512-wide 8888 framebuffer-texture), every sample hits the same column and
   *  the hash never changes, so video frames decoded into a reused buffer look
   *  frozen (the GE re-uses the stale uploaded texture). The grid walks columns
   *  and rows independently, so horizontal motion is always seen. */
  private hashTexture(texState: GETextureState, bus: MemoryBus): number {
    const fmt = texState.texFormat;
    const bppNum = fmt === 3 ? 4 : fmt >= 4 ? 1 : 2; // 8888=4B, CLUT4/8≈1B, 16-bit=2B
    const stride = (texState.texBufWidth0 || texState.texWidth0) || 1;
    const w = texState.texWidth0 || stride;
    const h = texState.texHeight0 || 1;
    const base = texState.texAddr0 >>> 0;
    const rowBytes = stride * bppNum;
    let hash = 0;
    const XS = 16, YS = 16; // 256 samples spread across the texture
    for (let yi = 0; yi < YS; yi++) {
      const y = ((yi * h) / YS) | 0;
      for (let xi = 0; xi < XS; xi++) {
        const x = ((xi * w) / XS) | 0;
        hash = (hash ^ bus.readU32(base + y * rowBytes + x * bppNum)) >>> 0;
        hash = (hash * 0x01000193) >>> 0; // FNV-style mix so position matters
      }
    }
    if (texState.clutAddr) {
      for (let i = 0; i < 16; i++) hash = (hash ^ bus.readU32(texState.clutAddr + i * 16)) >>> 0;
    }
    return hash;
  }

  private getOrUploadTexture(texState: GETextureState, bus: MemoryBus): WebGLTexture {
    // Framebuffer-as-texture: if texture address matches a known VFB, use it directly.
    // Can't use it if it's the CURRENT render target (would read while writing).
    // PPSSPP TextureCacheCommon.cpp:629 — GetBestFramebufferCandidate.
    const texAddrNorm = this.normFb(texState.texAddr0);
    const texVfb = this.vfbs.get(texAddrNorm);
    if (texVfb && texAddrNorm !== this.currentRenderAddr) {
      return texVfb.tex;
    }

    const gl = this.gl;
    const key = texCacheKey(texState);
    const hash = this.hashTexture(texState, bus);
    const cached = this.texCache.get(key);
    if (cached) {
      if (cached.hash === hash) return cached.tex;
      gl.deleteTexture(cached.tex); // content changed in place — re-upload
      this.texCache.delete(key);
    }

    const { data, width, height } = decodeTexture(bus, texState);

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    this.texCache.set(key, { tex, hash });

    // Evict old entries if cache gets too large
    if (this.texCache.size > 512) {
      const firstKey = this.texCache.keys().next().value;
      if (firstKey !== undefined) {
        const old = this.texCache.get(firstKey);
        if (old) gl.deleteTexture(old.tex);
        this.texCache.delete(firstKey);
      }
    }

    return tex;
  }

  private applyBlendState(gl: WebGLRenderingContext, frag: GEFragmentState): void {
    if (frag.alphaBlendEnable) {
      if (!this.currentBlendEnabled) { gl.enable(gl.BLEND); this.currentBlendEnabled = true; }

      const eq = mapBlendOp(gl, frag.blendOp, this.blendMinEq, this.blendMaxEq);
      // Color uses the PSP blend op; alpha stays ADD so the ZERO/ONE alpha
      // factors below keep destination alpha (stencil). A MIN/MAX color eq must
      // not bleed into alpha — MIN/MAX ignore factors. Matches PPSSPP, which
      // sets color and alpha equations separately.
      gl.blendEquationSeparate(eq, gl.FUNC_ADD);

      // Handle FIXA/FIXB: PSP has separate fixed colors, WebGL has one blendColor.
      // PPSSPP GPUStateUtils.cpp:1303-1349 — 3-tier fallback.
      if (frag.blendSrc === 10 && frag.blendDst === 10) {
        // Both use fixed color — try to unify
        const fixA = frag.blendFixedA;
        const fixB = frag.blendFixedB;
        const invA = (~fixA) & 0xFFFFFF;
        if (colorsClose(fixA, invA, fixB)) {
          // fixA ≈ ~fixB → use CONSTANT_COLOR + ONE_MINUS_CONSTANT_COLOR
          gl.blendColor(
            (fixA & 0xFF) / 255, ((fixA >>> 8) & 0xFF) / 255,
            ((fixA >>> 16) & 0xFF) / 255, 1.0,
          );
          gl.blendFuncSeparate(gl.CONSTANT_COLOR, gl.ONE_MINUS_CONSTANT_COLOR, gl.ZERO, gl.ONE);
        } else if (colorsClose(fixA, fixA, fixB)) {
          // fixA ≈ fixB → use CONSTANT_COLOR for both
          gl.blendColor(
            (fixA & 0xFF) / 255, ((fixA >>> 8) & 0xFF) / 255,
            ((fixA >>> 16) & 0xFF) / 255, 1.0,
          );
          gl.blendFuncSeparate(gl.CONSTANT_COLOR, gl.CONSTANT_COLOR, gl.ZERO, gl.ONE);
        } else {
          // Can't unify — approximate: pick fixA for blendColor, approximate fixB
          gl.blendColor(
            (fixA & 0xFF) / 255, ((fixA >>> 8) & 0xFF) / 255,
            ((fixA >>> 16) & 0xFF) / 255, 1.0,
          );
          gl.blendFuncSeparate(
            gl.CONSTANT_COLOR, blendColor2Func(gl, fixB), gl.ZERO, gl.ONE,
          );
        }
      } else if (frag.blendSrc === 10) {
        gl.blendColor(
          (frag.blendFixedA & 0xFF) / 255, ((frag.blendFixedA >>> 8) & 0xFF) / 255,
          ((frag.blendFixedA >>> 16) & 0xFF) / 255, 1.0,
        );
        gl.blendFuncSeparate(
          gl.CONSTANT_COLOR, mapBlendFactor(gl, frag.blendDst, false), gl.ZERO, gl.ONE,
        );
      } else if (frag.blendDst === 10) {
        gl.blendColor(
          (frag.blendFixedB & 0xFF) / 255, ((frag.blendFixedB >>> 8) & 0xFF) / 255,
          ((frag.blendFixedB >>> 16) & 0xFF) / 255, 1.0,
        );
        gl.blendFuncSeparate(
          mapBlendFactor(gl, frag.blendSrc, true), gl.CONSTANT_COLOR, gl.ZERO, gl.ONE,
        );
      } else {
        // No fixed color — standard factors.
        // PSP: alpha channel preserves destination (stencil). PPSSPP GPUStateUtils.cpp:1450.
        // Alpha factors = (ZERO, ONE): alphaOut = 0*srcA + 1*dstA = dstA.
        gl.blendFuncSeparate(
          mapBlendFactor(gl, frag.blendSrc, true),
          mapBlendFactor(gl, frag.blendDst, false),
          gl.ZERO, gl.ONE,
        );
      }
    } else {
      if (this.currentBlendEnabled) { gl.disable(gl.BLEND); this.currentBlendEnabled = false; }
    }
  }

  private applyDepthState(gl: WebGLRenderingContext, state: GEDrawState): void {
    if (state.depthTestEnable) {
      if (!this.currentDepthEnabled) { gl.enable(gl.DEPTH_TEST); this.currentDepthEnabled = true; }
      gl.depthFunc(mapDepthFunc(gl, state.depthFunc));
      gl.depthMask(!state.depthWriteDisable);
    } else {
      if (this.currentDepthEnabled) { gl.disable(gl.DEPTH_TEST); this.currentDepthEnabled = false; }
    }
  }

  private applyScissorState(gl: WebGLRenderingContext, state: GEDrawState): void {
    const hasScissor = state.scissorX1 > 0 || state.scissorY1 > 0 ||
                       state.scissorX2 < 479 || state.scissorY2 < 271;
    if (hasScissor) {
      if (!this.currentScissorEnabled) { gl.enable(gl.SCISSOR_TEST); this.currentScissorEnabled = true; }
      // PSP Y-down → WebGL Y-up, scaled to the render target.
      const s = this.scale;
      const glY = PSP_HEIGHT - 1 - state.scissorY2;
      const w = state.scissorX2 - state.scissorX1 + 1;
      const h = state.scissorY2 - state.scissorY1 + 1;
      gl.scissor(state.scissorX1 * s, glY * s, w * s, h * s);
    } else {
      if (this.currentScissorEnabled) { gl.disable(gl.SCISSOR_TEST); this.currentScissorEnabled = false; }
    }
  }

  private applyCullState(gl: WebGLRenderingContext, state: GEDrawState): void {
    if (state.cullEnable) {
      if (!this.currentCullEnabled) { gl.enable(gl.CULL_FACE); this.currentCullEnabled = true; }
      // PSP CW = cull clockwise faces. WebGL: gl.FRONT is CCW by default (glFrontFace(CCW)).
      // So CW culling = gl.FRONT (if CCW is front, then CW faces are BACK)
      // Actually PSP: cullCW=true means cull CW-wound triangles.
      // WebGL default: front face = CCW. gl.cullFace(BACK) culls CCW, gl.cullFace(FRONT) culls CW.
      // Wait — WebGL Y is flipped in our FBO, which reverses winding. So invert.
      gl.cullFace(state.cullCW ? gl.BACK : gl.FRONT);
    } else {
      if (this.currentCullEnabled) { gl.disable(gl.CULL_FACE); this.currentCullEnabled = false; }
    }
  }

  private applyStencilState(gl: WebGLRenderingContext, frag: GEFragmentState): void {
    if (frag.stencilTestEnable) {
      if (!this.currentStencilEnabled) { gl.enable(gl.STENCIL_TEST); this.currentStencilEnabled = true; }
      gl.stencilFunc(mapStencilFunc(gl, frag.stencilFunc), frag.stencilRef, frag.stencilMask);
      gl.stencilOp(
        mapStencilOp(gl, frag.stencilSFail),
        mapStencilOp(gl, frag.stencilZFail),
        mapStencilOp(gl, frag.stencilZPass),
      );
    } else {
      if (this.currentStencilEnabled) { gl.disable(gl.STENCIL_TEST); this.currentStencilEnabled = false; }
    }
  }

  private applyColorMask(gl: WebGLRenderingContext, frag: GEFragmentState): void {
    // PSP mask: bit=1 means DON'T write. Invert to get OpenGL-style mask.
    // PPSSPP GPUStateUtils.cpp:1086-1127: inverts then uses threshold >= 128 for per-channel enable.
    // WebGL only supports per-channel on/off, not per-bit masks.
    const invR = (~frag.maskRgb) & 0xFF;
    const invG = (~frag.maskRgb >>> 8) & 0xFF;
    const invB = (~frag.maskRgb >>> 16) & 0xFF;
    const invA = (~frag.maskAlpha) & 0xFF;
    gl.colorMask(invR >= 128, invG >= 128, invB >= 128, invA >= 128);
  }
}
