# GE Opcode Reference

Every GE display-list command is a 32-bit word: the top 8 bits are the opcode, the low 24 bits are the parameter. `GEProcessor.executeOp` (`src/gpu/ge-processor.ts`) dispatches on the opcode; named opcodes live in `src/gpu/ge-commands.ts` (`GE_CMD`).

Opcodes not listed below, and the ones marked "parsed, no effect", are treated as no-ops: the parameter is recorded but nothing is rendered from it. Tables follow the real dispatch, so an opcode marked no-op is one the processor accepts but does not act on yet.

## List control and flow

| Opcode | Name | Description |
| --- | --- | --- |
| `0x00` | NOP | Does nothing. |
| `0x08` | JUMP | Jump to the relative address in the parameter. |
| `0x09` | BJUMP | Conditional jump on the bounding-box result. The bbox test always reports visible, so this never jumps. |
| `0x0A` | CALL | Push the return address and current `offsetAddr`, then jump. Capped at the call-stack depth. |
| `0x0B` | RET | Pop the call stack and return; restores `offsetAddr`. |
| `0x0C` | END | Terminate the list. |
| `0x0E` | SIGNAL | First half of a SIGNAL+END pair. The behaviour byte selects jump, call, ret, sync, or a handler callback (see below). |
| `0x0F` | FINISH | No effect here; list end is driven by END. |
| `0x10` | BASE | Base address for relative addressing (bits [19:16]). |
| `0x13` | OFFSET_ADDR | Set `offsetAddr` to `param << 8`. |
| `0x14` | ORIGIN_ADDR | Set `offsetAddr` to the current list PC. |

### SIGNAL behaviours

The behaviour byte is bits [23:16] of the SIGNAL parameter; the paired END supplies the low 16 bits of the target.

| Value | Name | Action |
| --- | --- | --- |
| `0x10` | JUMP | Absolute jump to `(signalData << 16) | endData`. |
| `0x11` | CALL | Push return (with `offsetAddr` and `baseAddr`), then jump. |
| `0x12` | RET | Pop the call stack and return. |
| `0x01` / `0x02` / `0x03` | HANDLER_SUSPEND / CONTINUE / PAUSE | Invoke the registered signal callback, then skip the paired END. |
| `0x08` | SYNC | Memory barrier; no handler. |

## Vertex and primitives

| Opcode | Name | Description |
| --- | --- | --- |
| `0x01` | VADDR | Vertex buffer address (relative). |
| `0x02` | IADDR | Index buffer address (relative). |
| `0x12` | VTYPE | Vertex format bitmask (position, color, UV, weights, index, through-mode). |
| `0x04` | PRIM | Draw a primitive. The parameter holds the vertex count and primitive type. |
| `0x05` | BEZIER | Draw a Bezier surface patch (uCount, vCount in the parameter). |
| `0x06` | SPLINE | Draw a spline surface patch (counts plus edge types). |
| `0x07` | BOUNDINGBOX | Test a bounding box. Vertices are consumed but the result is always "visible". |
| `0x36` | PATCHDIVISION | Patch tessellation divisions (divU, divV). |
| `0x37` | PATCHPRIMITIVE | Patch output primitive type (triangles, lines, points). |
| `0x38` | PATCHFACING | Reverse patch normals. |
| `0x2C` to `0x33` | Morph weights | Parsed, no effect. |

### Immediate-mode vertices (`0xF0` to `0xF9`)

These build a single vertex in registers; `VAP` triggers the draw.

| Opcode | Name | Description |
| --- | --- | --- |
| `0xF0` / `0xF1` / `0xF2` | VSCX / VSCY / VSCZ | Immediate vertex X / Y / Z (screen space). |
| `0xF3` / `0xF4` / `0xF5` | VTCS / VTCT / VTCQ | Immediate texture S / T / Q. |
| `0xF6` | VCV | Immediate vertex color (RGB). |
| `0xF7` | VAP | Immediate alpha and primitive type; triggers the draw. |
| `0xF8` | VFC | Immediate fog coefficient. |
| `0xF9` | VSCV | Immediate secondary (specular) color. |

## Matrices

Each matrix has a NUMBER command (sets the write pointer) and a DATA command (writes one float24 and auto-increments).

| Opcode | Name | Description |
| --- | --- | --- |
| `0x2A` / `0x2B` | BONEMATRIXNUMBER / DATA | Skinning bone matrices (8 bones x 12 floats). |
| `0x3A` / `0x3B` | WORLDMATRIXNUMBER / DATA | World matrix. |
| `0x3C` / `0x3D` | VIEWMATRIXNUMBER / DATA | View matrix. |
| `0x3E` / `0x3F` | PROJMATRIXNUMBER / DATA | Projection matrix. |
| `0x40` / `0x41` | TGENMATRIXNUMBER / DATA | Texture-coordinate generation matrix. |

## Viewport, offset, region

| Opcode | Name | Description |
| --- | --- | --- |
| `0x42` / `0x43` / `0x44` | Viewport scale X / Y / Z | float24 viewport scale. |
| `0x45` / `0x46` / `0x47` | Viewport center X / Y / Z | float24 viewport center. |
| `0x4C` / `0x4D` | OFFSET_X / OFFSET_Y | Screen offset, in 1/16-pixel units. |
| `0x4E` / `0x4F` | (unknown) | Parsed, no effect. |
| `0x15` / `0x16` | REGION1 / REGION2 | Drawing region. Parsed, no effect (the scissor is used instead). |

## Lighting and material

| Opcode | Name | Description |
| --- | --- | --- |
| `0x17` | Lighting enable | Master lighting toggle. |
| `0x18` to `0x1B` | Light 0 to 3 enable | Per-light toggle. |
| `0x5E` | Light mode | Single-color or separate-specular. |
| `0x5F` to `0x62` | Light 0 to 3 type | Light type and computation. |
| `0x63` to `0x86` | Light geometry | Position, direction, and attenuation (three floats each) for lights 0 to 3. |
| `0x87` to `0x8A` | Light 0 to 3 spot exponent | float24 spotlight exponent. |
| `0x8B` to `0x8E` | Light 0 to 3 spot cutoff | float24 spotlight cutoff. |
| `0x8F` to `0x9A` | Light 0 to 3 colors | Ambient, diffuse, and specular color per light. |
| `0x5C` / `0x5D` | AMBIENT_COLOR / AMBIENT_ALPHA | Global ambient color and alpha. |
| `0x50` | Shade mode | Flat or Gouraud. |
| `0x51` | Reverse normals | Flip vertex normals. |
| `0x53` | Material update | Which material components track the vertex color. |
| `0x54` | Material emissive | 24-bit color. |
| `0x55` | Material ambient | 24-bit color. |
| `0x56` | Material diffuse | 24-bit color. |
| `0x57` | Material specular | 24-bit color. |
| `0x58` | Material alpha | 8-bit alpha. |
| `0x5B` | Material specular coefficient | float24 shininess. |

## Texture and CLUT

| Opcode | Name | Description |
| --- | --- | --- |
| `0x1E` | Texture enable | Toggle texturing. |
| `0xA0` | TEXADDR0 | Texture address, level 0. |
| `0xA8` | TEXBUFWIDTH0 | Texture buffer width (stride), level 0. |
| `0xA1` to `0xA7`, `0xA9` to `0xAF` | TEXADDR / TEXBUFWIDTH 1 to 7 | Mip levels 1 to 7. Parsed, no effect (only level 0 is used). |
| `0xB8` | TEXSIZE0 | Texture width and height, level 0 (each `1 << n`). |
| `0xB9` to `0xBF` | TEXSIZE 1 to 7 | Mip sizes. Parsed, no effect. |
| `0xC2` | Texture mode | Swizzle flag (and max mip level). |
| `0xC3` | TEXFORMAT | Texel format (0 to 10: direct color, CLUT, DXT). |
| `0xC4` | Load CLUT | Triggers the CLUT load; the data is already addressed. No extra work here. |
| `0xC5` | CLUT format | Palette format, shift, mask, and start index. |
| `0xC6` | Texture filter | Min and mag filters. |
| `0xC7` | Texture wrap | Clamp or repeat for U and V. |
| `0xC8` | Texture level (LOD) | Parsed, no effect. |
| `0xC9` | Texture function | Modulate, decal, blend, replace, add; plus alpha and color doubling. |
| `0xCA` | Texture env color | Used by the BLEND texture function. |
| `0xCB` / `0xCC` | Texture flush / sync | No effect. |
| `0xC0` | TEXMAPMODE | UV generation mode and projection mode. |
| `0xC1` | TEXSHADELS | Light sources for shade mapping. |
| `0xB0` / `0xB1` | CLUT address lower / upper | Palette base address. |
| `0x48` / `0x49` | Texture scale U / V | float24 UV scale (transform mode). |
| `0x4A` / `0x4B` | Texture offset U / V | float24 UV offset (transform mode). |
| `0xD0` | TEXLODSLOPE | float24 LOD slope. |
| `0xD1` | (reserved) | Parsed, no effect. |

## Fog

| Opcode | Name | Description |
| --- | --- | --- |
| `0x1F` | Fog enable | Toggle fog. |
| `0xCD` | FOG1 | float24 fog end distance. |
| `0xCE` | FOG2 | float24 fog density slope, `1 / (end - start)`. |
| `0xCF` | FOGCOLOR | 24-bit fog color. |

## Fragment pipeline (blend, test, mask)

| Opcode | Name | Description |
| --- | --- | --- |
| `0x1C` | Depth clamp enable | Parsed, no effect. |
| `0x1D` | Cull enable | Toggle back-face culling. |
| `0x9B` | Cull face | Cull direction (clockwise or counter-clockwise). |
| `0x20` | Dither enable | Toggle dithering. |
| `0x21` | Alpha blend enable | Toggle blending. |
| `0x22` | Alpha test enable | Toggle the alpha test. |
| `0x23` | Depth test enable | Toggle the depth test. |
| `0x24` | Stencil test enable | Toggle the stencil test. |
| `0x25` | Antialias enable | Parsed, no effect. |
| `0x26` | Patch cull enable | Parsed, no effect. |
| `0x27` | Color test enable | Toggle the color test. |
| `0x28` | Logic op enable | Toggle the logic op. |
| `0xDF` | BLENDMODE | Source factor, destination factor, and equation. |
| `0xE0` / `0xE1` | Blend fixed A / B | Fixed blend colors. |
| `0xDB` | ALPHATEST | Function, reference, and mask. |
| `0xDE` | ZTEST | Depth test function. |
| `0xE7` | Depth write disable | Disable depth writes. |
| `0xD6` / `0xD7` | Min / max Z | Parsed, no effect. |
| `0xD8` | COLORTEST | Color test function. |
| `0xD9` | COLORREF | Color test reference (24-bit). |
| `0xDA` | COLORTESTMASK | Color test mask (24-bit). |
| `0xDC` | STENCILTEST | Function, reference, and mask. |
| `0xDD` | STENCILOP | Stencil-fail, depth-fail, and depth-pass operations. |
| `0xE2` to `0xE5` | DITH0 to DITH3 | The 4x4 dither matrix, one row per command. |
| `0xE6` | LOGICOP | Logic operation. |
| `0xE8` | MASKRGB | Color write mask (24-bit). |
| `0xE9` | MASKALPHA | Alpha write mask (8-bit). |

## Framebuffer and scissor

| Opcode | Name | Description |
| --- | --- | --- |
| `0x9C` | FRAMEBUFPTR | Framebuffer address (low bits; high bits come from FRAMEBUFWIDTH). |
| `0x9D` | FRAMEBUFWIDTH | Framebuffer stride and the high address bits. |
| `0x9E` / `0x9F` | ZBUFPTR / ZBUFWIDTH | Depth buffer address and width. Parsed, no effect. |
| `0xD2` | FRAMEBUFPIXFMT | Framebuffer pixel format (0 to 3). |
| `0xD3` | CLEAR | Enter or leave clear mode, and which channels clear-mode draws write. |
| `0xD4` / `0xD5` | SCISSOR1 / SCISSOR2 | Scissor rectangle corners. |

## Block transfer

A block transfer copies a rectangle between memory regions (a GE "sceGeBufferCopy").

| Opcode | Name | Description |
| --- | --- | --- |
| `0xB2` | TRANSFERSRC | Source address (low bits). |
| `0xB3` | TRANSFERSRCW | Source stride and high address bits. |
| `0xB4` | TRANSFERDST | Destination address (low bits). |
| `0xB5` | TRANSFERDSTW | Destination stride and high address bits. |
| `0xEB` | TRANSFERSRCPOS | Source X and Y position. |
| `0xEC` | TRANSFERDSTPOS | Destination X and Y position. |
| `0xEE` | TRANSFERSIZE | Width and height of the copy. |
| `0xEA` | TRANSFERSTART | Run the copy. Bit 0 selects 16-bit (0) or 32-bit (1) pixels. |

See [GPU (GE)](/systems/gpu-ge) for how these commands are processed and rendered.
