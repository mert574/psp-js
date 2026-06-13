import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";
const emu = await loadGame("test/fixtures/burnout-legends.iso");
const kernel = emu.hle;
let pmfFd = -1;
const ev: string[] = [];
const push = (s: string) => { ev.push(s); if (ev.length > 30) ev.shift(); };
const orig = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: (c: number, r: { getGpr(n: number): number }) => void }).dispatch = (code, regs) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : "?";
  let path = "";
  if (name === "sceIoOpen" || name === "sceIoOpenAsync") { const a0 = regs.getGpr(4)>>>0; for (let p=a0;path.length<80;p++){const c=emu.bus.readU8(p); if(!c)break; path+=String.fromCharCode(c);} }
  const a0 = regs.getGpr(4)>>>0, a1=regs.getGpr(5)>>>0, a2=regs.getGpr(6)>>>0;
  orig(code, regs as never);
  const ret = regs.getGpr(2)>>>0;
  if ((name==="sceIoOpen"||name==="sceIoOpenAsync") && /englis30\.pmf/i.test(path)) { pmfFd = ret; push(`OPEN ${name} ${path} -> fd ${ret}`); }
  else if (pmfFd>=0 && a0===pmfFd && /sceIo/.test(name)) {
    let res = "";
    if (name==="sceIoLseek"||name==="sceIoLseek32") res=`whence pos=${a1}`;
    push(`t${kernel.currentThreadId} ${name}(buf=0x${a1.toString(16)},sz=0x${a2.toString(16)}) -> 0x${ret.toString(16)} ${res}`);
  }
};
for (let f=0;f<400;f++) emu.runFrame();
console.log("RESULT pmf fd:", pmfFd);
console.log(ev.join("\n"));
