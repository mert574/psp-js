/** What is burnout's main thread doing in its frontend loop? Log distinct
 *  file ops it repeats in steady state + syscalls returning errors. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/burnout-legends.iso");
const kernel = emu.hle;
const opens = new Map<string, number>();
const errs = new Map<string, number>();
let logging = false;

const orig = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: (c: number, r: { getGpr(n: number): number }) => void }).dispatch = (code, regs) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : "?";
  let path = "";
  if (logging && (name === "sceIoOpen" || name === "sceIoDopen" || name === "sceIoGetstat")) {
    const a0 = regs.getGpr(4) >>> 0;
    for (let p = a0; path.length < 80; p++) { const c = emu.bus.readU8(p); if (!c) break; path += String.fromCharCode(c); }
  }
  orig(code, regs as never);
  if (!logging) return;
  const ret = regs.getGpr(2) >>> 0;
  if (path) opens.set(`${name} ${path}`, (opens.get(`${name} ${path}`) ?? 0) + 1);
  if (ret >= 0x80000000 && ret < 0xdeadbeef && !name.startsWith("sceKernelWait") && name !== "sceKernelPollEventFlag")
    errs.set(`${name}=>0x${ret.toString(16)}`, (errs.get(`${name}=>0x${ret.toString(16)}`) ?? 0) + 1);
};

for (let f = 0; f < 600; f++) { if (f === 350) logging = true; emu.runFrame(); }
const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
console.log("RESULT repeated file ops (f350-600):");
for (const [k, c] of top(opens, 18)) console.log(`  ${c}x ${k}`);
console.log("RESULT syscall errors:");
for (const [k, c] of top(errs, 18)) console.log(`  ${c}x ${k}`);
