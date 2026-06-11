/**
 * PSP Bezier and B-Spline patch tessellation.
 *
 * Algorithms match PPSSPP's GPU/Common/SplineCommon.cpp:
 *   - Bezier3DWeight::CalcWeights  (Bernstein basis + derivatives)
 *   - Spline3DWeight::CalcKnots / CalcWeights  (cubic B-spline with open/closed knot types)
 *   - SubdivisionSurface::Tessellate  (patch evaluation + normal computation)
 */

import type { Vertex } from "./ge-types.js";

// ---------------------------------------------------------------------------
// Weight type — 4 basis values + 4 derivative values
// ---------------------------------------------------------------------------

interface Weight {
  b0: number; b1: number; b2: number; b3: number;
  d0: number; d1: number; d2: number; d3: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len < 1e-30) return [0, 0, 1];
  const inv = 1.0 / len;
  return [x * inv, y * inv, z * inv];
}

// ---------------------------------------------------------------------------
// Bezier weight computation  (PPSSPP Bezier3DWeight::CalcWeights)
// ---------------------------------------------------------------------------

function calcBezierWeights(tess: number): Weight[] {
  const weights: Weight[] = [];
  const inv = 1.0 / tess;
  for (let i = 0; i <= tess; i++) {
    const t = i * inv;
    const mt = 1 - t;
    weights.push({
      b0: mt * mt * mt,
      b1: 3 * t * mt * mt,
      b2: 3 * t * t * mt,
      b3: t * t * t,
      d0: -3 * mt * mt,
      d1: 9 * t * t - 12 * t + 3,
      d2: 3 * (2 - 3 * t) * t,
      d3: 3 * t * t,
    });
  }
  return weights;
}

// ---------------------------------------------------------------------------
// Spline weight computation  (PPSSPP Spline3DWeight)
// ---------------------------------------------------------------------------

interface KnotDiv {
  _3_0: number; _4_1: number; _5_2: number;
  _3_1: number; _4_2: number; _3_2: number;
}

function calcSplineKnotsAndDivs(n: number, type: number): { knots: number[]; divs: KnotDiv[] } {
  const knots: number[] = [];
  const divs: KnotDiv[] = [];
  for (let i = 0; i < n; i++) {
    divs.push({ _3_0: 1 / 3, _4_1: 1 / 3, _5_2: 1 / 3, _3_1: 1 / 2, _4_2: 1 / 2, _3_2: 1 });
  }
  for (let i = 0; i < n + 2; i++) {
    knots.push(i - 2);
  }

  if ((type & 1) !== 0) {
    knots[0] = 0;
    knots[1] = 0;
    const d0 = divs[0]!;
    d0._3_0 = 1.0;
    d0._4_1 = 1.0 / 2.0;
    d0._3_1 = 1.0;
    if (n > 1) divs[1]!._3_0 = 1.0 / 2.0;
  }
  if ((type & 2) !== 0) {
    const dLast = divs[n - 1]!;
    dLast._4_1 = 1.0 / 2.0;
    dLast._5_2 = 1.0;
    dLast._4_2 = 1.0;
    if (n > 1) divs[n - 2]!._5_2 = 1.0 / 2.0;
  }

  return { knots, divs };
}

function calcSplineWeight(t: number, knots: number[], knotOff: number, div: KnotDiv): Weight {
  const t0 = t - knots[knotOff]!;
  const t1 = t - knots[knotOff + 1]!;
  const t2 = t - knots[knotOff + 2]!;

  const f30 = t0 * div._3_0;
  const f41 = t1 * div._4_1;
  const f52 = t2 * div._5_2;
  const f31 = t1 * div._3_1;
  const f42 = t2 * div._4_2;
  const f32 = t2 * div._3_2;

  const a = (1 - f30) * (1 - f31);
  const b = f31 * f41;
  const c = (1 - f41) * (1 - f42);
  const d = f42 * f52;

  const i1 = (1 - f31) * (1 - f32);
  const i2 = f31 * (1 - f32) + (1 - f42) * f32;
  const i3 = f42 * f32;
  const f130 = i1 * div._3_0;
  const f241 = i2 * div._4_1;
  const f352 = i3 * div._5_2;

  return {
    b0: a * (1 - f32),
    b1: 1 - a - b + (a + b + c - 1) * f32,
    b2: b + (1 - b - c - d) * f32,
    b3: d * f32,
    d0: 3 * (0 - f130),
    d1: 3 * (f130 - f241),
    d2: 3 * (f241 - f352),
    d3: 3 * (f352 - 0),
  };
}

function calcSplineWeightsAll(tess: number, count: number, type: number): Weight[] {
  const numPatches = count - 3;
  const weights: Weight[] = new Array<Weight>(tess * numPatches + 1);
  const { knots, divs } = calcSplineKnotsAndDivs(numPatches, type);
  const invTess = 1.0 / tess;

  for (let i = 0; i < numPatches; i++) {
    const start = i === 0 ? 0 : 1;
    for (let j = start; j <= tess; j++) {
      const index = i * tess + j;
      const t = index * invTess;
      weights[index] = calcSplineWeight(t, knots, i, divs[i]!);
    }
  }
  return weights;
}

// ---------------------------------------------------------------------------
// Core: evaluate one 4x4 control-point block at a single (wu, wv) sample
// ---------------------------------------------------------------------------

function evalSample(
  cp: Vertex[],
  cpIdx: number[],
  wu: Weight,
  wv: Weight,
  patchFacing: boolean,
): Vertex {
  // Unroll 4x4 accumulation using named weight fields — avoids array indexing
  // that triggers noUncheckedIndexedAccess.
  const buArr = [wu.b0, wu.b1, wu.b2, wu.b3] as const;
  const duArr = [wu.d0, wu.d1, wu.d2, wu.d3] as const;
  const bvArr = [wv.b0, wv.b1, wv.b2, wv.b3] as const;
  const dvArr = [wv.d0, wv.d1, wv.d2, wv.d3] as const;

  let px = 0, py = 0, pz = 0;
  let dux = 0, duy = 0, duz = 0;
  let dvx = 0, dvy = 0, dvz = 0;
  let tu = 0, tv = 0;
  let cr = 0, cg = 0, cb = 0, ca = 0;

  for (let j = 0; j < 4; j++) {
    const bv = bvArr[j as 0 | 1 | 2 | 3];
    const dv = dvArr[j as 0 | 1 | 2 | 3];
    for (let i = 0; i < 4; i++) {
      const bu = buArr[i as 0 | 1 | 2 | 3];
      const du = duArr[i as 0 | 1 | 2 | 3];
      const w = bu * bv;
      const p = cp[cpIdx[j * 4 + i]!]!;

      px += w * p.x; py += w * p.y; pz += w * p.z;
      tu += w * p.u; tv += w * p.v;

      dux += du * bv * p.x; duy += du * bv * p.y; duz += du * bv * p.z;
      dvx += bu * dv * p.x; dvy += bu * dv * p.y; dvz += bu * dv * p.z;

      const col = p.color;
      cr += w * (col & 0xFF);
      cg += w * ((col >>> 8) & 0xFF);
      cb += w * ((col >>> 16) & 0xFF);
      ca += w * ((col >>> 24) & 0xFF);
    }
  }

  let [nx, ny, nz] = normalize3(
    duy * dvz - duz * dvy,
    duz * dvx - dux * dvz,
    dux * dvy - duy * dvx,
  );
  if (patchFacing) { nx = -nx; ny = -ny; nz = -nz; }

  return {
    x: px, y: py, z: pz,
    u: tu, v: tv,
    nx, ny, nz,
    color: (
      (clamp255(ca) << 24) | (clamp255(cb) << 16) | (clamp255(cg) << 8) | clamp255(cr)
    ) >>> 0,
    clipw: 1.0,
    fogCoef: 1.0,
  };
}

// ---------------------------------------------------------------------------
// Grid → triangle list
// ---------------------------------------------------------------------------

function gridToTriangles(grid: Vertex[], gridW: number, gridH: number): Vertex[] {
  const tris: Vertex[] = [];
  for (let v = 0; v < gridH - 1; v++) {
    for (let u = 0; u < gridW - 1; u++) {
      const i0 = v * gridW + u;
      const i2 = (v + 1) * gridW + u;
      // Winding matches PPSSPP BuildIndex: (0,2,1), (1,2,3)
      tris.push(grid[i0]!, grid[i2]!, grid[i0 + 1]!);
      tris.push(grid[i0 + 1]!, grid[i2]!, grid[i2 + 1]!);
    }
  }
  return tris;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Tessellate a Bezier surface composed of 4x4 cubic patches.
 *
 * Control points are row-major: index = v * uCount + u.
 * Adjacent patches overlap by 1 control point (stride 3), so
 * numPatchesU = (uCount - 1) / 3, matching PPSSPP BezierSurface.
 */
export function tessellateBezier(
  controlPoints: Vertex[],
  uCount: number,
  vCount: number,
  divU: number,
  divV: number,
  patchFacing: boolean,
): Vertex[] {
  if (divU < 1) divU = 1;
  if (divV < 1) divV = 1;
  if (uCount < 4 || vCount < 4) return [];

  const numPatchesU = Math.floor((uCount - 1) / 3);
  const numPatchesV = Math.floor((vCount - 1) / 3);

  const wU = calcBezierWeights(divU);
  const wV = calcBezierWeights(divV);

  const allTriangles: Vertex[] = [];

  for (let pv = 0; pv < numPatchesV; pv++) {
    for (let pu = 0; pu < numPatchesU; pu++) {
      const cpIdx: number[] = [];
      const baseU = pu * 3;
      const baseV = pv * 3;
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          cpIdx.push((baseV + j) * uCount + (baseU + i));
        }
      }

      // Evaluate the tessellation grid for this patch
      const gridW = divU + 1;
      const gridH = divV + 1;
      const grid: Vertex[] = new Array<Vertex>(gridW * gridH);

      for (let iv = 0; iv < gridH; iv++) {
        for (let iu = 0; iu < gridW; iu++) {
          grid[iv * gridW + iu] = evalSample(controlPoints, cpIdx, wU[iu]!, wV[iv]!, patchFacing);
        }
      }

      const tris = gridToTriangles(grid, gridW, gridH);
      for (let k = 0; k < tris.length; k++) allTriangles.push(tris[k]!);
    }
  }

  return allTriangles;
}

/**
 * Tessellate a B-spline surface.
 *
 * typeU / typeV encode open/closed knot configuration:
 *   bit 0 = open start, bit 1 = open end.
 * Number of patches: (uCount - 3) x (vCount - 3), matching PPSSPP SplineSurface.
 */
export function tessellateSpline(
  controlPoints: Vertex[],
  uCount: number,
  vCount: number,
  typeU: number,
  typeV: number,
  divU: number,
  divV: number,
  patchFacing: boolean,
): Vertex[] {
  if (divU < 1) divU = 1;
  if (divV < 1) divV = 1;
  if (uCount < 4 || vCount < 4) return [];

  const numPatchesU = uCount - 3;
  const numPatchesV = vCount - 3;

  const allWeightsU = calcSplineWeightsAll(divU, uCount, typeU);
  const allWeightsV = calcSplineWeightsAll(divV, vCount, typeV);

  // Spline patches share edge vertices — build one big grid
  const totalU = numPatchesU * divU + 1;
  const totalV = numPatchesV * divV + 1;
  const grid: Vertex[] = new Array<Vertex>(totalU * totalV);

  for (let pv = 0; pv < numPatchesV; pv++) {
    const startV = pv === 0 ? 0 : 1;
    for (let pu = 0; pu < numPatchesU; pu++) {
      const startU = pu === 0 ? 0 : 1;

      const cpIdx: number[] = [];
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          cpIdx.push((pv + j) * uCount + (pu + i));
        }
      }

      for (let tv = startV; tv <= divV; tv++) {
        const indexV = pv * divV + tv;
        const wv = allWeightsV[indexV]!;

        for (let tu = startU; tu <= divU; tu++) {
          const indexU = pu * divU + tu;
          const wu = allWeightsU[indexU]!;

          grid[indexV * totalU + indexU] = evalSample(controlPoints, cpIdx, wu, wv, patchFacing);
        }
      }
    }
  }

  return gridToTriangles(grid, totalU, totalV);
}
