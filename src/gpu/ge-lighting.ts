/**
 * PSP vertex lighting — matches PPSSPP GPU/Software/Lighting.cpp exactly.
 *
 * Fixed-point math uses s9 factors: LightColorFactor(c) = c * 2 + 1 per channel,
 * then LightColorScaleBy512(factor, color, scale) = (factor * color * scale) >> 19.
 */


// ---------------------------------------------------------------------------
// Public state interface
// ---------------------------------------------------------------------------

export interface LightingState {
  lightingEnable: boolean;
  lightEnable: boolean[];           // 4 lights
  lightType: number[];              // 4 lights: bits [1:0]=type(0=dir,1=point,2=spot), bit 2=poweredDiffuse
  lightPos: Float32Array;           // 4*3 floats (x,y,z per light) — getFloat24 decoded
  lightDir: Float32Array;           // 4*3 floats — direction vectors
  lightAtt: Float32Array;           // 4*3 floats — attenuation (kA, kB, kC)
  lightSpotExp: Float32Array;       // 4 floats
  lightSpotCutoff: Float32Array;    // 4 floats (cos of cutoff angle)
  lightAmbientColor: Uint32Array;   // 4 values, 24-bit RGB packed
  lightDiffuseColor: Uint32Array;   // 4 values
  lightSpecularColor: Uint32Array;  // 4 values
  ambientColor: number;             // global ambient RGB (24-bit)
  ambientAlpha: number;             // global ambient alpha (8-bit)
  materialEmissive: number;         // 24-bit RGB
  materialAmbient: number;          // 24-bit RGB
  materialAlpha: number;            // 8-bit
  materialDiffuse: number;          // 24-bit RGB
  materialSpecular: number;         // 24-bit RGB
  materialSpecCoef: number;         // specular exponent (float)
  lightMode: number;                // 0=single color, 1=separate specular
  materialUpdate: number;           // bits: 0=ambient, 1=diffuse, 2=specular use vertex color
  reverseNormals: boolean;
}

// ---------------------------------------------------------------------------
// Precomputed per-light state
// ---------------------------------------------------------------------------

interface LightPrecomp {
  enabled: boolean;
  directional: boolean;
  spot: boolean;
  poweredDiffuse: boolean;
  hasAmbient: boolean;
  hasDiffuse: boolean;
  hasSpecular: boolean;
  posX: number; posY: number; posZ: number;
  attX: number; attY: number; attZ: number;
  spotDirX: number; spotDirY: number; spotDirZ: number;
  spotCutoff: number;
  spotExp: number;
  ambientColorFactor: Vec4;
  diffuseColorFactor: Vec4;
  specularColorFactor: Vec4;
}

// Simple 4-component integer vector (R, G, B, A)
type Vec4 = [number, number, number, number];

// ---------------------------------------------------------------------------
// Helper: pspLightPow — matches PPSSPP Lighting.cpp:47
// ---------------------------------------------------------------------------

function pspLightPow(v: number, e: number): number {
  if (e <= 0.0) return 1.0;
  if (v > 0.0) return Math.pow(v, e);
  return v; // negative stays negative
}

// ---------------------------------------------------------------------------
// Helper: normalizeOr001 — normalize vector, fallback (0,0,1) if length ~ 0
// Returns [nx, ny, nz, length].
// ---------------------------------------------------------------------------

function normalizeOr001(x: number, y: number, z: number): [number, number, number, number] {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len > 0.0) {
    const inv = 1.0 / len;
    return [x * inv, y * inv, z * inv, len];
  }
  return [0, 0, 1, 0];
}

// ---------------------------------------------------------------------------
// Vec4 color helpers (RGBA channels as integers 0-255)
// ---------------------------------------------------------------------------

/** Expand a 24-bit RGB packed value into [R, G, B, 0]. */
function fromRGB24(c: number): Vec4 {
  return [c & 0xFF, (c >>> 8) & 0xFF, (c >>> 16) & 0xFF, 0];
}

/** Expand a 24-bit RGB + separate 8-bit alpha into [R, G, B, A]. */
function fromRGBA(rgb: number, a: number): Vec4 {
  return [rgb & 0xFF, (rgb >>> 8) & 0xFF, (rgb >>> 16) & 0xFF, a & 0xFF];
}

/** Expand ABGR8888 into [R, G, B, A]. */
function fromABGR(c: number): Vec4 {
  return [c & 0xFF, (c >>> 8) & 0xFF, (c >>> 16) & 0xFF, (c >>> 24) & 0xFF];
}

/** LightColorFactor: c * 2 + 1 per channel (s9 representation). */
function lightColorFactor4(rgba: Vec4): Vec4 {
  return [rgba[0] * 2 + 1, rgba[1] * 2 + 1, rgba[2] * 2 + 1, rgba[3] * 2 + 1];
}

/**
 * IsLargerThanHalf — PPSSPP scalar path checks v[i] > 1 for i = 0..2,
 * but uses `=` not `|=`, so only the last iteration (i=2, blue channel) matters.
 */
function isLargerThanHalf(factor: Vec4): boolean {
  return factor[2] > 1;
}

/** LightColorScaleBy512: (factor * color * scale) >> 19 per channel. */
function lightColorScaleBy512(factor: Vec4, color: Vec4, scale: number): Vec4 {
  return [
    (factor[0] * color[0] * scale) >> 19,
    (factor[1] * color[1] * scale) >> 19,
    (factor[2] * color[2] * scale) >> 19,
    (factor[3] * color[3] * scale) >> 19,
  ];
}

/** LightCeil — integer ceiling. */
function lightCeil(f: number): number {
  return Math.ceil(f);
}

/** Clamp integer to [0, 255]. */
function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Check if a float is negative (including -0 and -NaN). Matches std::signbit. */
function signbit(v: number): boolean {
  if (v === 0) return 1 / v === -Infinity; // -0
  if (isNaN(v)) {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setFloat64(0, v);
    return (buf.getUint8(0) & 0x80) !== 0;
  }
  return v < 0;
}

// ---------------------------------------------------------------------------
// Build precomputed light (mirrors Lighting::ComputeState per-light loop)
// ---------------------------------------------------------------------------

function buildLightPrecomp(state: LightingState, idx: number): LightPrecomp {
  const ltype = state.lightType[idx] ?? 0;
  // PPSSPP GPUState.h:337-344:
  //   getLightComputation = ltype & 3  (0=diffuse, 1=both, 2=poweredDiffuse)
  //   getLightType = (ltype >> 8) & 3  (0=directional, 1=point, 2+=spot)
  //   isUsingSpecularLight = (ltype & 3) === 1
  //   isUsingPoweredDiffuseLight = (ltype & 3) === 2
  const lightComp = ltype & 3;
  const lightGeomType = (ltype >> 8) & 3;

  const lp: LightPrecomp = {
    enabled: !!state.lightEnable[idx],
    directional: lightGeomType === 0,    // GE_LIGHTTYPE_DIRECTIONAL
    spot: lightGeomType >= 2,            // GE_LIGHTTYPE_SPOT (2 or 3)
    poweredDiffuse: lightComp === 2,     // GE_LIGHTCOMP_ONLYPOWDIFFUSE
    hasAmbient: false,
    hasDiffuse: false,
    hasSpecular: false,
    posX: 0, posY: 0, posZ: 0,
    attX: 0, attY: 0, attZ: 0,
    spotDirX: 0, spotDirY: 0, spotDirZ: 0,
    spotCutoff: 0,
    spotExp: 0,
    ambientColorFactor: [1, 1, 1, 1],
    diffuseColorFactor: [1, 1, 1, 1],
    specularColorFactor: [1, 1, 1, 1],
  };

  if (!lp.enabled) return lp;

  // PPSSPP Lighting.cpp:103 — check isUsingSpecularLight BEFORE computing specular factor
  const usesSpecular = lightComp === 1; // GE_LIGHTCOMP_BOTH

  // Ambient color factor
  lp.ambientColorFactor = lightColorFactor4(fromRGB24(state.lightAmbientColor[idx] ?? 0));
  lp.hasAmbient = isLargerThanHalf(lp.ambientColorFactor);

  // Diffuse color factor
  lp.diffuseColorFactor = lightColorFactor4(fromRGB24(state.lightDiffuseColor[idx] ?? 0));
  lp.hasDiffuse = isLargerThanHalf(lp.diffuseColorFactor);

  // Specular color factor — only computed when light computation mode is BOTH
  if (usesSpecular) {
    lp.specularColorFactor = lightColorFactor4(fromRGB24(state.lightSpecularColor[idx] ?? 0));
    lp.hasSpecular = isLargerThanHalf(lp.specularColorFactor);
  }

  // If nothing contributes, disable (matches PPSSPP)
  if (!lp.hasSpecular && !lp.hasAmbient && !lp.hasDiffuse) {
    lp.enabled = false;
    return lp;
  }

  // Position
  const pi = idx * 3;
  lp.posX = state.lightPos[pi] ?? 0;
  lp.posY = state.lightPos[pi + 1] ?? 0;
  lp.posZ = state.lightPos[pi + 2] ?? 0;

  if (lp.directional) {
    const [nx, ny, nz] = normalizeOr001(lp.posX, lp.posY, lp.posZ);
    lp.posX = nx; lp.posY = ny; lp.posZ = nz;
  } else {
    lp.attX = state.lightAtt[pi] ?? 0;
    lp.attY = state.lightAtt[pi + 1] ?? 0;
    lp.attZ = state.lightAtt[pi + 2] ?? 0;
  }

  // Spot parameters
  if (lp.spot) {
    const dx = state.lightDir[pi] ?? 0;
    const dy = state.lightDir[pi + 1] ?? 0;
    const dz = state.lightDir[pi + 2] ?? 0;
    const [sdx, sdy, sdz] = normalizeOr001(dx, dy, dz);
    lp.spotDirX = sdx; lp.spotDirY = sdy; lp.spotDirZ = sdz;

    lp.spotCutoff = state.lightSpotCutoff[idx] ?? 0;
    if (isNaN(lp.spotCutoff) && signbit(lp.spotCutoff)) {
      lp.spotCutoff = 0.0;
    }

    lp.spotExp = state.lightSpotExp[idx] ?? 0;
    if (lp.spotExp <= 0.0) {
      lp.spotExp = 0.0;
    } else if (isNaN(lp.spotExp)) {
      lp.spotExp = signbit(lp.spotExp) ? 0.0 : Infinity;
    }
  }

  return lp;
}

// ---------------------------------------------------------------------------
// Main lighting function
// ---------------------------------------------------------------------------

export function computeVertexLighting(
  state: LightingState,
  worldPos: [number, number, number],
  worldNormal: [number, number, number],
  vertexColor: number,   // ABGR8888
  hasVertexColor: boolean,
): number /* ABGR8888 color0 */ {

  // --- Precompute per-light state (mirrors Lighting::ComputeState) ---

  const materialupdate = state.materialUpdate & (hasVertexColor ? 7 : 0);
  const colorForAmbient = (materialupdate & 1) !== 0;
  const colorForDiffuse = (materialupdate & 2) !== 0;
  const colorForSpecular = (materialupdate & 4) !== 0;

  // Build per-light precomputed data
  const light0 = buildLightPrecomp(state, 0);
  const light1 = buildLightPrecomp(state, 1);
  const light2 = buildLightPrecomp(state, 2);
  const light3 = buildLightPrecomp(state, 3);
  let anyAmbient = light0.hasAmbient || light1.hasAmbient || light2.hasAmbient || light3.hasAmbient;
  let anyDiffuse = light0.hasDiffuse || light1.hasDiffuse || light2.hasDiffuse || light3.hasDiffuse;
  let anySpecular = light0.hasSpecular || light1.hasSpecular || light2.hasSpecular || light3.hasSpecular;

  // Material color factors (when not using vertex color)
  let materialAmbientFactor: Vec4;
  if (!colorForAmbient) {
    materialAmbientFactor = lightColorFactor4(fromRGBA(state.materialAmbient, state.materialAlpha));
    if (!isLargerThanHalf(materialAmbientFactor) && anyAmbient) {
      light0.hasAmbient = false; light1.hasAmbient = false;
      light2.hasAmbient = false; light3.hasAmbient = false;
    }
  } else {
    materialAmbientFactor = [0, 0, 0, 0]; // will be replaced by vertex color
  }

  let materialDiffuseFactor: Vec4 = [0, 0, 0, 0];
  if (anyDiffuse && !colorForDiffuse) {
    materialDiffuseFactor = lightColorFactor4(fromRGB24(state.materialDiffuse));
    if (!isLargerThanHalf(materialDiffuseFactor)) {
      anyDiffuse = false;
      light0.hasDiffuse = false; light1.hasDiffuse = false;
      light2.hasDiffuse = false; light3.hasDiffuse = false;
    }
  }

  let materialSpecularFactor: Vec4 = [0, 0, 0, 0];
  if (anySpecular && !colorForSpecular) {
    materialSpecularFactor = lightColorFactor4(fromRGB24(state.materialSpecular));
    if (!isLargerThanHalf(materialSpecularFactor)) {
      anySpecular = false;
      light0.hasSpecular = false; light1.hasSpecular = false;
      light2.hasSpecular = false; light3.hasSpecular = false;
    }
  }

  // Specular exponent
  let specularExp = state.materialSpecCoef;
  if (anyDiffuse || anySpecular) {
    if (specularExp <= 0.0) {
      specularExp = 0.0;
    } else if (isNaN(specularExp)) {
      specularExp = signbit(specularExp) ? 0.0 : Infinity;
    }
  }

  const addColor1 = state.lightMode === 0 && anySpecular;

  // --- Process vertex (mirrors ProcessSIMD) ---

  // Compute vertex color factor if needed
  let colorFactor: Vec4 = [0, 0, 0, 0];
  if (colorForAmbient || colorForDiffuse || colorForSpecular) {
    colorFactor = lightColorFactor4(fromABGR(vertexColor));
  }

  // mac = material ambient color factor
  const mac: Vec4 = colorForAmbient ? colorFactor : materialAmbientFactor;

  // Global ambient: baseAmbientColorFactor
  const baseAmbientFactor = lightColorFactor4(fromRGBA(state.ambientColor, state.ambientAlpha));

  // ambient = (mac * baseAmbientFactor) >> 10
  const ambient: Vec4 = [
    (mac[0] * baseAmbientFactor[0]) >> 10,
    (mac[1] * baseAmbientFactor[1]) >> 10,
    (mac[2] * baseAmbientFactor[2]) >> 10,
    (mac[3] * baseAmbientFactor[3]) >> 10,
  ];

  // mec = material emissive color
  const mec = fromRGB24(state.materialEmissive);

  // final_color = mec + ambient
  const fc: Vec4 = [
    mec[0] + ambient[0],
    mec[1] + ambient[1],
    mec[2] + ambient[2],
    mec[3] + ambient[3],
  ];

  // specular accumulator
  const sc: Vec4 = [0, 0, 0, 0];

  // Normal direction (apply reverseNormals)
  const wnX = state.reverseNormals ? -worldNormal[0] : worldNormal[0];
  const wnY = state.reverseNormals ? -worldNormal[1] : worldNormal[1];
  const wnZ = state.reverseNormals ? -worldNormal[2] : worldNormal[2];

  for (const lstate of [light0, light1, light2, light3]) {
    if (!lstate.enabled) continue;

    // L = vector from vertex to light (or light direction for directional)
    let Lx = lstate.posX;
    let Ly = lstate.posY;
    let Lz = lstate.posZ;
    let attspot = 1.0;

    if (!lstate.directional) {
      Lx -= worldPos[0];
      Ly -= worldPos[1];
      Lz -= worldPos[2];
      const [nx, ny, nz, d] = normalizeOr001(Lx, Ly, Lz);
      Lx = nx; Ly = ny; Lz = nz;

      // Attenuation: 1 / (kA + kB*d + kC*d*d)
      const attDenom = lstate.attX + lstate.attY * d + lstate.attZ * d * d;
      let att = 1.0 / attDenom;
      // PPSSPP: if (!(att > 0.0f)) att = 0.0f; else if (att > 1.0f) att = 1.0f;
      if (!(att > 0.0)) att = 0.0;
      else if (att > 1.0) att = 1.0;
      attspot = att;
    }

    if (lstate.spot) {
      let rawSpot = lstate.spotDirX * Lx + lstate.spotDirY * Ly + lstate.spotDirZ * Lz;
      if (isNaN(rawSpot)) {
        rawSpot = signbit(rawSpot) ? 0.0 : 1.0;
      }

      let spot = 1.0;
      if (rawSpot >= lstate.spotCutoff) {
        spot = pspLightPow(rawSpot, lstate.spotExp);
        if (isNaN(spot)) spot = 0.0;
      } else {
        spot = 0.0;
      }
      attspot *= spot;
    }

    // Ambient contribution
    if (lstate.hasAmbient) {
      let attspot512 = lightCeil(256 * 2 * attspot + 1);
      if (attspot512 > 512) attspot512 = 512;
      const lambient = lightColorScaleBy512(lstate.ambientColorFactor, mac, attspot512);
      fc[0] += lambient[0];
      fc[1] += lambient[1];
      fc[2] += lambient[2];
      fc[3] += lambient[3];
    }

    // Diffuse factor
    let diffuse_factor = 0.0;
    if (lstate.hasDiffuse || lstate.hasSpecular) {
      diffuse_factor = Lx * wnX + Ly * wnY + Lz * wnZ;
      if (lstate.poweredDiffuse) {
        diffuse_factor = pspLightPow(diffuse_factor, specularExp);
      }
    }

    // Diffuse contribution
    if (lstate.hasDiffuse && diffuse_factor > 0.0) {
      let diffuse_attspot = lightCeil(256 * 2 * attspot * diffuse_factor + 1);
      if (diffuse_attspot > 512) diffuse_attspot = 512;
      const mdc: Vec4 = colorForDiffuse ? colorFactor : materialDiffuseFactor;
      const ldiffuse = lightColorScaleBy512(lstate.diffuseColorFactor, mdc, diffuse_attspot);
      fc[0] += ldiffuse[0];
      fc[1] += ldiffuse[1];
      fc[2] += ldiffuse[2];
      fc[3] += ldiffuse[3];
    }

    // Specular contribution
    if (lstate.hasSpecular && diffuse_factor >= 0.0) {
      // H = normalize(L + (0,0,1))
      const [Hx, Hy, Hz] = normalizeOr001(Lx, Ly, Lz + 1.0);

      let specular_factor = Hx * wnX + Hy * wnY + Hz * wnZ;
      specular_factor = pspLightPow(specular_factor, specularExp);

      if (specular_factor > 0.0) {
        let specular_attspot = lightCeil(256 * 2 * attspot * specular_factor + 1);
        if (specular_attspot > 512) specular_attspot = 512;
        const msc: Vec4 = colorForSpecular ? colorFactor : materialSpecularFactor;
        const lspecular = lightColorScaleBy512(lstate.specularColorFactor, msc, specular_attspot);
        sc[0] += lspecular[0];
        sc[1] += lspecular[1];
        sc[2] += lspecular[2];
        sc[3] += lspecular[3];
      }
    }
  }

  // Combine final color
  // For now we always add specular into color0 (we don't have a color1 vertex field).
  // addColor1: lightMode == 0 (single color) with specular — add specular into color0.
  // lightMode == 1 (separate specular): ideally color1, but we fold it in too.
  let r: number, g: number, b: number, a: number;
  if (addColor1 || state.lightMode === 1) {
    r = clamp255(fc[0] + sc[0]);
    g = clamp255(fc[1] + sc[1]);
    b = clamp255(fc[2] + sc[2]);
    a = clamp255(fc[3]); // alpha from final_color only
  } else {
    r = clamp255(fc[0]);
    g = clamp255(fc[1]);
    b = clamp255(fc[2]);
    a = clamp255(fc[3]);
  }

  // Pack as ABGR8888
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}
