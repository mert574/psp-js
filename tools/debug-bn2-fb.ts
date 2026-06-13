/** Burnout: compare the GE draw-target framebuffer vs the displayed framebuffer.
 *  Logs sceDisplaySetFrameBuf addresses, GE draw fbPtrs, and per-100-frame the
 *  non-black pixel count of BOTH the display buffer and each GE target. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/burnout-legends.iso");
const kernel = emu.hle;
const bus = emu.bus;

const setFbAddrs = new Set<number>();
const geTargets = new Set<number>();

kernel.ensureGeProcessor();

const orig = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: (c: number, r: { getGpr(n: number): number }) => void }).dispatch = (code, regs) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  if (name === "sceDisplaySetFrameBuf") setFbAddrs.add(regs.getGpr(4) >>> 0);
  orig(code, regs as never);
};

function countNonBlack(addr: number, stride = 512, fmt = 3): number {
  const phys = (addr & 0x1fffffff) - 0x04000000;
  if (phys < 0) return -1;
  const vram = bus.vramBuffer;
  const bpp = fmt === 3 ? 4 : 2;
  let n = 0;
  const end = Math.min(phys + stride * 272 * bpp, vram.length);
  for (let i = phys; i + bpp <= end; i += bpp) {
    if (bpp === 4) { if (vram[i]! | vram[i + 1]! | vram[i + 2]!) n++; }
    else { if (vram[i]! | vram[i + 1]!) n++; }
  }
  return n;
}

for (let f = 0; f < 500; f++) {
  emu.runFrame();
  const geFb = (kernel as unknown as { geFbAddr?: number }).geFbAddr ?? 0;
  if (geFb) geTargets.add(geFb >>> 0);
  if ((f + 1) % 100 === 0) {
    const dispAddr = kernel.framebufAddr >>> 0;
    console.log(`\nRESULT f${f}: displayAddr=0x${dispAddr.toString(16)} fmt=${kernel.framebufFormat} dispPx=${countNonBlack(dispAddr, kernel.framebufWidth || 512, kernel.framebufFormat)}`);
    console.log(`  setFbAddrs=[${[...setFbAddrs].map(a => "0x" + a.toString(16)).join(",")}]`);
    console.log(`  geTargets=[${[...geTargets].map(a => "0x" + a.toString(16)).join(",")}]`);
    for (const a of geTargets) console.log(`    geTarget 0x${a.toString(16)} px=${countNonBlack(a)}`);
  }
}
