# Fonts (`hle-font.ts`)

This file is the PGF font support code, not a syscall-registration module. It parses the PSP's PGF font format and decodes glyph bitmaps into PSP memory. The actual `sceFont*` syscalls are registered in `hle-kernel.ts` and call into this parser. The bundled replacement fonts (`flash0:/font/ltn*.pgf`) are read from the guest filesystem by the kernel on `sceFontNewLib` and parsed through this code.

## The PGF parser (`src/kernel/hle-font.ts`)

The type definitions are real multi-field structs, so they stay as code blocks; the parser's methods are listed in a table below.

### `enum FontPixelFormat`

```ts
enum FontPixelFormat {
  PSP_FONT_PIXELFORMAT_4 = 0,
  PSP_FONT_PIXELFORMAT_4_REV = 1,
  PSP_FONT_PIXELFORMAT_8 = 2,
  PSP_FONT_PIXELFORMAT_24 = 3,
  PSP_FONT_PIXELFORMAT_32 = 4,
}
```

The pixel formats a glyph can be written in: packed 4-bit (and its reversed-nibble variant), 8-bit, 24-bit, and 32-bit. Read from the GlyphImage struct and passed to `setFontPixel`.

### `interface PGFHeader`

```ts
interface PGFHeader { revision: number; version: number; charMapLength: number; /* ...37 fields */ }
```

The decoded PGF file header, read field by field at the exact byte offsets from PPSSPP's `PGF.h` struct. Holds the char-map/char-pointer lengths and bits-per-entry, bpp, h/v size and resolution, font name and type, first/last glyph code, the max ascender/descender and adjust values, and the dimension/xAdjust/yAdjust/advance/shadow table lengths.

### `interface Glyph`

```ts
interface Glyph { w: number; h: number; left: number; top: number; advanceH: number; advanceV: number;
  dimensionWidth: number; dimensionHeight: number; xAdjustH: number; xAdjustV: number;
  yAdjustH: number; yAdjustV: number; shadowID: number; shadowFlags: number; flags: number; ptr: number; }
```

One parsed glyph's metrics plus `ptr`, the byte offset of its pixel bitstream inside `fontData`. The horizontal and vertical metrics come either from a shared table (when the matching flag bit is set) or inline in the bitstream.

### `class PGF`

The parser itself. Holds the decoded `header`, the four metric tables, the char map and char pointers, the pre-parsed `glyphs` array, and `fontData` (the raw pixel bitstream after the tables).

| Signature | What it does |
| --- | --- |
| `constructor(data?: ArrayBuffer)` | Constructs the parser and decodes `data` right away if given. |
| `decode(data: ArrayBuffer): boolean` | Checks the `PGF0` magic (at offset 4, or at an embedded offset read from the first word) and hands off to the internal decoder; returns `false` on a bad magic. |
| `getGlyph(charCode: number): Glyph \| null` | Maps a character code through `firstGlyph`/`lastGlyph` and the char map to a pre-parsed `Glyph`, or `null` if the code is out of range or unmapped. |
| `drawCharacter(bus: MemoryBus, glyphImagePtr: number, charCode: number, altCharCode: number): void` | Decodes a glyph's nibble-RLE bitstream and writes its pixels into the GlyphImage buffer in PSP memory, falling back to `altCharCode` when the requested code is missing. Reads the GlyphImage struct (pixel format, 26.6 x/y position, buffer width/height, bytes-per-line, buffer pointer) from `glyphImagePtr` and lays the pixels out in horizontal- or vertical-row order per the glyph's bitmap flag. |

The remaining methods are private helpers: `decodeAt`, `readTable`, `readString`, `readBitTable`, `getBits`, `readCharGlyph` (parses one glyph's metrics from the bitstream), and `setFontPixel` (writes a single pixel in the requested `FontPixelFormat`).

## The `sceFont*` syscalls (`src/kernel/hle-kernel.ts`)

Registered in `registerFontHandlers()`. Signatures below are the PSP signatures verified against PPSSPP's `Core/HLE/sceFont.cpp`. Most return success and write a 0 into the caller's `errorCodePtr`; the ones backed by a real PGF use the parser above. Pointers are guest addresses. Metrics use 26.6 fixed point (pixels times 64).

### Library lifecycle

| Signature | What it does |
| --- | --- |
| `sceFontNewLib(paramPtr: u32, errorCodePtr: u32): u32` | Loads the standard `flash0:/font/ltn*.pgf` fonts into `pgfFonts` and returns a fixed library handle of 1. |
| `sceFontDoneLib(fontLibHandle: u32): int` | Closes the library. No-op that returns 0. |
| `sceFontGetNumFontList(fontLibHandle: u32, errorCodePtr: u32): int` | Reports the number of fonts in the library; returns 1. |

### Finding and opening fonts

| Signature | What it does |
| --- | --- |
| `sceFontFindOptimumFont(libHandle: u32, fontStylePtr: u32, errorCodePtr: u32): int` | Picks the best font for a requested style; always returns index 0. |
| `sceFontFindFont(libHandle: u32, fontStylePtr: u32, errorCodePtr: u32): int` | Finds a font matching a style; always returns index 0. |
| `sceFontOpen(libHandle: u32, index: u32, mode: u32, errorCodePtr: u32): u32` | Opens the font at `index`, maps a new font handle to that index in `fontHandleMap`, and returns the handle. |
| `sceFontOpenUserFile(libHandle: u32, fileName: const char*, mode: u32, errorCodePtr: u32): u32` | Reads the PGF file at the given path through the guest filesystem, parses it into a new `PGF`, and returns a handle bound to it (or to index 0 if the file is missing). |
| `sceFontOpenUserMemory(libHandle: u32, memoryFontPtr: u32, memoryFontLength: u32, errorCodePtr: u32): u32` | Opens a font from a memory buffer; returns a handle bound to index 0 without parsing the buffer. |
| `sceFontClose(fontHandle: u32): int` | Closes a font handle. No-op that returns 0. |

### Info and metrics

| Signature | What it does |
| --- | --- |
| `sceFontGetFontInfo(fontHandle: u32, fontInfoPtr: u32): int` | Fills the 264-byte `PGFFontInfo` at `fontInfoPtr` with dummy 12x14px metrics in 26.6 fixed point. |
| `sceFontGetFontInfoByIndexNumber(libHandle: u32, fontInfoPtr: u32, index: u32): int` | Zero-fills the 168-byte `PGFFontStyle` at `fontInfoPtr`. |
| `sceFontGetFontList(fontLibHandle: u32, fontStylePtr: u32, numFonts: int): int` | Zero-fills one 168-byte `PGFFontStyle` at `fontStylePtr` (it ignores `numFonts` rather than filling the whole list). |
| `sceFontGetCharInfo(fontHandle: u32, charCode: u32, charInfoPtr: u32): int` | Fills the 60-byte `PGFCharInfo` from the real glyph (width/height, bearing, advance) when a PGF is bound, otherwise writes plausible 12x14px fallback metrics. |
| `sceFontGetShadowInfo(fontHandle: u32, charCode: u32, charInfoPtr: u32): int` | Same struct as `sceFontGetCharInfo`, but zero-filled. |
| `sceFontGetCharImageRect(fontHandle: u32, charCode: u32, charRectPtr: u32): int` | Returns a zero glyph rect. Paired with `sceFontGetShadowImageRect`, which does the same. |

### Glyph images

| Signature | What it does |
| --- | --- |
| `sceFontGetCharGlyphImage(fontHandle: u32, charCode: u32, glyphImagePtr: u32): int` | Draws the glyph into the GlyphImage buffer via `PGF.drawCharacter` (alt char `0x20`), or writes a blank glyph if no PGF is bound. |
| `sceFontGetCharGlyphImage_Clip(fontHandle: u32, charCode: u32, glyphImagePtr: u32, clipXPos: int, clipYPos: int, clipWidth: int, clipHeight: int): int` | Same as `sceFontGetCharGlyphImage`; the clip rectangle args are ignored. |
| `sceFontGetShadowGlyphImage(fontHandle: u32, charCode: u32, glyphImagePtr: u32): int` | Writes a blank glyph into the buffer. Paired with `sceFontGetShadowGlyphImage_Clip`, which does the same. |

### Lifecycle and conversion no-ops

| Signature | What it does |
| --- | --- |
| `sceFontFlush(fontHandle: u32): int` | Accepted and ignored; returns 0. |
| `sceFontSetResolution(fontLibHandle: u32, hRes: float, vRes: float): int` | Accepted and ignored; returns 0. |
| `sceFontSetAltCharacterCode(fontLibHandle: u32, charCode: u32): int` | Accepted and ignored; returns 0. |
| `sceFontCalcMemorySize(): int` | Accepted and ignored; returns 0. |
| `sceFontPixelToPointH(fontLibHandle: int, fontPixelsH: float, errorCodePtr: u32): float` | Pixel/point conversion. Returns 0.0. The H/V and reverse forms (`sceFontPixelToPointV`, `sceFontPointToPixelH`, `sceFontPointToPixelV`) all do the same. |
