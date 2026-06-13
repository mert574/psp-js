import { loadGame } from "../test/helpers/boot-game.js";
const emu = await loadGame("test/fixtures/gow-sparta.iso");
const cpu = emu.cpu, kernel = emu.hle, bus = emu.bus;
const os = cpu.step.bind(cpu);
cpu.step = () => { if ((cpu.regs.pc>>>0)===0) cpu.regs.pc = cpu.regs.gpr[31]!>>>0; return os(); };
const names = new Set<string>();
const od = kernel.dispatch.bind(kernel);
(kernel as any).dispatch = (c:number, r:any) => {
  const nid = kernel.getNidBySyscallForTest(c);
  if (nid===0x446d8de6) { // sceKernelCreateThread
    let s=""; let p=r.getGpr(4)>>>0;
    for(let i=0;i<32;i++){const b=bus.readU8(p+i); if(b===0)break; s+=String.fromCharCode(b);}
    names.add(s);
  }
  return od(c,r);
};
for(let f=0;f<30;f++) emu.runFrame();
console.log([...names].sort().join("\n"));
