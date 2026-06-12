/** Find where the headless GE scanner runs into ASCII data in puyo-puyo.
 *  Wraps _scanGeListHeadless to trace readU32 pcs, dumps context when OFFSET_Y gets garbage. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("public/puyo-puyo.iso");
const hk = emu.hle as any;
const ge = hk.ensureGeProcessor() as any;
const bus = emu.bus as any;

const ring: { from: number; fromWord: number; to: number; toWord: number }[] = [];
let scanning = false;
let curEntry: any = null;
let lastPc = -1, lastWord = 0;
const origRead = bus.readU32.bind(bus);
const origScan = hk._scanGeListHeadless.bind(hk);
hk._scanGeListHeadless = (entry: any) => {
  curEntry = entry;
  scanning = true;
  lastPc = -1;
  ring.push({ from: -1, fromWord: 0, to: entry.pc >>> 0, toWord: 0 }); // scan start marker
  bus.readU32 = (addr: number) => {
    const w = origRead(addr);
    if (scanning) {
      if (lastPc !== -1 && (addr >>> 0) !== ((lastPc + 4) >>> 0)) {
        ring.push({ from: lastPc, fromWord: lastWord, to: addr >>> 0, toWord: w >>> 0 });
        if (ring.length > 400) ring.shift();
      }
      lastPc = addr; lastWord = w >>> 0;
    }
    return w;
  };
  try { return origScan(entry); } finally { bus.readU32 = origRead; scanning = false; }
};

let dumped = false;
const origExec = ge.executeCommand.bind(ge);
ge.executeCommand = (op: number, param: number) => {
  if (!dumped && op === 0x4d && param === 0x424c4b) {
    dumped = true;
    console.log(`\n!!! bad OFFSET_Y. list entry: pc=0x${(curEntry?.pc>>>0).toString(16)} stall=0x${(curEntry?.stallAddr>>>0).toString(16)} started=${curEntry?.started}`);
    console.log(`scanner transitions (last ${ring.length}), current read pc=0x${lastPc.toString(16)}:`);
    for (const r of ring.slice(-40)) {
      if (r.from === -1) console.log(`  === scan start at 0x${r.to.toString(16)} ===`);
      else console.log(`  0x${r.from.toString(16)} (word 0x${r.fromWord.toString(16).padStart(8,"0")} cmd 0x${(r.fromWord>>>24).toString(16)}) → 0x${r.to.toString(16)} (word 0x${r.toWord.toString(16).padStart(8,"0")})`);
    }
  }
  origExec(op, param);
};

for (let f = 0; f < 300; f++) { emu.runFrame(); await Promise.resolve(); if (dumped) break; }
if (!dumped) console.log("bad OFFSET_Y not seen in 300 frames");
