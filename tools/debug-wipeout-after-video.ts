/** After the wipeout intro-video loop stops, what is the game doing?
 *  Tracks display flips + key syscalls per window, dumps thread states at end. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const iso = process.argv[2] ?? "test/fixtures/wipeout-pure.iso";
const frames = parseInt(process.argv[3] ?? "600", 10);
const WaitTypeName = ["NONE","DELAY","VBLANK","SLEEP","SEMA","EVENT_FLAG","AUDIO","ATRAC_DECODE","GE_DRAW_SYNC","GE_LIST_SYNC","THREAD_END","MUTEX","FPL","VPL","MODULE","LWMUTEX","CTRL"];
const StateName = ["RUNNING","READY","WAITING","DORMANT","DEAD"];

const emu = await loadGame(iso);
const hle = emu.hle as any;
const s2n: Map<number, number> = hle.syscallToNid;

const watch = new Set(["sceDisplaySetFrameBuf","sceMpegAvcDecode","sceCtrlReadBufferPositive","sceCtrlPeekBufferPositive","sceMpegRingbufferPut","sceMpegDelete","sceMpegAvcDecodeStop","sceMpegFlushAllStream"]);
let win: Record<string, number> = {};
let lastFb = 0;
const origDispatch = hle.dispatch.bind(hle);
hle.dispatch = (code: number, regs: any) => {
  const nid = s2n.get(code);
  const name = nid != null ? NID_NAMES.get(nid) : undefined;
  if (name === "sceDisplaySetFrameBuf") lastFb = regs.getGpr(4) >>> 0;
  if (name && watch.has(name)) win[name] = (win[name] ?? 0) + 1;
  origDispatch(code, regs);
};

for (let i = 0; i < frames; i++) {
  emu.runFrame(); await Promise.resolve();
  if ((i + 1) % 75 === 0) {
    const parts = [...watch].filter(k => win[k]).map(k => `${k.replace("sce","")}=${win[k]}`).join(" ");
    console.log(`frames ${i - 73}-${i + 1}: ${parts || "(no watched calls)"}  fb=0x${lastFb.toString(16)}`);
    win = {};
  }
}

console.log("\n=== thread states at end ===");
for (const t of hle.getThreadsSnapshot()) {
  console.log(`  tid=${t.id} ${StateName[t.state]} wait=${WaitTypeName[t.waitType]} pc=0x${(t.pc >>> 0).toString(16)} prio=${t.priority}`);
}
console.log(`idleBreak=${hle.idleBreak}`);
