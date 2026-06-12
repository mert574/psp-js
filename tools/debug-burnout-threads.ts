import { loadGame } from "../test/helpers/boot-game.js";
const emu = await loadGame("public/burnout-legends.iso");
for (let f = 0; f < 200; f++) { emu.runFrame(); await Promise.resolve(); }
const k = emu.hle as any;
const WT = ["NONE","DELAY","VBLANK","SLEEP","SEMA","EVENT_FLAG","AUDIO","GE_DRAW_SYNC","GE_LIST_SYNC","CTRL","MSG_PIPE","MUTEX","LWMUTEX","THREAD_END","IO","UMD","FPL","VPL","MBX","KERNEL"];
const ST = ["RUNNING","READY","WAITING","DORMANT","DEAD"];
for (const t of k.threads.values()) {
  console.log(`t${t.id} ${t.name||""} state=${ST[t.state]} wait=${WT[t.waitType]??t.waitType} waitId=${t.waitId ?? t.waitSemaId ?? "?"} prio=${t.priority} pc=0x${(t.context?.pc>>>0).toString(16)}`);
}
// dump sema states
console.log("--- semaphores ---");
const semas = k.semaphores ?? k.semas;
if (semas) for (const [id, s] of semas) console.log(`sema ${id} "${s.name||""}" count=${s.count} waiters=${s.waitThreads?.length ?? s.waiters?.length ?? "?"}`);
// pending async
console.log("--- threads waiting count by type ---");
