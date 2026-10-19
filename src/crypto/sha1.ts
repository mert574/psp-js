/** SHA-1 for PSP file compatibility, from FIPS 180-4 section 6.1. */
export interface ShaCtx {
  words: Uint32Array;
  pending: Uint8Array;
  used: number;
  bytes: bigint;
}
const rotate = (word: number, bits: number): number => (word << bits) | (word >>> (32 - bits));
export function shaInit(): ShaCtx {
  return {
    words: Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0),
    pending: new Uint8Array(64), used: 0, bytes: 0n,
  };
}
function compress(ctx: ShaCtx, block: Uint8Array): void {
  const schedule = new Uint32Array(80);
  const view = new DataView(block.buffer, block.byteOffset, 64);
  for (let i = 0; i < 16; i++) schedule[i] = view.getUint32(i * 4, false);
  for (let i = 16; i < 80; i++) {
    schedule[i] = rotate(schedule[i - 3]! ^ schedule[i - 8]! ^ schedule[i - 14]! ^ schedule[i - 16]!, 1);
  }
  let [a, b, c, d, e] = Array.from(ctx.words) as [number, number, number, number, number];
  for (let i = 0; i < 80; i++) {
    const round = Math.floor(i / 20);
    const choice = round === 0 ? (b & c) ^ (~b & d)
      : round === 2 ? (b & c) ^ (b & d) ^ (c & d) : b ^ c ^ d;
    const constant = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6][round]!;
    const next = (rotate(a, 5) + choice + e + constant + schedule[i]!) >>> 0;
    [a, b, c, d, e] = [next, a, rotate(b, 30), c, d];
  }
  [a, b, c, d, e].forEach((value, i) => { ctx.words[i] = (ctx.words[i]! + value) >>> 0; });
}
export function shaUpdate(ctx: ShaCtx, input: Uint8Array, offset: number, count: number): void {
  if (offset < 0 || count < 0 || offset + count > input.length) throw new RangeError("SHA-1 input range");
  ctx.bytes += BigInt(count);
  const end = offset + count;
  while (offset < end) {
    const take = Math.min(64 - ctx.used, end - offset);
    ctx.pending.set(input.subarray(offset, offset + take), ctx.used);
    ctx.used += take;
    offset += take;
    if (ctx.used === 64) { compress(ctx, ctx.pending); ctx.used = 0; }
  }
}
export function shaFinal(output: Uint8Array, offset: number, ctx: ShaCtx): void {
  if (offset < 0 || offset + 20 > output.length) throw new RangeError("SHA-1 output range");
  const tail = new Uint8Array(ctx.used < 56 ? 64 : 128);
  tail.set(ctx.pending.subarray(0, ctx.used));
  tail[ctx.used] = 0x80;
  new DataView(tail.buffer).setBigUint64(tail.length - 8, BigInt.asUintN(64, ctx.bytes * 8n), false);
  for (let at = 0; at < tail.length; at += 64) compress(ctx, tail.subarray(at, at + 64));
  const result = new DataView(output.buffer, output.byteOffset + offset, 20);
  ctx.words.forEach((word, i) => result.setUint32(i * 4, word, false));
}
