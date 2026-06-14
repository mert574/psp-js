/**
 * amctrl — PGD decryption. Faithful port of PPSSPP ext/libkirk/amctrl.c
 */

import { aesCreateCtx, aesSetKey, aesEncryptBlock } from "./aes.js";
import { type KirkState, kirkSceUtilsBufferCopyWithRange } from "./kirk.js";

// ── Constants from amctrl.c ──────────────────────────────────────────

const loc_1CD4 = new Uint8Array([0xe3, 0x50, 0xed, 0x1d, 0x91, 0x0a, 0x1f, 0xd0, 0x29, 0xbb, 0x1c, 0x3e, 0xf3, 0x40, 0x77, 0xfb]);
const loc_1CE4 = new Uint8Array([0x13, 0x5f, 0xa4, 0x7c, 0xab, 0x39, 0x5b, 0xa4, 0x76, 0xb8, 0xcc, 0xa9, 0x8f, 0x3a, 0x04, 0x45]);
const loc_1CF4 = new Uint8Array([0x67, 0x8d, 0x7f, 0xa3, 0x2a, 0x9c, 0xa0, 0xd1, 0x50, 0x8a, 0xd8, 0x38, 0x5e, 0x4b, 0x01, 0x7e]);

const dnas_key1A90 = new Uint8Array([0xed, 0xe2, 0x5d, 0x2d, 0xbb, 0xf8, 0x12, 0xe5, 0x3c, 0x5c, 0x59, 0x32, 0xfa, 0xe3, 0xe2, 0x43]);
const dnas_key1AA0 = new Uint8Array([0x27, 0x74, 0xfb, 0xeb, 0xa4, 0xa0, 0x01, 0xd7, 0x02, 0x56, 0x9e, 0x33, 0x8c, 0x19, 0x57, 0x83]);

const key_357C = new Uint8Array([
  0x07, 0x3d, 0x9e, 0x9d, 0xa8, 0xfd, 0x3b, 0x2f, 0x63, 0x18, 0x93, 0x2e, 0xf8, 0x57, 0xa6, 0x64,
  0x37, 0x49, 0xb7, 0x01, 0xca, 0xe2, 0xe0, 0xc5, 0x44, 0x2e, 0x06, 0xb6, 0x1e, 0xff, 0x84, 0xf2,
  0x9d, 0x31, 0xb8, 0x5a, 0xc8, 0xfa, 0x16, 0x80, 0x73, 0x60, 0x18, 0x82, 0x18, 0x77, 0x91, 0x9d,
]);

const key_363C = new Uint8Array([0x38, 0x20, 0xd0, 0x11, 0x07, 0xa3, 0xff, 0x3e, 0x0a, 0x4c, 0x20, 0x85, 0x39, 0x10, 0xb5, 0x54]);

// ── Helpers ──────────────────────────────────────────────────────────

function readU32LE(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>> 0;
}

function writeU32LE(buf: Uint8Array, off: number, val: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
  buf[off + 2] = (val >>> 16) & 0xff;
  buf[off + 3] = (val >>> 24) & 0xff;
}

// ── MAC_KEY / CIPHER_KEY ─────────────────────────────────────────────

interface MacKey {
  type: number;
  key: Uint8Array;  // 16
  pad: Uint8Array;  // 16
  padSize: number;
}

interface CipherKey {
  type: number;
  seed: number;
  key: Uint8Array;  // 16
}

// ── Internal kirk wrappers (matching amctrl.c do_kirk4/7/kirk5/kirk8/kirk14) ──

function doKirk4(kirk: KirkState, buf: Uint8Array, size: number, type: number): number {
  // Write KIRK_AES128CBC_HEADER at buf[0..19]
  writeU32LE(buf, 0, 4);      // mode = KIRK_MODE_ENCRYPT_CBC
  writeU32LE(buf, 4, 0);
  writeU32LE(buf, 8, 0);
  writeU32LE(buf, 12, type);  // keyseed
  writeU32LE(buf, 16, size);  // data_size
  const ret = kirkSceUtilsBufferCopyWithRange(kirk, buf, size + 0x14, buf, size, 4);
  return ret ? 0x80510311 : 0;
}

function doKirk7(kirk: KirkState, buf: Uint8Array, size: number, type: number): number {
  writeU32LE(buf, 0, 5);      // mode = KIRK_MODE_DECRYPT_CBC
  writeU32LE(buf, 4, 0);
  writeU32LE(buf, 8, 0);
  writeU32LE(buf, 12, type);
  writeU32LE(buf, 16, size);
  const ret = kirkSceUtilsBufferCopyWithRange(kirk, buf, size + 0x14, buf, size, 7);
  return ret ? 0x80510311 : 0;
}

function kirk5(kirk: KirkState, buf: Uint8Array, size: number): number {
  writeU32LE(buf, 0, 4);
  writeU32LE(buf, 4, 0);
  writeU32LE(buf, 8, 0);
  writeU32LE(buf, 12, 0x0100);
  writeU32LE(buf, 16, size);
  const ret = kirkSceUtilsBufferCopyWithRange(kirk, buf, size + 0x14, buf, size, 5);
  return ret ? 0x80510312 : 0;
}

function kirk8(kirk: KirkState, buf: Uint8Array, size: number): number {
  writeU32LE(buf, 0, 5);
  writeU32LE(buf, 4, 0);
  writeU32LE(buf, 8, 0);
  writeU32LE(buf, 12, 0x0100);
  writeU32LE(buf, 16, size);
  const ret = kirkSceUtilsBufferCopyWithRange(kirk, buf, size + 0x14, buf, size, 8);
  return ret ? 0x80510312 : 0;
}

function kirk14(kirk: KirkState, buf: Uint8Array): number {
  const ret = kirkSceUtilsBufferCopyWithRange(kirk, buf, 0x14, new Uint8Array(0), 0, 14);
  return ret ? 0x80510315 : 0;
}

// ── sub_158: encrypt buf and update key (amctrl.c:119-135) ───────────

function sub158(kirk: KirkState, buf: Uint8Array, size: number, key: Uint8Array, keyType: number): number {
  for (let i = 0; i < 16; i++) buf[0x14 + i] = buf[0x14 + i]! ^ key[i]!;
  const ret = doKirk4(kirk, buf, size, keyType);
  if (ret) return ret;
  key.set(buf.subarray(size + 4, size + 4 + 16));
  return 0;
}

// ── sceDrmBBMacInit/Update/Final/Final2/getkey ───────────────────────

function sceDrmBBMacInit(mkey: MacKey, type: number): number {
  mkey.type = type;
  mkey.padSize = 0;
  mkey.key.fill(0);
  mkey.pad.fill(0);
  return 0;
}

function sceDrmBBMacUpdate(kirk: KirkState, mkey: MacKey, buf: Uint8Array, bufOff: number, size: number): number {
  if (mkey.padSize > 16) return 0x80510302;

  if (mkey.padSize + size <= 16) {
    mkey.pad.set(buf.subarray(bufOff, bufOff + size), mkey.padSize);
    mkey.padSize += size;
    return 0;
  }

  const kbuf = kirk.kirk_buf;
  kbuf.set(mkey.pad.subarray(0, mkey.padSize), 0x14);

  let p = mkey.padSize;
  mkey.padSize = (mkey.padSize + size) & 0x0f;
  if (mkey.padSize === 0) mkey.padSize = 16;
  size -= mkey.padSize;
  mkey.pad.set(buf.subarray(bufOff + size, bufOff + size + mkey.padSize));

  const type = mkey.type === 2 ? 0x3a : 0x38;
  let off = bufOff;
  while (size > 0) {
    const ksize = (size + p >= 0x0800) ? 0x0800 : size + p;
    kbuf.set(buf.subarray(off, off + ksize - p), 0x14 + p);
    const ret = sub158(kirk, kbuf, ksize, mkey.key, type);
    if (ret) return ret;
    size -= (ksize - p);
    off += ksize - p;
    p = 0;
  }
  return 0;
}

function sceDrmBBMacFinal(kirk: KirkState, mkey: MacKey, out: Uint8Array, outOff: number, vkey: Uint8Array | null): number {
  if (mkey.padSize > 16) return 0x80510302;

  const code = mkey.type === 2 ? 0x3a : 0x38;
  const kbuf = kirk.kirk_buf;

  kbuf.fill(0, 0x14, 0x14 + 16);
  let ret = doKirk4(kirk, kbuf, 16, code);
  if (ret) return ret;

  const tmp = new Uint8Array(16);
  tmp.set(kbuf.subarray(0x14, 0x14 + 16));

  // left shift tmp 1 bit
  let t0 = (tmp[0]! & 0x80) ? 0x87 : 0;
  for (let i = 0; i < 15; i++) {
    tmp[i] = ((tmp[i]! << 1) | (tmp[i + 1]! >>> 7)) & 0xff;
  }
  tmp[15] = ((tmp[15]! << 1) ^ t0) & 0xff;

  if (mkey.padSize < 16) {
    // left shift tmp 1 bit again
    t0 = (tmp[0]! & 0x80) ? 0x87 : 0;
    for (let i = 0; i < 15; i++) {
      tmp[i] = ((tmp[i]! << 1) | (tmp[i + 1]! >>> 7)) & 0xff;
    }
    tmp[15] = ((tmp[15]! << 1) ^ t0) & 0xff;

    mkey.pad[mkey.padSize] = 0x80;
    if (mkey.padSize + 1 < 16) mkey.pad.fill(0, mkey.padSize + 1, 16);
  }

  for (let i = 0; i < 16; i++) mkey.pad[i] = mkey.pad[i]! ^ tmp[i]!;

  kbuf.set(mkey.pad, 0x14);
  const tmp1 = new Uint8Array(16);
  tmp1.set(mkey.key);

  ret = sub158(kirk, kbuf, 0x10, tmp1, code);
  if (ret) return ret;

  for (let i = 0; i < 0x10; i++) tmp1[i] = tmp1[i]! ^ loc_1CD4[i]!;

  if (mkey.type === 2) {
    kbuf.set(tmp1, 0x14);
    ret = kirk5(kirk, kbuf, 0x10);
    if (ret) return ret;
    ret = doKirk4(kirk, kbuf, 0x10, code);
    if (ret) return ret;
    tmp1.set(kbuf.subarray(0x14, 0x14 + 16));
  }

  if (vkey) {
    for (let i = 0; i < 0x10; i++) tmp1[i] = tmp1[i]! ^ vkey[i]!;
    kbuf.set(tmp1, 0x14);
    ret = doKirk4(kirk, kbuf, 0x10, code);
    if (ret) return ret;
    tmp1.set(kbuf.subarray(0x14, 0x14 + 16));
  }

  out.set(tmp1, outOff);
  mkey.key.fill(0);
  mkey.pad.fill(0);
  mkey.padSize = 0;
  mkey.type = 0;
  return 0;
}

function sceDrmBBMacFinal2(kirk: KirkState, mkey: MacKey, expected: Uint8Array, expectedOff: number, vkey: Uint8Array | null): number {
  const type = mkey.type;
  const tmp = new Uint8Array(16);
  const ret = sceDrmBBMacFinal(kirk, mkey, tmp, 0, vkey);
  if (ret) return ret;

  const kbuf = kirk.kirk_buf;
  if (type === 3) {
    kbuf.set(expected.subarray(expectedOff, expectedOff + 0x10), 0x14);
    doKirk7(kirk, kbuf, 0x10, 0x63);
  } else {
    kbuf.set(expected.subarray(expectedOff, expectedOff + 0x10));
  }

  for (let i = 0; i < 0x10; i++) {
    if (kbuf[i] !== tmp[i]) return 0x80510300;
  }
  return 0;
}

function bbmacGetkey(kirk: KirkState, mkey: MacKey, bbmac: Uint8Array, bbmacOff: number, vkey: Uint8Array): number {
  const type = mkey.type;
  const tmp = new Uint8Array(16);
  const ret = sceDrmBBMacFinal(kirk, mkey, tmp, 0, null);
  if (ret) return ret;

  const kbuf = kirk.kirk_buf;
  if (type === 3) {
    kbuf.set(bbmac.subarray(bbmacOff, bbmacOff + 0x10), 0x14);
    doKirk7(kirk, kbuf, 0x10, 0x63);
  } else {
    kbuf.set(bbmac.subarray(bbmacOff, bbmacOff + 0x10));
  }

  const tmp1 = new Uint8Array(16);
  tmp1.set(kbuf.subarray(0, 16));
  kbuf.set(tmp1, 0x14);

  const code = type === 2 ? 0x3a : 0x38;
  doKirk7(kirk, kbuf, 0x10, code);

  for (let i = 0; i < 0x10; i++) vkey[i] = tmp[i]! ^ kbuf[i]!;
  return 0;
}

// ── sub_1F8: decrypt buf and XOR with key (amctrl.c:378-398) ─────────

function sub1F8(kirk: KirkState, buf: Uint8Array, size: number, key: Uint8Array, keyType: number): number {
  const tmp = new Uint8Array(16);
  tmp.set(buf.subarray(size + 0x14 - 16, size + 0x14));
  const ret = doKirk7(kirk, buf, size, keyType);
  if (ret) return ret;
  for (let i = 0; i < 16; i++) buf[i] = buf[i]! ^ key[i]!;
  key.set(tmp);
  return 0;
}

// ── sub_428: cipher update helper (amctrl.c:401-447) ─────────────────

function sub428(kirk: KirkState, kbuf: Uint8Array, dbuf: Uint8Array, dbufOff: number, size: number, ckey: CipherKey): number {
  kbuf.set(ckey.key, 0x14);
  for (let i = 0; i < 16; i++) kbuf[0x14 + i] = kbuf[0x14 + i]! ^ loc_1CF4[i]!;

  let ret: number;
  if (ckey.type === 2)
    ret = kirk8(kirk, kbuf, 16);
  else
    ret = doKirk7(kirk, kbuf, 16, 0x39);
  if (ret) return ret;

  for (let i = 0; i < 16; i++) kbuf[i] = kbuf[i]! ^ loc_1CE4[i]!;

  const tmp2 = new Uint8Array(16);
  tmp2.set(kbuf.subarray(0, 16));

  const tmp1 = new Uint8Array(16);
  if (ckey.seed === 1) {
    tmp1.fill(0);
  } else {
    tmp1.set(tmp2);
    writeU32LE(tmp1, 0x0c, ckey.seed - 1);
  }

  for (let i = 0; i < size; i += 16) {
    kbuf.set(tmp2.subarray(0, 12), 0x14 + i);
    writeU32LE(kbuf, 0x14 + i + 12, ckey.seed);
    ckey.seed += 1;
  }

  ret = sub1F8(kirk, kbuf, size, tmp1, 0x63);
  if (ret) return ret;

  for (let i = 0; i < size; i++) dbuf[dbufOff + i] = dbuf[dbufOff + i]! ^ kbuf[i]!;
  return 0;
}

// ── sceDrmBBCipherInit/Update/Final ──────────────────────────────────

function sceDrmBBCipherInit(kirk: KirkState, ckey: CipherKey, type: number, mode: number, headerKey: Uint8Array, hkOff: number, versionKey: Uint8Array | null, seed: number): number {
  const kbuf = kirk.kirk_buf;
  ckey.type = type;

  if (mode === 2) {
    // decrypt mode
    ckey.seed = seed + 1;
    for (let i = 0; i < 16; i++) ckey.key[i] = headerKey[hkOff + i]!;
    if (versionKey) {
      for (let i = 0; i < 16; i++) ckey.key[i] = ckey.key[i]! ^ versionKey[i]!;
    }
    return 0;
  } else if (mode === 1) {
    // encrypt mode
    ckey.seed = 1;
    let ret = kirk14(kirk, kbuf);
    if (ret) return ret;
    const kb = kbuf.subarray(0x14);
    kb.set(kbuf.subarray(0, 0x10));
    kb.fill(0, 0x0c, 0x10);

    if (ckey.type === 2) {
      for (let i = 0; i < 16; i++) kb[i] = kb[i]! ^ loc_1CE4[i]!;
      ret = kirk5(kirk, kbuf, 0x10);
      for (let i = 0; i < 16; i++) kb[i] = kb[i]! ^ loc_1CF4[i]!;
    } else {
      for (let i = 0; i < 16; i++) kb[i] = kb[i]! ^ loc_1CE4[i]!;
      ret = doKirk4(kirk, kbuf, 0x10, 0x39);
      for (let i = 0; i < 16; i++) kb[i] = kb[i]! ^ loc_1CF4[i]!;
    }
    if (ret) return ret;

    ckey.key.set(kb.subarray(0, 0x10));
    headerKey.set(kb.subarray(0, 0x10), hkOff);

    if (versionKey) {
      for (let i = 0; i < 16; i++) ckey.key[i] = ckey.key[i]! ^ versionKey[i]!;
    }
    return 0;
  }
  return 0;
}

function sceDrmBBCipherUpdate(kirk: KirkState, ckey: CipherKey, data: Uint8Array, dataOff: number, size: number): number {
  let p = 0;
  while (size > 0) {
    const dsize = size >= 0x0800 ? 0x0800 : size;
    const ret = sub428(kirk, kirk.kirk_buf, data, dataOff + p, dsize, ckey);
    if (ret) return ret;
    size -= dsize;
    p += dsize;
  }
  return 0;
}

function sceDrmBBCipherFinal(ckey: CipherKey): number {
  ckey.key.fill(0);
  ckey.type = 0;
  ckey.seed = 0;
  return 0;
}

// ── PGD_DESC ─────────────────────────────────────────────────────────

export interface PgdDesc {
  vkey: Uint8Array;    // 16
  dkey: Uint8Array;    // 16
  openFlag: number;
  keyIndex: number;
  drmType: number;
  macType: number;
  cipherType: number;
  dataSize: number;
  alignSize: number;
  blockSize: number;
  blockNr: number;
  dataOffset: number;
  tableOffset: number;
  blockBuf: Uint8Array;
  currentBlock: number;
  fileOffset: number;
}

// ── pgd_open / pgd_decrypt_block / pgd_close ─────────────────────────

export function pgdOpen(kirk: KirkState, pgdBuf: Uint8Array, pgdBufOff: number, pgdFlag: number, pgdVkey: Uint8Array | null): PgdDesc | null {
  const pgd: PgdDesc = {
    vkey: new Uint8Array(16),
    dkey: new Uint8Array(16),
    openFlag: 0,
    keyIndex: readU32LE(pgdBuf, pgdBufOff + 4),
    drmType: readU32LE(pgdBuf, pgdBufOff + 8),
    macType: 0,
    cipherType: 0,
    dataSize: 0,
    alignSize: 0,
    blockSize: 0,
    blockNr: 0,
    dataOffset: 0,
    tableOffset: 0,
    blockBuf: new Uint8Array(0),
    currentBlock: -1,
    fileOffset: 0,
  };

  if (pgd.drmType === 1) {
    pgd.macType = 1;
    pgdFlag |= 4;
    if (pgd.keyIndex > 1) {
      pgd.macType = 3;
      pgdFlag |= 8;
    }
    pgd.cipherType = 1;
  } else {
    pgd.macType = 2;
    pgd.cipherType = 2;
  }
  pgd.openFlag = pgdFlag;

  // select fixed key
  let fkey: Uint8Array | null = null;
  if (pgdFlag & 2) fkey = dnas_key1A90;
  if (pgdFlag & 1) fkey = dnas_key1AA0;
  if (!fkey) return null;

  // MAC_0x80 check
  const mkey: MacKey = { type: 0, key: new Uint8Array(16), pad: new Uint8Array(16), padSize: 0 };
  sceDrmBBMacInit(mkey, pgd.macType);
  sceDrmBBMacUpdate(kirk, mkey, pgdBuf, pgdBufOff, 0x80);
  let ret = sceDrmBBMacFinal2(kirk, mkey, pgdBuf, pgdBufOff + 0x80, fkey);
  if (ret) return null;

  // MAC_0x70
  sceDrmBBMacInit(mkey, pgd.macType);
  sceDrmBBMacUpdate(kirk, mkey, pgdBuf, pgdBufOff, 0x70);
  if (pgdVkey) {
    ret = sceDrmBBMacFinal2(kirk, mkey, pgdBuf, pgdBufOff + 0x70, pgdVkey);
    if (ret) return null;
    pgd.vkey.set(pgdVkey);
  } else {
    bbmacGetkey(kirk, mkey, pgdBuf, pgdBufOff + 0x70, pgd.vkey);
  }

  // decrypt PGD descriptor (0x30 bytes at offset 0x30)
  const ckey: CipherKey = { type: 0, seed: 0, key: new Uint8Array(16) };
  sceDrmBBCipherInit(kirk, ckey, pgd.cipherType, 2, pgdBuf, pgdBufOff + 0x10, pgd.vkey, 0);
  sceDrmBBCipherUpdate(kirk, ckey, pgdBuf, pgdBufOff + 0x30, 0x30);
  sceDrmBBCipherFinal(ckey);

  pgd.dataSize = readU32LE(pgdBuf, pgdBufOff + 0x44);
  pgd.blockSize = readU32LE(pgdBuf, pgdBufOff + 0x48);
  pgd.dataOffset = readU32LE(pgdBuf, pgdBufOff + 0x4c);
  pgd.dkey.set(pgdBuf.subarray(pgdBufOff + 0x30, pgdBufOff + 0x30 + 16));

  pgd.alignSize = (pgd.dataSize + 15) & ~15;
  pgd.tableOffset = pgd.dataOffset + pgd.alignSize;
  pgd.blockNr = ((pgd.alignSize + pgd.blockSize - 1) & ~(pgd.blockSize - 1)) / pgd.blockSize;

  pgd.fileOffset = 0;
  pgd.currentBlock = -1;
  pgd.blockBuf = new Uint8Array(pgd.blockSize * 2);

  return pgd;
}

export function pgdDecryptBlock(kirk: KirkState, pgd: PgdDesc, block: number): number {
  const blockOffset = block * pgd.blockSize;
  const ckey: CipherKey = { type: 0, seed: 0, key: new Uint8Array(16) };
  sceDrmBBCipherInit(kirk, ckey, pgd.cipherType, 2, pgd.dkey, 0, pgd.vkey, blockOffset >>> 4);
  sceDrmBBCipherUpdate(kirk, ckey, pgd.blockBuf, 0, pgd.blockSize);
  sceDrmBBCipherFinal(ckey);
  return pgd.blockSize;
}

// ── sceNpDrmGetFixedKey (amctrl.c:556-592) ───────────────────────────

export function sceNpDrmGetFixedKey(kirk: KirkState, key: Uint8Array, keyOff: number, npstr: string, type: number): number {
  if ((type & 0x01000000) === 0) return 0x80550901;
  type &= 0x000000ff;

  const strbuf = new Uint8Array(0x30);
  const enc = new TextEncoder();
  const strBytes = enc.encode(npstr);
  strbuf.set(strBytes.subarray(0, Math.min(strBytes.length, 0x30)));

  const mkey: MacKey = { type: 0, key: new Uint8Array(16), pad: new Uint8Array(16), padSize: 0 };
  let ret = sceDrmBBMacInit(mkey, 1);
  if (ret) return ret;
  ret = sceDrmBBMacUpdate(kirk, mkey, strbuf, 0, 0x30);
  if (ret) return ret;
  ret = sceDrmBBMacFinal(kirk, mkey, key, keyOff, key_363C);
  if (ret) return 0x80550902;

  if (type === 0) return 0;
  if (type > 3) return 0x80550901;
  const off = (type - 1) * 16;

  const akey = aesCreateCtx();
  aesSetKey(akey, key_357C, off, 128);
  aesEncryptBlock(akey, key, keyOff, key, keyOff);
  return 0;
}
