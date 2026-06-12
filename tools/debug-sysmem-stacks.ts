/** Diagnose sysmem test thread stack addresses */
import { readFileSync } from "node:fs";
import { PSPEmulator } from "../src/emulator.js";

const prxPath = "ppsspp-reference/pspautotests/tests/sysmem/sysmem.prx";
const prxData = new Uint8Array(readFileSync(prxPath));
const emu = new PSPEmulator();
emu.hle.stdoutBuffer = [];
await emu.loadElfBinary(prxData);

const hk = emu.hle as any;
const origDispatch = hk.dispatch.bind(hk);

const logs: string[] = [];
hk.dispatch = (code: number, regs: any) => {
  const nid: number | undefined = hk.syscallToNid?.get(code);
  const tid = hk.currentThreadId;
  origDispatch(code, regs);
  const ret = regs.getGpr(2);
  if (nid === 0xd13bde95) { // sceKernelCreateThread
    const newThread = hk.threads?.get(ret);
    if (newThread) {
      const tt = newThread as any;
      logs.push(`t${tid} CreateThread → t${ret}: stackBase=0x${tt.stackBase.toString(16)} size=0x${tt.stackSize.toString(16)} top=0x${(tt.stackBase+tt.stackSize).toString(16)}`);
    }
  }
  if (nid === 0xf475845d) { // sceKernelReferThreadStatus
    const statusPtr = regs.getGpr(5);
    logs.push(`t${tid} ReferThreadStatus(statusPtr=0x${statusPtr.toString(16)}) → ${ret}`);
    // info.stack is at offset 48
    if (statusPtr !== 0) {
      const infoStack = emu.bus.readU32(statusPtr + 48);
      logs.push(`  &info=0x${statusPtr.toString(16)} info.stack=0x${infoStack.toString(16)} diff=0x${((infoStack - statusPtr) >>> 0).toString(16)}`);
    }
  }
};

for (let f = 0; f < 30; f++) {
  emu.runFrame();
  await Promise.resolve();
}

for (const l of logs) console.log(l);

console.log("\nAll threads (stackBase, stackSize, top):");
for (const [id, t] of hk.threads as Map<number, any>) {
  console.log(`  t${id}: 0x${t.stackBase.toString(16)} + 0x${t.stackSize.toString(16)} = top 0x${(t.stackBase+t.stackSize).toString(16)}`);
}

console.log("\nStdout:", hk.stdoutBuffer?.trim());
