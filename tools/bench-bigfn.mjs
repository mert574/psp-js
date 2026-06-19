// Does a LARGE hot function get deoptimized in the browser but not node?
// Two interpreters identical except the per-instruction function is small vs
// bloated with a big never-taken cold block (like step()'s fault dump). If the
// big version is ~Nx slower than small in the BROWSER but not node, then V8 is
// refusing to optimize the oversized hot function -> fix = split cold paths out.
// node: node tools/bench-bigfn.mjs ; browser: paste makeBench body into eval.
export function run(big) {
  const N = 30000000;
  const regs = new Uint32Array(32);
  const mem = new Uint32Array(1 << 16);
  const instr = { op: 0, rd: 1, rs: 2, rt: 3, imm: 5 };
  const getGpr = (i) => regs[i] >>> 0;
  const setGpr = (i, v) => { if (i !== 0) regs[i] = v >>> 0; };
  // hot body is identical; `big` adds a giant cold block that never runs but
  // inflates the function so V8 may refuse to optimize it.
  function stepSmall(i) {
    const op = i & 3, rs = (i >>> 2) & 31, rt = (i >>> 7) & 31, rd = (i >>> 12) & 31, imm = i & 0xff;
    switch (op) { case 0: setGpr(rd, getGpr(rs) + getGpr(rt)); break; case 1: setGpr(rt, mem[(getGpr(rs) + imm) & 0xffff]); break; case 2: mem[(getGpr(rs) + imm) & 0xffff] = getGpr(rt); break; default: setGpr(rt, getGpr(rs) + imm); }
  }
  function stepBig(i) {
    const op = i & 3, rs = (i >>> 2) & 31, rt = (i >>> 7) & 31, rd = (i >>> 12) & 31, imm = i & 0xff;
    if (i === -999999) { // never true — cold block, ~ like step()'s fault dump
      let s = "";
      const rows = {};
      for (let k = 0; k < 64; k++) { s += "PC=0x" + (regs[k & 31] >>> 0).toString(16) + " ra=0x" + (regs[31] >>> 0).toString(16) + " sp=0x" + (regs[29] >>> 0).toString(16) + " a0=0x" + (regs[4] >>> 0).toString(16) + " a1=0x" + (regs[5] >>> 0).toString(16) + " a2=0x" + (regs[6] >>> 0).toString(16) + " | "; rows["r" + k] = { hex: "0x" + (regs[k & 31] >>> 0).toString(16).padStart(8, "0"), ascii: String.fromCharCode((regs[k & 31] & 0x7f) || 46) }; }
      const t = []; for (let k = 0; k < 128; k++) t.push("0x" + (regs[k & 31] >>> 0).toString(16));
      console.log(s, rows, t.join(" -> "));
      for (let off = -0x60; off <= 0x60; off += 4) { const v = mem[off & 0xffff] >>> 0; rows["m" + off] = { hex: "0x" + v.toString(16), ascii: [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("") }; }
      const clob = [1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 24, 25]; for (const r of clob) regs[r] = 0xDEADBEEF;
    }
    switch (op) { case 0: setGpr(rd, getGpr(rs) + getGpr(rt)); break; case 1: setGpr(rt, mem[(getGpr(rs) + imm) & 0xffff]); break; case 2: mem[(getGpr(rs) + imm) & 0xffff] = getGpr(rt); break; default: setGpr(rt, getGpr(rs) + imm); }
  }
  const step = big ? stepBig : stepSmall;
  function loop() { for (let i = 0; i < N; i++) step(i); }
  loop();
  const t = performance.now(); loop(); const ms = performance.now() - t;
  return { ms: +ms.toFixed(0), Mips: +((N / (ms / 1000)) / 1e6).toFixed(0) };
}
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
  const small = run(false), big = run(true);
  console.log({ small, big, big_vs_small: +(big.ms / small.ms).toFixed(2) });
}
