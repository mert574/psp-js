/** GTA discovery: per-100-frame timeline of framebuf flips, ctrl reads, mpeg
 *  calls, IO opens, utility calls, error returns, and pixel counts.
 *  Usage: npx tsx tools/debug-gta2-timeline.ts [frames] [--press f:buttonbits:hold]
 */
import { loadGame, PspButton, type InputAction } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const frames = parseInt(process.argv[2] ?? "600", 10);
const input: InputAction[] = [];
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === "--press" && process.argv[i + 1]) {
    const [f, name, hold] = process.argv[i + 1]!.split(":");
    const btn = (PspButton as Record<string, number>)[name!] ?? parseInt(name!, 16);
    const s = parseInt(f!, 10);
    input.push({ start: s, end: s + (hold ? parseInt(hold, 10) : 30), buttons: btn });
  }
}

const emu = await loadGame("test/fixtures/gta.iso");

let frame = 0;
emu.hle.inputSnapshot = () => {
  let buttons = 0;
  for (const a of input) if (frame >= a.start && frame < a.end) buttons |= a.buttons;
  return { buttons, analog: { x: 0, y: 0 } };
};

// Per-window counters
interface Win {
  ctrl: number; setFb: number; mpeg: Map<string, number>;
  io: string[]; util: Map<string, number>; errs: Map<string, number>;
  fbAddrs: Set<number>;
}
const newWin = (): Win => ({ ctrl: 0, setFb: 0, mpeg: new Map(), io: [], util: new Map(), errs: new Map(), fbAddrs: new Set() });
let win = newWin();
const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : "?";
  const a0 = regs.getGpr(4) >>> 0;
  orig(code, regs);
  const ret = regs.getGpr(2) >>> 0;

  if (name.startsWith("sceCtrl")) win.ctrl++;
  else if (name === "sceDisplaySetFrameBuf") { win.setFb++; win.fbAddrs.add(a0); }
  else if (name.startsWith("sceMpeg") || name.startsWith("scePsmf")) inc(win.mpeg, name);
  else if (name === "sceIoOpen") {
    // read filename from a0
    let s = "";
    for (let p = a0; s.length < 64; p++) {
      const c = emu.bus.readU8(p);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    win.io.push(`${s}→${ret >= 0x80000000 ? "0x" + ret.toString(16) : "fd" + ret}`);
  } else if (name.startsWith("sceUtility")) inc(win.util, `${name}→0x${ret.toString(16)}`);

  if (ret >= 0x80000000 && !name.startsWith("sceKernelWait") && name !== "sceKernelPollEventFlag")
    inc(win.errs, `${name}→0x${ret.toString(16)}`);
};

function pixelCount(): { addr: number; px: number } {
  const fbAddr = emu.hle.framebufAddr !== 0 ? emu.hle.framebufAddr : emu.hle.geFbAddr;
  if (fbAddr < 0x04000000) return { addr: fbAddr, px: -1 };
  const vram = emu.bus.vramBuffer;
  const off = fbAddr - 0x04000000;
  const stride = emu.hle.framebufWidth || 512;
  const end = Math.min(off + stride * 272 * 4, vram.length);
  let px = 0;
  for (let i = off; i + 3 < end; i += 4) if (vram[i]! | vram[i + 1]! | vram[i + 2]!) px++;
  return { addr: fbAddr, px };
}

const fmt = (m: Map<string, number>) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}×${n}`).join(" ");

for (frame = 0; frame < frames; frame++) {
  emu.runFrame();
  await Promise.resolve();
  if ((frame + 1) % 100 === 0) {
    const { addr, px } = pixelCount();
    console.log(`\n== f${frame - 99}-${frame} ==`);
    console.log(`  fb=0x${addr.toString(16)} px=${px} setFb=${win.setFb} fbAddrs=[${[...win.fbAddrs].map((a) => "0x" + a.toString(16)).join(",")}] ctrlReads=${win.ctrl}`);
    if (win.mpeg.size) console.log(`  mpeg: ${fmt(win.mpeg)}`);
    if (win.util.size) console.log(`  util: ${fmt(win.util)}`);
    if (win.io.length) console.log(`  io: ${win.io.slice(0, 12).join(" ")}${win.io.length > 12 ? ` (+${win.io.length - 12})` : ""}`);
    if (win.errs.size) console.log(`  errs: ${fmt(win.errs)}`);
    win = newWin();
  }
  if (emu.halted || emu.cpu.stepFaulted) { console.log(`HALT/FAULT at frame ${frame}`); break; }
}

console.log(`\nthreads:`);
for (const t of emu.hle.threads.values()) {
  if (t.state !== 4) console.log(`  t${t.id} "${t.name}" state=${t.state} wait=${t.waitType} prio=${t.priority}`);
}
