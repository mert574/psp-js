/** Keep forcing event flag bits and trace what the game does next */
import { loadGame } from "../test/helpers/boot-game.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const emu = await loadGame("public/space-invaders.iso");
if (existsSync("public/flash0/font")) {
  for (const f of readdirSync("public/flash0/font")) {
    if (f.endsWith(".pgf")) emu.hle.fileData.set(`flash0:/font/${f}`, new Uint8Array(readFileSync(`public/flash0/font/${f}`)));
  }
}

const hk = emu.hle as any;
const efMap = hk.eventFlags as Map<number, { pattern: number; attr: number }>;

// Track what syscalls happen after the event flag is set
const NID_NAMES: Record<number, string> = {
  0x30fd48f0: "PollEvFlag", 0x402fcf22: "WaitEvFlag", 0x1fb15a32: "SetEvFlag",
  0x4e3a1105: "WaitSema", 0x3f53e640: "SignalSema",
  0xceadeb47: "DelayThread", 0x289d82fe: "SetFrameBuf",
  0xab49e76a: "GeListEnQueue", 0xb287bd61: "GeDrawSync",
  0x46f186c3: "WaitVblankCB", 0x30fd48f0: "PollEvFlag",
  0x278c0df2: "WaitThreadEnd", 0xaa73c935: "ExitThread",
  0x109f50bc: "IoOpen", 0x6a638d83: "IoRead",
};

type Entry = { frame: number; tid: number; name: string; a0: number; ret: number };
const afterFlagSet: Entry[] = [];
let trackingPost = false;

const origDispatch = hk.dispatch.bind(hk);
hk.dispatch = (code: number, regs: any) => {
  const nid: number | undefined = (hk.syscallToNid as Map<number, number>).get(code);
  const name = NID_NAMES[nid ?? 0] ?? `0x${(nid ?? code).toString(16)}`;
  const a0 = regs.getGpr(4);
  const tid: number = hk.currentThreadId ?? 0;
  origDispatch(code, regs);
  const ret = regs.getGpr(2);
  if (trackingPost && afterFlagSet.length < 100) {
    afterFlagSet.push({ frame: currentFrame, tid, name, a0, ret });
  }
  return;
};

let currentFrame = 0;
let flagSetDone = false;

for (let f = 0; f < 60; f++) {
  currentFrame = f;
  // Keep ef102 bits set every frame
  const ef102 = efMap.get(0x102);
  if (ef102 && !flagSetDone && f >= 2) {
    ef102.pattern |= 0x7;
    if (f === 2) { trackingPost = true; console.log(`Frame ${f}: force-set ef102 bits=0x7, tracking starts`); }
  }
  emu.runFrame();
  await Promise.resolve();
}

console.log(`\nSyscalls after flag set (first 60):`);
for (const e of afterFlagSet.slice(0, 60)) {
  console.log(`  f${e.frame} t${e.tid} ${e.name}(0x${e.a0.toString(16)}) → 0x${e.ret.toString(16)}`);
}

const threads: Map<number, any> = hk.threads ?? hk._threads;
console.log(`\nFinal threads:`);
for (const [id, t] of threads) {
  if (t.state !== 4 && t.state !== 3)
    console.log(`  t${id} prio=${t.priority} state=${t.state} wait=${t.waitType}`);
}

// Count non-black pixels
const fbAddr = (hk.framebufAddr || hk.geFbAddr || 0) >>> 0;
const fmt = hk.framebufFormat ?? 3;
const stride = hk.framebufWidth || 512;
const vram = emu.bus.vramBuffer;
const off = fbAddr - 0x04000000;
let nonBlack = 0;
for (let y = 0; y < 272; y++) {
  for (let x = 0; x < 480; x++) {
    const s = off + (y * stride + x) * (fmt === 3 ? 4 : 2);
    const px = fmt === 3
      ? (vram[s]! | (vram[s+1]! << 8) | (vram[s+2]! << 16))
      : (vram[s]! | (vram[s+1]! << 8));
    if (px > 0) nonBlack++;
  }
}
console.log(`\nNon-black pixels: ${nonBlack}, FB: 0x${fbAddr.toString(16)} fmt=${fmt}`);
