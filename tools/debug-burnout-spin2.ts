import { loadGame } from "../test/helpers/boot-game.js";
const emu = await loadGame("public/burnout-legends.iso");
const k = emu.hle as any;
for (let f = 0; f < 150; f++) { emu.runFrame(); await Promise.resolve(); }
// Sample t1's PC over many steps to find the tight loop range
const regs = emu.cpu.regs as any;
const cpu = emu.cpu as any;
const pcHits = new Map<number, number>();
const origStep = cpu.step.bind(cpu);
let n = 0;
cpu.step = () => { if (k.currentThreadId === 1) { const pc = regs.pc >>> 0; pcHits.set(pc, (pcHits.get(pc)??0)+1); n++; } return origStep(); };
for (let f = 0; f < 5; f++) { emu.runFrame(); await Promise.resolve(); }
const top = [...pcHits.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
console.log("t1 hot PCs:", top.map(([p,c])=>`0x${p.toString(16)}:${c}`).join(" "));
const lo = Math.min(...top.map(([p])=>p));
console.log("\ndisasm around loop:");
const reg = ["zero","at","v0","v1","a0","a1","a2","a3","t0","t1","t2","t3","t4","t5","t6","t7","s0","s1","s2","s3","s4","s5","s6","s7","t8","t9","k0","k1","gp","sp","fp","ra"];
for (let a = lo - 8; a < lo + 48; a += 4) {
  const w = emu.bus.readU32(a) >>> 0;
  const op = w>>>26, rs=(w>>>21)&31, rt=(w>>>16)&31, imm=(w&0xffff)<<16>>16;
  let s = `0x${w.toString(16).padStart(8,"0")}`;
  if (op===0x23) s += `  lw ${reg[rt]}, ${imm}(${reg[rs]})`;
  else if (op===0x2b) s += `  sw ${reg[rt]}, ${imm}(${reg[rs]})`;
  else if (op===0x04) s += `  beq ${reg[rs]}, ${reg[rt]}, ${imm}`;
  else if (op===0x05) s += `  bne ${reg[rs]}, ${reg[rt]}, ${imm}`;
  else if (op===0x0c) s += `  andi`;
  else if (op===0) s += `  [special fn=0x${(w&0x3f).toString(16)}]`;
  console.log(`  0x${a.toString(16)}: ${s}`);
}
