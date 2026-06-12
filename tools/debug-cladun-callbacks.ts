/** Trace cladun callback lifecycle: create/register/notify/dispatch order. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("public/cladun-rpg.iso");

const log: string[] = [];
let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  const tid = emu.hle.currentThreadId;
  const a0 = regs.getGpr(4) >>> 0;
  const a1 = regs.getGpr(5) >>> 0;
  const a2 = regs.getGpr(6) >>> 0;
  orig(code, regs);
  const v0 = regs.getGpr(2) >>> 0;
  if (name === "sceKernelCreateCallback") {
    let s = "";
    for (let i = 0; i < 32; i++) { const c = emu.bus.readU8(a0 + i); if (!c) break; s += String.fromCharCode(c); }
    log.push(`f${frame} t${tid} CreateCallback("${s}", entry=0x${a1.toString(16)}) → cbId=${v0}`);
  } else if (name === "sceUmdRegisterUMDCallBack") {
    log.push(`f${frame} t${tid} UmdRegisterUMDCallBack(cbId=${a0}) → 0x${v0.toString(16)}`);
  } else if (name === "sceUmdActivate") {
    log.push(`f${frame} t${tid} UmdActivate(mode=${a0}) → 0x${v0.toString(16)}`);
  } else if (name === "sceUmdDeactivate") {
    log.push(`f${frame} t${tid} UmdDeactivate → 0x${v0.toString(16)}`);
  } else if (name.startsWith("sceUmdWaitDriveStat")) {
    log.push(`f${frame} t${tid} ${name}(stat=0x${a0.toString(16)}) → 0x${v0.toString(16)}`);
  } else if (name === "sceKernelNotifyCallback") {
    log.push(`f${frame} t${tid} NotifyCallback(cbId=${a0}, arg=0x${a1.toString(16)}) → 0x${v0.toString(16)}`);
  }
};

for (let f = 0; f < 600; f++) {
  frame = f;
  emu.runFrame();
  await Promise.resolve();
}

// dedupe consecutive
let last = "", count = 0;
for (const s of [...log, "<end>"]) {
  const key = s.replace(/^f\d+ /, "");
  if (key === last) { count++; continue; }
  if (last) console.log(`  ${lastFull}${count > 1 ? ` ×${count}` : ""}`);
  last = key; count = 1;
  var lastFull = s;
}

console.log("\n--- pspCallbacks state after 600 frames ---");
for (const [id, cb] of emu.hle.pspCallbacks) {
  console.log(`cbId=${id} thread=${cb.threadId} entry=0x${(cb.entry >>> 0).toString(16)} notifyCount=${cb.notifyCount} notifyArg=0x${(cb.notifyArg >>> 0).toString(16)} called=${cb.callCount ?? "?"}`);
}
console.log("\nthreads:", [...emu.hle.threads.values()].map((t: any) => `t${t.id}:${t.name}:${t.state}${t.callbacks?.length ? ` cbs=[${t.callbacks}]` : ""}`).join(" "));
