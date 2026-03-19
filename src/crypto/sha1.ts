/**
 * SHA-1 — faithful port of PPSSPP ext/libkirk/SHA1.c
 */

const SHS_DATASIZE = 64;

function rotl(n: number, x: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

const K1 = 0x5a827999;
const K2 = 0x6ed9eba1;
const K3 = 0x8f1bbcdc;
const K4 = 0xca62c1d6;

export interface ShaCtx {
  digest: Uint32Array; // 5
  countLo: number;
  countHi: number;
  data: Uint32Array; // 16
  dataBytes: Uint8Array; // byte view of data
}

export function shaInit(): ShaCtx {
  const data = new Uint32Array(16);
  return {
    digest: new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]),
    countLo: 0,
    countHi: 0,
    data,
    dataBytes: new Uint8Array(data.buffer),
  };
}

function longReverse(buf: Uint32Array, wordCount: number): void {
  // Always little-endian in JS (DataView not needed — we byte-swap)
  for (let i = 0; i < wordCount; i++) {
    const v = buf[i]!;
    buf[i] = (((v & 0xff00ff00) >>> 8) | ((v & 0x00ff00ff) << 8));
    buf[i] = ((buf[i]! << 16) | (buf[i]! >>> 16)) >>> 0;
  }
}

function shsTransform(digest: Uint32Array, data: Uint32Array): void {
  let A = digest[0]!;
  let B = digest[1]!;
  let C = digest[2]!;
  let D = digest[3]!;
  let E = digest[4]!;

  const W = new Uint32Array(16);
  W.set(data);

  function expand(i: number): number {
    W[i & 15] = rotl(1, W[i & 15]! ^ W[(i - 14) & 15]! ^ W[(i - 8) & 15]! ^ W[(i - 3) & 15]!);
    return W[i & 15]!;
  }

  function f1(x: number, y: number, z: number) { return (z ^ (x & (y ^ z))) >>> 0; }
  function f2(x: number, y: number, z: number) { return (x ^ y ^ z) >>> 0; }
  function f3(x: number, y: number, z: number) { return ((x & y) | (z & (x | y))) >>> 0; }

  function sub(a: number, b: number, c: number, d: number, e: number, f: (x: number, y: number, z: number) => number, k: number, data: number): [number, number, number, number, number] {
    e = (e + rotl(5, a) + f(b, c, d) + k + data) >>> 0;
    b = rotl(30, b);
    return [a, b, c, d, e];
  }

  // Rounds 0-19
  for (let i = 0; i < 16; i++) {
    [A, B, C, D, E] = sub(A, B, C, D, E, f1, K1, W[i]!);
    // rotate variables
    const t = E; E = D; D = C; C = B; B = A; A = t;
  }
  for (let i = 16; i < 20; i++) {
    [A, B, C, D, E] = sub(A, B, C, D, E, f1, K1, expand(i));
    const t = E; E = D; D = C; C = B; B = A; A = t;
  }
  // Rounds 20-39
  for (let i = 20; i < 40; i++) {
    [A, B, C, D, E] = sub(A, B, C, D, E, f2, K2, expand(i));
    const t = E; E = D; D = C; C = B; B = A; A = t;
  }
  // Rounds 40-59
  for (let i = 40; i < 60; i++) {
    [A, B, C, D, E] = sub(A, B, C, D, E, f3, K3, expand(i));
    const t = E; E = D; D = C; C = B; B = A; A = t;
  }
  // Rounds 60-79
  for (let i = 60; i < 80; i++) {
    [A, B, C, D, E] = sub(A, B, C, D, E, f2, K4, expand(i));
    const t = E; E = D; D = C; C = B; B = A; A = t;
  }

  digest[0] = (digest[0]! + A) >>> 0;
  digest[1] = (digest[1]! + B) >>> 0;
  digest[2] = (digest[2]! + C) >>> 0;
  digest[3] = (digest[3]! + D) >>> 0;
  digest[4] = (digest[4]! + E) >>> 0;
}

export function shaUpdate(ctx: ShaCtx, buffer: Uint8Array, bufOff: number, count: number): void {
  const tmp = ctx.countLo;
  ctx.countLo = (tmp + (count << 3)) >>> 0;
  if (ctx.countLo < tmp) ctx.countHi++;
  ctx.countHi += count >>> 29;

  let dataCount = (tmp >>> 3) & 0x3f;

  let off = bufOff;
  if (dataCount) {
    const p = dataCount;
    dataCount = SHS_DATASIZE - dataCount;
    if (count < dataCount) {
      ctx.dataBytes.set(buffer.subarray(off, off + count), p);
      return;
    }
    ctx.dataBytes.set(buffer.subarray(off, off + dataCount), p);
    longReverse(ctx.data, 16);
    shsTransform(ctx.digest, ctx.data);
    off += dataCount;
    count -= dataCount;
  }

  while (count >= SHS_DATASIZE) {
    ctx.dataBytes.set(buffer.subarray(off, off + SHS_DATASIZE));
    longReverse(ctx.data, 16);
    shsTransform(ctx.digest, ctx.data);
    off += SHS_DATASIZE;
    count -= SHS_DATASIZE;
  }

  ctx.dataBytes.set(buffer.subarray(off, off + count));
}

export function shaFinal(output: Uint8Array, outOff: number, ctx: ShaCtx): void {
  let count = (ctx.countLo >>> 3) & 0x3f;

  ctx.dataBytes[count++] = 0x80;

  const bytesLeft = SHS_DATASIZE - count;
  if (bytesLeft < 8) {
    ctx.dataBytes.fill(0, count, SHS_DATASIZE);
    longReverse(ctx.data, 16);
    shsTransform(ctx.digest, ctx.data);
    ctx.dataBytes.fill(0, 0, SHS_DATASIZE - 8);
  } else {
    ctx.dataBytes.fill(0, count, SHS_DATASIZE - 8);
  }

  ctx.data[14] = ctx.countHi;
  ctx.data[15] = ctx.countLo;

  longReverse(ctx.data, 14);
  shsTransform(ctx.digest, ctx.data);

  // output digest as bytes (big-endian)
  for (let i = 0; i < 5; i++) {
    const v = ctx.digest[i]!;
    output[outOff + i * 4 + 3] = v & 0xff;
    output[outOff + i * 4 + 2] = (v >>> 8) & 0xff;
    output[outOff + i * 4 + 1] = (v >>> 16) & 0xff;
    output[outOff + i * 4] = (v >>> 24) & 0xff;
  }
}
