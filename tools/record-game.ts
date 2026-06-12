/** Record a game's display framebuffer to an mp4 via ffmpeg (software raster, headless).
 *  Usage: npx tsx tools/record-game.ts <iso> [frames=900] [--press f:Button[:hold]]...
 *  Output: public/vids/<iso-name>.mp4 (overwritten each run; never deleted). */
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { loadGame, PspButton } from "../test/helpers/boot-game.js";

const isoPath = process.argv[2] ?? "public/cladun-rpg.iso";
const maxFrames = parseInt(process.argv[3]?.startsWith("--") ? "900" : (process.argv[3] ?? "900"), 10);

// Parse --press f:Button[:hold] actions
interface Press { start: number; end: number; buttons: number }
const presses: Press[] = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--press" && process.argv[i + 1]) {
    const [f, btn, hold] = process.argv[i + 1]!.split(":");
    const bit = (PspButton as Record<string, number>)[btn!];
    if (bit) presses.push({ start: parseInt(f!, 10), end: parseInt(f!, 10) + (hold ? parseInt(hold, 10) : 5), buttons: bit });
  }
}

const W = 480, H = 272;
const FPS = 30; // capture every 2nd frame of 60fps emulation

const emu = await loadGame(isoPath);
if (existsSync("public/flash0/font")) {
  for (const f of readdirSync("public/flash0/font")) {
    if (f.endsWith(".pgf")) emu.hle.fileData.set(`flash0:/font/${f}`, new Uint8Array(readFileSync(`public/flash0/font/${f}`)));
  }
}

mkdirSync("public/vids", { recursive: true });
const outName = `public/vids/${basename(isoPath).replace(/\.[^.]+$/, "")}.mp4`;

const ff = spawn("ffmpeg", [
  "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS),
  "-i", "-",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "fast",
  outName,
], { stdio: ["pipe", "ignore", "inherit"] });

// ── Keypress overlay: tiny 5x7 bitmap font stamped onto frames (yellow on black)
const GLYPHS: Record<string, number[]> = {
  A: [0x0e,0x11,0x11,0x1f,0x11,0x11,0x11], C: [0x0e,0x11,0x10,0x10,0x10,0x11,0x0e],
  D: [0x1e,0x11,0x11,0x11,0x11,0x11,0x1e], E: [0x1f,0x10,0x10,0x1e,0x10,0x10,0x1f],
  G: [0x0e,0x11,0x10,0x17,0x11,0x11,0x0f], H: [0x11,0x11,0x11,0x1f,0x11,0x11,0x11],
  I: [0x0e,0x04,0x04,0x04,0x04,0x04,0x0e], L: [0x10,0x10,0x10,0x10,0x10,0x10,0x1f],
  N: [0x11,0x19,0x15,0x13,0x11,0x11,0x11], O: [0x0e,0x11,0x11,0x11,0x11,0x11,0x0e],
  P: [0x1e,0x11,0x11,0x1e,0x10,0x10,0x10], Q: [0x0e,0x11,0x11,0x11,0x15,0x12,0x0d],
  R: [0x1e,0x11,0x11,0x1e,0x14,0x12,0x11], S: [0x0f,0x10,0x10,0x0e,0x01,0x01,0x1e],
  T: [0x1f,0x04,0x04,0x04,0x04,0x04,0x04], U: [0x11,0x11,0x11,0x11,0x11,0x11,0x0e],
  W: [0x11,0x11,0x11,0x15,0x15,0x15,0x0a], X: [0x11,0x11,0x0a,0x04,0x0a,0x11,0x11],
  F: [0x1f,0x10,0x10,0x1e,0x10,0x10,0x10], B: [0x1e,0x11,0x11,0x1e,0x11,0x11,0x1e],
};
function stampText(buf: Buffer, text: string): void {
  const scale = 2, x0 = 8, y0 = 8;
  const wpx = text.length * 6 * scale + 8, hpx = 7 * scale + 8;
  // black box
  for (let y = y0 - 4; y < y0 - 4 + hpx; y++)
    for (let x = x0 - 4; x < x0 - 4 + wpx; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0;
    }
  // glyphs
  for (let c = 0; c < text.length; c++) {
    const g = GLYPHS[text[c]!.toUpperCase()];
    if (!g) continue;
    for (let row = 0; row < 7; row++)
      for (let col = 0; col < 5; col++) {
        if (!((g[row]! >> (4 - col)) & 1)) continue;
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++) {
            const x = x0 + (c * 6 + col) * scale + sx;
            const y = y0 + row * scale + sy;
            if (x >= W || y >= H) continue;
            const i = (y * W + x) * 4;
            buf[i] = 255; buf[i + 1] = 220; buf[i + 2] = 0;
          }
      }
  }
}

const frameBuf = Buffer.alloc(W * H * 4);

function captureFrame(): Buffer {
  const hk = emu.hle as any;
  const fbAddr = (hk.framebufAddr !== 0 ? hk.framebufAddr : hk.geFbAddr) >>> 0;
  const stride = hk.framebufWidth || 512;
  const fmt = hk.framebufFormat ?? 3;
  const vram = emu.bus.vramBuffer;
  const off = fbAddr - 0x04000000;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const di = (y * W + x) * 4;
      if (fmt === 3) {
        // VRAM stores BGRA for fmt 3; the display shader swizzles B<->R when
        // presenting. Mirror that here so recorded colors match the browser.
        const src = off + (y * stride + x) * 4;
        frameBuf[di] = vram[src + 2] ?? 0;     // R <- stored B
        frameBuf[di + 1] = vram[src + 1] ?? 0; // G
        frameBuf[di + 2] = vram[src] ?? 0;     // B <- stored R
      } else {
        const src = off + (y * stride + x) * 2;
        const px = (vram[src] ?? 0) | ((vram[src + 1] ?? 0) << 8);
        let r = 0, g = 0, b = 0;
        if (fmt === 0) {        // BGR5650
          r = (px & 0x1f) << 3; g = ((px >> 5) & 0x3f) << 2; b = ((px >> 11) & 0x1f) << 3;
        } else if (fmt === 1) { // ABGR5551
          r = (px & 0x1f) << 3; g = ((px >> 5) & 0x1f) << 3; b = ((px >> 10) & 0x1f) << 3;
        } else {                // ABGR4444
          r = (px & 0xf) << 4; g = ((px >> 4) & 0xf) << 4; b = ((px >> 8) & 0xf) << 4;
        }
        frameBuf[di] = r; frameBuf[di + 1] = g; frameBuf[di + 2] = b;
      }
      frameBuf[di + 3] = 255;
    }
  }
  return frameBuf;
}

console.log(`Recording ${isoPath} → ${outName} (${maxFrames} frames @${FPS}fps capture)`);
const t0 = Date.now();
for (let f = 0; f < maxFrames; f++) {
  // Scripted input (same mechanism as bootGame: inputSnapshot closure)
  let buttons = 0;
  for (const p of presses) if (f >= p.start && f < p.end) buttons |= p.buttons;
  emu.hle.inputSnapshot = () => ({ buttons, analog: { x: 0, y: 0 } });
  emu.runFrame();
  await Promise.resolve();
  if (f % 2 === 0) {
    const frame = captureFrame();
    // Overlay held button names (linger 30 frames so brief taps are visible)
    const held = presses.filter((p) => f >= p.start && f < p.end + 30);
    if (held.length) {
      const names = held.map((p) => Object.entries(PspButton).find(([, v]) => v === p.buttons)?.[0] ?? "?");
      stampText(frame, names.join(" "));
    }
    if (!ff.stdin.write(frame)) await new Promise<void>((res) => ff.stdin.once("drain", res));
  }
  if (emu.halted || emu.cpu.stepFaulted) { console.log(`halted at frame ${f}`); break; }
}
ff.stdin.end();
await new Promise<void>((res) => ff.on("close", () => res()));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outName}`);
