/** Check whether SI's memorystick callback (cb 2) gets dispatched. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("test/fixtures/space-invaders.iso");
for (let f = 0; f < 200; f++) {
  emu.runFrame();
  await Promise.resolve();
  const cb = (emu.hle as any).pspCallbacks.get(2);
  if (cb && f % 20 === 0) console.log(`f${f}: cb2 notifyCount=${cb.notifyCount} threadId=${cb.threadId}`);
}
const t1 = (emu.hle as any).threads.get(1);
console.log("t1.callbacks =", t1?.callbacks, "isProcessingCallbacks =", t1?.isProcessingCallbacks);
