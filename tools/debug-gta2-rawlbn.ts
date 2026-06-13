/** Full experiment: serve ALL disc0:/sce_lbnX_sizeY opens from the raw ISO
 *  (what PPSSPP does in ISOFileSystem). Timeline per 100 frames.
 *  Usage: npx tsx tools/debug-gta2-rawlbn.ts [frames] [--press f:name:hold]... */
import { readFileSync } from "node:fs";
import { loadGame, PspButton, type InputAction } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const frames = parseInt(process.argv[2] ?? "900", 10);
const input: InputAction[] = [];
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === "--press" && process.argv[i + 1]) {
    const [f, name, hold] = process.argv[i + 1]!.split(":");
    const s = parseInt(f!, 10);
    input.push({ start: s, end: s + (hold ? parseInt(hold, 10) : 30), buttons: (PspButton as Record<string, number>)[name!]! });
  }
}

const emu = await loadGame("test/fixtures/gta.iso");
const iso = new Uint8Array(readFileSync("test/fixtures/gta.iso").buffer as ArrayBuffer);

let frame = 0;
emu.hle.inputSnapshot = () => {
  let buttons = 0;
  for (const a of input) if (frame >= a.start && frame < a.end) buttons |= a.buttons;
  return { buttons, analog: { x: 0, y: 0 } };
};

interface Win { ctrl: number; setFb: number; fbAddrs: Set<number>; mpeg: Map<string, number>; io: string[]; errs: Map<string, number> }
const newWin = (): Win => ({ ctrl: 0, setFb: 0, fbAddrs: new Set(), mpeg: new Map(), io: [], errs: new Map() });
let win = newWin();
const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : "?";
  const a0 = regs.getGpr(4) >>> 0;
  if (name === "sceIoOpen") {
    let s = "";
    for (let p = a0; s.length < 70; p++) { const c = emu.bus.readU8(p); if (c === 0) break; s += String.fromCharCode(c); }
    const m = /^disc0:\/sce_lbn(0x)?([0-9a-f]+)_size(0x)?([0-9a-f]+)$/i.exec(s);
    const key = s.toLowerCase();
    if (m && !emu.hle.fileData.has(key)) {
      const lbn = parseInt(m[2]!, 16), size = parseInt(m[4]!, 16);
      emu.hle.fileData.set(key, iso.subarray(lbn * 2048, lbn * 2048 + size));
    }
    win.io.push(s);
  }
  orig(code, regs);
  const ret = regs.getGpr(2) >>> 0;
  if (name.startsWith("sceCtrl")) win.ctrl++;
  else if (name === "sceDisplaySetFrameBuf") { win.setFb++; win.fbAddrs.add(a0); }
  else if (name.startsWith("sceMpeg") || name.startsWith("scePsmf")) inc(win.mpeg, name);
  if (ret >= 0x80000000 && ret < 0xdeadbeef && name !== "sceKernelPollEventFlag" && !name.startsWith("sceKernelWait")) inc(win.errs, `${name}→0x${ret.toString(16)}`);
};

const fmt = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9).map(([k, n]) => `${k}×${n}`).join(" ");
function px(): string {
  const fbAddr = emu.hle.framebufAddr !== 0 ? emu.hle.framebufAddr : emu.hle.geFbAddr;
  if (fbAddr < 0x04000000) return "fb=ram";
  const vram = emu.bus.vramBuffer; const off = fbAddr - 0x04000000;
  const stride = emu.hle.framebufWidth || 512;
  let n = 0;
  const end = Math.min(off + stride * 272 * 4, vram.length);
  for (let i = off; i + 3 < end; i += 4) if (vram[i]! | vram[i + 1]! | vram[i + 2]!) n++;
  return `fb=0x${fbAddr.toString(16)} px=${n}`;
}

for (frame = 0; frame < frames; frame++) {
  emu.runFrame();
  await Promise.resolve();
  if ((frame + 1) % 100 === 0) {
    console.log(`\n== f${frame - 99}-${frame} == ${px()} setFb=${win.setFb} addrs=[${[...win.fbAddrs].slice(0,4).map((a) => "0x" + a.toString(16))}] ctrl=${win.ctrl}`);
    if (win.mpeg.size) console.log(`  mpeg: ${fmt(win.mpeg)}`);
    if (win.io.length) console.log(`  open: ${win.io.slice(0, 8).join(" ")}${win.io.length > 8 ? ` (+${win.io.length - 8})` : ""}`);
    if (win.errs.size) console.log(`  errs: ${fmt(win.errs)}`);
    win = newWin();
  }
  if (emu.halted || emu.cpu.stepFaulted) { console.log(`HALT/FAULT f${frame} pc=0x${emu.cpu.regs.pc.toString(16)}`); break; }
}
console.log(`\nfinal pc=0x${emu.cpu.regs.pc.toString(16)} tid=${emu.hle.currentThreadId}`);
const WT = ["NONE","DELAY","VBLANK","SLEEP","SEMA","EVENT_FLAG","AUDIO","ATRAC","GE_DRAW","GE_LIST","THREAD_END","MUTEX","FPL","VPL","MODULE","LWMUTEX","CTRL"];
for (const t of emu.hle.threads.values()) if (t.state !== 4) console.log(`  t${t.id} state=${t.state} wait=${WT[t.waitType] ?? t.waitType}`);
