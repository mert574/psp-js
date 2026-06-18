import { GE_CMD } from "./ge-commands.js";
import type { MemoryBus } from "../memory/memory-bus.js";
import { Logger } from "../utils/logger.js";
import { getFloat24 } from "./ge-types.js";
import type { GeExecuteResult, Vertex } from "./ge-types.js";
import type { GETextureState } from "./ge-texture.js";
import { sampleTexture } from "./ge-texture.js";
import type { GEFragmentState } from "./ge-fragment.js";
import {
  passAlphaTest, emitFragment, applyTexFunc, writePixel as writePixelFn,
} from "./ge-fragment.js";
import {
  readVertices as readVerticesFn, skipVertices as skipVerticesFn,
} from "./ge-vertex.js";
import { computeVertexLighting } from "./ge-lighting.js";
import type { LightingState } from "./ge-lighting.js";
import { tessellateBezier, tessellateSpline } from "./ge-patches.js";
import type { WebGLGERenderer, GEDrawState } from "./ge-webgl-renderer.js";

export type { GeExecuteResult } from "./ge-types.js";
export type { Vertex } from "./ge-types.js";

const log = Logger.get("GE");

const MAX_COMMANDS = 1_000_000;

const CALL_STACK_DEPTH = 8;

/**
 * Plain, JSON-round-trippable snapshot of every mutable GE state field that
 * affects rendering or command interpretation. Produced by serialize() and
 * consumed by deserialize() for save states. Typed arrays are stored as plain
 * number arrays; nested arrays (callStack/immBuffer) are deep-copied plain objects.
 *
 * Not captured (reconstructed elsewhere): signalCallback (a JS function),
 * webglRenderer (host renderer, re-attached after restore), vram32 (a view over
 * VRAM, rebuilt from the bus), and the bus reference itself.
 */
export interface GeProcessorState {
  // Display-list control
  baseAddr: number;
  offsetAddr: number;
  callStack: Array<{ pc: number; offsetAddr: number; baseAddr?: number }>;

  // Framebuffer state
  fbPtr: number;
  fbWidth: number;
  fbFormat: number;
  lastDrawFbPtr: number;
  lastDrawFbWidth: number;
  lastDrawFbFormat: number;

  // Vertex state
  vtypeRaw: number;
  vertexAddr: number;
  indexAddr: number;

  // Clear mode
  clearMode: boolean;
  clearColorWrite: boolean;
  clearAlphaWrite: boolean;
  clearDepthWrite: boolean;

  // Texture LOD slope
  texLodSlope: number;

  // Texture state
  texAddr0: number;
  texBufWidth0: number;
  texWidth0: number;
  texHeight0: number;
  texFormat: number;
  texEnable: boolean;
  texSwizzle: boolean;
  texWrapU: number;
  texWrapV: number;
  texFunc: number;
  texFuncAlpha: boolean;
  colorDoubling: boolean;
  texEnvColor: number;
  texMinFilter: number;
  texMagFilter: number;
  texMapMode: number;
  texProjMode: number;
  texShadeLS0: number;
  texShadeLS1: number;
  tgenMat: number[];
  lightPos: number[];
  texScaleU: number;
  texScaleV: number;
  texOffsetU: number;
  texOffsetV: number;

  // CLUT
  clutAddr: number;
  clutFormat: number;
  clutShift: number;
  clutMask: number;
  clutStart: number;

  // Alpha blend
  alphaBlendEnable: boolean;
  blendSrc: number;
  blendDst: number;
  blendOp: number;
  blendFixedA: number;
  blendFixedB: number;

  // Alpha test
  alphaTestEnable: boolean;
  alphaTestFunc: number;
  alphaTestRef: number;
  alphaTestMask: number;

  // Scissor
  scissorX1: number;
  scissorY1: number;
  scissorX2: number;
  scissorY2: number;

  // Depth
  depthTestEnable: boolean;
  depthWriteDisable: boolean;
  depthFunc: number;

  // Write masks
  maskRgb: number;
  maskAlpha: number;

  // Stencil
  stencilTestEnable: boolean;
  stencilFunc: number;
  stencilRef: number;
  stencilMask: number;
  stencilSFail: number;
  stencilZFail: number;
  stencilZPass: number;

  // Color test
  colorTestEnable: boolean;
  colorTestFunc: number;
  colorTestRef: number;
  colorTestMask: number;

  // Logic op
  logicOpEnable: boolean;
  logicOp: number;

  // Dither
  ditherEnable: boolean;
  ditherMatrix: number[];

  // Fog
  fogEnable: boolean;
  fogColor: number;
  fogEnd: number;
  fogSlope: number;

  // Patch
  patchDivU: number;
  patchDivV: number;
  patchPrimType: number;
  patchFacing: boolean;

  // Material
  materialEmissive: number;
  materialAmbient: number;
  materialDiffuse: number;
  materialSpecular: number;
  materialAlpha: number;
  materialSpecCoef: number;
  materialUpdate: number;
  shadeMode: number;
  reverseNormals: boolean;

  // Lighting
  lightingEnable: boolean;
  lightEnable: boolean[];
  lightType: number[];
  lightMode: number;
  lightDir: number[];
  lightAtt: number[];
  lightSpotExp: number[];
  lightSpotCutoff: number[];
  lightAmbientColor: number[];
  lightDiffuseColor: number[];
  lightSpecularColor: number[];
  ambientColor: number;
  ambientAlpha: number;

  // Cull
  cullEnable: boolean;
  cullCW: boolean;

  // Block transfer
  trSrc: number;
  trSrcW: number;
  trDst: number;
  trDstW: number;
  trSrcPos: number;
  trDstPos: number;
  trSize: number;
  trBpp: number;

  // Transform matrices
  boneMats: number[];
  boneMatIdx: number;
  worldMat: number[];
  viewMat: number[];
  projMat: number[];
  worldMatIdx: number;
  viewMatIdx: number;
  projMatIdx: number;
  tgenMatIdx: number;

  // Viewport
  vpScaleX: number;
  vpScaleY: number;
  vpScaleZ: number;
  vpCenterX: number;
  vpCenterY: number;
  vpCenterZ: number;
  geOffsetX: number;
  geOffsetY: number;

  // Immediate-mode vertex state
  immVscx: number;
  immVscy: number;
  immVscz: number;
  immVtcs: number;
  immVtct: number;
  immVtcq: number;
  immCv: number;
  immFc: number;
  immScv: number;
  immBuffer: Vertex[];
  immPrim: number;
}

/**
 * Minimal PSP Graphics Engine command list processor.
 *
 * Processes GE display lists submitted via sceGeListEnQueue.
 * Supports: clear, block transfer, basic PRIM sprite rendering,
 * jump/call/ret, and framebuffer setup.
 */
export class GEProcessor {
  private bus: MemoryBus;

  /** When true, skip per-pixel sprite/triangle rasterization (keep clears + block transfers). */
  skipSoftwareRaster = false;

  /** When set, route PRIM and clear commands to WebGL instead of software rasterization. */
  webglRenderer: WebGLGERenderer | null = null;

  /** Cached u32 view over VRAM for the sprite fill fast path. */
  private vram32: Uint32Array | null = null;

  // GE state registers
  private baseAddr = 0;
  private offsetAddr = 0;

  // Framebuffer state (draw target)
  private fbPtr = 0;
  private fbWidth = 512;
  private fbFormat = 3; // pixel format (0-3)
  /** Last fbPtr that had actual sprite/triangle pixels drawn to it (not just clears). */
  private lastDrawFbPtr = 0;
  private lastDrawFbWidth = 512;
  private lastDrawFbFormat = 3;

  // Vertex state
  private vtypeRaw = 0;
  private vertexAddr = 0;

  // Clear mode state (from CLEARMODE 0xD3)
  private clearMode = false;
  private clearColorWrite = true;  // bit 8: write RGB
  private clearAlphaWrite = true;  // bit 9: write alpha/stencil
  private clearDepthWrite = false; // bit 10: write depth

  // Texture LOD slope (0xD0) — PPSSPP ge_constants.h:217
  // Parsed from the GE command but not consumed yet; kept to document the state
  // and captured in save states.
  private texLodSlope = 0.0;

  // Texture state
  private texAddr0 = 0;
  private texBufWidth0 = 0;
  private texWidth0 = 0;
  private texHeight0 = 0;
  private texFormat = 0;
  private texEnable = false;
  private texSwizzle = false;
  private texWrapU = 0;  // 0=repeat, 1=clamp
  private texWrapV = 0;
  private texFunc = 0;   // 0=modulate, 1=decal, 2=blend, 3=replace, 4=add
  private texFuncAlpha = false;
  private colorDoubling = false;
  private texEnvColor = 0; // 24-bit BGR for BLEND texture function (GE_CMD_TEXENVCOLOR = 0xCA)
  // Texture filter (GE_CMD_TEXFILTER = 0xC6)
  // PPSSPP GPUState.h: getMinFilt() = texfilter & 7, getMagFilt() = (texfilter >> 8) & 1
  // Min: 0=nearest,1=linear,4=nearest_mipnearest,5=linear_mipnearest,6=nearest_miplinear,7=linear_miplinear
  // Mag: 0=nearest, 1=linear
  private texMinFilter = 0;
  private texMagFilter = 0;

  // Texture mapping mode (GE_CMD_TEXMAPMODE = 0xC0)
  // PPSSPP GPUState.h:366-367: getUVGenMode() = texmapmode & 3, getUVProjMode() = (texmapmode >> 8) & 3
  // GE_TEXMAP_TEXTURE_COORDS=0 (vertex UV), GE_TEXMAP_TEXTURE_MATRIX=1, GE_TEXMAP_ENVIRONMENT_MAP=2
  private texMapMode = 0;   // UV generation mode (2 bits)
  private texProjMode = 0;  // projection source for TEXTURE_MATRIX mode (2 bits)
  // Texture shade mapping light sources (GE_CMD_TEXSHADELS = 0xC1)
  // PPSSPP GPUState.h:368-369: getUVLS0() = texshade & 3, getUVLS1() = (texshade >> 8) & 3
  private texShadeLS0 = 0;  // light index for env map S coordinate
  private texShadeLS1 = 0;  // light index for env map T coordinate

  // Texture gen matrix (4x3 column-major, same layout as world/view)
  // Stored from GE_CMD_TGENMATRIXDATA (0x41); only used when texMapMode == 1 (TEXTURE_MATRIX)
  private tgenMat = new Float32Array([1,0,0, 0,1,0, 0,0,1, 0,0,0]);

  // Light positions — needed for environment mapping (texMapMode == 2)
  // Stored as 4 lights x 3 floats (x,y,z) from GE_CMD_LX0..LZ3 (opcodes 0x63-0x6E)
  private lightPos = new Float32Array(4 * 3); // lightPos[light*3 + axis]

  private texScaleU = 1.0;
  private texScaleV = 1.0;
  private texOffsetU = 0.0;
  private texOffsetV = 0.0;

  // Alpha blend state
  private alphaBlendEnable = false;
  private blendSrc = 0;
  private blendDst = 0;
  private blendOp = 0;
  private blendFixedA = 0xFFFFFF;
  private blendFixedB = 0;

  // Alpha test state
  private alphaTestEnable = false;
  private alphaTestFunc = 0;
  private alphaTestRef = 0;
  private alphaTestMask = 0xFF;

  // Scissor
  private scissorX1 = 0;
  private scissorY1 = 0;
  private scissorX2 = 479;
  private scissorY2 = 271;

  // Index buffer
  private indexAddr = 0;

  // Depth
  private depthTestEnable = false;
  private depthWriteDisable = false;

  // Color/alpha write mask (0xE8/0xE9): bit=1 means DON'T write that bit
  private maskRgb = 0;    // 24-bit: bits 0-7=R mask, 8-15=G mask, 16-23=B mask
  private maskAlpha = 0;  // 8-bit: alpha mask

  // Stencil test state (PPSSPP ge_constants.h: GE_CMD_STENCILTESTENABLE=0x24,
  // GE_CMD_STENCILTEST=0xDC, GE_CMD_STENCILOP=0xDD)
  private stencilTestEnable = false;
  private stencilFunc = 1;   // GEComparison (default ALWAYS)
  private stencilRef = 0;    // 8-bit reference
  private stencilMask = 0xFF; // 8-bit read mask
  private stencilSFail = 0;  // GEStencilOp: fail
  private stencilZFail = 0;  // GEStencilOp: z-fail
  private stencilZPass = 0;  // GEStencilOp: z-pass

  // Color test state (PPSSPP: GE_CMD_COLORTESTENABLE=0x27, GE_CMD_COLORTEST=0xD8,
  // GE_CMD_COLORREF=0xD9, GE_CMD_COLORTESTMASK=0xDA)
  private colorTestEnable = false;
  private colorTestFunc = 1;      // 0=never,1=always,2=equal,3=notequal
  private colorTestRef = 0;       // 24-bit BGR
  private colorTestMask = 0xFFFFFF; // 24-bit BGR

  // Logic op state (PPSSPP: GE_CMD_LOGICOPENABLE=0x28, GE_CMD_LOGICOP=0xE6)
  private logicOpEnable = false;
  private logicOp = 3;   // GELogicOp: default COPY (src)

  // Dither state (PPSSPP: GE_CMD_DITHERENABLE=0x20, GE_CMD_DITH0-3=0xE2-0xE5)
  private ditherEnable = false;
  private ditherMatrix = new Int8Array(16); // 4x4, signed [-8..+7]

  // Fog state (GE_CMD_FOGENABLE=0x1F, GE_CMD_FOGCOLOR=0xCF,
  // GE_CMD_FOG1=0xCD float24 end, GE_CMD_FOG2=0xCE float24 1/(end-start))
  private fogEnable = false;
  private fogColor = 0;    // 24-bit BGR
  private fogEnd = 0.0;    // fog end distance
  private fogSlope = 0.0;  // 1/(end-start) — fog density slope

  // Depth test function (PPSSPP: GE_CMD_ZTEST=0xDE)
  private depthFunc = 1;  // GEComparison: default ALWAYS

  // Patch state (PPSSPP: GE_CMD_PATCHDIVISION=0x36, PATCHPRIMITIVE=0x37, PATCHFACING=0x38)
  private patchDivU = 0;
  private patchDivV = 0;
  // Parsed from the GE command but not consumed yet; kept to document the state
  // and captured in save states.
  private patchPrimType = 0; // 0=triangles,1=lines,2=points
  private patchFacing = false;

  // Material colors (PPSSPP ge_constants.h: 0x54-0x58, 0x5B)
  private materialEmissive = 0;       // 24-bit RGB (0x54)
  private materialAmbient = 0xFFFFFF; // 24-bit RGB (0x55)
  private materialDiffuse = 0;        // 24-bit RGB (0x56)
  private materialSpecular = 0;       // 24-bit RGB (0x57)
  private materialAlpha   = 0xFF;     // 8-bit alpha (0x58)
  private materialSpecCoef = 0.0;     // specular exponent (0x5B)
  private materialUpdate = 0;         // which material uses vertex color (0x53)
  private shadeMode = 1;              // 0=flat, 1=gouraud (0x50)
  private reverseNormals = false;     // (0x51)

  // Lighting state
  private lightingEnable = false;     // (0x17)
  private lightEnable = [false, false, false, false]; // (0x18-0x1B)
  private lightType = new Uint32Array(4);  // (0x5F-0x62)
  private lightMode = 0;              // 0=single, 1=separate specular (0x5E)
  // Light directions (0x6F-0x7A)
  private lightDir = new Float32Array(12);
  // Light attenuation (0x7B-0x86)
  private lightAtt = new Float32Array(12);
  // Spotlight exponent (0x87-0x8A)
  private lightSpotExp = new Float32Array(4);
  // Spotlight cutoff (0x8B-0x8E)
  private lightSpotCutoff = new Float32Array(4);
  // Light colors: ambient (0x8F,0x92,0x95,0x98), diffuse (0x90,0x93,0x96,0x99), specular (0x91,0x94,0x97,0x9A)
  private lightAmbientColor = new Uint32Array(4);
  private lightDiffuseColor = new Uint32Array(4);
  private lightSpecularColor = new Uint32Array(4);

  // Global ambient (0x5C, 0x5D)
  private ambientColor = 0;
  private ambientAlpha = 0;

  // Cull
  private cullEnable = false;
  private cullCW = false; // true = CW, false = CCW

  // Block transfer registers
  private trSrc = 0;
  private trSrcW = 0;
  private trDst = 0;
  private trDstW = 0;
  private trSrcPos = 0;
  private trDstPos = 0;
  private trSize = 0;
  private trBpp = 2; // bytes per pixel: 2 (16-bit) or 4 (32-bit); set by TRANSFERSRCW bit 22

  // Transform matrices (column-major, 4x3 for world/view, 4x4 for proj)
  // Identity: col0=[1,0,0], col1=[0,1,0], col2=[0,0,1], col3=[0,0,0]
  /** 8 bone matrices x 12 floats each (4x3, column-major). */
  private boneMats = new Float32Array(8 * 12);
  private boneMatIdx = 0;

  private worldMat = new Float32Array([1,0,0, 0,1,0, 0,0,1, 0,0,0]);
  private viewMat  = new Float32Array([1,0,0, 0,1,0, 0,0,1, 0,0,0]);
  private projMat  = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

  // Matrix upload indices (separate per matrix type)
  private worldMatIdx = 0;
  private viewMatIdx  = 0;
  private projMatIdx  = 0;
  private tgenMatIdx  = 0; // texture gen matrix (ignored, but track index)

  /** Matrix readback for sceGeGetMtx — type 0-7 bone, 8 world, 9 view,
   *  10 proj (16 floats), 11 texgen (PPSSPP GPUCommon::GetMatrix24). */
  getMatrixFloats(type: number): Float32Array | null {
    if (type >= 0 && type <= 7) return this.boneMats.subarray(type * 12, type * 12 + 12);
    if (type === 8) return this.worldMat;
    if (type === 9) return this.viewMat;
    if (type === 10) return this.projMat;
    if (type === 11) return this.tgenMat;
    return null;
  }

  // Viewport (GE float24 decoded, typically in pixel units)
  private vpScaleX  = 240;
  private vpScaleY  = 136;
  private vpScaleZ  = 65535;
  private vpCenterX = 2048;
  private vpCenterY = 2048;
  private vpCenterZ = 65535;

  // GE screen offset (in 1/16 pixel units, default 2048 = 128px)
  private geOffsetX = 2048;
  private geOffsetY = 2048;

  // Call stack for CALL/RET — each entry saves return PC, offsetAddr, and optionally baseAddr
  private callStack: Array<{ pc: number; offsetAddr: number; baseAddr?: number }> = [];

  // Immediate mode vertex state (opcodes 0xF0-0xF9) — PPSSPP GPUCommon.cpp:1242-1373
  private immVscx = 0;
  private immVscy = 0;
  private immVscz = 0;
  private immVtcs = 0;
  private immVtct = 0;
  // Parsed from the GE command but not consumed yet; kept to document the state
  // and captured in save states.
  private immVtcq = 0;
  private immCv = 0;   // vertex color RGB (24 bits)
  // Parsed from the GE command but not consumed yet; captured in save states.
  private immFc = 0;   // fog coefficient
  // Parsed from the GE command but not consumed yet; captured in save states.
  private immScv = 0;  // secondary color (specular)
  private immBuffer: Vertex[] = [];
  private immPrim = -1; // current immediate prim type (-1 = none)

  /**
   * Optional callback invoked when the GE processes a SIGNAL command with
   * handler behaviour (0x01/0x02/0x03).  Parameter: signalId (lower 16 bits).
   * Used by the HLE kernel to fire the sceGe signal_func so that sceGu's
   * ring-buffer threshold can advance.
   */
  signalCallback: ((signalId: number) => void) | null = null;

  constructor(bus: MemoryBus) {
    this.bus = bus;
  }

  /** Rate-limit: log each unknown GE opcode only once. */
  private _warnedOpcodes = new Set<number>();

  // Debug: track unique opcodes across all lists
  private _dbgListCount = 0;
  private _dbgOpcodes = new Set<number>();
  private _dbgPrimCount = 0;
  private _dbgClearCount = 0;
  private _dbgSkipCount = 0;
  // Cumulative totals across all executeList calls (including stall updates)
  private _dbgTotalPrim = 0;
  private _dbgTotalClear = 0;
  private _dbgTotalSkip = 0;
  private _dbgTotalCalls = 0;
  private _dbgTotalTransfer = 0;
  private _dbgTotalCmds = 0;
  private _dbgAllOpcodes = new Map<number, number>(); // opcode -> total count
  private _dbgBadFbOff = 0; // draws skipped because fbOff was out of VRAM bounds

  /** Current GE draw framebuffer address (0 = VRAM offset 0 = 0x04000000). */
  private toPhysical(ptr: number): number {
    if (ptr === 0) return 0x04000000;
    return ptr < 0x04000000 ? 0x04000000 + ptr : ptr;
  }
  get currentFbAddr(): number   { return this.toPhysical(this.lastDrawFbPtr || this.fbPtr); }
  get currentFbWidth(): number  { return this.lastDrawFbPtr ? this.lastDrawFbWidth : (this.fbWidth || 512); }
  get currentFbFormat(): number { return this.lastDrawFbPtr ? this.lastDrawFbFormat : this.fbFormat; }
  get totalListCount(): number { return this._dbgListCount; }
  get totalPrimCount(): number { return this._dbgTotalPrim; }
  get totalClearCount(): number { return this._dbgTotalClear; }
  get totalSkipCount(): number { return this._dbgTotalSkip; }

  /** Snapshot all GE state needed for a WebGL draw call. */
  get drawState(): GEDrawState {
    return {
      throughMode: ((this.vtypeRaw >>> 23) & 1) === 1,
      texEnable: this.texEnable,
      texState: {
        texAddr0: this.texAddr0,
        texBufWidth0: this.texBufWidth0,
        texWidth0: this.texWidth0,
        texHeight0: this.texHeight0,
        texFormat: this.texFormat,
        texSwizzle: this.texSwizzle,
        texWrapU: this.texWrapU,
        texWrapV: this.texWrapV,
        texMinFilter: this.texMinFilter,
        texMagFilter: this.texMagFilter,
        texMapMode: this.texMapMode,
        texScaleU: this.texScaleU,
        texScaleV: this.texScaleV,
        texOffsetU: this.texOffsetU,
        texOffsetV: this.texOffsetV,
        vtypeRaw: this.vtypeRaw,
        clutAddr: this.clutAddr,
        clutFormat: this.clutFormat,
        clutShift: this.clutShift,
        clutMask: this.clutMask,
        clutStart: this.clutStart,
      },
      fragState: {
        alphaTestEnable: this.alphaTestEnable,
        alphaTestFunc: this.alphaTestFunc,
        alphaTestRef: this.alphaTestRef,
        alphaTestMask: this.alphaTestMask,
        colorTestEnable: this.colorTestEnable,
        colorTestFunc: this.colorTestFunc,
        colorTestRef: this.colorTestRef,
        colorTestMask: this.colorTestMask,
        stencilTestEnable: this.stencilTestEnable,
        stencilFunc: this.stencilFunc,
        stencilRef: this.stencilRef,
        stencilMask: this.stencilMask,
        stencilSFail: this.stencilSFail,
        stencilZFail: this.stencilZFail,
        stencilZPass: this.stencilZPass,
        alphaBlendEnable: this.alphaBlendEnable,
        blendSrc: this.blendSrc,
        blendDst: this.blendDst,
        blendOp: this.blendOp,
        blendFixedA: this.blendFixedA,
        blendFixedB: this.blendFixedB,
        logicOpEnable: this.logicOpEnable,
        logicOp: this.logicOp,
        ditherEnable: this.ditherEnable,
        ditherMatrix: this.ditherMatrix,
        fbFormat: this.fbFormat,
        maskRgb: this.maskRgb,
        maskAlpha: this.maskAlpha,
        texFunc: this.texFunc,
        texFuncAlpha: this.texFuncAlpha,
        texEnvColor: this.texEnvColor,
      },
      fbPtr: this.fbPtr,
      fbWidth: this.fbWidth,
      fbFormat: this.fbFormat,
      clearMode: this.clearMode,
      clearColorWrite: this.clearColorWrite,
      clearAlphaWrite: this.clearAlphaWrite,
      clearDepthWrite: this.clearDepthWrite,
      depthTestEnable: this.depthTestEnable,
      depthFunc: this.depthFunc,
      depthWriteDisable: this.depthWriteDisable,
      cullEnable: this.cullEnable,
      cullCW: this.cullCW,
      scissorX1: this.scissorX1,
      scissorY1: this.scissorY1,
      scissorX2: this.scissorX2,
      scissorY2: this.scissorY2,
      fogEnable: this.fogEnable,
      fogColor: this.fogColor,
      fogEnd: this.fogEnd,
      fogSlope: this.fogSlope,
      colorDoubling: this.colorDoubling,
      shadeMode: this.shadeMode,
    };
  }

  /** Set the GE draw framebuffer externally (e.g. from sceDisplaySetFrameBuf double-buffer swap). */
  setFramebuf(addr: number, width: number, format: number): void {
    this.fbPtr = addr & 0x1FFFFFFF;
    if (width > 0) this.fbWidth = width;
    this.fbFormat = format;
  }

  /**
   * PPSSPP getRelativeAddress: ((base & 0x000F0000) << 8 | data) + offsetAddr) & 0x0FFFFFFF
   * Used by JUMP, CALL, VADDR, IADDR.
   */
  private getRelativeAddress(data: number): number {
    const baseExtended = ((this.baseAddr & 0x00FF0000) << 8) | data;
    return (this.offsetAddr + baseExtended) & 0x0FFFFFFF;
  }

  /** Process a GE command list starting at listAddr. Returns the PC where execution stopped. */
  executeList(listAddr: number, stallAddr: number): number {
    return this.executeListBudgeted(listAddr, stallAddr, MAX_COMMANDS).stoppedPc;
  }

  /**
   * Process GE commands with a command budget.  Returns early when:
   *  - END command reached (stoppedPc = -1)
   *  - Stall address reached (stoppedPc = stallAddr)
   *  - Budget exhausted (stoppedPc = current PC, for resume)
   */
  executeListBudgeted(listAddr: number, stallAddr: number, maxCommands: number): GeExecuteResult {
    this._dbgListCount++;
    this._dbgTotalCalls++;
    this._dbgPrimCount = 0;
    this._dbgClearCount = 0;
    this._dbgSkipCount = 0;
    this._dbgOpcodes.clear();
    let pc = listAddr;
    let count = 0;

    while (count < maxCommands) {
      if (stallAddr !== 0 && pc === stallAddr) break;

      const cmd = this.bus.readU32(pc);
      const opcode = cmd >>> 24;
      const param = cmd & 0x00FFFFFF;
      this._dbgOpcodes.add(opcode);

      const nextPc = this.executeOp(opcode, param, pc);
      count++;
      if (nextPc < 0) {
        // END — list completed
        log.debug(`List #${this._dbgListCount} END: drawn=${this._dbgPrimCount - this._dbgSkipCount} clear=${this._dbgClearCount} fbPtr=0x${this.fbPtr.toString(16)}`);
        this._dbgBadFbOff = 0;
        return { stoppedPc: -1, commandsProcessed: count };
      }
      pc = nextPc;
    }

    return { stoppedPc: pc, commandsProcessed: count }; // stalled or budget exhausted
  }

  /** Set the vertex address directly (used by the HLE list scanner, which owns
   *  relative-address computation via its own base/offset tracking). */
  setVertexAddr(addr: number): void { this.vertexAddr = addr; }

  /** Set the index address directly (used by the HLE list scanner). */
  setIndexAddr(addr: number): void { this.indexAddr = addr; }

  /** Count a new display list started by an external list walker (HLE scanner). */
  noteListStart(): void { this._dbgListCount++; this._dbgTotalCalls++; }

  /**
   * Execute a single state/draw GE command from an external list walker
   * (the HLE kernel's headless scanner). The walker owns the program counter
   * and handles control flow (JUMP/CALL/RET/END/SIGNAL/FINISH) plus relative
   * addressing (VADDR/IADDR via setVertexAddr/setIndexAddr) — do NOT forward
   * those opcodes here.
   */
  executeCommand(opcode: number, param: number): void {
    this.executeOp(opcode, param, 0);
  }

  /**
   * Execute one GE command. Returns the next pc, or -1 when END completes
   * the list. `pc` is only used by control-flow opcodes (JUMP/CALL/RET/
   * SIGNAL/ORIGIN_ADDR).
   */
  private executeOp(opcode: number, param: number, pc: number): number {
    this._dbgTotalCmds++;
    this._dbgAllOpcodes.set(opcode, (this._dbgAllOpcodes.get(opcode) ?? 0) + 1);

    switch (opcode) {
        case GE_CMD.NOP:
          break;

        case GE_CMD.BASE:
          // Store raw 24-bit param; address extension uses bits [19:16] per PPSSPP getRelativeAddress
          this.baseAddr = param;
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
          this.vertexAddr = this.getRelativeAddress(param & 0xFFFFFF);
          break;

        // Draw primitives
        case GE_CMD.PRIM:
          this._dbgPrimCount++;
          this._dbgTotalPrim++;
          this.doPrim(param);
          break;

        // ── Bezier surface (0x05) ────────────────────────────────
        case GE_CMD.BEZIER: {
          const uCount = param & 0xFF;
          const vCount = (param >> 8) & 0xFF;
          this.doPatch("bezier", uCount, vCount, 0, 0);
          break;
        }

        // ── Spline surface (0x06) ────────────────────────────────
        case GE_CMD.SPLINE: {
          const uCount = param & 0xFF;
          const vCount = (param >> 8) & 0xFF;
          const typeU = (param >> 16) & 3;
          const typeV = (param >> 18) & 3;
          this.doPatch("spline", uCount, vCount, typeU, typeV);
          break;
        }

        // ── Conditional jump (0x09) ────────────────────────────────
        // PPSSPP GPUCommon.cpp:914 Execute_BJump: jump if bboxResult is false.
        // Since we always report bbox as visible (true), BJUMP never jumps.
        case GE_CMD.BJUMP:
          break;

        // ── Bounding box test (0x07) ─────────────────────────────
        // PPSSPP GPUCommon.cpp Execute_BoundingBox:
        //   count = op & 0xFFFF (number of vertices to test)
        //   Result stored in currentList->bboxResult.
        //   Games use BJUMP (0x09) to conditionally skip rendering if bbox is off-screen.
        //   We always report "visible" (pass) by not failing any bbox test.
        case GE_CMD.BOUNDINGBOX: {
          const bbCount = param & 0xFFFF;
          if (bbCount > 0) {
            this.doSkipVertices(bbCount);
          }
          // Result: always visible (no frustum culling implemented)
          break;
        }

        // Texture LOD slope (opcode 0xD0) — PPSSPP ge_constants.h:217
        case GE_CMD.TEXLODSLOPE:
          this.texLodSlope = getFloat24(param);
          break;

        // 0xD1 — GE_CMD_UNKNOWN_D1 (reserved/NOP per PPSSPP ge_constants.h:270)
        case 0xD1:
          break;

        case GE_CMD.AMBIENT_COLOR:
          this.ambientColor = param & 0xFFFFFF;
          break;

        case GE_CMD.AMBIENT_ALPHA:
          this.ambientAlpha = param & 0xFF;
          break;

        case GE_CMD.CLEAR:
          if (param & 1) {
            this.clearMode = true;
            this._dbgClearCount++;
            this._dbgTotalClear++;
            // Bits 8/9/10 control which channels are written during clear-mode PRIMs
            this.clearColorWrite = (param & 0x100) !== 0;
            this.clearAlphaWrite = (param & 0x200) !== 0;
            this.clearDepthWrite = (param & 0x400) !== 0;
          } else {
            this.clearMode = false;
          }
          break;

        // Texture enable
        case 0x1E:
          this.texEnable = (param & 1) !== 0;
          break;

        // Texture address (level 0) — PPSSPP GPUState.h:293
        case 0xA0:
          this.texAddr0 = (this.texAddr0 & 0x0F000000) | (param & 0xFFFFF0);
          break;

        // Texture addresses / buffer widths for mip levels 1-7 (NOP — only level 0 used)
        case 0xA1: case 0xA2: case 0xA3: case 0xA4: case 0xA5: case 0xA6: case 0xA7:
          break;
        case 0xA9: case 0xAA: case 0xAB: case 0xAC: case 0xAD: case 0xAE: case 0xAF:
          break;
        // Texture size levels 1-7 (NOP)
        case 0xB9: case 0xBA: case 0xBB: case 0xBC: case 0xBD: case 0xBE: case 0xBF:
          break;

        // Texture buffer width (level 0) — PPSSPP GPUState.h:293
        case 0xA8:
          this.texAddr0 = (this.texAddr0 & 0x00FFFFFf) | ((param << 8) & 0x0F000000);
          this.texBufWidth0 = param & 0x07FF;
          break;

        // Texture size (level 0)
        case 0xB8:
          this.texWidth0 = 1 << (param & 0xF);
          this.texHeight0 = 1 << ((param >>> 8) & 0xF);
          break;

        // Texture pixel format (PPSSPP: GE_CMD_TEXFORMAT = 0xC3)
        case 0xC3:
          this.texFormat = param & 0xF;
          break;

        // Texture mode (0xC2): max mip level, swizzle
        case 0xC2:
          this.texSwizzle = (param & 1) !== 0;
          break;

        // Texture filter (0xC6): min/mag filter
        // PPSSPP GPUState.h: getMinFilt() = texfilter & 7, getMagFilt() = (texfilter >> 8) & 1
        case 0xC6:
          this.texMinFilter = param & 7;
          this.texMagFilter = (param >> 8) & 1;
          break;

        // Texture wrap mode (0xC7): clamp/repeat for U and V
        case 0xC7:
          this.texWrapU = param & 1;         // 0=repeat, 1=clamp
          this.texWrapV = (param >> 8) & 1;
          break;

        // Texture function (0xC9): modulate, decal, blend, replace, add + color doubling
        case 0xC9:
          this.texFunc = param & 7;
          this.texFuncAlpha = ((param >> 8) & 1) !== 0;
          // PPSSPP GPUState.h:301 — isColorDoublingEnabled = (texfunc & 0x10000) != 0
          this.colorDoubling = ((param >> 16) & 1) !== 0;
          break;

        // Texture env color (0xCA) — used by BLEND texture function
        // PPSSPP GPUState.h: getTextureEnvColRGB() = texenvcolor & 0xFFFFFF
        case 0xCA:
          this.texEnvColor = param & 0xFFFFFF;
          break;

        // Texture flush / sync — NOP
        case 0xCB:
        case 0xCC:
          break;

        // ── Enable flags ──────────────────────────────────────────
        case 0x17: this.lightingEnable = (param & 1) !== 0; break;
        case 0x18: this.lightEnable[0] = (param & 1) !== 0; break;
        case 0x19: this.lightEnable[1] = (param & 1) !== 0; break;
        case 0x1A: this.lightEnable[2] = (param & 1) !== 0; break;
        case 0x1B: this.lightEnable[3] = (param & 1) !== 0; break;
        case 0x1C: break; // depth clamp enable
        case 0x1D: this.cullEnable = (param & 1) !== 0; break;
        case 0x1F: this.fogEnable = (param & 1) !== 0; break; // GE_CMD_FOGENABLE
        case 0x20: this.ditherEnable = (param & 1) !== 0; break;    // GE_CMD_DITHERENABLE
        case 0x21: this.alphaBlendEnable = (param & 1) !== 0; break;
        case 0x22: this.alphaTestEnable = (param & 1) !== 0; break;
        case 0x23: this.depthTestEnable = (param & 1) !== 0; break;
        case 0x24: this.stencilTestEnable = (param & 1) !== 0; break; // GE_CMD_STENCILTESTENABLE
        case 0x25: break; // antialias enable
        case 0x26: break; // patch cull enable
        case 0x27: this.colorTestEnable = (param & 1) !== 0; break;  // GE_CMD_COLORTESTENABLE
        case 0x28: this.logicOpEnable = (param & 1) !== 0; break;    // GE_CMD_LOGICOPENABLE

        // ── Index address ────────────────────────────────────────
        case GE_CMD.IADDR:
          this.indexAddr = this.getRelativeAddress(param & 0xFFFFFF);
          break;

        // ── Scissor ──────────────────────────────────────────────
        case GE_CMD.SCISSOR1:
          this.scissorX1 = param & 0x3FF;
          this.scissorY1 = (param >> 10) & 0x3FF;
          break;
        case GE_CMD.SCISSOR2:
          this.scissorX2 = param & 0x3FF;
          this.scissorY2 = (param >> 10) & 0x3FF;
          break;

        // ── Alpha blend mode ─────────────────────────────────────
        case 0xDF: // BLENDMODE: srcFactor[3:0] | dstFactor[7:4] | equation[10:8]
          this.blendSrc = param & 0xF;
          this.blendDst = (param >> 4) & 0xF;
          this.blendOp  = (param >> 8) & 0x7;
          break;
        case 0xE0: this.blendFixedA = param; break;
        case 0xE1: this.blendFixedB = param; break;

        // ── Alpha test ───────────────────────────────────────────
        case 0xDB: // ALPHATEST: func | ref | mask
          this.alphaTestFunc = param & 7;
          this.alphaTestRef = (param >> 8) & 0xFF;
          this.alphaTestMask = (param >> 16) & 0xFF;
          break;

        // ── Depth ────────────────────────────────────────────────
        // GE_CMD_ZTEST (0xDE): depth test function — PPSSPP GPUState.h getDepthTestFunction()
        case 0xDE: this.depthFunc = param & 7; break;
        case 0xE7: this.depthWriteDisable = (param & 1) !== 0; break;

        // ── Cull face direction ──────────────────────────────────
        case 0x9B: this.cullCW = (param & 1) !== 0; break;

        // ── Depth buffer ─────────────────────────────────────────
        case GE_CMD.ZBUFPTR: break;   // store if Z-buffer needed
        case GE_CMD.ZBUFWIDTH: break;

        // ── Bone matrix ──────────────────────────────────────────
        case 0x2A: // BONEMATRIXNUMBER: set write index (0..95 for 8x12 floats)
          this.boneMatIdx = param & 0x7F;
          break;
        case 0x2B: // BONEMATRIXDATA: write one float24 and auto-increment
          if (this.boneMatIdx < 96) {
            this.boneMats[this.boneMatIdx++] = getFloat24(param);
          }
          break;

        // ── World matrix ─────────────────────────────────────────
        case 0x3A: // WORLDMATRIXNUMBER: set write pointer
          this.worldMatIdx = param & 0xF;
          break;
        case 0x3B: // WORLDMATRIXDATA: write one float24 at current pointer
          if (this.worldMatIdx < 12) {
            this.worldMat[this.worldMatIdx++] = getFloat24(param);
          }
          break;

        // ── View matrix ──────────────────────────────────────────
        case 0x3C: // VIEWMATRIXNUMBER
          this.viewMatIdx = param & 0xF;
          break;
        case 0x3D: // VIEWMATRIXDATA
          if (this.viewMatIdx < 12) {
            this.viewMat[this.viewMatIdx++] = getFloat24(param);
          }
          break;

        // ── Proj matrix ──────────────────────────────────────────
        case 0x3E: // PROJMATRIXNUMBER
          this.projMatIdx = param & 0xF;
          break;
        case 0x3F: // PROJMATRIXDATA — the 16-slot counter wraps on real hardware
          // (gpu/ge/get expects writes 16-19 to land at slots 0-3)
          this.projMat[this.projMatIdx] = getFloat24(param);
          this.projMatIdx = (this.projMatIdx + 1) & 0xF;
          break;

        // ── Texture gen matrix ────────────────────────────────────
        case 0x40: // TGENMATRIXNUMBER
          this.tgenMatIdx = param & 0xF;
          break;
        case 0x41: // TGENMATRIXDATA — write one float24 at current pointer
          // PPSSPP TransformUnit.cpp:448 uses gstate.tgenMatrix for texture coordinate generation
          if (this.tgenMatIdx < 12) {
            this.tgenMat[this.tgenMatIdx++] = getFloat24(param);
          }
          break;

        // ── Viewport ─────────────────────────────────────────────
        case 0x42: this.vpScaleX  = getFloat24(param); break;
        case 0x43: this.vpScaleY  = getFloat24(param); break;
        case 0x44: this.vpScaleZ  = getFloat24(param); break;
        case 0x45: this.vpCenterX = getFloat24(param); break;
        case 0x46: this.vpCenterY = getFloat24(param); break;
        case 0x47: this.vpCenterZ = getFloat24(param); break;

        // ── Texture UV scale/offset ──────────────────────────────
        // Stored as GE float24 (sign bit + 7-bit exponent + 16-bit mantissa)
        case 0x48: this.texScaleU = getFloat24(param); break;
        case 0x49: this.texScaleV = getFloat24(param); break;
        case 0x4A: this.texOffsetU = getFloat24(param); break;
        case 0x4B: this.texOffsetV = getFloat24(param); break;

        // ── Screen offset ────────────────────────────────────────
        case 0x4C: this.geOffsetX = param; break; // OFFSET_X (1/16 pixel units)
        case 0x4D: this.geOffsetY = param; break; // OFFSET_Y
        case 0x4E: case 0x4F: break; // unknown/unused

        // ── Shade model (0x50), misc ─────────────────────────────
        case 0x50: this.shadeMode = param & 1; break;
        case 0x51: this.reverseNormals = (param & 1) !== 0; break;
        case 0x53: this.materialUpdate = param & 7; break;
        case 0x54: this.materialEmissive = param & 0xFFFFFF; break;
        case 0x55: this.materialAmbient = param & 0xFFFFFF; break;
        case 0x56: this.materialDiffuse = param & 0xFFFFFF; break;
        case 0x57: this.materialSpecular = param & 0xFFFFFF; break;
        case 0x58: this.materialAlpha = param & 0xFF; break;
        case 0x5B: this.materialSpecCoef = getFloat24(param); break;
        case 0x5E: this.lightMode = param & 1; break;

        // ── Lighting ──────────────────────────────────────────────
        // Light types (0x5F-0x62)
        case 0x5F: this.lightType[0] = param; break;
        case 0x60: this.lightType[1] = param; break;
        case 0x61: this.lightType[2] = param; break;
        case 0x62: this.lightType[3] = param; break;
        // Light positions: LX0-LZ3 (0x63-0x6E)
        case 0x63: case 0x64: case 0x65:
        case 0x66: case 0x67: case 0x68:
        case 0x69: case 0x6A: case 0x6B:
        case 0x6C: case 0x6D: case 0x6E:
          this.lightPos[opcode - 0x63] = getFloat24(param);
          break;
        // Light directions: LDX0-LDZ3 (0x6F-0x7A)
        case 0x6F: case 0x70: case 0x71:
        case 0x72: case 0x73: case 0x74:
        case 0x75: case 0x76: case 0x77:
        case 0x78: case 0x79: case 0x7A:
          this.lightDir[opcode - 0x6F] = getFloat24(param);
          break;
        // Light attenuation: LKA0-LKC3 (0x7B-0x86)
        case 0x7B: case 0x7C: case 0x7D:
        case 0x7E: case 0x7F: case 0x80:
        case 0x81: case 0x82: case 0x83:
        case 0x84: case 0x85: case 0x86:
          this.lightAtt[opcode - 0x7B] = getFloat24(param);
          break;
        // Spotlight exponent: LKS0-LKS3 (0x87-0x8A)
        case 0x87: this.lightSpotExp[0] = getFloat24(param); break;
        case 0x88: this.lightSpotExp[1] = getFloat24(param); break;
        case 0x89: this.lightSpotExp[2] = getFloat24(param); break;
        case 0x8A: this.lightSpotExp[3] = getFloat24(param); break;
        // Spotlight cutoff: LKO0-LKO3 (0x8B-0x8E)
        case 0x8B: this.lightSpotCutoff[0] = getFloat24(param); break;
        case 0x8C: this.lightSpotCutoff[1] = getFloat24(param); break;
        case 0x8D: this.lightSpotCutoff[2] = getFloat24(param); break;
        case 0x8E: this.lightSpotCutoff[3] = getFloat24(param); break;
        // Light colors: LAC0,LDC0,LSC0,LAC1,LDC1,LSC1,... (0x8F-0x9A)
        // Pattern: every 3 opcodes = ambient, diffuse, specular for one light
        case 0x8F: this.lightAmbientColor[0] = param; break;
        case 0x90: this.lightDiffuseColor[0] = param; break;
        case 0x91: this.lightSpecularColor[0] = param; break;
        case 0x92: this.lightAmbientColor[1] = param; break;
        case 0x93: this.lightDiffuseColor[1] = param; break;
        case 0x94: this.lightSpecularColor[1] = param; break;
        case 0x95: this.lightAmbientColor[2] = param; break;
        case 0x96: this.lightDiffuseColor[2] = param; break;
        case 0x97: this.lightSpecularColor[2] = param; break;
        case 0x98: this.lightAmbientColor[3] = param; break;
        case 0x99: this.lightDiffuseColor[3] = param; break;
        case 0x9A: this.lightSpecularColor[3] = param; break;

        // ── Tex map mode / shade ─────────────────────────────────
        // GE_CMD_TEXMAPMODE (0xC0): uvGenMode[1:0] | projMode[9:8]
        // PPSSPP GPUState.h:366-367
        case 0xC0:
          this.texMapMode = param & 3;
          this.texProjMode = (param >> 8) & 3;
          break;
        // GE_CMD_TEXSHADELS (0xC1): ls0[1:0] | ls1[9:8]
        // PPSSPP GPUState.h:368-369
        case 0xC1:
          this.texShadeLS0 = param & 3;
          this.texShadeLS1 = (param >> 8) & 3;
          break;
        case 0xB0: // CLUT addr lower — PPSSPP GPUState.h:306
          // clutaddr stores raw param; getClutAddress masks to 0x00FFFFF0
          this.clutAddr = (this.clutAddr & 0x0F000000) | (param & 0x00FFFFF0);
          break;
        case 0xB1: // CLUT addr upper — PPSSPP GPUState.h:306
          this.clutAddr = (this.clutAddr & 0x00FFFFF0) | ((param << 8) & 0x0F000000);
          break;
        case 0xC4: break; // load CLUT (triggers the load, data already set)
        case 0xC5: // CLUT format: format | shift | mask | start
          // PPSSPP GPUState.h:315-318
          this.clutFormat = param & 3;
          this.clutShift = (param >> 2) & 0x1F;
          this.clutMask = (param >> 8) & 0xFF;
          // getClutIndexStartPos: always << 4 (×16), regardless of format
          this.clutStart = ((param >> 16) & 0x1F) << 4;
          break;
        case 0xC8: break; // tex level (LOD)

        // ── Fog ──────────────────────────────────────────────────
        // GE_CMD_FOG1 (0xCD): float24 fog end distance
        case 0xCD: this.fogEnd = getFloat24(param); break;
        // GE_CMD_FOG2 (0xCE): float24 1/(end - start) — fog density slope
        case 0xCE: this.fogSlope = getFloat24(param); break;
        // GE_CMD_FOGCOLOR (0xCF): 24-bit BGR fog color
        case 0xCF: this.fogColor = param & 0xFFFFFF; break;

        // ── Stencil / color test / logic op / masks ──────────────
        case 0xD6: case 0xD7: break; // min/max Z

        // GE_CMD_COLORTEST (0xD8): func[1:0] — PPSSPP GPUState.h getColorTestFunction()
        case 0xD8: this.colorTestFunc = param & 3; break;
        // GE_CMD_COLORREF (0xD9): 24-bit BGR reference — PPSSPP GPUState.h getColorTestRef()
        case 0xD9: this.colorTestRef = param & 0xFFFFFF; break;
        // GE_CMD_COLORTESTMASK (0xDA): 24-bit BGR mask — PPSSPP GPUState.h getColorTestMask()
        case 0xDA: this.colorTestMask = param & 0xFFFFFF; break;

        // GE_CMD_STENCILTEST (0xDC): func[2:0] | ref[15:8] | mask[23:16]
        // PPSSPP GPUState.h: getStencilTestFunction/Ref/Mask()
        case 0xDC:
          this.stencilFunc = param & 7;
          this.stencilRef = (param >> 8) & 0xFF;
          this.stencilMask = (param >> 16) & 0xFF;
          break;
        // GE_CMD_STENCILOP (0xDD): sfail[2:0] | zfail[10:8] | zpass[18:16]
        // PPSSPP GPUState.h: getStencilOpSFail/ZFail/ZPass()
        case 0xDD:
          this.stencilSFail = param & 7;
          this.stencilZFail = (param >> 8) & 7;
          this.stencilZPass = (param >> 16) & 7;
          break;

        // GE_CMD_DITH0-3 (0xE2-0xE5): 4x4 dither matrix, each row = 4 x 4-bit signed values
        // PPSSPP GPUState.h getDitherValue(x,y): raw = (dithmtx[y] >> (x*4)) & 0xF; sign-extend
        case 0xE2: case 0xE3: case 0xE4: case 0xE5: {
          const row = opcode - 0xE2;
          for (let col = 0; col < 4; col++) {
            const raw = (param >> (col * 4)) & 0xF;
            // Sign-extend 4-bit: 8-15 -> -8..-1, 0-7 -> 0..7
            this.ditherMatrix[row * 4 + col] = (raw << 28) >> 28;
          }
          break;
        }

        // GE_CMD_LOGICOP (0xE6): op[3:0] — PPSSPP GPUState.h getLogicOp()
        case 0xE6: this.logicOp = param & 0xF; break;
        case 0xE8: this.maskRgb   = param & 0xFFFFFF; break; // MASKRGB
        case 0xE9: this.maskAlpha = param & 0xFF;      break; // MASKALPHA

        // ── Morph weights ────────────────────────────────────────
        case 0x2C: case 0x2D: case 0x2E: case 0x2F:
        case 0x30: case 0x31: case 0x32: case 0x33:
          break;

        // ── Patch state ─────────────────────────────────────────
        // GE_CMD_PATCHDIVISION (0x36): divU[6:0] | divV[14:8]
        // PPSSPP GPUState.h: getPatchDivisionU/V()
        case 0x36:
          this.patchDivU = param & 0x7F;
          this.patchDivV = (param >> 8) & 0x7F;
          break;
        // GE_CMD_PATCHPRIMITIVE (0x37): type[1:0] — 0=triangles,1=lines,2=points
        // PPSSPP GPUState.h: getPatchPrimitiveType()
        case 0x37:
          this.patchPrimType = param & 3;
          break;
        // GE_CMD_PATCHFACING (0x38): bit 0 = reverse normals
        // PPSSPP GPUState.h: isPatchNormalsReversed()
        case 0x38:
          this.patchFacing = (param & 1) !== 0;
          break;

        // ── Region ───────────────────────────────────────────────
        case GE_CMD.REGION1: case GE_CMD.REGION2: break;

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
          // Bit 0 of param selects pixel size: 0 = 16-bit, 1 = 32-bit
          this.trBpp = (param & 1) ? 4 : 2;
          this._dbgTotalTransfer++;
          this.doBlockTransfer();
          break;

        case GE_CMD.JUMP:
          return this.getRelativeAddress(param & 0xFFFFFC);

        case GE_CMD.CALL: {
          if (this.callStack.length < CALL_STACK_DEPTH) {
            this.callStack.push({ pc: pc + 4, offsetAddr: this.offsetAddr });
          }
          return this.getRelativeAddress(param & 0xFFFFFC);
        }

        case GE_CMD.RET:
          if (this.callStack.length > 0) {
            const entry = this.callStack.pop()!;
            this.offsetAddr = entry.offsetAddr;
            return entry.pc;
          }
          break;

        case GE_CMD.FINISH:
          break;

        case GE_CMD.END:
          // Check if previous instruction was SIGNAL (SIGNAL+END pair).
          // In that case the pair was already handled by SIGNAL — this END
          // is a standalone list-termination command.
          return -1; // completed

        case GE_CMD.SIGNAL: {
          // SIGNAL+END form a compound pair.  The behaviour type in bits [23:16]
          // of the SIGNAL param determines the action.  The following END command
          // provides the lower 16 bits of the target address or additional data.
          //
          // Reference: PPSSPP GPU/GPUCommon.cpp ExecuteOp / GE_CMD_END handler.
          const behaviour = (param >> 16) & 0xFF;
          const signalData = param & 0xFFFF;

          // Read the paired END instruction (always follows SIGNAL)
          const endCmd = this.bus.readU32(pc + 4);
          const endData = endCmd & 0xFFFF;

          switch (behaviour) {
            // ── Address control (no interrupt) ──────────────────────────
            case 0x10: // PSP_GE_SIGNAL_JUMP — absolute jump
              return ((signalData << 16) | endData);

            case 0x11: // PSP_GE_SIGNAL_CALL — subroutine call (saves offsetAddr + baseAddr)
              if (this.callStack.length < CALL_STACK_DEPTH) {
                this.callStack.push({ pc: pc + 8, offsetAddr: this.offsetAddr, baseAddr: this.baseAddr });
              }
              return ((signalData << 16) | endData);

            case 0x12: { // PSP_GE_SIGNAL_RET — return from subroutine
              if (this.callStack.length > 0) {
                const entry = this.callStack.pop()!;
                this.offsetAddr = entry.offsetAddr;
                if (entry.baseAddr !== undefined) this.baseAddr = entry.baseAddr;
                return entry.pc;
              }
              return pc + 8; // no stack — skip paired END
            }

            // ── Interrupt/handler behaviours ────────────────────────────
            case 0x01:   // PSP_GE_SIGNAL_HANDLER_SUSPEND
            case 0x02:   // PSP_GE_SIGNAL_HANDLER_CONTINUE
            case 0x03: { // PSP_GE_SIGNAL_HANDLER_PAUSE
              if (this.signalCallback) {
                this.signalCallback(signalData);
              }
              return pc + 8; // skip paired END
            }

            case 0x08: // PSP_GE_SIGNAL_SYNC — memory barrier, no handler
              return pc + 8; // skip paired END

            default:
              return pc + 8; // skip paired END
          }
        }

        // ── Immediate mode vertex commands (0xF0-0xF9) ──────────
        // PPSSPP GPUCommon.cpp Execute_ImmVertexAlphaPrim
        case GE_CMD.VSCX: this.immVscx = param; break;
        case GE_CMD.VSCY: this.immVscy = param; break;
        case GE_CMD.VSCZ: this.immVscz = param; break;
        case GE_CMD.VTCS: this.immVtcs = param; break;
        case GE_CMD.VTCT: this.immVtct = param; break;
        case GE_CMD.VTCQ: this.immVtcq = param; break;
        case GE_CMD.VCV:  this.immCv = param; break;
        case GE_CMD.VFC:  this.immFc = param; break;
        case GE_CMD.VSCV: this.immScv = param; break;
        case GE_CMD.VAP:
          this.executeImmVertex(param);
          break;

        default:
          // Unknown opcodes are NOPs in PPSSPP (stored in cmdmem but no execute handler).
          // Log once at debug level to avoid console spam.
          if (!this._warnedOpcodes.has(opcode)) {
            this._warnedOpcodes.add(opcode);
            log.debug(`Unhandled GE opcode 0x${opcode.toString(16)} param=0x${param.toString(16)}`);
          }
          break;
      }

    return pc + 4;
  }

  // ── State accessors for extracted modules ───────────────────────────────

  /** Build a GETextureState snapshot for texture sampling functions. */
  private get texState(): GETextureState {
    return {
      texAddr0: this.texAddr0, texBufWidth0: this.texBufWidth0,
      texWidth0: this.texWidth0, texHeight0: this.texHeight0,
      texFormat: this.texFormat, texSwizzle: this.texSwizzle,
      texWrapU: this.texWrapU, texWrapV: this.texWrapV,
      texMinFilter: this.texMinFilter, texMagFilter: this.texMagFilter,
      texMapMode: this.texMapMode,
      texScaleU: this.texScaleU, texScaleV: this.texScaleV,
      texOffsetU: this.texOffsetU, texOffsetV: this.texOffsetV,
      vtypeRaw: this.vtypeRaw,
      clutAddr: this.clutAddr, clutFormat: this.clutFormat,
      clutShift: this.clutShift, clutMask: this.clutMask, clutStart: this.clutStart,
    };
  }

  /** Build a GEFragmentState snapshot for fragment pipeline functions. */
  private get fragState(): GEFragmentState {
    return {
      alphaTestEnable: this.alphaTestEnable, alphaTestFunc: this.alphaTestFunc,
      alphaTestRef: this.alphaTestRef, alphaTestMask: this.alphaTestMask,
      colorTestEnable: this.colorTestEnable, colorTestFunc: this.colorTestFunc,
      colorTestRef: this.colorTestRef, colorTestMask: this.colorTestMask,
      stencilTestEnable: this.stencilTestEnable, stencilFunc: this.stencilFunc,
      stencilRef: this.stencilRef, stencilMask: this.stencilMask,
      stencilSFail: this.stencilSFail, stencilZFail: this.stencilZFail,
      stencilZPass: this.stencilZPass,
      alphaBlendEnable: this.alphaBlendEnable, blendSrc: this.blendSrc,
      blendDst: this.blendDst, blendOp: this.blendOp,
      blendFixedA: this.blendFixedA, blendFixedB: this.blendFixedB,
      logicOpEnable: this.logicOpEnable, logicOp: this.logicOp,
      ditherEnable: this.ditherEnable, ditherMatrix: this.ditherMatrix,
      fbFormat: this.fbFormat, maskRgb: this.maskRgb, maskAlpha: this.maskAlpha,
      texFunc: this.texFunc, texFuncAlpha: this.texFuncAlpha, texEnvColor: this.texEnvColor,
    };
  }

  /** Build a LightingState snapshot for the lighting module. */
  private get lightState(): LightingState {
    return {
      lightingEnable: this.lightingEnable,
      lightEnable: this.lightEnable,
      lightType: Array.from(this.lightType),
      lightPos: this.lightPos,
      lightDir: this.lightDir,
      lightAtt: this.lightAtt,
      lightSpotExp: this.lightSpotExp,
      lightSpotCutoff: this.lightSpotCutoff,
      lightAmbientColor: this.lightAmbientColor,
      lightDiffuseColor: this.lightDiffuseColor,
      lightSpecularColor: this.lightSpecularColor,
      ambientColor: this.ambientColor,
      ambientAlpha: this.ambientAlpha,
      materialEmissive: this.materialEmissive,
      materialAmbient: this.materialAmbient,
      materialAlpha: this.materialAlpha,
      materialDiffuse: this.materialDiffuse,
      materialSpecular: this.materialSpecular,
      materialSpecCoef: this.materialSpecCoef,
      lightMode: this.lightMode,
      materialUpdate: this.materialUpdate,
      reverseNormals: this.reverseNormals,
    };
  }

  /** Tessellate and draw a Bezier or Spline patch. */
  private doPatch(
    kind: "bezier" | "spline",
    uCount: number, vCount: number,
    typeU: number, typeV: number,
  ): void {
    const totalVerts = uCount * vCount;
    if (totalVerts === 0) return;

    // Read control point vertices
    const vtype = this.vtypeRaw;
    const texFmt  = (vtype >>> 0) & 3;
    const colorFmt = (vtype >>> 2) & 7;
    const posFmt  = (vtype >>> 7) & 3;
    const indexFmt = (vtype >>> 11) & 3;

    const result = readVerticesFn(
      this.bus, this.vertexAddr, this.indexAddr, vtype,
      this.materialAmbient, this.materialAlpha,
      totalVerts, texFmt, colorFmt, posFmt, indexFmt,
    );
    if (!result) {
      this.doSkipVertices(totalVerts);
      return;
    }
    this.vertexAddr = result.newVertexAddr;
    const cp = result.vertices;

    const divU = this.patchDivU || 4;
    const divV = this.patchDivV || 4;

    let tessVerts: import("./ge-types.js").Vertex[];
    if (kind === "bezier") {
      tessVerts = tessellateBezier(cp, uCount, vCount, divU, divV, this.patchFacing);
    } else {
      tessVerts = tessellateSpline(cp, uCount, vCount, typeU, typeV, divU, divV, this.patchFacing);
    }

    if (tessVerts.length === 0) return;

    // Transform tessellated vertices through the normal pipeline (same as PRIM triangles)
    const throughMode = (vtype >>> 23) & 1;
    if (!throughMode) {
      const doLighting = this.lightingEnable;
      const ls = doLighting ? this.lightState : null;
      const hasVColor = colorFmt !== 0;
      const normFmt = (vtype >>> 5) & 3;

      for (const v of tessVerts) {
        // Tessellated vertices are in model space — apply full pipeline
        const bx = v.x, by = v.y, bz = v.z;
        const wm = this.worldMat;
        const wx = wm[0]!*bx + wm[3]!*by + wm[6]!*bz + wm[9]!;
        const wy = wm[1]!*bx + wm[4]!*by + wm[7]!*bz + wm[10]!;
        const wz = wm[2]!*bx + wm[5]!*by + wm[8]!*bz + wm[11]!;

        let wnx = wm[0]!*v.nx + wm[3]!*v.ny + wm[6]!*v.nz;
        let wny = wm[1]!*v.nx + wm[4]!*v.ny + wm[7]!*v.nz;
        let wnz = wm[2]!*v.nx + wm[5]!*v.ny + wm[8]!*v.nz;
        const nLen = Math.sqrt(wnx*wnx + wny*wny + wnz*wnz);
        if (nLen > 1e-6) { wnx /= nLen; wny /= nLen; wnz /= nLen; }
        else { wnx = 0; wny = 0; wnz = 1; }

        if (ls && (normFmt !== 0 || kind === "bezier" || kind === "spline")) {
          v.color = computeVertexLighting(ls, [wx, wy, wz], [wnx, wny, wnz], v.color, hasVColor);
        }

        const { sx, sy, sz, cw } = this.transformVertex(bx, by, bz);
        v.x = sx; v.y = sy; v.z = sz; v.clipw = cw;
      }
    }

    // Draw tessellated triangles
    this.lastDrawFbPtr = this.fbPtr;
    this.lastDrawFbWidth = this.fbWidth;
    this.lastDrawFbFormat = this.fbFormat;
    for (let i = 0; i + 2 < tessVerts.length; i += 3) {
      this.drawTriangle(tessVerts[i]!, tessVerts[i + 1]!, tessVerts[i + 2]!);
    }
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

    // Index format
    const indexFmt = (vtype >>> 11) & 3; // 0=none, 1=u8, 2=u16

    // Read vertices
    const result = readVerticesFn(
      this.bus, this.vertexAddr, this.indexAddr, this.vtypeRaw,
      this.materialAmbient, this.materialAlpha,
      vertCount, texFmt, colorFmt, posFmt, indexFmt,
    );
    if (!result) return;
    const vertices = result.vertices;
    this.vertexAddr = result.newVertexAddr;

    // Apply vertex transform pipeline for non-through-mode primitives
    if (!throughMode) {
      // Snapshot lighting state once per draw call (not per vertex)
      const doLighting = this.lightingEnable;
      const ls = doLighting ? this.lightState : null;
      const hasVertexColor = colorFmt !== 0;
      const normFmt = (vtype >>> 5) & 3;

      for (const v of vertices) {
        let bx = v.x, by = v.y, bz = v.z;
        // Apply bone skinning if weights present
        if (v.weights && v.weights.length > 0) {
          bx = 0; by = 0; bz = 0;
          for (let bi = 0; bi < v.weights.length; bi++) {
            const w = v.weights[bi]!;
            if (w === 0) continue;
            const base = bi * 12;
            const bm = this.boneMats;
            bx += w * (bm[base+0]!*v.x + bm[base+3]!*v.y + bm[base+6]!*v.z + bm[base+9]!);
            by += w * (bm[base+1]!*v.x + bm[base+4]!*v.y + bm[base+7]!*v.z + bm[base+10]!);
            bz += w * (bm[base+2]!*v.x + bm[base+5]!*v.y + bm[base+8]!*v.z + bm[base+11]!);
          }
        }

        // ── Vertex lighting ─────────────────────────────────────────
        // Compute world-space position and normal for lighting and env mapping.
        // World transform: Pos = worldMat * modelPos (4x3 col-major)
        const wm = this.worldMat;
        const wx = wm[0]!*bx + wm[3]!*by + wm[6]!*bz + wm[9]!;
        const wy = wm[1]!*bx + wm[4]!*by + wm[7]!*bz + wm[10]!;
        const wz = wm[2]!*bx + wm[5]!*by + wm[8]!*bz + wm[11]!;

        // World-space normal (rotation only, no translation)
        let wnx = wm[0]!*v.nx + wm[3]!*v.ny + wm[6]!*v.nz;
        let wny = wm[1]!*v.nx + wm[4]!*v.ny + wm[7]!*v.nz;
        let wnz = wm[2]!*v.nx + wm[5]!*v.ny + wm[8]!*v.nz;
        // NormalizeOr001
        const nLen = Math.sqrt(wnx*wnx + wny*wny + wnz*wnz);
        if (nLen > 1e-6) {
          wnx /= nLen; wny /= nLen; wnz /= nLen;
        } else {
          wnx = 0; wny = 0; wnz = 1;
        }

        if (ls && normFmt !== 0) {
          v.color = computeVertexLighting(
            ls, [wx, wy, wz], [wnx, wny, wnz], v.color, hasVertexColor,
          );
        }

        // Texture coordinate generation — PPSSPP TransformUnit.cpp:426-452
        // Applied before screen transform, using model-space position.
        if (this.texMapMode === 1) {
          // GE_TEXMAP_TEXTURE_MATRIX: source x tgenMatrix (4x3)
          // PPSSPP TransformUnit.cpp:427-449
          let srcX: number, srcY: number, srcZ: number;
          switch (this.texProjMode) {
            case 0: // GE_PROJMAP_POSITION — use model-space position
              srcX = bx; srcY = by; srcZ = bz;
              break;
            case 1: // GE_PROJMAP_UV — use vertex UV
              srcX = v.u; srcY = v.v; srcZ = 0;
              break;
            case 2: // GE_PROJMAP_NORMALIZED_NORMAL
              srcX = wnx; srcY = wny; srcZ = wnz;
              break;
            case 3: // GE_PROJMAP_NORMAL (non-normalized)
              srcX = wm[0]!*v.nx + wm[3]!*v.ny + wm[6]!*v.nz;
              srcY = wm[1]!*v.nx + wm[4]!*v.ny + wm[7]!*v.nz;
              srcZ = wm[2]!*v.nx + wm[5]!*v.ny + wm[8]!*v.nz;
              break;
            default:
              srcX = 0; srcY = 0; srcZ = 0;
              break;
          }
          // Vec3ByMatrix43: out = col0*x + col1*y + col2*z + col3
          // Matrix stored column-major: col0=[0,1,2], col1=[3,4,5], col2=[6,7,8], col3=[9,10,11]
          const tm = this.tgenMat;
          v.u = tm[0]!*srcX + tm[3]!*srcY + tm[6]!*srcZ + tm[9]!;
          v.v = tm[1]!*srcX + tm[4]!*srcY + tm[7]!*srcZ + tm[10]!;
          // Note: texScaleU/V are NOT used in TEXTURE_MATRIX mode (PPSSPP:447)
        } else if (this.texMapMode === 2) {
          // GE_TEXMAP_ENVIRONMENT_MAP — PPSSPP Lighting.cpp:196-203, 205-209
          // Uses already-computed world-space normal (wnx, wny, wnz) from above.
          v.u = this.generateLightCoord(this.texShadeLS0, wnx, wny, wnz);
          v.v = this.generateLightCoord(this.texShadeLS1, wnx, wny, wnz);
        }
        // texMapMode === 0 (GE_TEXMAP_TEXTURE_COORDS): use vertex UV as-is (default)

        const { sx, sy, sz, cw, viewZ } = this.transformVertex(bx, by, bz);
        v.x = sx;
        v.y = sy;
        v.z = sz;
        v.clipw = cw;
        // PPSSPP SoftwareTransformCommon.cpp:353: fogCoef = (viewZ + fogEnd) * fogSlope
        if (this.fogEnable) {
          v.fogCoef = Math.max(0, Math.min(1, (viewZ + this.fogEnd) * this.fogSlope));
        }
      }
    }

    // For clear mode with PRIM, fill rectangles with clear color (all pairs)
    // For clear mode with PRIM, fill rectangles with clear color (all pairs)
    if (this.clearMode && primType === 6 && vertCount >= 2) {
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        this.doClearRect(vertices[i]!, vertices[i + 1]!);
      }
      return;
    }
    if (this.clearMode) return; // non-sprite clears: skip

    this._dbgPrimCount += Math.floor(vertices.length / (primType === 6 ? 2 : 3));

    // WebGL rendering path — GPU-accelerated draw calls via twgl.js
    if (this.webglRenderer) {
      this.lastDrawFbPtr = this.fbPtr;
      this.lastDrawFbWidth = this.fbWidth;
      this.lastDrawFbFormat = this.fbFormat;
      this.webglRenderer.drawPrimitives(primType, vertices, this.drawState, this.bus);
      return;
    }

    // Skip expensive software rasterization for non-clear primitives.
    if (this.skipSoftwareRaster) return;

    // Record which buffer is receiving actual pixel draws
    this.lastDrawFbPtr = this.fbPtr;
    this.lastDrawFbWidth = this.fbWidth;
    this.lastDrawFbFormat = this.fbFormat;

    // SPRITES (type 6): pairs of vertices define axis-aligned rectangles
    if (primType === 6) {
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        this.drawSprite(vertices[i]!, vertices[i + 1]!);
      }
    }
    // TRIANGLES (type 3)
    else if (primType === 3) {
      for (let i = 0; i + 2 < vertices.length; i += 3) {
        this.drawTriangle(vertices[i]!, vertices[i + 1]!, vertices[i + 2]!);
      }
    }
    // TRIANGLE_STRIP (type 4)
    else if (primType === 4) {
      for (let i = 0; i + 2 < vertices.length; i++) {
        if (i & 1) {
          this.drawTriangle(vertices[i + 1]!, vertices[i]!, vertices[i + 2]!);
        } else {
          this.drawTriangle(vertices[i]!, vertices[i + 1]!, vertices[i + 2]!);
        }
      }
    }
    // TRIANGLE_FAN (type 5)
    else if (primType === 5) {
      for (let i = 1; i + 1 < vertices.length; i++) {
        this.drawTriangle(vertices[0]!, vertices[i]!, vertices[i + 1]!);
      }
    }
    // LINES (type 1) — draw thin lines between pairs
    else if (primType === 1) {
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        this.drawLine(vertices[i]!, vertices[i + 1]!);
      }
    }
    // LINE_STRIP (type 2)
    else if (primType === 2) {
      for (let i = 0; i + 1 < vertices.length; i++) {
        this.drawLine(vertices[i]!, vertices[i + 1]!);
      }
    }
    // POINTS (type 0)
    else if (primType === 0) {
      for (const v of vertices) {
        this.plotPixel(v.x | 0, v.y | 0, v.color);
      }
    }
  }

  /**
   * Skip `count` vertices by advancing vertexAddr/indexAddr past them.
   */
  private doSkipVertices(count: number): void {
    const result = skipVerticesFn(this.vtypeRaw, this.vertexAddr, this.indexAddr, count);
    this.vertexAddr = result.newVertexAddr;
    this.indexAddr = result.newIndexAddr;
  }

  /** Draw a sprite (axis-aligned rectangle) from two corner vertices. */
  private drawSprite(v0: Vertex, v1: Vertex): void {
    const sx0 = Math.round(Math.min(v0.x, v1.x));
    const sy0 = Math.round(Math.min(v0.y, v1.y));
    const sx1 = Math.round(Math.max(v0.x, v1.x));
    const sy1 = Math.round(Math.max(v0.y, v1.y));

    if (sx0 >= sx1 || sy0 >= sy1) {
      // Zero-area: log transform-mode sprites that collapsed to a point (helps debug invisible sprites)
      if (Logger.debugEnabled && ((this.vtypeRaw >>> 23) & 1) === 0) {
        log.debug(`SPRITE zero-area (transform mode): v0=(${v0.x.toFixed(1)},${v0.y.toFixed(1)}) v1=(${v1.x.toFixed(1)},${v1.y.toFixed(1)}) → sx=${sx0}..${sx1} sy=${sy0}..${sy1}`);
      }
      return;
    }

    // Diagnostic: log small sprites (1-4px tall) to investigate horizontal-line artifacts
    if (Logger.debugEnabled && sy1 - sy0 <= 4) {
      log.debug(`SPRITE h=${sy1-sy0} x=${sx0}..${sx1} y=${sy0}..${sy1} uv0=(${v0.u.toFixed(1)},${v0.v.toFixed(1)}) uv1=(${v1.u.toFixed(1)},${v1.v.toFixed(1)}) tex=${this.texEnable} fmt=${this.texFormat} swiz=${this.texSwizzle} texW=${this.texWidth0} texH=${this.texHeight0} bw=${this.texBufWidth0} clutFmt=${this.clutFormat} clutShift=${this.clutShift} clutMask=${this.clutMask.toString(16)} through=${(this.vtypeRaw>>>23)&1}`);
    }

    const vram = this.bus.vramBuffer;
    const fbOff = this.toVramOffset(this.fbPtr);
    if (fbOff < 0 || fbOff >= vram.length) { this._dbgBadFbOff++; return; }
    const stride = this.fbWidth || 512;
    const bpp = this.bpp;

    // Map UV to screen corners: each vertex's UV belongs to that vertex's position,
    // so if vertices are swapped (v0.x > v1.x), swap the UVs accordingly.
    const u0 = v0.x <= v1.x ? v0.u : v1.u;
    const u1 = v0.x <= v1.x ? v1.u : v0.u;
    const vt0 = v0.y <= v1.y ? v0.v : v1.v;
    const vt1 = v0.y <= v1.y ? v1.v : v0.v;
    const du = (sx1 > sx0) ? (u1 - u0) / (sx1 - sx0) : 0;
    const dv = (sy1 > sy0) ? (vt1 - vt0) / (sy1 - sy0) : 0;

    const useTexture = this.texEnable && this.texAddr0 !== 0;
    const ts = this.texState;
    const fs = this.fragState;

    // Clamp to scissor + screen
    const xStart = Math.max(sx0, Math.max(0, this.scissorX1));
    const xEnd   = Math.min(sx1, Math.min(480, this.scissorX2 + 1));
    const yStart = Math.max(sy0, Math.max(0, this.scissorY1));
    const yEnd   = Math.min(sy1, Math.min(272, this.scissorY2 + 1));

    // One-shot center-pixel alpha probe: for large sprites, sample center and log
    // once per unique draw state when alpha=0 (invisible with SRC_ALPHA blend).
    // Fast path: untextured opaque ABGR8888 with no blending/alpha test
    const vc = v1.color;
    const noBlend = !this.alphaBlendEnable;
    const noAtest = !this.alphaTestEnable;
    if (!useTexture && bpp === 4 && noBlend && noAtest && this.maskRgb === 0 && this.maskAlpha === 0) {
      // Vertex color is PSP ABGR (R in the low byte); VRAM bytes are R,G,B,A.
      const r = (vc >>>  0) & 0xFF;
      const g = (vc >>>  8) & 0xFF;
      const b = (vc >>> 16) & 0xFF;
      const a = (vc >>> 24) & 0xFF;
      const pixel = r | (g << 8) | (b << 16) | (a << 24);
      if (!this.vram32 || this.vram32.buffer !== vram.buffer) {
        this.vram32 = new Uint32Array(vram.buffer, vram.byteOffset);
      }
      const vram32 = this.vram32;
      for (let y = yStart; y < yEnd; y++) {
        const rowOff = (fbOff + y * stride * 4) >>> 2;
        for (let x = xStart; x < xEnd; x++) {
          vram32[rowOff + x] = pixel;
        }
      }
    } else {
      // General path with texture sampling and fragment processing
      const pr = (vc >>> 16) & 0xFF;
      const pg = (vc >>>  8) & 0xFF;
      const pb = (vc >>>  0) & 0xFF;
      const pa = (vc >>> 24) & 0xFF;
      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          let r: number, g: number, b: number, a: number;

          if (useTexture) {
            const tu = u0 + (x - sx0 + 0.5) * du;
            const tv = vt0 + (y - sy0 + 0.5) * dv;
            const texel = sampleTexture(ts, this.bus, tu, tv);
            const tr = (texel >>> 16) & 0xFF;
            const tg = (texel >>>  8) & 0xFF;
            const tb = (texel >>>  0) & 0xFF;
            const ta = (texel >>> 24) & 0xFF;
            const o = applyTexFunc(fs, tr, tg, tb, ta, pr, pg, pb, pa);
            r = o[0]!; g = o[1]!; b = o[2]!; a = o[3]!;
          } else {
            r = pr; g = pg; b = pb; a = pa;
          }

          if (!passAlphaTest(fs, a)) continue;

          const idx = fbOff + (y * stride + x) * bpp;
          emitFragment(fs, vram, idx, x, y, r, g, b, a);
        }
      }
    }
  }

  /** Draw a filled triangle using scanline rasterization (through-mode). */
  private drawTriangle(v0: Vertex, v1: Vertex, v2: Vertex): void {
    const vram = this.bus.vramBuffer;
    const fbOff = this.toVramOffset(this.fbPtr);
    if (fbOff < 0 || fbOff >= vram.length) { this._dbgBadFbOff++; return; }
    const stride = this.fbWidth || 512;
    const bpp = this.bpp;
    const useTexture = this.texEnable && this.texAddr0 !== 0;
    const ts = this.texState;
    const fs = this.fragState;

    // Sort vertices by Y (v0.y <= v1.y <= v2.y)
    let a = v0, b = v1, c = v2;
    if (a.y > b.y) { const t = a; a = b; b = t; }
    if (a.y > c.y) { const t = a; a = c; c = t; }
    if (b.y > c.y) { const t = b; b = c; c = t; }

    const minY = Math.max(0, Math.max(this.scissorY1, Math.round(a.y)));
    const maxY = Math.min(271, Math.min(this.scissorY2, Math.round(c.y)));

    // Area for barycentric coords (2x signed area)
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(area) < 0.001) return; // degenerate
    const invArea = 1.0 / area;

    let _dbgTriPixels = 0;
    const edges: [Vertex, Vertex][] = [[a, b], [b, c], [a, c]];

    // Per-vertex color channels (R/B swapped for shader convention), constant per triangle
    const ca = a.color, cb2 = b.color, cc = c.color;
    const car = (ca >>> 16) & 0xFF, cag = (ca >>> 8) & 0xFF, cab = ca & 0xFF, caa = (ca >>> 24) & 0xFF;
    const cbr = (cb2 >>> 16) & 0xFF, cbg = (cb2 >>> 8) & 0xFF, cbb = cb2 & 0xFF, cba = (cb2 >>> 24) & 0xFF;
    const ccr = (cc >>> 16) & 0xFF, ccg = (cc >>> 8) & 0xFF, ccb = cc & 0xFF, cca = (cc >>> 24) & 0xFF;

    for (let y = minY; y <= maxY; y++) {
      // Find x range by edge intersection at this scanline
      let xMin = 480, xMax = -1;
      for (const [e0, e1] of edges) {
        const ey0 = e0.y, ey1 = e1.y;
        if ((y < ey0 && y < ey1) || (y > ey0 && y > ey1)) continue;
        if (Math.abs(ey1 - ey0) < 0.001) {
          xMin = Math.min(xMin, e0.x, e1.x);
          xMax = Math.max(xMax, e0.x, e1.x);
        } else {
          const t = (y - ey0) / (ey1 - ey0);
          const ex = e0.x + t * (e1.x - e0.x);
          xMin = Math.min(xMin, ex);
          xMax = Math.max(xMax, ex);
        }
      }

      const x0 = Math.max(0, Math.max(this.scissorX1, Math.ceil(xMin)));
      const x1 = Math.min(479, Math.min(this.scissorX2, Math.floor(xMax)));

      for (let x = x0; x <= x1; x++) {
        // Barycentric interpolation
        const w1 = ((b.x - x) * (c.y - y) - (c.x - x) * (b.y - y)) * invArea;
        const w2 = ((c.x - x) * (a.y - y) - (a.x - x) * (c.y - y)) * invArea;
        const w3 = 1.0 - w1 - w2;

        let r: number, g: number, b2: number, alpha: number;

        // Interpolate vertex prim color (R/B swapped for shader convention)
        const pr = (car * w1 + cbr * w2 + ccr * w3) | 0;
        const pg = (cag * w1 + cbg * w2 + ccg * w3) | 0;
        const pb = (cab * w1 + cbb * w2 + ccb * w3) | 0;
        const pa = (caa * w1 + cba * w2 + cca * w3) | 0;

        if (useTexture) {
          // PPSSPP Rasterizer.cpp:1091 — "Color interpolation is NOT perspective corrected on the PSP."
          // PPSSPP Rasterizer.cpp:1128 — "Texture coordinate interpolation must definitely be perspective-correct."
          // Formula (Rasterizer.cpp:555-564): q_i=1/clipw_i, wq_i=bary_i*q_i,
          //   s = (s0*wq0 + s1*wq1 + s2*wq2) / (wq0 + wq1 + wq2)
          // Through-mode: clipw=1 for all, so this reduces to affine interpolation.
          // Guard: if any clipw is 0 or negative (behind camera), fall back to affine.
          const aw = a.clipw, bw = b.clipw, cw = c.clipw;
          let tu: number, tv: number;
          if (aw > 0 && bw > 0 && cw > 0) {
            const qa = w1 / aw;
            const qb = w2 / bw;
            const qc = w3 / cw;
            const qSum = qa + qb + qc;
            const qRecip = qSum !== 0 ? 1.0 / qSum : 0;
            tu = (a.u * qa + b.u * qb + c.u * qc) * qRecip;
            tv = (a.v * qa + b.v * qb + c.v * qc) * qRecip;
          } else {
            // Affine fallback for degenerate clipw
            tu = w1 * a.u + w2 * b.u + w3 * c.u;
            tv = w1 * a.v + w2 * b.v + w3 * c.v;
          }
          const texel = sampleTexture(ts, this.bus, tu, tv);
          // Texel ABGR8888: swap R/B for shader convention (same as vertex color)
          const tr = (texel >>> 16) & 0xFF;  // B of texel
          const tg = (texel >>>  8) & 0xFF;
          const tb = (texel >>>  0) & 0xFF;  // R of texel
          const ta = (texel >>> 24) & 0xFF;
          const o = applyTexFunc(fs, tr, tg, tb, ta, pr, pg, pb, pa);
          r = o[0]!; g = o[1]!; b2 = o[2]!; alpha = o[3]!;
        } else {
          r = pr; g = pg; b2 = pb; alpha = pa;
        }

        if (!passAlphaTest(fs, alpha)) continue;

        const i = fbOff + (y * stride + x) * bpp;
        if (emitFragment(fs, vram, i, x, y, r, g, b2, alpha)) {
          _dbgTriPixels++;
        }
      }
    }
    // Diagnostic: log triangles with valid area but 0 pixels written
    if (Logger.debugEnabled && _dbgTriPixels === 0 && Math.abs(area) > 100) {
      const texel0 = useTexture ? sampleTexture(ts, this.bus, v0.u, v0.v) : 0;
      log.debug(
        `TRI invisible: v0=(${v0.x.toFixed(0)},${v0.y.toFixed(0)}) v1=(${v1.x.toFixed(0)},${v1.y.toFixed(0)}) v2=(${v2.x.toFixed(0)},${v2.y.toFixed(0)}) ` +
        `area=${area.toFixed(0)} col0=0x${v0.color.toString(16)} ` +
        `tex=${useTexture} texAddr=0x${this.texAddr0.toString(16)} texFmt=${this.texFormat} sampleV0=0x${texel0.toString(16)} ` +
        `atest=${this.alphaTestEnable}:${this.alphaTestFunc}:${this.alphaTestRef} ` +
        `blend=${this.alphaBlendEnable} s=${this.blendSrc} d=${this.blendDst} texFunc=${this.texFunc}`
      );
    }
  }

  /** Draw a line between two vertices (Bresenham). */
  private drawLine(v0: Vertex, v1: Vertex): void {
    let x0 = v0.x | 0, y0 = v0.y | 0;
    const x1 = v1.x | 0, y1 = v1.y | 0;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    for (let step = 0; step < dx + dy + 1; step++) {
      this.plotPixel(x0, y0, v0.color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  /** Plot a single pixel through the full fragment pipeline. */
  private plotPixel(x: number, y: number, color: number): void {
    if (x < this.scissorX1 || x > this.scissorX2 || y < this.scissorY1 || y > this.scissorY2) return;
    if (x < 0 || x >= 480 || y < 0 || y >= 272) return;

    const vram = this.bus.vramBuffer;
    const fbOff = this.toVramOffset(this.fbPtr);
    if (fbOff < 0 || fbOff >= vram.length) return;
    const stride = this.fbWidth || 512;

    const r = color & 0xFF, g = (color >>> 8) & 0xFF, b = (color >>> 16) & 0xFF, a = (color >>> 24) & 0xFF;
    const fs = this.fragState;
    if (!passAlphaTest(fs, a)) return;

    const idx = fbOff + (y * stride + x) * this.bpp;
    emitFragment(fs, vram, idx, x, y, r, g, b, a);
  }

  /** Fill a rectangle with clear color (used when clear mode + PRIM).
   *  Per PPSSPP, clear color always comes from vertex color (v1 for sprites).
   *  When vtype has no color attribute, the default vertex color is materialAmbient|materialAlpha. */
  private doClearRect(v0: Vertex, v1: Vertex): void {
    // If neither color nor alpha writes are enabled, nothing to draw
    if (!this.clearColorWrite && !this.clearAlphaWrite) return;

    const x0 = Math.max(0, Math.min(v0.x, v1.x) | 0);
    const y0 = Math.max(0, Math.min(v0.y, v1.y) | 0);
    const x1 = Math.min(480, Math.max(v0.x, v1.x) | 0);
    const y1 = Math.min(272, Math.max(v0.y, v1.y) | 0);

    // Vertex color is ABGR8888 packed as (A<<24)|(B<<16)|(G<<8)|R
    const col = v1.color;
    const colR = col & 0xFF;
    const colG = (col >>> 8) & 0xFF;
    const colB = (col >>> 16) & 0xFF;
    const colA = (col >>> 24) & 0xFF;

    // WebGL clear path — pass true R,G,B,A
    if (this.webglRenderer) {
      this.webglRenderer.clearRect(
        x0, y0, x1, y1, colR, colG, colB, colA,
        this.clearColorWrite, this.clearAlphaWrite, this.clearDepthWrite,
        this.fbPtr, this.fbFormat, this.fbWidth || 512,
        // PSP clear mode writes the rect's own z to depth (here already in [0,1]).
        Math.max(0, Math.min(1, v1.z)),
      );
      return;
    }

    // Software path: writePixel uses internal BGR convention (r=B, g=G, b=R)
    const r = colB;
    const g = colG;
    const b = colR;
    const a = colA;

    const vram = this.bus.vramBuffer;
    const fbOff = this.toVramOffset(this.fbPtr);
    if (fbOff < 0 || fbOff >= vram.length) return;
    const stride = this.fbWidth || 512;

    const bpp = this.bpp;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = fbOff + (y * stride + x) * bpp;
        writePixelFn(vram, i, r, g, b, a, this.fbFormat, this.maskRgb, this.maskAlpha);
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

    const bpp = this.trBpp; // 2 for 16-bit formats, 4 for 32-bit

    // PPSSPP NotifyBlockTransferBefore: if both src and dst are VFBs, GPU blit (no CPU copy).
    if (this.webglRenderer) {
      const srcIsVFB = !!this.webglRenderer.getVFBAt(srcAddr);
      const dstIsVFB = !!this.webglRenderer.getVFBAt(dstAddr);

      if (srcIsVFB && dstIsVFB) {
        // Both are VFBs — GPU blit, skip CPU copy entirely.
        // PPSSPP NotifyBlockTransferBefore returns true (handled).
        this.webglRenderer.blitVFB(srcAddr, dstAddr);
        this.webglRenderer.invalidateTextures();
        return;
      }

      // Source overlaps a VFB (possibly at an offset) — its VRAM bytes are
      // stale, so read the FBO back before the CPU copy below reads them.
      const srcVfbBase = this.webglRenderer.findVFBBaseContaining(srcAddr);
      if (srcVfbBase >= 0) {
        this.webglRenderer.readbackToVRAM(this.bus.vramBuffer, srcVfbBase);
      }
    }

    // CPU copy pixels in VRAM/RAM
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

    if (this.webglRenderer) {
      // Transfer INTO a framebuffer: the FBO never sees CPU memory, so upload
      // the transferred rect into the VFB texture or it stays invisible.
      // PPSSPP NotifyBlockTransferAfter -> DrawPixels (dstBuffer && !srcBuffer,
      // FramebufferManagerCommon.cpp:2823). Offset-tolerant like
      // FindTransferFramebuffer (dstAddr may point inside the VFB).
      this.webglRenderer.uploadRectFromVRAM(
        this.bus.vramBuffer, dstAddr, dstStride, dstX, dstY, width, height, bpp,
      );
      // Invalidate texture cache (textures may have been overwritten)
      this.webglRenderer.invalidateTextures();
    }
  }

  // ── Pixel write helpers ─────────────────────────────────────────────────

  /** Bytes per pixel for the current framebuffer format. */
  private get bpp(): number {
    return this.fbFormat === 3 ? 4 : 2;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Transform a vertex position through the world -> view -> proj pipeline,
   * then apply the viewport transform to produce screen-space pixel coordinates.
   */
  private transformVertex(x: number, y: number, z: number): { sx: number; sy: number; sz: number; cw: number; viewZ: number } {
    // World transform (4x3, column-major): col0=[0..2], col1=[3..5], col2=[6..8], col3=[9..11]
    const wm = this.worldMat;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const wx = wm[0]!*x + wm[3]!*y + wm[6]!*z + wm[9]!;
    const wy = wm[1]!*x + wm[4]!*y + wm[7]!*z + wm[10]!;
    const wz = wm[2]!*x + wm[5]!*y + wm[8]!*z + wm[11]!;

    // View transform (4x3)
    const vm = this.viewMat;
    const vx = vm[0]!*wx + vm[3]!*wy + vm[6]!*wz + vm[9]!;
    const vy = vm[1]!*wx + vm[4]!*wy + vm[7]!*wz + vm[10]!;
    const vz = vm[2]!*wx + vm[5]!*wy + vm[8]!*wz + vm[11]!;

    // Proj transform (4x4, column-major): col0=[0..3], col1=[4..7], col2=[8..11], col3=[12..15]
    const pm = this.projMat;
    const cx = pm[0]!*vx + pm[4]!*vy + pm[8]!*vz  + pm[12]!;
    const cy = pm[1]!*vx + pm[5]!*vy + pm[9]!*vz  + pm[13]!;
    const cz = pm[2]!*vx + pm[6]!*vy + pm[10]!*vz + pm[14]!;
    const cw = pm[3]!*vx + pm[7]!*vy + pm[11]!*vz + pm[15]!;

    // Perspective divide -> NDC
    const invW = cw !== 0 ? 1.0 / cw : 1.0;
    const ndcX = cx * invW;
    const ndcY = cy * invW;
    const ndcZ = cz * invW;

    // Viewport transform: NDC -> screen pixels
    // PSP formula: pixel = ndc * vpScale + vpCenter - geOffset/16
    // vpScaleY is typically negative (PSP flips Y), so this naturally inverts Y.
    const sx = ndcX * this.vpScaleX + this.vpCenterX - this.geOffsetX / 16.0;
    const sy = ndcY * this.vpScaleY + this.vpCenterY - this.geOffsetY / 16.0;
    const sz = (ndcZ * this.vpScaleZ + this.vpCenterZ) / 65535.0;

    return { sx, sy, sz, cw, viewZ: vz };
  }

  /**
   * Generate a single texture coordinate from environment mapping.
   * PPSSPP Lighting.cpp:196-202 GenerateLightCoord:
   *   L = GetLightVec(gstate.lpos, light).NormalizedOr001()
   *   return (dot(L, worldNormal) + 1.0) / 2.0
   */
  private generateLightCoord(light: number, wnx: number, wny: number, wnz: number): number {
    const base = light * 3;
    let lx = this.lightPos[base]!;
    let ly = this.lightPos[base + 1]!;
    let lz = this.lightPos[base + 2]!;
    // NormalizedOr001: if length is 0, use (0,0,1)
    const lLen = Math.sqrt(lx*lx + ly*ly + lz*lz);
    if (lLen > 1e-6) {
      lx /= lLen; ly /= lLen; lz /= lLen;
    } else {
      lx = 0; ly = 0; lz = 1;
    }
    const diffuse = lx * wnx + ly * wny + lz * wnz;
    return (diffuse + 1.0) / 2.0;
  }

  // ── Immediate mode vertex rendering ──────────────────────────────────────

  /**
   * Execute an immediate-mode vertex submission (VAP command, 0xF7).
   * PPSSPP GPUCommon.cpp:1242-1373 Execute_ImmVertexAlphaPrim.
   */
  private executeImmVertex(param: number): void {
    const prim = (param >> 8) & 7;
    const alphaVal = param & 0xFF;

    // If prim type changed (not GE_PRIM_KEEP_PREVIOUS=7), flush and start new batch
    if (prim !== 7) {
      this.flushImmBuffer();
      this.immPrim = prim;
    }

    // Build vertex from immediate state registers
    const throughMode = (this.vtypeRaw >>> 23) & 1;
    let x: number, y: number;
    if (throughMode) {
      // PPSSPP: ((int)(gstate.imm_vscx & 0xFFFF) - 0x8000) / 16.0f
      x = ((this.immVscx & 0xFFFF) - 0x8000) / 16.0;
      y = ((this.immVscy & 0xFFFF) - 0x8000) / 16.0;
    } else {
      // Transform mode: subtract viewport offset
      x = ((this.immVscx & 0xFFFF) - this.geOffsetX) / 16.0;
      y = ((this.immVscy & 0xFFFF) - this.geOffsetY) / 16.0;
    }
    const z = this.immVscz & 0xFFFF;
    const u = getFloat24(this.immVtcs);
    const v = getFloat24(this.immVtct);
    const color = (this.immCv & 0xFFFFFF) | (alphaVal << 24);

    const vert: Vertex = {
      x, y, z, u, v, color,
      nx: 0, ny: 0, nz: 1,
      clipw: 1.0, fogCoef: 1.0,
    };
    this.immBuffer.push(vert);

    // Auto-flush when enough vertices for the primitive type
    // PPSSPP: flushPrimCount[] = { 1, 2, 0, 3, 0, 0, 2, 0 }
    const flushCount = [1, 2, 0, 3, 0, 0, 2, 0][this.immPrim] ?? 0;
    if (flushCount > 0 && this.immBuffer.length >= flushCount) {
      this.flushImmBuffer();
    }
  }

  /** Flush accumulated immediate-mode vertices as a draw call. */
  private flushImmBuffer(): void {
    if (this.immBuffer.length === 0 || this.immPrim < 0) return;

    const vertices = this.immBuffer;
    this.immBuffer = [];

    // Record draw target
    this.lastDrawFbPtr = this.fbPtr;
    this.lastDrawFbWidth = this.fbWidth;
    this.lastDrawFbFormat = this.fbFormat;

    // Immediate vertices are already in screen space — draw directly
    const primType = this.immPrim;

    // WebGL path for immediate mode
    if (this.webglRenderer) {
      this.webglRenderer.drawPrimitives(primType, vertices, this.drawState, this.bus);
      return;
    }

    if (primType === 6) { // SPRITES
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        this.drawSprite(vertices[i]!, vertices[i + 1]!);
      }
    } else if (primType === 3) { // TRIANGLES
      for (let i = 0; i + 2 < vertices.length; i += 3) {
        this.drawTriangle(vertices[i]!, vertices[i + 1]!, vertices[i + 2]!);
      }
    } else if (primType === 4) { // TRIANGLE_STRIP
      for (let i = 0; i + 2 < vertices.length; i++) {
        if (i & 1) {
          this.drawTriangle(vertices[i + 1]!, vertices[i]!, vertices[i + 2]!);
        } else {
          this.drawTriangle(vertices[i]!, vertices[i + 1]!, vertices[i + 2]!);
        }
      }
    } else if (primType === 5) { // TRIANGLE_FAN
      for (let i = 1; i + 1 < vertices.length; i++) {
        this.drawTriangle(vertices[0]!, vertices[i]!, vertices[i + 1]!);
      }
    } else if (primType === 1) { // LINES
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        this.drawLine(vertices[i]!, vertices[i + 1]!);
      }
    } else if (primType === 2) { // LINE_STRIP
      for (let i = 0; i + 1 < vertices.length; i++) {
        this.drawLine(vertices[i]!, vertices[i + 1]!);
      }
    } else if (primType === 0) { // POINTS
      for (const vt of vertices) {
        this.plotPixel(vt.x | 0, vt.y | 0, vt.color);
      }
    }
  }

  // ── CLUT (Color Lookup Table) support ────────────────────────────────────

  private clutAddr = 0;
  private clutFormat = 0;  // 0=5650, 1=5551, 2=4444, 3=8888
  private clutShift = 0;
  private clutMask = 0xFF;
  private clutStart = 0;

  // ── Save state ───────────────────────────────────────────────────────────

  /** Deep-copy one immediate-mode vertex into a plain object (no aliasing). */
  private static cloneVertex(v: Vertex): Vertex {
    const out: Vertex = {
      x: v.x, y: v.y, z: v.z,
      u: v.u, v: v.v,
      color: v.color,
      nx: v.nx, ny: v.ny, nz: v.nz,
      clipw: v.clipw, fogCoef: v.fogCoef,
    };
    if (v.weights) out.weights = [...v.weights];
    return out;
  }

  /** Deep-copy a call-stack entry, keeping baseAddr optional. */
  private static cloneCallEntry(
    e: { pc: number; offsetAddr: number; baseAddr?: number },
  ): { pc: number; offsetAddr: number; baseAddr?: number } {
    const out: { pc: number; offsetAddr: number; baseAddr?: number } =
      { pc: e.pc, offsetAddr: e.offsetAddr };
    if (e.baseAddr !== undefined) out.baseAddr = e.baseAddr;
    return out;
  }

  /**
   * Capture every mutable GE state field into a plain JSON-round-trippable
   * object. Typed arrays become number arrays; callStack/immBuffer become
   * deep-copied plain objects so the snapshot never aliases live state.
   *
   * Skipped on purpose (rebuilt elsewhere, never serialized): signalCallback,
   * webglRenderer, vram32, the bus reference, and the debug counters.
   */
  serialize(): GeProcessorState {
    return {
      baseAddr: this.baseAddr,
      offsetAddr: this.offsetAddr,
      callStack: this.callStack.map((e) => GEProcessor.cloneCallEntry(e)),

      fbPtr: this.fbPtr,
      fbWidth: this.fbWidth,
      fbFormat: this.fbFormat,
      lastDrawFbPtr: this.lastDrawFbPtr,
      lastDrawFbWidth: this.lastDrawFbWidth,
      lastDrawFbFormat: this.lastDrawFbFormat,

      vtypeRaw: this.vtypeRaw,
      vertexAddr: this.vertexAddr,
      indexAddr: this.indexAddr,

      clearMode: this.clearMode,
      clearColorWrite: this.clearColorWrite,
      clearAlphaWrite: this.clearAlphaWrite,
      clearDepthWrite: this.clearDepthWrite,

      texLodSlope: this.texLodSlope,

      texAddr0: this.texAddr0,
      texBufWidth0: this.texBufWidth0,
      texWidth0: this.texWidth0,
      texHeight0: this.texHeight0,
      texFormat: this.texFormat,
      texEnable: this.texEnable,
      texSwizzle: this.texSwizzle,
      texWrapU: this.texWrapU,
      texWrapV: this.texWrapV,
      texFunc: this.texFunc,
      texFuncAlpha: this.texFuncAlpha,
      colorDoubling: this.colorDoubling,
      texEnvColor: this.texEnvColor,
      texMinFilter: this.texMinFilter,
      texMagFilter: this.texMagFilter,
      texMapMode: this.texMapMode,
      texProjMode: this.texProjMode,
      texShadeLS0: this.texShadeLS0,
      texShadeLS1: this.texShadeLS1,
      tgenMat: Array.from(this.tgenMat),
      lightPos: Array.from(this.lightPos),
      texScaleU: this.texScaleU,
      texScaleV: this.texScaleV,
      texOffsetU: this.texOffsetU,
      texOffsetV: this.texOffsetV,

      clutAddr: this.clutAddr,
      clutFormat: this.clutFormat,
      clutShift: this.clutShift,
      clutMask: this.clutMask,
      clutStart: this.clutStart,

      alphaBlendEnable: this.alphaBlendEnable,
      blendSrc: this.blendSrc,
      blendDst: this.blendDst,
      blendOp: this.blendOp,
      blendFixedA: this.blendFixedA,
      blendFixedB: this.blendFixedB,

      alphaTestEnable: this.alphaTestEnable,
      alphaTestFunc: this.alphaTestFunc,
      alphaTestRef: this.alphaTestRef,
      alphaTestMask: this.alphaTestMask,

      scissorX1: this.scissorX1,
      scissorY1: this.scissorY1,
      scissorX2: this.scissorX2,
      scissorY2: this.scissorY2,

      depthTestEnable: this.depthTestEnable,
      depthWriteDisable: this.depthWriteDisable,
      depthFunc: this.depthFunc,

      maskRgb: this.maskRgb,
      maskAlpha: this.maskAlpha,

      stencilTestEnable: this.stencilTestEnable,
      stencilFunc: this.stencilFunc,
      stencilRef: this.stencilRef,
      stencilMask: this.stencilMask,
      stencilSFail: this.stencilSFail,
      stencilZFail: this.stencilZFail,
      stencilZPass: this.stencilZPass,

      colorTestEnable: this.colorTestEnable,
      colorTestFunc: this.colorTestFunc,
      colorTestRef: this.colorTestRef,
      colorTestMask: this.colorTestMask,

      logicOpEnable: this.logicOpEnable,
      logicOp: this.logicOp,

      ditherEnable: this.ditherEnable,
      ditherMatrix: Array.from(this.ditherMatrix),

      fogEnable: this.fogEnable,
      fogColor: this.fogColor,
      fogEnd: this.fogEnd,
      fogSlope: this.fogSlope,

      patchDivU: this.patchDivU,
      patchDivV: this.patchDivV,
      patchPrimType: this.patchPrimType,
      patchFacing: this.patchFacing,

      materialEmissive: this.materialEmissive,
      materialAmbient: this.materialAmbient,
      materialDiffuse: this.materialDiffuse,
      materialSpecular: this.materialSpecular,
      materialAlpha: this.materialAlpha,
      materialSpecCoef: this.materialSpecCoef,
      materialUpdate: this.materialUpdate,
      shadeMode: this.shadeMode,
      reverseNormals: this.reverseNormals,

      lightingEnable: this.lightingEnable,
      lightEnable: [...this.lightEnable],
      lightType: Array.from(this.lightType),
      lightMode: this.lightMode,
      lightDir: Array.from(this.lightDir),
      lightAtt: Array.from(this.lightAtt),
      lightSpotExp: Array.from(this.lightSpotExp),
      lightSpotCutoff: Array.from(this.lightSpotCutoff),
      lightAmbientColor: Array.from(this.lightAmbientColor),
      lightDiffuseColor: Array.from(this.lightDiffuseColor),
      lightSpecularColor: Array.from(this.lightSpecularColor),
      ambientColor: this.ambientColor,
      ambientAlpha: this.ambientAlpha,

      cullEnable: this.cullEnable,
      cullCW: this.cullCW,

      trSrc: this.trSrc,
      trSrcW: this.trSrcW,
      trDst: this.trDst,
      trDstW: this.trDstW,
      trSrcPos: this.trSrcPos,
      trDstPos: this.trDstPos,
      trSize: this.trSize,
      trBpp: this.trBpp,

      boneMats: Array.from(this.boneMats),
      boneMatIdx: this.boneMatIdx,
      worldMat: Array.from(this.worldMat),
      viewMat: Array.from(this.viewMat),
      projMat: Array.from(this.projMat),
      worldMatIdx: this.worldMatIdx,
      viewMatIdx: this.viewMatIdx,
      projMatIdx: this.projMatIdx,
      tgenMatIdx: this.tgenMatIdx,

      vpScaleX: this.vpScaleX,
      vpScaleY: this.vpScaleY,
      vpScaleZ: this.vpScaleZ,
      vpCenterX: this.vpCenterX,
      vpCenterY: this.vpCenterY,
      vpCenterZ: this.vpCenterZ,
      geOffsetX: this.geOffsetX,
      geOffsetY: this.geOffsetY,

      immVscx: this.immVscx,
      immVscy: this.immVscy,
      immVscz: this.immVscz,
      immVtcs: this.immVtcs,
      immVtct: this.immVtct,
      immVtcq: this.immVtcq,
      immCv: this.immCv,
      immFc: this.immFc,
      immScv: this.immScv,
      immBuffer: this.immBuffer.map((v) => GEProcessor.cloneVertex(v)),
      immPrim: this.immPrim,
    };
  }

  /** Restore every field captured by serialize(). Fixed-size typed arrays are
   *  written in place; plain-object arrays are rebuilt as fresh copies so the
   *  restored state never aliases the saved snapshot. */
  deserialize(s: GeProcessorState): void {
    this.baseAddr = s.baseAddr;
    this.offsetAddr = s.offsetAddr;
    this.callStack = s.callStack.map((e) => GEProcessor.cloneCallEntry(e));

    this.fbPtr = s.fbPtr;
    this.fbWidth = s.fbWidth;
    this.fbFormat = s.fbFormat;
    this.lastDrawFbPtr = s.lastDrawFbPtr;
    this.lastDrawFbWidth = s.lastDrawFbWidth;
    this.lastDrawFbFormat = s.lastDrawFbFormat;

    this.vtypeRaw = s.vtypeRaw;
    this.vertexAddr = s.vertexAddr;
    this.indexAddr = s.indexAddr;

    this.clearMode = s.clearMode;
    this.clearColorWrite = s.clearColorWrite;
    this.clearAlphaWrite = s.clearAlphaWrite;
    this.clearDepthWrite = s.clearDepthWrite;

    this.texLodSlope = s.texLodSlope;

    this.texAddr0 = s.texAddr0;
    this.texBufWidth0 = s.texBufWidth0;
    this.texWidth0 = s.texWidth0;
    this.texHeight0 = s.texHeight0;
    this.texFormat = s.texFormat;
    this.texEnable = s.texEnable;
    this.texSwizzle = s.texSwizzle;
    this.texWrapU = s.texWrapU;
    this.texWrapV = s.texWrapV;
    this.texFunc = s.texFunc;
    this.texFuncAlpha = s.texFuncAlpha;
    this.colorDoubling = s.colorDoubling;
    this.texEnvColor = s.texEnvColor;
    this.texMinFilter = s.texMinFilter;
    this.texMagFilter = s.texMagFilter;
    this.texMapMode = s.texMapMode;
    this.texProjMode = s.texProjMode;
    this.texShadeLS0 = s.texShadeLS0;
    this.texShadeLS1 = s.texShadeLS1;
    this.tgenMat.set(s.tgenMat);
    this.lightPos.set(s.lightPos);
    this.texScaleU = s.texScaleU;
    this.texScaleV = s.texScaleV;
    this.texOffsetU = s.texOffsetU;
    this.texOffsetV = s.texOffsetV;

    this.clutAddr = s.clutAddr;
    this.clutFormat = s.clutFormat;
    this.clutShift = s.clutShift;
    this.clutMask = s.clutMask;
    this.clutStart = s.clutStart;

    this.alphaBlendEnable = s.alphaBlendEnable;
    this.blendSrc = s.blendSrc;
    this.blendDst = s.blendDst;
    this.blendOp = s.blendOp;
    this.blendFixedA = s.blendFixedA;
    this.blendFixedB = s.blendFixedB;

    this.alphaTestEnable = s.alphaTestEnable;
    this.alphaTestFunc = s.alphaTestFunc;
    this.alphaTestRef = s.alphaTestRef;
    this.alphaTestMask = s.alphaTestMask;

    this.scissorX1 = s.scissorX1;
    this.scissorY1 = s.scissorY1;
    this.scissorX2 = s.scissorX2;
    this.scissorY2 = s.scissorY2;

    this.depthTestEnable = s.depthTestEnable;
    this.depthWriteDisable = s.depthWriteDisable;
    this.depthFunc = s.depthFunc;

    this.maskRgb = s.maskRgb;
    this.maskAlpha = s.maskAlpha;

    this.stencilTestEnable = s.stencilTestEnable;
    this.stencilFunc = s.stencilFunc;
    this.stencilRef = s.stencilRef;
    this.stencilMask = s.stencilMask;
    this.stencilSFail = s.stencilSFail;
    this.stencilZFail = s.stencilZFail;
    this.stencilZPass = s.stencilZPass;

    this.colorTestEnable = s.colorTestEnable;
    this.colorTestFunc = s.colorTestFunc;
    this.colorTestRef = s.colorTestRef;
    this.colorTestMask = s.colorTestMask;

    this.logicOpEnable = s.logicOpEnable;
    this.logicOp = s.logicOp;

    this.ditherEnable = s.ditherEnable;
    this.ditherMatrix.set(s.ditherMatrix);

    this.fogEnable = s.fogEnable;
    this.fogColor = s.fogColor;
    this.fogEnd = s.fogEnd;
    this.fogSlope = s.fogSlope;

    this.patchDivU = s.patchDivU;
    this.patchDivV = s.patchDivV;
    this.patchPrimType = s.patchPrimType;
    this.patchFacing = s.patchFacing;

    this.materialEmissive = s.materialEmissive;
    this.materialAmbient = s.materialAmbient;
    this.materialDiffuse = s.materialDiffuse;
    this.materialSpecular = s.materialSpecular;
    this.materialAlpha = s.materialAlpha;
    this.materialSpecCoef = s.materialSpecCoef;
    this.materialUpdate = s.materialUpdate;
    this.shadeMode = s.shadeMode;
    this.reverseNormals = s.reverseNormals;

    this.lightingEnable = s.lightingEnable;
    this.lightEnable = [...s.lightEnable];
    this.lightType.set(s.lightType);
    this.lightMode = s.lightMode;
    this.lightDir.set(s.lightDir);
    this.lightAtt.set(s.lightAtt);
    this.lightSpotExp.set(s.lightSpotExp);
    this.lightSpotCutoff.set(s.lightSpotCutoff);
    this.lightAmbientColor.set(s.lightAmbientColor);
    this.lightDiffuseColor.set(s.lightDiffuseColor);
    this.lightSpecularColor.set(s.lightSpecularColor);
    this.ambientColor = s.ambientColor;
    this.ambientAlpha = s.ambientAlpha;

    this.cullEnable = s.cullEnable;
    this.cullCW = s.cullCW;

    this.trSrc = s.trSrc;
    this.trSrcW = s.trSrcW;
    this.trDst = s.trDst;
    this.trDstW = s.trDstW;
    this.trSrcPos = s.trSrcPos;
    this.trDstPos = s.trDstPos;
    this.trSize = s.trSize;
    this.trBpp = s.trBpp;

    this.boneMats.set(s.boneMats);
    this.boneMatIdx = s.boneMatIdx;
    this.worldMat.set(s.worldMat);
    this.viewMat.set(s.viewMat);
    this.projMat.set(s.projMat);
    this.worldMatIdx = s.worldMatIdx;
    this.viewMatIdx = s.viewMatIdx;
    this.projMatIdx = s.projMatIdx;
    this.tgenMatIdx = s.tgenMatIdx;

    this.vpScaleX = s.vpScaleX;
    this.vpScaleY = s.vpScaleY;
    this.vpScaleZ = s.vpScaleZ;
    this.vpCenterX = s.vpCenterX;
    this.vpCenterY = s.vpCenterY;
    this.vpCenterZ = s.vpCenterZ;
    this.geOffsetX = s.geOffsetX;
    this.geOffsetY = s.geOffsetY;

    this.immVscx = s.immVscx;
    this.immVscy = s.immVscy;
    this.immVscz = s.immVscz;
    this.immVtcs = s.immVtcs;
    this.immVtct = s.immVtct;
    this.immVtcq = s.immVtcq;
    this.immCv = s.immCv;
    this.immFc = s.immFc;
    this.immScv = s.immScv;
    this.immBuffer = s.immBuffer.map((v) => GEProcessor.cloneVertex(v));
    this.immPrim = s.immPrim;
  }
}
