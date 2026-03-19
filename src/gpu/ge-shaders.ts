/**
 * GLSL shaders for the PSP GE WebGL renderer.
 *
 * Both through-mode and transform-mode vertices arrive pre-transformed
 * to screen space by ge-processor.ts (the PSP fixed-function pipeline
 * runs on CPU, matching PPSSPP). The vertex shader just converts from
 * pixel coordinates to clip space.
 */

export const VS_GE = `
attribute vec3 a_position;
attribute vec2 a_texcoord;
attribute vec4 a_color;

uniform vec2 u_resolution;

varying vec2 v_texcoord;
varying vec4 v_color;

void main() {
  // Screen pixels → clip space: x [0,W]→[-1,1], y [0,H]→[1,-1] (PSP Y-down)
  vec2 ndc = (a_position.xy / u_resolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  // Z: PSP depth [0,1] maps to WebGL depth [-1,1]
  float z = a_position.z * 2.0 - 1.0;
  gl_Position = vec4(ndc, z, 1.0);
  v_texcoord = a_texcoord;
  v_color = a_color;
}
`;

export const FS_GE = `
precision mediump float;

varying vec2 v_texcoord;
varying vec4 v_color;

uniform sampler2D u_texture;
uniform bool u_texEnable;
uniform int u_texFunc;        // 0=modulate,1=decal,2=blend,3=replace,4=add
uniform bool u_texFuncAlpha;
uniform vec3 u_texEnvColor;   // normalized RGB for blend mode

uniform bool u_alphaTestEnable;
uniform int u_alphaTestFunc;  // 0=never,1=always,2=eq,3=neq,4=lt,5=le,6=gt,7=ge
uniform float u_alphaTestRef; // 0-255 range

void main() {
  vec4 prim = v_color;
  vec4 result;

  if (u_texEnable) {
    vec4 tex = texture2D(u_texture, v_texcoord);

    if (u_texFunc == 0) {
      // MODULATE
      result = vec4(prim.rgb * tex.rgb, u_texFuncAlpha ? prim.a * tex.a : prim.a);
    } else if (u_texFunc == 1) {
      // DECAL
      result = vec4(mix(prim.rgb, tex.rgb, tex.a), prim.a);
    } else if (u_texFunc == 2) {
      // BLEND
      result = vec4(mix(prim.rgb, u_texEnvColor, tex.rgb),
                    u_texFuncAlpha ? prim.a * tex.a : prim.a);
    } else if (u_texFunc == 3) {
      // REPLACE
      result = vec4(tex.rgb, u_texFuncAlpha ? tex.a : prim.a);
    } else {
      // ADD
      result = vec4(clamp(prim.rgb + tex.rgb, 0.0, 1.0),
                    u_texFuncAlpha ? prim.a * tex.a : prim.a);
    }
  } else {
    result = prim;
  }

  // Alpha test (no native WebGL1 alpha test)
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
