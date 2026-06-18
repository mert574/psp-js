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

// PSP framebuffer pixels are stored R-low in memory for every format:
// 8888 is 0xAABBGGRR (bytes [R,G,B,A]) and the 16-bit formats put R in the low
// bits. Both the raw 8888 upload and the CPU-converted 16-bit buffer are already
// [R,G,B,A], which WebGL reads straight as RGBA, so no channel swap is needed.
const FS = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
void main() {
  gl_FragColor = texture2D(u_texture, v_uv);
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
  private maxAttribs: number;

  constructor(canvas: HTMLCanvasElement) {
    // Present at native size. The WebGL GE renderer may have left the backing
    // store scaled up (scale×); reset it so the fullscreen quad fills the canvas.
    canvas.width = PSP_WIDTH;
    canvas.height = PSP_HEIGHT;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false });
    if (!gl) throw new Error("WebGL not supported");
    this.gl = gl;
    this.maxAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;

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
    const tex = twgl.createTexture(gl, {
      width: 512,
      height: PSP_HEIGHT,
      min: gl.NEAREST,
      mag: gl.NEAREST,
      wrap: gl.CLAMP_TO_EDGE,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
    });
    if (!tex) throw new Error("Could not create WebGL texture");
    this.texture = tex;

    this.rgbaBuf = new Uint8Array(512 * PSP_HEIGHT * 4);

    gl.viewport(0, 0, PSP_WIDTH, PSP_HEIGHT);
    gl.clearColor(0, 0, 0, 1);
  }

  /** Render VRAM framebuffer to the canvas. */
  render(vram: Uint8Array, addr: number, width: number, format: number): void {
    if (addr === 0) return;

    const gl = this.gl;

    // The canvas may have been used by WebGLGERenderer in a previous boot
    // (getContext returns the same context), so reset the state it changes.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, PSP_WIDTH, PSP_HEIGHT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    const offset = (addr & 0x1FFFFFFF) - VRAM_BASE; // physical offset into VRAM
    if (offset < 0 || offset >= vram.length) return;

    const stride = width || 512; // buffer width (pixels per row)

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
    const texcoordAttrib = this.bufferInfo.attribs?.["texcoord"];
    if (texcoordAttrib) {
      twgl.setAttribInfoBufferFromArray(
        gl,
        texcoordAttrib,
        { numComponents: 2, data: [0, 1, uMax, 1, 0, 0, uMax, 0] },
      );
    }

    // The GE renderer (WebGLGERenderer) leaves its vertex attrib arrays enabled
    // on this shared context. Our quad only uses position+texcoord, so any other
    // enabled-but-unbound array makes drawElements throw INVALID_OPERATION.
    // Disable them all; setBuffersAndAttributes re-enables the two we need.
    for (let i = 0; i < this.maxAttribs; i++) gl.disableVertexAttribArray(i);

    gl.useProgram(this.programInfo.program);
    twgl.setBuffersAndAttributes(gl, this.programInfo, this.bufferInfo);
    twgl.setUniforms(this.programInfo, {
      u_texture: this.texture,
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
