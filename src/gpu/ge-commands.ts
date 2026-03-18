/** PSP GE (Graphics Engine) command opcodes. Top 8 bits of each 32-bit command word. */
export const GE_CMD = {
  NOP:            0x00,
  VADDR:          0x01,
  IADDR:          0x02,
  PRIM:           0x04,
  BEZIER:         0x05,
  SPLINE:         0x06,
  BOUNDINGBOX:    0x07,
  JUMP:           0x08,
  BJUMP:          0x09,
  CALL:           0x0A,
  RET:            0x0B,
  END:            0x0C,
  SIGNAL:         0x0E,
  FINISH:         0x0F,
  BASE:           0x10,
  VTYPE:          0x12,
  OFFSET_ADDR:    0x13,
  ORIGIN_ADDR:    0x14,
  REGION1:        0x15,
  REGION2:        0x16,

  // Lighting / material (per PPSSPP ge_constants.h)
  AMBIENT_COLOR:      0x5C,
  AMBIENT_ALPHA:      0x5D,
  MATERIAL_AMBIENT:   0x55,

  // Framebuffer
  FRAMEBUFPTR:    0x9C,
  FRAMEBUFWIDTH:  0x9D,
  ZBUFPTR:        0x9E,
  ZBUFWIDTH:      0x9F,

  // Framebuffer pixel format
  FRAMEBUFPIXFMT: 0xD2,

  // Texture LOD slope (0xD0) — PPSSPP ge_constants.h:217
  // NOTE: 0xD1 is GE_CMD_UNKNOWN_D1 (reserved/NOP)
  TEXLODSLOPE:    0xD0,

  // Clear mode
  CLEAR:          0xD3,

  // Scissor
  SCISSOR1:       0xD4,
  SCISSOR2:       0xD5,

  // Block transfer
  TRANSFERSRC:    0xB2,
  TRANSFERSRCW:   0xB3,
  TRANSFERDST:    0xB4,
  TRANSFERDSTW:   0xB5,
  TRANSFERSRCPOS: 0xEB,
  TRANSFERDSTPOS: 0xEC,
  TRANSFERSIZE:   0xEE,
  TRANSFERSTART:  0xEA,

  // Immediate mode vertex commands (0xF0-0xF9) — PPSSPP ge_constants.h:254-263
  VSCX:           0xF0,  // Immediate vertex X (screen-space)
  VSCY:           0xF1,  // Immediate vertex Y
  VSCZ:           0xF2,  // Immediate vertex Z
  VTCS:           0xF3,  // Immediate texture S (U)
  VTCT:           0xF4,  // Immediate texture T (V)
  VTCQ:           0xF5,  // Immediate texture Q (perspective W)
  VCV:            0xF6,  // Immediate vertex color (RGB)
  VAP:            0xF7,  // Immediate alpha + prim type (triggers draw)
  VFC:            0xF8,  // Immediate fog coefficient
  VSCV:           0xF9,  // Immediate secondary color (specular)
} as const;
