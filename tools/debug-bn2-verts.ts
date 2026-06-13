/** Burnout: are the GE prims degenerate/off-screen? Hook the software
 *  rasterizer's triangle entry and log a sample of screen-space vertex coords
 *  + whether any pixel anywhere in VRAM is non-black. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("test/fixtures/burnout-legends.iso");
const kernel = emu.hle;
const bus = emu.bus;
const ge = kernel.ensureGeProcessor() as unknown as Record<string, unknown>;

// Find a draw method to hook (drawTriangle / drawPrimitives etc.)
const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(ge)).filter(m => /draw|prim|tri|sprite/i.test(m));
console.log("RESULT ge draw methods:", methods.join(", "));

const samples: string[] = [];
for (const m of ["drawTriangle", "drawSprite", "drawPrim", "doPrim"]) {
  const fn = ge[m];
  if (typeof fn === "function") {
    ge[m] = function (...args: unknown[]) {
      if (samples.length < 12) {
        const a0 = args[0] as { x?: number; y?: number } | undefined;
        if (a0 && typeof a0.x === "number") samples.push(`${m}(x=${a0.x?.toFixed(1)},y=${a0.y?.toFixed(1)})`);
        else samples.push(`${m}(${args.length} args, a0=${typeof a0})`);
      }
      return (fn as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
}

for (let f = 0; f < 400; f++) emu.runFrame();

// Full VRAM non-black scan
const vram = bus.vramBuffer;
let nonBlack = 0, firstAt = -1;
for (let i = 0; i + 3 < vram.length; i += 4) {
  if (vram[i]! | vram[i + 1]! | vram[i + 2]!) { nonBlack++; if (firstAt < 0) firstAt = i; }
}
console.log(`RESULT VRAM non-black words: ${nonBlack} firstAt=0x${(0x04000000 + (firstAt < 0 ? 0 : firstAt)).toString(16)}`);
console.log("RESULT vertex samples:", samples.slice(0, 12).join(" | ") || "(none captured)");
