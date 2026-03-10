import * as twgl from "twgl.js";

const PSP_WIDTH = 480;
const PSP_HEIGHT = 272;
const VRAM_BASE = 0x04000000;

const VS = `
attribute vec2 position;
attribute vec2 texcoord;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
  v_uv = texcoord;
}
`;

// Fragment shader swizzles ABGR → RGBA for format 3 (most common).
// For other formats we do CPU conversion to RGBA before upload.
const FS = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform bool u_swizzle; // true for ABGR8888 direct upload
void main() {
  vec4 c = texture2D(u_texture, v_uv);
  if (u_swizzle) {
    gl_FragColor = vec4(c.b, c.g, c.r, c.a); // BGRA → RGBA (WebGL reads as RGBA)
  } else {
    gl_FragColor = c;
  }
}
`;

/**
 * Renders the PSP framebuffer from VRAM to a WebGL canvas.
 *
 * Each frame:
 * 1. Read pixel data from the VRAM byte array at the address set by sceDisplaySetFrameBuf
 * 2. Convert to RGBA8888 if needed (16-bit formats)
 * 3. Upload as texture
 * 4. Draw fullscreen quad
 */
export class FramebufferRenderer {
  private gl: WebGLRenderingContext;
  private programInfo: twgl.ProgramInfo;
  private bufferInfo: twgl.BufferInfo;
  private texture: WebGLTexture;
  private rgbaBuf: Uint8Array; // pre-allocated RGBA conversion buffer

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false })!;
    if (!gl) throw new Error("WebGL not supported");
    this.gl = gl;

    this.programInfo = twgl.createProgramInfo(gl, [VS, FS]);

    // Fullscreen quad: two triangles covering clip space.
    // UV maps 480/512 of texture width (stride is 512, display is 480).
    const uMax = PSP_WIDTH / 512;
    this.bufferInfo = twgl.createBufferInfoFromArrays(gl, {
      position: { numComponents: 2, data: [-1, -1, 1, -1, -1, 1, 1, 1] },
      texcoord: { numComponents: 2, data: [0, 1, uMax, 1, 0, 0, uMax, 0] },
      indices: [0, 1, 2, 2, 1, 3],
    });

    // Create texture — 512×272, nearest filtering for crisp pixels
    this.texture = twgl.createTexture(gl, {
      width: 512,
      height: PSP_HEIGHT,
      min: gl.NEAREST,
      mag: gl.NEAREST,
      wrap: gl.CLAMP_TO_EDGE,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
    });

    this.rgbaBuf = new Uint8Array(512 * PSP_HEIGHT * 4);

    gl.viewport(0, 0, PSP_WIDTH, PSP_HEIGHT);
    gl.clearColor(0, 0, 0, 1);
  }

  /** Render VRAM framebuffer to the canvas. */
  render(vram: Uint8Array, addr: number, width: number, format: number): void {
    if (addr === 0) return;

    const gl = this.gl;
    const offset = (addr & 0x1FFFFFFF) - VRAM_BASE; // physical offset into VRAM
    if (offset < 0 || offset >= vram.length) return;

    const stride = width || 512; // buffer width (pixels per row)
    const swizzle = format === 3;

    if (format === 3) {
      // ABGR8888: upload raw VRAM bytes, swizzle in shader
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, stride, PSP_HEIGHT,
        gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(vram.buffer, vram.byteOffset + offset, stride * PSP_HEIGHT * 4),
      );
    } else {
      // 16-bit formats: convert to RGBA on CPU
      this.convert16bpp(vram, offset, stride, format);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, stride, PSP_HEIGHT,
        gl.RGBA, gl.UNSIGNED_BYTE,
        this.rgbaBuf,
      );
    }

    // Update UV if stride changed
    const uMax = PSP_WIDTH / stride;
    twgl.setAttribInfoBufferFromArray(
      gl,
      this.bufferInfo.attribs!["texcoord"],
      { numComponents: 2, data: [0, 1, uMax, 1, 0, 0, uMax, 0] },
    );

    gl.useProgram(this.programInfo.program);
    twgl.setBuffersAndAttributes(gl, this.programInfo, this.bufferInfo);
    twgl.setUniforms(this.programInfo, {
      u_texture: this.texture,
      u_swizzle: swizzle,
    });
    twgl.drawBufferInfo(gl, this.bufferInfo);
  }

  /** Convert 16bpp PSP pixel data to RGBA8888 into this.rgbaBuf. */
  private convert16bpp(
    vram: Uint8Array, offset: number, stride: number, format: number,
  ): void {
    const src = new DataView(vram.buffer, vram.byteOffset + offset);
    const dst = this.rgbaBuf;
    const total = stride * PSP_HEIGHT;

    for (let i = 0; i < total; i++) {
      const px = src.getUint16(i * 2, true);
      const di = i * 4;

      switch (format) {
        case 0: // BGR5650
          dst[di]     = ((px       ) & 0x1F) << 3; // R
          dst[di + 1] = ((px >>>  5) & 0x3F) << 2; // G
          dst[di + 2] = ((px >>> 11) & 0x1F) << 3; // B
          dst[di + 3] = 255;                        // A
          break;
        case 1: // ABGR5551
          dst[di]     = ((px       ) & 0x1F) << 3;
          dst[di + 1] = ((px >>>  5) & 0x1F) << 3;
          dst[di + 2] = ((px >>> 10) & 0x1F) << 3;
          dst[di + 3] = (px >>> 15) ? 255 : 0;
          break;
        case 2: // ABGR4444
          dst[di]     = ((px       ) & 0xF) << 4;
          dst[di + 1] = ((px >>>  4) & 0xF) << 4;
          dst[di + 2] = ((px >>>  8) & 0xF) << 4;
          dst[di + 3] = ((px >>> 12) & 0xF) << 4;
          break;
      }
    }
  }

  destroy(): void {
    this.gl.deleteTexture(this.texture);
  }
}
