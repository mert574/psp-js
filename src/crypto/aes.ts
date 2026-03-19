/**
 * AES-128 (Rijndael) — faithful port of PPSSPP ext/libkirk/AES.c
 * Supports: key setup, single-block encrypt/decrypt, CBC encrypt/decrypt, CMAC.
 * Only AES-128 is used by KIRK; 192/256 key setup included for completeness.
 */

import { Te0, Te1, Te2, Te3, Te4, Td0, Td1, Td2, Td3, Td4, rcon } from "./aes-tables.js";

const AES_MAXROUNDS = 14;

// ── Helpers ──────────────────────────────────────────────────────────

function GETU32(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

function PUTU32(b: Uint8Array, off: number, v: number): void {
  b[off] = (v >>> 24) & 0xff;
  b[off + 1] = (v >>> 16) & 0xff;
  b[off + 2] = (v >>> 8) & 0xff;
  b[off + 3] = v & 0xff;
}

function xor128(a: Uint8Array, aOff: number, b: Uint8Array, bOff: number, dst: Uint8Array, dOff: number): void {
  for (let i = 0; i < 16; i++) dst[dOff + i] = a[aOff + i]! ^ b[bOff + i]!;
}

// ── AES context ──────────────────────────────────────────────────────

export interface AESCtx {
  Nr: number;
  ek: Uint32Array; // encrypt key schedule
  dk: Uint32Array; // decrypt key schedule
}

export function aesCreateCtx(): AESCtx {
  return {
    Nr: 0,
    ek: new Uint32Array(4 * (AES_MAXROUNDS + 1)),
    dk: new Uint32Array(4 * (AES_MAXROUNDS + 1)),
  };
}

// ── Key setup ────────────────────────────────────────────────────────

function rijndaelKeySetupEnc(rk: Uint32Array, key: Uint8Array, keyOff: number, bits: number): number {
  let i = 0;
  rk[0] = GETU32(key, keyOff);
  rk[1] = GETU32(key, keyOff + 4);
  rk[2] = GETU32(key, keyOff + 8);
  rk[3] = GETU32(key, keyOff + 12);
  if (bits === 128) {
    let off = 0;
    for (;;) {
      const temp = rk[off + 3]!;
      rk[off + 4] =
        rk[off]! ^
        (Te4[(temp >>> 16) & 0xff]! & 0xff000000) ^
        (Te4[(temp >>> 8) & 0xff]! & 0x00ff0000) ^
        (Te4[temp & 0xff]! & 0x0000ff00) ^
        (Te4[(temp >>> 24)]! & 0x000000ff) ^
        rcon[i]!;
      rk[off + 5] = rk[off + 1]! ^ rk[off + 4]!;
      rk[off + 6] = rk[off + 2]! ^ rk[off + 5]!;
      rk[off + 7] = rk[off + 3]! ^ rk[off + 6]!;
      if (++i === 10) return 10;
      off += 4;
    }
  }
  rk[4] = GETU32(key, keyOff + 16);
  rk[5] = GETU32(key, keyOff + 20);
  if (bits === 192) {
    let off = 0;
    for (;;) {
      const temp = rk[off + 5]!;
      rk[off + 6] =
        rk[off]! ^
        (Te4[(temp >>> 16) & 0xff]! & 0xff000000) ^
        (Te4[(temp >>> 8) & 0xff]! & 0x00ff0000) ^
        (Te4[temp & 0xff]! & 0x0000ff00) ^
        (Te4[(temp >>> 24)]! & 0x000000ff) ^
        rcon[i]!;
      rk[off + 7] = rk[off + 1]! ^ rk[off + 6]!;
      rk[off + 8] = rk[off + 2]! ^ rk[off + 7]!;
      rk[off + 9] = rk[off + 3]! ^ rk[off + 8]!;
      if (++i === 8) return 12;
      rk[off + 10] = rk[off + 4]! ^ rk[off + 9]!;
      rk[off + 11] = rk[off + 5]! ^ rk[off + 10]!;
      off += 6;
    }
  }
  rk[6] = GETU32(key, keyOff + 24);
  rk[7] = GETU32(key, keyOff + 28);
  if (bits === 256) {
    let off = 0;
    for (;;) {
      let temp = rk[off + 7]!;
      rk[off + 8] =
        rk[off]! ^
        (Te4[(temp >>> 16) & 0xff]! & 0xff000000) ^
        (Te4[(temp >>> 8) & 0xff]! & 0x00ff0000) ^
        (Te4[temp & 0xff]! & 0x0000ff00) ^
        (Te4[(temp >>> 24)]! & 0x000000ff) ^
        rcon[i]!;
      rk[off + 9] = rk[off + 1]! ^ rk[off + 8]!;
      rk[off + 10] = rk[off + 2]! ^ rk[off + 9]!;
      rk[off + 11] = rk[off + 3]! ^ rk[off + 10]!;
      if (++i === 7) return 14;
      temp = rk[off + 11]!;
      rk[off + 12] =
        rk[off + 4]! ^
        (Te4[(temp >>> 24)]! & 0xff000000) ^
        (Te4[(temp >>> 16) & 0xff]! & 0x00ff0000) ^
        (Te4[(temp >>> 8) & 0xff]! & 0x0000ff00) ^
        (Te4[temp & 0xff]! & 0x000000ff);
      rk[off + 13] = rk[off + 5]! ^ rk[off + 12]!;
      rk[off + 14] = rk[off + 6]! ^ rk[off + 13]!;
      rk[off + 15] = rk[off + 7]! ^ rk[off + 14]!;
      off += 8;
    }
  }
  return 0;
}

function rijndaelKeySetupDec(rk: Uint32Array, key: Uint8Array, keyOff: number, bits: number): number {
  const Nr = rijndaelKeySetupEnc(rk, key, keyOff, bits);
  // invert round key order
  for (let i = 0, j = 4 * Nr; i < j; i += 4, j -= 4) {
    for (let k = 0; k < 4; k++) {
      const tmp = rk[i + k]!;
      rk[i + k] = rk[j + k]!;
      rk[j + k] = tmp;
    }
  }
  // apply inverse MixColumn to all round keys except first and last
  let off = 4;
  for (let i = 1; i < Nr; i++) {
    for (let k = 0; k < 4; k++) {
      const v = rk[off + k]!;
      rk[off + k] =
        Td0[Te4[(v >>> 24)]! & 0xff]! ^
        Td1[Te4[(v >>> 16) & 0xff]! & 0xff]! ^
        Td2[Te4[(v >>> 8) & 0xff]! & 0xff]! ^
        Td3[Te4[v & 0xff]! & 0xff]!;
    }
    off += 4;
  }
  return Nr;
}

export function aesSetKey(ctx: AESCtx, key: Uint8Array, keyOff: number, bits: number): void {
  ctx.Nr = rijndaelKeySetupEnc(ctx.ek, key, keyOff, bits);
  rijndaelKeySetupDec(ctx.dk, key, keyOff, bits);
}

// ── Single-block encrypt / decrypt ───────────────────────────────────

export function aesEncryptBlock(ctx: AESCtx, src: Uint8Array, sOff: number, dst: Uint8Array, dOff: number): void {
  const rk = ctx.ek;
  const Nr = ctx.Nr;
  let s0 = GETU32(src, sOff) ^ rk[0]!;
  let s1 = GETU32(src, sOff + 4) ^ rk[1]!;
  let s2 = GETU32(src, sOff + 8) ^ rk[2]!;
  let s3 = GETU32(src, sOff + 12) ^ rk[3]!;
  let t0: number, t1: number, t2: number, t3: number;
  let rkOff = 0;
  let r = Nr >> 1;
  for (;;) {
    t0 = Te0[(s0 >>> 24)]! ^ Te1[(s1 >>> 16) & 0xff]! ^ Te2[(s2 >>> 8) & 0xff]! ^ Te3[s3 & 0xff]! ^ rk[rkOff + 4]!;
    t1 = Te0[(s1 >>> 24)]! ^ Te1[(s2 >>> 16) & 0xff]! ^ Te2[(s3 >>> 8) & 0xff]! ^ Te3[s0 & 0xff]! ^ rk[rkOff + 5]!;
    t2 = Te0[(s2 >>> 24)]! ^ Te1[(s3 >>> 16) & 0xff]! ^ Te2[(s0 >>> 8) & 0xff]! ^ Te3[s1 & 0xff]! ^ rk[rkOff + 6]!;
    t3 = Te0[(s3 >>> 24)]! ^ Te1[(s0 >>> 16) & 0xff]! ^ Te2[(s1 >>> 8) & 0xff]! ^ Te3[s2 & 0xff]! ^ rk[rkOff + 7]!;
    rkOff += 8;
    if (--r === 0) break;
    s0 = Te0[(t0 >>> 24)]! ^ Te1[(t1 >>> 16) & 0xff]! ^ Te2[(t2 >>> 8) & 0xff]! ^ Te3[t3 & 0xff]! ^ rk[rkOff]!;
    s1 = Te0[(t1 >>> 24)]! ^ Te1[(t2 >>> 16) & 0xff]! ^ Te2[(t3 >>> 8) & 0xff]! ^ Te3[t0 & 0xff]! ^ rk[rkOff + 1]!;
    s2 = Te0[(t2 >>> 24)]! ^ Te1[(t3 >>> 16) & 0xff]! ^ Te2[(t0 >>> 8) & 0xff]! ^ Te3[t1 & 0xff]! ^ rk[rkOff + 2]!;
    s3 = Te0[(t3 >>> 24)]! ^ Te1[(t0 >>> 16) & 0xff]! ^ Te2[(t1 >>> 8) & 0xff]! ^ Te3[t2 & 0xff]! ^ rk[rkOff + 3]!;
  }
  // last round
  const rkF = Nr << 2;
  s0 =
    (Te4[(t0 >>> 24)]! & 0xff000000) ^
    (Te4[(t1 >>> 16) & 0xff]! & 0x00ff0000) ^
    (Te4[(t2 >>> 8) & 0xff]! & 0x0000ff00) ^
    (Te4[t3 & 0xff]! & 0x000000ff) ^
    rk[rkF]!;
  PUTU32(dst, dOff, s0);
  s1 =
    (Te4[(t1 >>> 24)]! & 0xff000000) ^
    (Te4[(t2 >>> 16) & 0xff]! & 0x00ff0000) ^
    (Te4[(t3 >>> 8) & 0xff]! & 0x0000ff00) ^
    (Te4[t0 & 0xff]! & 0x000000ff) ^
    rk[rkF + 1]!;
  PUTU32(dst, dOff + 4, s1);
  s2 =
    (Te4[(t2 >>> 24)]! & 0xff000000) ^
    (Te4[(t3 >>> 16) & 0xff]! & 0x00ff0000) ^
    (Te4[(t0 >>> 8) & 0xff]! & 0x0000ff00) ^
    (Te4[t1 & 0xff]! & 0x000000ff) ^
    rk[rkF + 2]!;
  PUTU32(dst, dOff + 8, s2);
  s3 =
    (Te4[(t3 >>> 24)]! & 0xff000000) ^
    (Te4[(t0 >>> 16) & 0xff]! & 0x00ff0000) ^
    (Te4[(t1 >>> 8) & 0xff]! & 0x0000ff00) ^
    (Te4[t2 & 0xff]! & 0x000000ff) ^
    rk[rkF + 3]!;
  PUTU32(dst, dOff + 12, s3);
}

export function aesDecryptBlock(ctx: AESCtx, src: Uint8Array, sOff: number, dst: Uint8Array, dOff: number): void {
  const rk = ctx.dk;
  const Nr = ctx.Nr;
  let s0 = GETU32(src, sOff) ^ rk[0]!;
  let s1 = GETU32(src, sOff + 4) ^ rk[1]!;
  let s2 = GETU32(src, sOff + 8) ^ rk[2]!;
  let s3 = GETU32(src, sOff + 12) ^ rk[3]!;
  let t0: number, t1: number, t2: number, t3: number;
  let rkOff = 0;
  let r = Nr >> 1;
  for (;;) {
    t0 = Td0[(s0 >>> 24)]! ^ Td1[(s3 >>> 16) & 0xff]! ^ Td2[(s2 >>> 8) & 0xff]! ^ Td3[s1 & 0xff]! ^ rk[rkOff + 4]!;
    t1 = Td0[(s1 >>> 24)]! ^ Td1[(s0 >>> 16) & 0xff]! ^ Td2[(s3 >>> 8) & 0xff]! ^ Td3[s2 & 0xff]! ^ rk[rkOff + 5]!;
    t2 = Td0[(s2 >>> 24)]! ^ Td1[(s1 >>> 16) & 0xff]! ^ Td2[(s0 >>> 8) & 0xff]! ^ Td3[s3 & 0xff]! ^ rk[rkOff + 6]!;
    t3 = Td0[(s3 >>> 24)]! ^ Td1[(s2 >>> 16) & 0xff]! ^ Td2[(s1 >>> 8) & 0xff]! ^ Td3[s0 & 0xff]! ^ rk[rkOff + 7]!;
    rkOff += 8;
    if (--r === 0) break;
    s0 = Td0[(t0 >>> 24)]! ^ Td1[(t3 >>> 16) & 0xff]! ^ Td2[(t2 >>> 8) & 0xff]! ^ Td3[t1 & 0xff]! ^ rk[rkOff]!;
    s1 = Td0[(t1 >>> 24)]! ^ Td1[(t0 >>> 16) & 0xff]! ^ Td2[(t3 >>> 8) & 0xff]! ^ Td3[t2 & 0xff]! ^ rk[rkOff + 1]!;
    s2 = Td0[(t2 >>> 24)]! ^ Td1[(t1 >>> 16) & 0xff]! ^ Td2[(t0 >>> 8) & 0xff]! ^ Td3[t3 & 0xff]! ^ rk[rkOff + 2]!;
    s3 = Td0[(t3 >>> 24)]! ^ Td1[(t2 >>> 16) & 0xff]! ^ Td2[(t1 >>> 8) & 0xff]! ^ Td3[t0 & 0xff]! ^ rk[rkOff + 3]!;
  }
  // last round
  const rkF = Nr << 2;
  s0 =
    (Td4[(t0 >>> 24)]! & 0xff000000) ^
    (Td4[(t3 >>> 16) & 0xff]! & 0x00ff0000) ^
    (Td4[(t2 >>> 8) & 0xff]! & 0x0000ff00) ^
    (Td4[t1 & 0xff]! & 0x000000ff) ^
    rk[rkF]!;
  PUTU32(dst, dOff, s0);
  s1 =
    (Td4[(t1 >>> 24)]! & 0xff000000) ^
    (Td4[(t0 >>> 16) & 0xff]! & 0x00ff0000) ^
    (Td4[(t3 >>> 8) & 0xff]! & 0x0000ff00) ^
    (Td4[t2 & 0xff]! & 0x000000ff) ^
    rk[rkF + 1]!;
  PUTU32(dst, dOff + 4, s1);
  s2 =
    (Td4[(t2 >>> 24)]! & 0xff000000) ^
    (Td4[(t1 >>> 16) & 0xff]! & 0x00ff0000) ^
    (Td4[(t0 >>> 8) & 0xff]! & 0x0000ff00) ^
    (Td4[t3 & 0xff]! & 0x000000ff) ^
    rk[rkF + 2]!;
  PUTU32(dst, dOff + 8, s2);
  s3 =
    (Td4[(t3 >>> 24)]! & 0xff000000) ^
    (Td4[(t2 >>> 16) & 0xff]! & 0x00ff0000) ^
    (Td4[(t1 >>> 8) & 0xff]! & 0x0000ff00) ^
    (Td4[t0 & 0xff]! & 0x000000ff) ^
    rk[rkF + 3]!;
  PUTU32(dst, dOff + 12, s3);
}

// ── CBC modes (IV = 0, matching PPSSPP AES.c) ────────────────────────

export function aesCbcEncrypt(ctx: AESCtx, src: Uint8Array, srcOff: number, dst: Uint8Array, dstOff: number, size: number): void {
  const block = new Uint8Array(16);
  for (let i = 0; i < size; i += 16) {
    // copy src block to dst
    dst.set(src.subarray(srcOff + i, srcOff + i + 16), dstOff + i);
    // XOR with previous cipher block (or zero for first)
    if (i > 0) xor128(dst, dstOff + i, block, 0, dst, dstOff + i);
    // encrypt → block buffer
    aesEncryptBlock(ctx, dst, dstOff + i, block, 0);
    // copy back
    dst.set(block, dstOff + i);
  }
}

export function aesCbcDecrypt(ctx: AESCtx, src: Uint8Array, srcOff: number, dst: Uint8Array, dstOff: number, size: number): void {
  if (size < 16) return;
  const prev = new Uint8Array(16);
  const cur = new Uint8Array(16);

  // first block
  prev.set(src.subarray(srcOff, srcOff + 16));
  aesDecryptBlock(ctx, src, srcOff, dst, dstOff);

  for (let i = 16; i < size; i += 16) {
    cur.set(src.subarray(srcOff + i, srcOff + i + 16));
    aesDecryptBlock(ctx, src, srcOff + i, dst, dstOff + i);
    xor128(dst, dstOff + i, prev, 0, dst, dstOff + i);
    prev.set(cur);
  }
}

// ── CMAC ─────────────────────────────────────────────────────────────

function leftshiftOneBit(input: Uint8Array, output: Uint8Array): void {
  let overflow = 0;
  for (let i = 15; i >= 0; i--) {
    output[i] = ((input[i]! << 1) | overflow) & 0xff;
    overflow = (input[i]! & 0x80) ? 1 : 0;
  }
}

const CMAC_RB = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x87]);

export function aesCmac(ctx: AESCtx, input: Uint8Array, inputOff: number, length: number, mac: Uint8Array, macOff: number): void {
  const K1 = new Uint8Array(16);
  const K2 = new Uint8Array(16);
  const L = new Uint8Array(16);
  const tmp = new Uint8Array(16);
  const zero = new Uint8Array(16);

  // generate sub-keys
  aesEncryptBlock(ctx, zero, 0, L, 0);
  if ((L[0]! & 0x80) === 0) {
    leftshiftOneBit(L, K1);
  } else {
    leftshiftOneBit(L, tmp);
    xor128(tmp, 0, CMAC_RB, 0, K1, 0);
  }
  if ((K1[0]! & 0x80) === 0) {
    leftshiftOneBit(K1, K2);
  } else {
    leftshiftOneBit(K1, tmp);
    xor128(tmp, 0, CMAC_RB, 0, K2, 0);
  }

  let n = ((length + 15) / 16) | 0;
  let flag: boolean;
  if (n === 0) {
    n = 1;
    flag = false;
  } else {
    flag = (length % 16) === 0;
  }

  const MLast = new Uint8Array(16);
  if (flag) {
    xor128(input, inputOff + 16 * (n - 1), K1, 0, MLast, 0);
  } else {
    const padded = new Uint8Array(16);
    const rem = length % 16;
    for (let j = 0; j < 16; j++) {
      if (j < rem) padded[j] = input[inputOff + 16 * (n - 1) + j]!;
      else if (j === rem) padded[j] = 0x80;
      else padded[j] = 0;
    }
    xor128(padded, 0, K2, 0, MLast, 0);
  }

  const X = new Uint8Array(16);
  const Y = new Uint8Array(16);
  for (let i = 0; i < n - 1; i++) {
    xor128(X, 0, input, inputOff + 16 * i, Y, 0);
    aesEncryptBlock(ctx, Y, 0, X, 0);
  }
  xor128(X, 0, MLast, 0, Y, 0);
  aesEncryptBlock(ctx, Y, 0, X, 0);
  mac.set(X, macOff);
}
