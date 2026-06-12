/** Trace Space Invaders boot — see top syscalls and thread state */
import { loadGame } from "../test/helpers/boot-game.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const emu = await loadGame("public/space-invaders.iso");
if (existsSync("public/flash0/font")) {
  for (const f of readdirSync("public/flash0/font")) {
    if (f.endsWith(".pgf")) emu.hle.fileData.set(`flash0:/font/${f}`, new Uint8Array(readFileSync(`public/flash0/font/${f}`)));
  }
}

const hk = emu.hle as any;
const syscallCounts = new Map<number, number>();
const origDispatch = hk.dispatch.bind(hk);
hk.dispatch = (code: number, regs: any) => {
  syscallCounts.set(code, (syscallCounts.get(code) ?? 0) + 1);
  return origDispatch(code, regs);
};

for (let f = 0; f < 180; f++) {
  emu.runFrame();
  await Promise.resolve();
}

console.log(`\nTop 30 syscalls:`);
const sorted = [...syscallCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
for (const [code, count] of sorted) {
  const nid: number | undefined = hk.syscallToNid?.get(code);
  const nidStr = nid ? `0x${nid.toString(16).padStart(8, "0")}` : "unknown";
  // Find name by searching nid constants
  console.log(`  ${count.toString().padStart(6)} code=0x${code.toString(16).padStart(3,"0")} nid=${nidStr}`);
}

const fbAddr = (hk.framebufAddr || hk.geFbAddr || 0) >>> 0;
const fmt = hk.framebufFormat ?? 3;
const stride = hk.framebufWidth || 512;
console.log(`\nFB: addr=0x${fbAddr.toString(16)} fmt=${fmt} stride=${stride}`);

const threads: Map<number, any> = hk.threads ?? hk._threads;
if (threads) {
  console.log(`\nFinal threads:`);
  for (const [id, t] of threads) {
    if (t.state !== "DORMANT" && t.state !== "DEAD")
      console.log(`  t${id} prio=${t.priority} state=${t.state} wait=${t.waitType}`);
  }
}

// Check raw VRAM for any non-black pixels (both stride=480 and stride=512)
const vram = emu.bus.vramBuffer;
for (const stride2 of [480, 512]) {
  const off = fbAddr - 0x04000000;
  let nonBlack = 0;
  for (let y = 0; y < 272; y++) {
    for (let x = 0; x < 480; x++) {
      const s = off + (y * stride2 + x) * 2;
      const px = (vram[s] ?? 0) | ((vram[s+1] ?? 0) << 8);
      if (px !== 0) nonBlack++;
    }
  }
  console.log(`  stride=${stride2}: ${nonBlack} non-black pixels`);
}
