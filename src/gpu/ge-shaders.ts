/**
 * GLSL shaders for the PSP GE WebGL renderer.
 *
 * Both through-mode and transform-mode vertices arrive pre-transformed
 * to screen space by ge-processor.ts (the PSP fixed-function pipeline
 * runs on CPU, matching PPSSPP). The vertex shader just converts from
 * pixel coordinates to clip space.
 */

// 11 floats per vertex: x, y, z, u, v, r, g, b, a, fogCoef, clipw
export const FLOATS_PER_VERT = 11;

export const VS_GE = `
attribute vec3 a_position;
attribute vec2 a_texcoord;
attribute vec4 a_color;
attribute float a_fogCoef;
attribute float a_clipw;

uniform vec2 u_resolution;

varying vec2 v_texcoord;
varying vec4 v_color;
varying float v_fogCoef;

void main() {
  // Screen pixels → screen-NDC: x [0,W]→[-1,1], y [0,H]→[1,-1] (PSP Y-down)
  vec2 ndc = (a_position.xy / u_resolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  // Z: PSP depth [0,1] maps to WebGL depth [-1,1]. Quantize to the PSP's 16-bit
  // depth resolution first — games draw 2D layers at very close but distinct z
  // values that all land on the same 16-bit Z, so GEQUAL/LEQUAL act as a no-op
  // (painter's order). Our depth buffer is 24-bit, which would otherwise keep
  // those tiny differences and reject the later, slightly-nearer layers.
  float z16 = floor(a_position.z * 65535.0 + 0.5) / 65535.0;
  float z = z16 * 2.0 - 1.0;
  // Positions arrive pre-divided to screen space, with the original clip-space w
  // in a_clipw. Scaling the screen-NDC clip position by w rebuilds a true
  // clip-space coordinate (w cancels the 1/w baked into the pre-divide, so this
  // stays linear in the original clip coords even for behind-camera verts). The
  // GPU then (a) does the perspective divide back to the same screen position,
  // (b) interpolates texcoord/color/fog perspective-correctly — no more texture
  // swim — and (c) clips at the near plane (w<=0), so behind-camera and
  // camera-straddling triangles are clipped instead of smearing. a_clipw is 1.0
  // for 2D/through-mode, so those stay exactly as before.
  float w = a_clipw;
  gl_Position = vec4(ndc * w, z * w, w);
  v_texcoord = a_texcoord;
  v_color = a_color;
  v_fogCoef = a_fogCoef;
}
`;

export const FS_GE = `
precision mediump float;

varying vec2 v_texcoord;
varying vec4 v_color;
varying float v_fogCoef;

uniform sampler2D u_texture;
uniform bool u_texEnable;
uniform int u_texFunc;        // 0=modulate,1=decal,2=blend,3=replace,4=add
uniform bool u_texFuncAlpha;
uniform vec3 u_texEnvColor;   // normalized RGB for blend mode

uniform bool u_alphaTestEnable;
uniform int u_alphaTestFunc;  // 0=never,1=always,2=eq,3=neq,4=lt,5=le,6=gt,7=ge
uniform float u_alphaTestRef; // 0-255 range

// Color doubling — PPSSPP FragmentShaderGenerator.cpp:833-834
uniform bool u_colorDoubling;

// Fog — PPSSPP FragmentShaderGenerator.cpp:854-860
uniform bool u_fogEnable;
uniform vec3 u_fogColor;

// Color test — PPSSPP FragmentShaderGenerator.cpp:860-875
uniform bool u_colorTestEnable;
uniform int u_colorTestFunc;   // 0=never,1=always,2=equal,3=notequal
uniform vec3 u_colorTestRef;   // 0-255 range per channel
uniform vec3 u_colorTestMask;  // 0-255 range per channel

// Stencil-to-alpha — PPSSPP FragmentShaderGenerator.cpp:883-930
uniform bool u_stencilReplace;
uniform float u_stencilReplaceValue; // 0-1 range

void main() {
  vec4 prim = v_color;
  vec4 result;

  if (u_texEnable) {
    vec4 tex = texture2D(u_texture, v_texcoord);

    if (u_texFunc == 0) {
      // MODULATE — PPSSPP FragmentShaderGenerator.cpp:793
      result = vec4(prim.rgb * tex.rgb, u_texFuncAlpha ? prim.a * tex.a : prim.a);
    } else if (u_texFunc == 1) {
      // DECAL — PPSSPP FragmentShaderGenerator.cpp:796
      result = vec4(mix(prim.rgb, tex.rgb, tex.a), prim.a);
    } else if (u_texFunc == 2) {
      // BLEND — PPSSPP FragmentShaderGenerator.cpp:799
      result = vec4(mix(prim.rgb, u_texEnvColor, tex.rgb),
                    u_texFuncAlpha ? prim.a * tex.a : prim.a);
    } else if (u_texFunc == 3) {
      // REPLACE — PPSSPP FragmentShaderGenerator.cpp:802
      result = vec4(tex.rgb, u_texFuncAlpha ? tex.a : prim.a);
    } else {
      // ADD — PPSSPP FragmentShaderGenerator.cpp:811
      result = vec4(clamp(prim.rgb + tex.rgb, 0.0, 1.0),
                    u_texFuncAlpha ? prim.a * tex.a : prim.a);
    }

    // Color doubling — PPSSPP FragmentShaderGenerator.cpp:833-834
    if (u_colorDoubling) {
      result.rgb = clamp(result.rgb * 2.0, 0.0, 1.0);
    }
  } else {
    result = prim;
  }

  // Fog — PPSSPP FragmentShaderGenerator.cpp:841-843
  // fogCoef is pre-computed per vertex: clamp((viewZ + fogEnd) * fogSlope, 0, 1)
  if (u_fogEnable) {
    result.rgb = mix(u_fogColor, result.rgb, v_fogCoef);
  }

  // Alpha test FIRST — PPSSPP FragmentShaderGenerator.cpp:859-896
  if (u_alphaTestEnable) {
    float a = floor(result.a * 255.0 + 0.5);
    float ref = u_alphaTestRef;
    bool pass;
    if      (u_alphaTestFunc == 0) pass = false;          // NEVER
    else if (u_alphaTestFunc == 1) pass = true;           // ALWAYS
    else if (u_alphaTestFunc == 2) pass = (a == ref);     // EQUAL
    else if (u_alphaTestFunc == 3) pass = (a != ref);     // NOTEQUAL
    else if (u_alphaTestFunc == 4) pass = (a < ref);      // LESS
    else if (u_alphaTestFunc == 5) pass = (a <= ref);     // LEQUAL
    else if (u_alphaTestFunc == 6) pass = (a > ref);      // GREATER
    else                           pass = (a >= ref);     // GEQUAL
    if (!pass) discard;
  }

  // Color test SECOND — PPSSPP FragmentShaderGenerator.cpp:898-936
  // WebGL1 lacks bitwise ops, use floor-based integer comparison
  if (u_colorTestEnable) {
    vec3 pixRgb = floor(result.rgb * 255.0 + 0.5);
    vec3 maskedPix = floor(pixRgb * u_colorTestMask / 255.0);
    vec3 maskedRef = floor(u_colorTestRef * u_colorTestMask / 255.0);
    bool colorPass;
    if (u_colorTestFunc == 0) colorPass = false;       // NEVER
    else if (u_colorTestFunc == 1) colorPass = true;   // ALWAYS
    else if (u_colorTestFunc == 2) colorPass = (maskedPix == maskedRef); // EQUAL
    else colorPass = (maskedPix != maskedRef);          // NOTEQUAL
    if (!colorPass) discard;
  }

  // Stencil-to-alpha — PPSSPP FragmentShaderGenerator.cpp:883-930
  if (u_stencilReplace) {
    result.a = u_stencilReplaceValue;
  }

  gl_FragColor = result;
}
`;

/** Simple pass-through shader for presenting an FBO texture to screen. */
export const VS_PRESENT = `
attribute vec2 a_position;
attribute vec2 a_texcoord;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_uv = a_texcoord;
}
`;

export const FS_PRESENT = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
void main() {
  gl_FragColor = texture2D(u_texture, v_uv);
}
`;
