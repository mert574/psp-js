import { color5650to8888, color5551to8888, color4444to8888 } from "./ge-types.js";

export interface GEFragmentState {
  alphaTestEnable: boolean;
  alphaTestFunc: number;
  alphaTestRef: number;
  alphaTestMask: number;
  colorTestEnable: boolean;
  colorTestFunc: number;
  colorTestRef: number;
  colorTestMask: number;
  stencilTestEnable: boolean;
  stencilFunc: number;
  stencilRef: number;
  stencilMask: number;
  stencilSFail: number;
  stencilZFail: number;
  stencilZPass: number;
  alphaBlendEnable: boolean;
  blendSrc: number;
  blendDst: number;
  blendOp: number;
  blendFixedA: number;
  blendFixedB: number;
  logicOpEnable: boolean;
  logicOp: number;
  ditherEnable: boolean;
  ditherMatrix: Int8Array;
  fbFormat: number;
  maskRgb: number;
  maskAlpha: number;
  texFunc: number;
  texFuncAlpha: boolean;
  texEnvColor: number;
}

/** Alpha test: returns true if the pixel passes.
 *  PPSSPP ge_constants.h GEComparison enum: 0=NEVER,1=ALWAYS,2=EQUAL,3=NOTEQUAL,
 *  4=LESS,5=LEQUAL,6=GREATER,7=GEQUAL */
export function passAlphaTest(state: GEFragmentState, a: number): boolean {
  if (!state.alphaTestEnable) return true;
  const ref = state.alphaTestRef;
  const val = a & state.alphaTestMask;
  const refMasked = ref & state.alphaTestMask;
  switch (state.alphaTestFunc) {
    case 0: return false;              // NEVER
    case 1: return true;               // ALWAYS
    case 2: return val === refMasked;  // EQUAL
    case 3: return val !== refMasked;  // NOTEQUAL
    case 4: return val < refMasked;    // LESS
    case 5: return val <= refMasked;   // LEQUAL
    case 6: return val > refMasked;    // GREATER
    case 7: return val >= refMasked;   // GEQUAL
    default: return true;
  }
}

/** Color test: returns true if the pixel's RGB passes.
 *  PPSSPP GPUState.h: func is 2-bit subset of GEComparison (0=never,1=always,2=equal,3=notequal).
 *  Test: (pixelRGB & mask) func (ref & mask) */
export function passColorTest(state: GEFragmentState, r: number, g: number, b: number): boolean {
  if (!state.colorTestEnable) return true;
  const pixRgb = (r & 0xFF) | ((g & 0xFF) << 8) | ((b & 0xFF) << 16);
  const masked = pixRgb & state.colorTestMask;
  const refMasked = state.colorTestRef & state.colorTestMask;
  switch (state.colorTestFunc) {
    case 0: return false;              // NEVER
    case 1: return true;               // ALWAYS
    case 2: return masked === refMasked; // EQUAL
    case 3: return masked !== refMasked; // NOTEQUAL
    default: return true;
  }
}

/** Stencil test: compare stencil buffer value against reference.
 *  Returns true if the fragment passes.
 *  PPSSPP ge_constants.h GEComparison: same 8-function enum as alpha test.
 *  Since we don't have a stencil buffer, we use the alpha channel of the
 *  framebuffer pixel as the stencil value (matches PSP hardware for 8888 format). */
export function passStencilTest(state: GEFragmentState, dstAlpha: number): boolean {
  if (!state.stencilTestEnable) return true;
  const val = dstAlpha & state.stencilMask;
  const refMasked = state.stencilRef & state.stencilMask;
  switch (state.stencilFunc) {
    case 0: return false;
    case 1: return true;
    case 2: return val === refMasked;
    case 3: return val !== refMasked;
    case 4: return val < refMasked;
    case 5: return val <= refMasked;
    case 6: return val > refMasked;
    case 7: return val >= refMasked;
    default: return true;
  }
}

/** Apply stencil operation to produce a new stencil/alpha value.
 *  PPSSPP ge_constants.h GEStencilOp:
 *  0=KEEP,1=ZERO,2=REPLACE(ref),3=INVERT,4=INCR,5=DECR */
export function applyStencilOp(state: GEFragmentState, op: number, currentAlpha: number): number {
  switch (op) {
    case 0: return currentAlpha;                         // KEEP
    case 1: return 0;                                    // ZERO
    case 2: return state.stencilRef;                     // REPLACE
    case 3: return (~currentAlpha) & 0xFF;               // INVERT
    case 4: return Math.min(255, currentAlpha + 1);      // INCR
    case 5: return Math.max(0, currentAlpha - 1);        // DECR
    default: return currentAlpha;
  }
}

/** Apply logic operation between source and destination pixel.
 *  PPSSPP DrawPixel.cpp:337-405 — "All operations intentionally preserve alpha/stencil."
 *  Logic ops only affect the lower 24 bits (RGB); alpha byte of new_color is preserved.
 *  ge_constants.h GELogicOp: 0=CLEAR,1=AND,2=AND_REVERSE,3=COPY,
 *  4=AND_INVERTED,5=NOOP,6=XOR,7=OR,8=NOR,9=EQUIV,10=INVERTED,
 *  11=OR_REVERSE,12=COPY_INVERTED,13=OR_INVERTED,14=NAND,15=SET */
export function applyLogicOp(state: GEFragmentState, newColor: number, oldColor: number): number {
  switch (state.logicOp) {
    case 0:  return newColor & 0xFF000000;                                                  // CLEAR
    case 1:  return newColor & (oldColor | 0xFF000000);                                     // AND
    case 2:  return newColor & (~oldColor | 0xFF000000);                                    // AND_REVERSE
    case 3:  return newColor;                                                               // COPY
    case 4:  return (~newColor & (oldColor & 0x00FFFFFF)) | (newColor & 0xFF000000);        // AND_INVERTED
    case 5:  return (oldColor & 0x00FFFFFF) | (newColor & 0xFF000000);                      // NOOP
    case 6:  return newColor ^ (oldColor & 0x00FFFFFF);                                     // XOR
    case 7:  return newColor | (oldColor & 0x00FFFFFF);                                     // OR
    case 8:  return (~(newColor | oldColor) & 0x00FFFFFF) | (newColor & 0xFF000000);        // NOR
    case 9:  return (~(newColor ^ oldColor) & 0x00FFFFFF) | (newColor & 0xFF000000);        // EQUIV
    case 10: return (~oldColor & 0x00FFFFFF) | (newColor & 0xFF000000);                     // INVERTED
    case 11: return newColor | (~oldColor & 0x00FFFFFF);                                    // OR_REVERSE
    case 12: return (~newColor & 0x00FFFFFF) | (newColor & 0xFF000000);                     // COPY_INVERTED
    case 13: return ((~newColor | oldColor) & 0x00FFFFFF) | (newColor & 0xFF000000);        // OR_INVERTED
    case 14: return (~(newColor & oldColor) & 0x00FFFFFF) | (newColor & 0xFF000000);        // NAND
    case 15: return newColor | 0x00FFFFFF;                                                  // SET
    default: return newColor;
  }
}

/** Apply 4x4 dither matrix offset to a color channel.
 *  PPSSPP GPUState.h getDitherValue(x,y): 4-bit signed [-8..+7] */
export function applyDither(state: GEFragmentState, value: number, x: number, y: number): number {
  if (!state.ditherEnable) return value;
  const offset = state.ditherMatrix[(y & 3) * 4 + (x & 3)]!;
  return Math.max(0, Math.min(255, value + offset));
}

/**
 * Apply texture function (texFunc) blending between primitive color and texel color.
 * All channels use the internal convention: r=B-channel, g=G-channel, b=R-channel, a=A-channel
 * (R/B swapped for shader swizzle). Returns [r, g, b, a].
 *
 * PPSSPP reference: GPU/Software/Sampler.cpp lines ~524-592
 * Rounding: PPSSPP uses (prim+1)*tex / 256 for MODULATE/ADD alpha,
 * and (255-tex)*prim + tex*env + 255) / 256 for BLEND RGB (rounds up).
 * DECAL uses (prim+1)*(255-tex_a) + (tex+1)*tex_a) / 256.
 */
export function applyTexFunc(
  state: GEFragmentState,
  tr: number, tg: number, tb: number, ta: number,  // texel (r=B, g=G, b=R, a=A)
  pr: number, pg: number, pb: number, pa: number,  // prim vertex color (same convention)
): [number, number, number, number] {
  const useAlpha = state.texFuncAlpha;
  switch (state.texFunc) {
    case 0: { // MODULATE: out = (prim+1) * tex / 256  — PPSSPP Sampler.cpp:527
      const or = (pr + 1) * tr >> 8;
      const og = (pg + 1) * tg >> 8;
      const ob = (pb + 1) * tb >> 8;
      const oa = useAlpha ? ((pa + 1) * ta >> 8) : pa;
      return [or, og, ob, oa];
    }
    case 1: { // DECAL — PPSSPP Sampler.cpp:534-545
      // out_rgb = ((prim+1)*(255-tex_a) + (tex+1)*tex_a) / 256
      const invA = 255 - ta;
      const or = ((pr + 1) * invA + (tr + 1) * ta) >> 8;
      const og = ((pg + 1) * invA + (tg + 1) * ta) >> 8;
      const ob = ((pb + 1) * invA + (tb + 1) * ta) >> 8;
      return [or, og, ob, pa];
    }
    case 2: { // BLEND — PPSSPP Sampler.cpp:555-569
      // out_rgb = ((255-tex)*prim + tex*texenv + 255) / 256  (rounds UP)
      const er = state.texEnvColor & 0xFF;
      const eg = (state.texEnvColor >>> 8) & 0xFF;
      const eb = (state.texEnvColor >>> 16) & 0xFF;
      const or = ((255 - tr) * pr + tr * er + 255) >> 8;
      const og = ((255 - tg) * pg + tg * eg + 255) >> 8;
      const ob = ((255 - tb) * pb + tb * eb + 255) >> 8;
      const oa = useAlpha ? ((pa + 1) * ta >> 8) : pa;
      return [or, og, ob, oa];
    }
    case 3: { // REPLACE — PPSSPP Sampler.cpp:573-579
      const oa = useAlpha ? ta : pa;
      return [tr, tg, tb, oa];
    }
    case 4: { // ADD — PPSSPP Sampler.cpp:581-592
      // out_rgb = prim + tex (clamped later)
      const or = pr + tr;
      const og = pg + tg;
      const ob = pb + tb;
      const oa = useAlpha ? ((pa + 1) * ta >> 8) : pa;
      return [or, og, ob, oa];
    }
    default:
      return [tr, tg, tb, ta];
  }
}

/** Alpha blend: combine source (r,g,b,a) with destination. Returns [r,g,b,a]. */
export function blend(
  state: GEFragmentState,
  sr: number, sg: number, sb: number, sa: number, dst: number,
): [number, number, number, number] {
  const dr = dst & 0xFF, dg = (dst >>> 8) & 0xFF, db = (dst >>> 16) & 0xFF, da = (dst >>> 24) & 0xFF;

  // Get source and dest factors
  let sfR: number, sfG: number, sfB: number;
  let dfR: number, dfG: number, dfB: number;

  [sfR, sfG, sfB] = getBlendFactor(state, state.blendSrc, sr, sg, sb, sa, dr, dg, db, da, true);
  [dfR, dfG, dfB] = getBlendFactor(state, state.blendDst, sr, sg, sb, sa, dr, dg, db, da, false);

  // Apply blend op
  let outR: number, outG: number, outB: number;
  switch (state.blendOp) {
    case 0: // ADD
      outR = sr * sfR / 255 + dr * dfR / 255;
      outG = sg * sfG / 255 + dg * dfG / 255;
      outB = sb * sfB / 255 + db * dfB / 255;
      break;
    case 1: // SUBTRACT
      outR = sr * sfR / 255 - dr * dfR / 255;
      outG = sg * sfG / 255 - dg * dfG / 255;
      outB = sb * sfB / 255 - db * dfB / 255;
      break;
    case 2: // REVERSE_SUBTRACT
      outR = dr * dfR / 255 - sr * sfR / 255;
      outG = dg * dfG / 255 - sg * sfG / 255;
      outB = db * dfB / 255 - sb * sfB / 255;
      break;
    case 3: // MIN
      outR = Math.min(sr, dr);
      outG = Math.min(sg, dg);
      outB = Math.min(sb, db);
      break;
    case 4: // MAX
      outR = Math.max(sr, dr);
      outG = Math.max(sg, dg);
      outB = Math.max(sb, db);
      break;
    case 5: // ABS
      outR = Math.abs(sr - dr);
      outG = Math.abs(sg - dg);
      outB = Math.abs(sb - db);
      break;
    default:
      outR = sr; outG = sg; outB = sb;
  }

  return [
    Math.max(0, Math.min(255, outR | 0)),
    Math.max(0, Math.min(255, outG | 0)),
    Math.max(0, Math.min(255, outB | 0)),
    sa, // alpha passthrough
  ];
}

/** Get blend factor RGB values (0-255).
 *  PSP uses SEPARATE factor tables for source and destination (unlike OpenGL).
 *
 *  Source factors (GEBlendSrcFactor):
 *    0=DST_COLOR  1=INV_DST_COLOR  2=SRC_ALPHA  3=INV_SRC_ALPHA
 *    4=DST_ALPHA  5=INV_DST_ALPHA  6=2*SRC_ALPHA  7=2*INV_SRC_ALPHA
 *    8=2*DST_ALPHA  9=2*INV_DST_ALPHA  10=FIXA
 *
 *  Destination factors (GEBlendDstFactor):
 *    0=SRC_COLOR  1=INV_SRC_COLOR  2=SRC_ALPHA  3=INV_SRC_ALPHA
 *    4=DST_ALPHA  5=INV_DST_ALPHA  6=2*SRC_ALPHA  7=2*INV_SRC_ALPHA
 *    8=2*DST_ALPHA  9=2*INV_DST_ALPHA  10=FIXB
 */
export function getBlendFactor(
  state: GEFragmentState,
  factor: number, sr: number, sg: number, sb: number, sa: number,
  dr: number, dg: number, db: number, da: number, isSrc: boolean,
): [number, number, number] {
  if (isSrc) {
    switch (factor) {
      case 0:  return [dr, dg, db];                                            // DST_COLOR
      case 1:  return [255 - dr, 255 - dg, 255 - db];                         // INV_DST_COLOR
      case 2:  return [sa, sa, sa];                                            // SRC_ALPHA
      case 3:  return [255 - sa, 255 - sa, 255 - sa];                         // INV_SRC_ALPHA
      case 4:  return [da, da, da];                                            // DST_ALPHA
      case 5:  return [255 - da, 255 - da, 255 - da];                         // INV_DST_ALPHA
      case 6:  return [Math.min(255, 2*sa), Math.min(255, 2*sa), Math.min(255, 2*sa)];    // 2*SRC_ALPHA
      case 7:  { const v = Math.min(255, 2*(255-sa)); return [v, v, v]; }     // 2*INV_SRC_ALPHA
      case 8:  return [Math.min(255, 2*da), Math.min(255, 2*da), Math.min(255, 2*da)];    // 2*DST_ALPHA
      case 9:  { const v = Math.min(255, 2*(255-da)); return [v, v, v]; }     // 2*INV_DST_ALPHA
      case 10: { const f = state.blendFixedA; return [f & 0xFF, (f >> 8) & 0xFF, (f >> 16) & 0xFF]; } // FIXA
      default: return [255, 255, 255];
    }
  } else {
    switch (factor) {
      case 0:  return [sr, sg, sb];                                            // SRC_COLOR
      case 1:  return [255 - sr, 255 - sg, 255 - sb];                         // INV_SRC_COLOR
      case 2:  return [sa, sa, sa];                                            // SRC_ALPHA
      case 3:  return [255 - sa, 255 - sa, 255 - sa];                         // INV_SRC_ALPHA
      case 4:  return [da, da, da];                                            // DST_ALPHA
      case 5:  return [255 - da, 255 - da, 255 - da];                         // INV_DST_ALPHA
      case 6:  return [Math.min(255, 2*sa), Math.min(255, 2*sa), Math.min(255, 2*sa)];    // 2*SRC_ALPHA
      case 7:  { const v = Math.min(255, 2*(255-sa)); return [v, v, v]; }     // 2*INV_SRC_ALPHA
      case 8:  return [Math.min(255, 2*da), Math.min(255, 2*da), Math.min(255, 2*da)];    // 2*DST_ALPHA
      case 9:  { const v = Math.min(255, 2*(255-da)); return [v, v, v]; }     // 2*INV_DST_ALPHA
      case 10: { const f = state.blendFixedB; return [f & 0xFF, (f >> 8) & 0xFF, (f >> 16) & 0xFF]; } // FIXB
      default: return [255, 255, 255];
    }
  }
}

/** Read a pixel from VRAM as ABGR8888. */
export function readPixel(vram: Uint8Array, off: number, fbFormat: number): number {
  if (fbFormat === 3) {
    if (off + 3 >= vram.length) return 0;
    return vram[off]! | (vram[off + 1]! << 8) | (vram[off + 2]! << 16) | (vram[off + 3]! << 24);
  }
  if (off + 1 >= vram.length) return 0;
  const px = vram[off]! | (vram[off + 1]! << 8);
  switch (fbFormat) {
    case 0: return color5650to8888(px);
    case 1: return color5551to8888(px);
    case 2: return color4444to8888(px);
    default: return 0;
  }
}

/** Write a pixel (r,g,b,a in 0-255) to VRAM at byte offset, respecting fbFormat. */
export function writePixel(
  vram: Uint8Array, off: number, r: number, g: number, b: number, a: number,
  fbFormat: number, maskRgb: number, maskAlpha: number,
): void {
  if (fbFormat === 3) {
    // ABGR8888
    if (off + 3 < vram.length) {
      if (maskRgb === 0 && maskAlpha === 0) {
        vram[off]     = r;
        vram[off + 1] = g;
        vram[off + 2] = b;
        vram[off + 3] = a;
      } else {
        const mr = maskRgb & 0xFF;
        const mg = (maskRgb >>> 8) & 0xFF;
        const mb = (maskRgb >>> 16) & 0xFF;
        const ma = maskAlpha;
        vram[off]     = (r & ~mr) | (vram[off]!   & mr);
        vram[off + 1] = (g & ~mg) | (vram[off+1]! & mg);
        vram[off + 2] = (b & ~mb) | (vram[off+2]! & mb);
        vram[off + 3] = (a & ~ma) | (vram[off+3]! & ma);
      }
    }
  } else if (off + 1 < vram.length) {
    let px: number;
    switch (fbFormat) {
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

/**
 * Full fragment output pipeline matching PPSSPP DrawPixel.cpp:665-764 order:
 *   color test -> stencil test -> blend+dither -> stencil->alpha -> logic op -> write.
 * Returns true if the pixel was written.
 */
export function emitFragment(
  state: GEFragmentState, vram: Uint8Array, idx: number, x: number, y: number,
  r: number, g: number, b: number, a: number,
): boolean {
  // 1. Color test (DrawPixel.cpp:687-689)
  if (!passColorTest(state, r, g, b)) return false;

  const oldColor = readPixel(vram, idx, state.fbFormat);
  const dstA = (oldColor >>> 24) & 0xFF;

  // 2. Stencil test (DrawPixel.cpp:697-712)
  let stencil = dstA;
  if (state.stencilTestEnable) {
    if (!passStencilTest(state, stencil)) {
      // sfail: update stencil only (DrawPixel.cpp:700-702)
      stencil = applyStencilOp(state, state.stencilSFail, stencil);
      writePixel(vram, idx, oldColor & 0xFF, (oldColor >>> 8) & 0xFF, (oldColor >>> 16) & 0xFF, stencil,
                 state.fbFormat, state.maskRgb, state.maskAlpha);
      return false;
    }
    // Note: depth test would go here (zfail path) but we don't have a depth buffer
    // zpass: (DrawPixel.cpp:712)
    stencil = applyStencilOp(state, state.stencilZPass, stencil);
  }

  // 3. Blend + dither (DrawPixel.cpp:727-748)
  // PPSSPP applies dither AFTER blend but before clamp, or to prim color if no blend.
  if (state.alphaBlendEnable) {
    [r, g, b, a] = blend(state, r, g, b, a, oldColor);
    r = applyDither(state, r, x, y);
    g = applyDither(state, g, x, y);
    b = applyDither(state, b, x, y);
  } else {
    r = applyDither(state, r, x, y);
    g = applyDither(state, g, x, y);
    b = applyDither(state, b, x, y);
  }

  // 4. Pack new_color with alpha (DrawPixel.cpp:736/745-748)
  // When stencil test is enabled, the stencil op result goes into the alpha byte.
  // When disabled, use the source alpha (from blend output or prim color).
  const outA = state.stencilTestEnable ? stencil : (a & 0xFF);
  let newColor = (Math.max(0, Math.min(255, r)) & 0xFF)
               | ((Math.max(0, Math.min(255, g)) & 0xFF) << 8)
               | ((Math.max(0, Math.min(255, b)) & 0xFF) << 16)
               | ((outA & 0xFF) << 24);

  // 5. Logic op — preserves alpha/stencil (DrawPixel.cpp:752-754)
  if (state.logicOpEnable) {
    newColor = applyLogicOp(state, newColor, oldColor);
  }

  // 6. Write (DrawPixel.cpp:764)
  writePixel(vram, idx, newColor & 0xFF, (newColor >>> 8) & 0xFF,
              (newColor >>> 16) & 0xFF, (newColor >>> 24) & 0xFF,
              state.fbFormat, state.maskRgb, state.maskAlpha);
  return true;
}
