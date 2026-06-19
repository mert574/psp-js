// Synthetic tree-walking interpreter, structurally like our CPU
// (run -> step -> exec switch -> handler -> getGpr/setGpr method calls).
// Goal: does this structure run ~9x slower in the browser than in node?
// If yes, the deep call graph is the cause and a block-JIT (flat code) is the fix.
// Run in node: node tools/bench-treewalk.mjs
// Run in browser: paste the BODY into preview_eval.
export function bench() {
  const N = 30000000;
  const regs = new Uint32Array(32);
  const mem = new Uint32Array(1 << 16);
  const instr = { op: 0, rd: 1, rs: 2, rt: 3, imm: 5 };
  function getGpr(i) { return regs[i] >>> 0; }
  function setGpr(i, v) { if (i !== 0) regs[i] = v >>> 0; }
  function execADD() { setGpr(instr.rd, getGpr(instr.rs) + getGpr(instr.rt)); }
  function execLW() { setGpr(instr.rt, mem[(getGpr(instr.rs) + instr.imm) & 0xffff]); }
  function execSW() { mem[(getGpr(instr.rs) + instr.imm) & 0xffff] = getGpr(instr.rt); }
  function execADDI() { setGpr(instr.rt, getGpr(instr.rs) + instr.imm); }
  function exec() {
    switch (instr.op) {
      case 0: return execADD();
      case 1: return execLW();
      case 2: return execSW();
      case 3: return execADDI();
    }
  }
  function step(i) {
    instr.op = i & 3; instr.rs = (i >>> 2) & 31; instr.rt = (i >>> 7) & 31;
    instr.rd = (i >>> 12) & 31; instr.imm = i & 0xff;
    exec();
  }
  function run() { for (let i = 0; i < N; i++) step(i); }
  run(); // warm
  const t = performance.now(); run(); const ms = performance.now() - t;
  return { ms: +ms.toFixed(0), Minstr_per_sec: +((N / (ms / 1000)) / 1e6).toFixed(0) };
}
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
  console.log(bench());
}
