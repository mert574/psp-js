/** PSP GE (Graphics Engine) command opcodes. Top 8 bits of each 32-bit command word. */
export const GE_CMD = {
  NOP:            0x00,
  VADDR:          0x01,
  IADDR:          0x02,
  PRIM:           0x04,
  BEZIER:         0x05,
  SPLINE:         0x06,
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

  // Clear color / depth / stencil
  CLEARCOLOR:     0xD0,
  CLEARDEPTH:     0xD1,

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
} as const;
