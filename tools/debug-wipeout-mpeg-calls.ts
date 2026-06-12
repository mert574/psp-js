/** Boot wipeout and trace the sceMpeg ringbuffer/AU state around the moment
 *  video decode stops, to see what the game spins on.
 *  Usage: npx tsx tools/debug-wipeout-mpeg-calls.ts [iso] [frames] */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const iso = process.argv[2] ?? "test/fixtures/wipeout-pure.iso";
const frames = parseInt(process.argv[3] ?? "600", 10);

const emu = await loadGame(iso);
const hle = emu.hle as any;
const bus = emu.bus;
const s2n: Map<number, number> = hle.syscallToNid;

// SceMpegRingBuffer offsets
const RB_PACKETS = 0x00, RB_READ = 0x04, RB_AVAIL = 0x0c;

let curFrame = 0;
let lastAvailRet = -999;
let lastDecodeFrame = -1;
const events: string[] = [];
const push = (s: string): void => { events.push(`f${curFrame} ${s}`); if (events.length > 120) events.shift(); };

const origDispatch = hle.dispatch.bind(hle);
hle.dispatch = (code: number, regs: any) => {
  const nid = s2n.get(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : null;
  const isMpeg = name != null && /mpeg/i.test(name);
  const a0 = regs.getGpr(4) >>> 0, a1 = regs.getGpr(5) >>> 0;
  origDispatch(code, regs);
  if (!isMpeg) return;
  const ret = regs.getGpr(2) | 0;
  const rb = (off: number, base: number): number => bus.readU32(base + off) | 0;

  if (name === "sceMpegRingbufferAvailableSize") {
    if (ret !== lastAvailRet) { push(`AvailableSize ret=${ret} (packets=${rb(RB_PACKETS, a0)} avail=${rb(RB_AVAIL, a0)} read=${rb(RB_READ, a0)})`); lastAvailRet = ret; }
  } else if (name === "sceMpegRingbufferPut") {
    push(`Put numPkts=${a1} ret=${ret} (avail=${rb(RB_AVAIL, a0)} read=${rb(RB_READ, a0)})`);
  } else if (name === "sceMpegGetAvcAu") {
    push(`GetAvcAu ret=0x${(ret >>> 0).toString(16)}`);
  } else if (name === "sceMpegAvcDecode") {
    lastDecodeFrame = curFrame;
    push(`AvcDecode ret=0x${(ret >>> 0).toString(16)}`);
  } else if (name === "sceMpegGetAtracAu") {
    push(`GetAtracAu ret=0x${(ret >>> 0).toString(16)}`);
  }
};

for (let i = 0; i < frames; i++) { curFrame = i; emu.runFrame(); await Promise.resolve(); }

console.log(`\n=== last decode at frame ${lastDecodeFrame} of ${frames} ===`);
console.log(`=== last ${events.length} MPEG events ===`);
for (const e of events) console.log("  " + e);
