// Experiment: does LBP's pthread lib work if sceKernelReferThreadStatus fills
// the full SceKernelThreadInfo (size, name, attr, PSP status bitmask, etc.)?
// Runtime patch only — no src/ changes.
import { loadGame } from "../test/helpers/boot-game.js";
import { THREAD } from "../src/kernel/nids.js";

const emu = await loadGame("public/lbp.iso");
const k = emu.hle as any;
const bus = emu.bus as any;

// thread id → name captured at sceKernelCreateThread
const threadNames = new Map<number, string>();
threadNames.set(1, "user_main");

const readCStr = (addr: number, max = 31): string => {
  let s = "";
  for (let i = 0; i < max; i++) {
    const c = bus.readU8(addr + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
};

// find syscall codes for the NIDs we care about
const codes = { create: -1, refer: -1 };
for (const [code, nid] of k.syscallToNid) {
  if (nid === THREAD.sceKernelCreateThread) codes.create = code;
  if (nid === THREAD.sceKernelReferThreadStatus) codes.refer = code;
}
console.log("codes:", JSON.stringify(codes));

const origDispatch = k.dispatch.bind(k);
k.dispatch = (code: number, regs: any) => {
  if (code === codes.create) {
    const name = readCStr(regs.getGpr(4) >>> 0);
    origDispatch(code, regs);
    const tid = regs.getGpr(2) | 0;
    if (tid > 0) {
      threadNames.set(tid, name);
      console.log(`[create] tid=${tid} name="${name}"`);
    }
    return;
  }
  origDispatch(code, regs);
};

// PSP status bitmask from our ordinal enum (RUNNING,READY,WAITING,DORMANT,DEAD)
const STATUS_MAP = [1, 2, 4, 16, 32];

const referHandler = (regs: any, b: any) => {
  let thid = regs.getGpr(4);
  const ptr = regs.getGpr(5) >>> 0;
  if (thid === 0) thid = k.currentThreadId;
  const t = k.threads.get(thid);
  if (!t) { regs.setGpr(2, 0x800201bc); return; }
  if (ptr !== 0) {
    b.writeU32(ptr, 104); // size
    const name = threadNames.get(thid) ?? "";
    for (let i = 0; i < 32; i++) b.writeU8(ptr + 4 + i, i < name.length ? name.charCodeAt(i) : 0);
    b.writeU32(ptr + 36, 0x80004000 >>> 0);             // attr (user, default)
    b.writeU32(ptr + 40, STATUS_MAP[t.state] ?? 16);    // status bitmask
    b.writeU32(ptr + 44, t.entry);
    b.writeU32(ptr + 48, t.stackBase);
    b.writeU32(ptr + 52, t.stackSize);
    b.writeU32(ptr + 56, t.context.gpr[28] ?? 0);       // gpReg
    b.writeU32(ptr + 60, t.priority);                   // initPriority
    b.writeU32(ptr + 64, t.priority);                   // currentPriority
    b.writeU32(ptr + 68, t.waitType);
    b.writeU32(ptr + 72, 0);                            // waitId
    b.writeU32(ptr + 76, t.wakeupCount);
    b.writeU32(ptr + 80, 0);                            // exitStatus
    b.writeU32(ptr + 84, 0); b.writeU32(ptr + 88, 0);   // runClocks
    b.writeU32(ptr + 92, 0);                            // intrPreemptCount
    b.writeU32(ptr + 96, 0);                            // threadPreemptCount
    b.writeU32(ptr + 100, 0);                           // releaseCount
  }
  regs.setGpr(2, 0);
};
k.handlers.set(codes.refer, referHandler);

for (let f = 0; f < 600; f++) { emu.runFrame(); await Promise.resolve(); }

// report
const fb = emu.getFramebuffer?.() ?? null;
const WT = ["NONE","DELAY","VBLANK","SLEEP","SEMA","EVENT_FLAG","AUDIO","GE_DRAW_SYNC","GE_LIST_SYNC","CTRL","MSG_PIPE","MUTEX","LWMUTEX","THREAD_END","IO","UMD","FPL","VPL","MBX","KERNEL"];
const ST = ["RUNNING","READY","WAITING","DORMANT","DEAD"];
for (const t of k.threads.values()) {
  console.log(`t${t.id} "${threadNames.get(t.id) ?? ""}" state=${ST[t.state]} wait=${WT[t.waitType] ?? t.waitType} prio=${t.priority}`);
}
console.log("done");
