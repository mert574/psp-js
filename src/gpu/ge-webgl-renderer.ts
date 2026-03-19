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
import { VS_GE, FS_GE, VS_PRESENT, FS_PRESENT } from "./ge-shaders.js";
import { Logger } from "../utils/logger.js";

const log = Logger.get("GE-GL");

const PSP_WIDTH = 480;
const PSP_HEIGHT = 272;

// Max vertices per batch before flush
const MAX_VERTS = 65536;

// 9 floats per vertex: x, y, z, u, v, r, g, b, a
const FLOATS_PER_VERT = 9;

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

/** Map PSP blend op to WebGL. */
function mapBlendOp(gl: WebGLRenderingContext, op: number): number {
  switch (op) {
    case 0: return gl.FUNC_ADD;
    case 1: return gl.FUNC_SUBTRACT;
    case 2: return gl.FUNC_REVERSE_SUBTRACT;
    // MIN/MAX/ABS: WebGL1 doesn't have these natively — fallback to ADD
    case 3: return gl.FUNC_ADD; // MIN
    case 4: return gl.FUNC_ADD; // MAX
    case 5: return gl.FUNC_ADD; // ABS
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

/** Check if two 24-bit colors are close enough to unify (PPSSPP GPUStateUtils.cpp). */
function colorsClose(refColor: number, a: number, b: number): boolean {
  // Allow a small tolerance per channel (like PPSSPP does)
  void refColor;
  for (let i = 0; i < 3; i++) {
    const ca = (a >>> (i * 8)) & 0xFF;
    const cb = (b >>> (i * 8)) & 0xFF;
    if (Math.abs(ca - cb) > 4) return false;
  }
  return true;
}

/** Approximate a 24-bit fixed color as a standard GL blend factor (PPSSPP blendColor2Func). */
function blendColor2Func(gl: WebGLRenderingContext, color: number): number {
  const r = color & 0xFF, g = (color >>> 8) & 0xFF, b = (color >>> 16) & 0xFF;
  if (r < 4 && g < 4 && b < 4) return gl.ZERO;
  if (r > 251 && g > 251 && b > 251) return gl.ONE;
  return gl.CONSTANT_COLOR; // fallback: use blendColor (set to other fixColor)
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

export class WebGLGERenderer {
  private gl: WebGLRenderingContext;
  private geProgram: twgl.ProgramInfo;
  private presentProgram: twgl.ProgramInfo;
  private presentBuffer: twgl.BufferInfo;

  // Offscreen FBO for GE rendering
  private fbo: WebGLFramebuffer;
  private fboTex: WebGLTexture;
  private depthRb: WebGLRenderbuffer;

  // Dynamic vertex buffer
  private vertexData = new Float32Array(MAX_VERTS * FLOATS_PER_VERT);
  private vertexCount = 0;
  private glBuffer: WebGLBuffer;


  // Texture cache
  private texCache = new Map<string, WebGLTexture>();
  private dummyTex: WebGLTexture;

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

    // Create offscreen FBO (512x272 to match PSP stride)
    const fbo = gl.createFramebuffer()!;
    this.fbo = fbo;

    const fboTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 512, PSP_HEIGHT, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fboTex = fboTex;

    const depthRb = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, 512, PSP_HEIGHT);
    this.depthRb = depthRb;

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depthRb);

    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
      log.error(`FBO incomplete: 0x${fbStatus.toString(16)}`);
    }

    // Clear FBO to black
    gl.viewport(0, 0, 512, PSP_HEIGHT);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

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

    // Bind FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, 512, PSP_HEIGHT);

    // Set up UV normalization for this draw call
    this.setupUVNormalization(state);

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

    if (primType === 6) {
      // SPRITES: expand each pair to 2 triangles
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        this.expandSprite(vertices[i]!, vertices[i + 1]!);
      }
    } else if (primType === 3) {
      // TRIANGLES
      for (let i = 0; i + 2 < vertices.length; i += 3) {
        this.pushVertex(vertices[i]!);
        this.pushVertex(vertices[i + 1]!);
        this.pushVertex(vertices[i + 2]!);
      }
    } else if (primType === 4) {
      // TRIANGLE_STRIP → expand to individual triangles
      for (let i = 0; i + 2 < vertices.length; i++) {
        if (i & 1) {
          this.pushVertex(vertices[i + 1]!);
          this.pushVertex(vertices[i]!);
          this.pushVertex(vertices[i + 2]!);
        } else {
          this.pushVertex(vertices[i]!);
          this.pushVertex(vertices[i + 1]!);
          this.pushVertex(vertices[i + 2]!);
        }
      }
    } else if (primType === 5) {
      // TRIANGLE_FAN
      for (let i = 1; i + 1 < vertices.length; i++) {
        this.pushVertex(vertices[0]!);
        this.pushVertex(vertices[i]!);
        this.pushVertex(vertices[i + 1]!);
      }
    } else if (primType === 1) {
      // LINES
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        this.pushVertex(vertices[i]!);
        this.pushVertex(vertices[i + 1]!);
      }
    } else if (primType === 2) {
      // LINE_STRIP
      for (let i = 0; i + 1 < vertices.length; i++) {
        this.pushVertex(vertices[i]!);
        this.pushVertex(vertices[i + 1]!);
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

    // Bind attributes manually (interleaved buffer)
    const stride = FLOATS_PER_VERT * 4;
    const posLoc = gl.getAttribLocation(this.geProgram.program, "a_position");
    const uvLoc = gl.getAttribLocation(this.geProgram.program, "a_texcoord");
    const colLoc = gl.getAttribLocation(this.geProgram.program, "a_color");

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

    twgl.setUniforms(this.geProgram, {
      u_resolution: [PSP_WIDTH, PSP_HEIGHT],
      u_texEnable: state.texEnable,
      u_texFunc: frag.texFunc,
      u_texFuncAlpha: frag.texFuncAlpha,
      u_texEnvColor: [envR, envG, envB],
      u_alphaTestEnable: frag.alphaTestEnable,
      u_alphaTestFunc: frag.alphaTestFunc,
      u_alphaTestRef: frag.alphaTestRef,
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
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, 512, PSP_HEIGHT);

    // Use scissor to limit the clear to the requested rectangle
    gl.enable(gl.SCISSOR_TEST);
    // WebGL scissor Y is bottom-up, PSP is top-down
    const glY0 = PSP_HEIGHT - y1;
    const glY1 = PSP_HEIGHT - y0;
    gl.scissor(x0, glY0, x1 - x0, glY1 - glY0);

    gl.colorMask(colorWrite, colorWrite, colorWrite, alphaWrite);
    gl.depthMask(depthWrite);
    gl.clearColor(r / 255, g / 255, b / 255, a / 255);

    let clearBits = 0;
    if (colorWrite || alphaWrite) clearBits |= gl.COLOR_BUFFER_BIT;
    if (depthWrite) clearBits |= gl.DEPTH_BUFFER_BIT;
    if (clearBits) gl.clear(clearBits);

    // Restore defaults and reset tracking flags (we modified GL state directly)
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
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
    gl.viewport(0, 0, PSP_WIDTH, PSP_HEIGHT);

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

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    const presTexLoc = gl.getUniformLocation(this.presentProgram.program, "u_texture");
    gl.uniform1i(presTexLoc, 0);

    twgl.drawBufferInfo(gl, this.presentBuffer);

  }

  /**
   * Read back the FBO contents into a VRAM buffer.
   * Only needed when CPU code reads from the framebuffer region.
   */
  readbackToVRAM(vram: Uint8Array, fbPtr: number, fbWidth: number, _fbFormat: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);

    const buf = new Uint8Array(fbWidth * PSP_HEIGHT * 4);
    gl.readPixels(0, 0, fbWidth, PSP_HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    // Convert RGBA → ABGR8888 and write to VRAM (flip Y since WebGL is bottom-up)
    const phys = (fbPtr & 0x1FFFFFFF) - 0x04000000;
    if (phys < 0) return;

    for (let y = 0; y < PSP_HEIGHT; y++) {
      const srcY = PSP_HEIGHT - 1 - y; // flip
      for (let x = 0; x < fbWidth; x++) {
        const si = (srcY * fbWidth + x) * 4;
        const di = phys + (y * fbWidth + x) * 4;
        if (di + 3 >= vram.length) continue;
        // RGBA → ABGR: vram stores as [R, G, B, A] in little-endian ABGR format
        vram[di]     = buf[si]!;     // R
        vram[di + 1] = buf[si + 1]!; // G
        vram[di + 2] = buf[si + 2]!; // B
        vram[di + 3] = buf[si + 3]!; // A
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Invalidate all cached textures (e.g., after block transfer to VRAM).
   *  PPSSPP uses hash-based invalidation with backoff; we invalidate per-frame for correctness.
   *  Games modify texture data in RAM between frames (animations, dynamic textures). */
  invalidateTextures(): void {
    const gl = this.gl;
    for (const tex of this.texCache.values()) {
      gl.deleteTexture(tex);
    }
    this.texCache.clear();
  }

  /** Call at the start of each frame to invalidate textures that may have changed.
   *  PPSSPP would hash texture data; we use a simpler per-frame flush. */
  onFrameStart(): void {
    this.invalidateTextures();
  }

  /** Get the WebGL context (shared with FramebufferRenderer if needed). */
  getGL(): WebGLRenderingContext {
    return this.gl;
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteFramebuffer(this.fbo);
    gl.deleteTexture(this.fboTex);
    gl.deleteRenderbuffer(this.depthRb);
    gl.deleteBuffer(this.glBuffer);
    gl.deleteTexture(this.dummyTex);
    for (const tex of this.texCache.values()) {
      gl.deleteTexture(tex);
    }
    this.texCache.clear();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  // UV normalization state (set per draw call)
  private uvScaleU = 1;
  private uvScaleV = 1;
  private uvOffsetU = 0;
  private uvOffsetV = 0;

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
      // Transform mode (texMapMode 0): sampleTexture applies texScaleU + texOffsetU
      // rawU = u * texScaleU + texOffsetU → texel coord → normalized = rawU / tw
      this.uvScaleU = ts.texScaleU / tw;
      this.uvScaleV = ts.texScaleV / th;
      this.uvOffsetU = ts.texOffsetU / tw;
      this.uvOffsetV = ts.texOffsetV / th;
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
    const c = v.color;
    d[base + 5] = (c & 0xFF) / 255;              // R
    d[base + 6] = ((c >>> 8) & 0xFF) / 255;      // G
    d[base + 7] = ((c >>> 16) & 0xFF) / 255;     // B
    d[base + 8] = ((c >>> 24) & 0xFF) / 255;     // A

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
    const br: Vertex = { x: v1.x, y: v1.y, z, u: v1.u, v: v1.v, color: col, nx: 0, ny: 0, nz: 1, clipw: 1 };
    // Top-right: v1's X, v0's Y; v1's U, v0's V
    const tr: Vertex = { x: v1.x, y: v0.y, z, u: v1.u, v: v0.v, color: col, nx: 0, ny: 0, nz: 1, clipw: 1 };
    // Top-left: v0's X and Y; v0's U and V
    const tl: Vertex = { x: v0.x, y: v0.y, z, u: v0.u, v: v0.v, color: col, nx: 0, ny: 0, nz: 1, clipw: 1 };
    // Bottom-left: v0's X, v1's Y; v0's U, v1's V
    const bl: Vertex = { x: v0.x, y: v1.y, z, u: v0.u, v: v1.v, color: col, nx: 0, ny: 0, nz: 1, clipw: 1 };

    // Two triangles: BR-TR-TL, TL-BL-BR (matching PPSSPP's index order)
    this.pushVertex(br);
    this.pushVertex(tr);
    this.pushVertex(tl);
    this.pushVertex(tl);
    this.pushVertex(bl);
    this.pushVertex(br);
  }

  private getOrUploadTexture(texState: GETextureState, bus: MemoryBus): WebGLTexture {
    const key = texCacheKey(texState);
    const cached = this.texCache.get(key);
    if (cached) return cached;

    const gl = this.gl;
    const { data, width, height } = decodeTexture(bus, texState);

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    this.texCache.set(key, tex);

    // Evict old entries if cache gets too large
    if (this.texCache.size > 512) {
      const firstKey = this.texCache.keys().next().value;
      if (firstKey !== undefined) {
        const old = this.texCache.get(firstKey);
        if (old) gl.deleteTexture(old);
        this.texCache.delete(firstKey);
      }
    }

    return tex;
  }

  private applyBlendState(gl: WebGLRenderingContext, frag: GEFragmentState): void {
    if (frag.alphaBlendEnable) {
      if (!this.currentBlendEnabled) { gl.enable(gl.BLEND); this.currentBlendEnabled = true; }

      const eq = mapBlendOp(gl, frag.blendOp);
      gl.blendEquation(eq);

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
      // PSP Y-down → WebGL Y-up
      const glY = PSP_HEIGHT - 1 - state.scissorY2;
      const w = state.scissorX2 - state.scissorX1 + 1;
      const h = state.scissorY2 - state.scissorY1 + 1;
      gl.scissor(state.scissorX1, glY, w, h);
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
