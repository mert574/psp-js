/**
 * Verify cladun reacts to input headless: boot to title, press START, UP, X
 * (project_cladun.md: UP then X starts a new game) and check the framebuffer
 * actually changes after each press.
 */
import { loadGame } from "../test/helpers/boot-game.js";

const emulator = await loadGame("test/fixtures/cladun-rpg.iso");
const kernel = emulator.hle;

let buttons = 0;
kernel.inputSnapshot = () => ({ buttons, analog: { x: 0, y: 0 } });

function fbChecksum(): number {
  const vram = emulator.bus.vramBuffer;
  const off = (kernel.framebufAddr & 0x1fffffff) - 0x04000000;
  if (off < 0) return -1;
  let h = 0;
  for (let i = 0; i < 512 * 272 * 2; i += 1024) {
    h = (h ^ vram[off + i]!) >>> 0;
    h = (h * 31) >>> 0;
  }
  return h;
}

function run(frames: number): void {
  for (let i = 0; i < frames; i++) emulator.runFrame();
}

const PSP_UP = 0x0010;
const PSP_CROSS = 0x4000;
const PSP_START = 0x0008;

run(500);
const t0 = fbChecksum();
console.log("RESULT after 500 frames: fb", t0.toString(16));

buttons = PSP_START; run(20); buttons = 0; run(60);
const t1 = fbChecksum();
console.log("RESULT after START:", t1.toString(16), t1 !== t0 ? "(CHANGED)" : "(same)");

buttons = PSP_UP; run(20); buttons = 0; run(60);
const t2 = fbChecksum();
console.log("RESULT after UP:", t2.toString(16), t2 !== t1 ? "(CHANGED)" : "(same)");

buttons = PSP_CROSS; run(20); buttons = 0; run(180);
const t3 = fbChecksum();
console.log("RESULT after CROSS:", t3.toString(16), t3 !== t2 ? "(CHANGED)" : "(same)");

const threads = kernel.getThreadsSnapshot();
console.log("RESULT threads:", JSON.stringify(threads.map(t => ({ id: t.id, s: t.state, w: t.waitType }))));
