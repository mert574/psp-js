/**
 * KIRK crypto engine — faithful port of PPSSPP ext/libkirk/kirk_engine.c
 * Only the commands needed for PGD decryption: CMD4, CMD5, CMD7, CMD8, CMD11, CMD14, init.
 */

import { type AESCtx, aesCreateCtx, aesSetKey, aesCbcEncrypt, aesCbcDecrypt } from "./aes.js";
import { shaInit, shaUpdate, shaFinal } from "./sha1.js";
import { keyvault } from "./kirk-keys.js";

// ── Error codes ──────────────────────────────────────────────────────
export const KIRK_OPERATION_SUCCESS = 0;
export const KIRK_NOT_INITIALIZED = 0xc;
export const KIRK_INVALID_MODE = 2;
export const KIRK_INVALID_SIZE = 0xf;
export const KIRK_DATA_SIZE_ZERO = 0x10;

// ── KIRK mode constants ──────────────────────────────────────────────
const KIRK_MODE_ENCRYPT_CBC = 4;
const KIRK_MODE_DECRYPT_CBC = 5;

// ── KIRK command numbers ─────────────────────────────────────────────
const KIRK_CMD_ENCRYPT_IV_0 = 4;
// CMD 5 (ENCRYPT_IV_FUSE) and 8 (DECRYPT_IV_FUSE) intentionally not implemented
const KIRK_CMD_DECRYPT_IV_0 = 7;
const KIRK_CMD_SHA1_HASH = 11;
const KIRK_CMD_PRNG = 14;

// ── Static keys ──────────────────────────────────────────────────────
const kirk1_key = new Uint8Array([0x98, 0xc9, 0x40, 0x97, 0x5c, 0x1d, 0x10, 0xe8, 0x7f, 0xe6, 0x0e, 0xa3, 0xfd, 0x03, 0xa8, 0xba]);
const random_data = new Uint8Array([0xa7, 0x2e, 0x4c, 0xb6, 0xc3, 0x34, 0xdf, 0x85, 0x70, 0x01, 0x49, 0xfc, 0xc0, 0x87, 0xc4, 0x77]);
const random_key = new Uint8Array([0x07, 0xab, 0xef, 0xf8, 0x96, 0x8c, 0xf3, 0xd6, 0x14, 0xe0, 0xeb, 0xb2, 0x9d, 0x8b, 0x4e, 0x74]);

// ── KIRK_AES128CBC_HEADER layout ─────────────────────────────────────
// offset 0:  mode    (i32)
// offset 4:  unk_4   (i32)
// offset 8:  unk_8   (i32)
// offset 12: keyseed (i32)
// offset 16: data_size (i32)
const KIRK_AES_HDR_SIZE = 0x14; // 20 bytes

function readI32LE(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) | 0;
}

function writeI32LE(buf: Uint8Array, off: number, val: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
  buf[off + 2] = (val >>> 16) & 0xff;
  buf[off + 3] = (val >>> 24) & 0xff;
}

// ── KIRK state ───────────────────────────────────────────────────────

export interface KirkState {
  g_fuse90: number;
  g_fuse94: number;
  aes_kirk1: AESCtx;
  PRNG_DATA: Uint8Array; // 0x14 bytes
  kirk_buf: Uint8Array;  // 0x0814 bytes
  is_initialized: boolean;
}

export function kirkCreate(): KirkState {
  return {
    g_fuse90: 0,
    g_fuse94: 0,
    aes_kirk1: aesCreateCtx(),
    PRNG_DATA: new Uint8Array(0x14),
    kirk_buf: new Uint8Array(0x0814),
    is_initialized: false,
  };
}

// ── Key vault lookup ─────────────────────────────────────────────────

function kirk47GetKey(keyType: number): Uint8Array | null {
  if (keyType < 0 || keyType >= 0x80) return null;
  return keyvault[keyType]!;
}

// ── CMD11: SHA1 hash ─────────────────────────────────────────────────

function kirkCMD11(kirk: KirkState, outbuff: Uint8Array, outOff: number, inbuff: Uint8Array, inOff: number, inSize: number): number {
  // KIRK_SHA1_HEADER: u32 data_size at offset 0
  const dataSize = readI32LE(inbuff, inOff);
  if (dataSize === 0 || inSize === 0) return KIRK_DATA_SIZE_ZERO;

  const sha = shaInit();
  shaUpdate(sha, inbuff, inOff + 4, dataSize);
  shaFinal(outbuff, outOff, sha);
  return KIRK_OPERATION_SUCCESS;
}

// ── CMD4: AES-128-CBC encrypt (IV=0) ─────────────────────────────────

function kirkCMD4(kirk: KirkState, outbuff: Uint8Array, inbuff: Uint8Array, inOff: number, _inSize: number): number {
  if (!kirk.is_initialized) return KIRK_NOT_INITIALIZED;
  const mode = readI32LE(inbuff, inOff);
  const keyseed = readI32LE(inbuff, inOff + 12);
  const dataSize = readI32LE(inbuff, inOff + 16);
  if (mode !== KIRK_MODE_ENCRYPT_CBC) return KIRK_INVALID_MODE;
  if (dataSize === 0) return KIRK_DATA_SIZE_ZERO;

  const key = kirk47GetKey(keyseed);
  if (!key) return KIRK_INVALID_SIZE;

  const ctx = aesCreateCtx();
  aesSetKey(ctx, key, 0, 128);
  aesCbcEncrypt(ctx, inbuff, inOff + KIRK_AES_HDR_SIZE, outbuff, inOff + KIRK_AES_HDR_SIZE, dataSize);
  return KIRK_OPERATION_SUCCESS;
}

// ── CMD5/CMD8: fuse-based IV variants ─────────────────────────────────
// PPSSPP's kirk_engine.c does NOT implement CMD5/CMD8 — they're not in the switch,
// so kirkSceUtilsBufferCopyWithRange returns -1 for these commands.
// PPSSPP's sceChnnlsv.cpp:118 explicitly notes: "CMD 5 and 8 are not available"
// This means amctrl.c's kirk5()/kirk8() always fail (return 0x80510312).
// Consequence: pgd_open() fails for drm_type==2 (mac_type==2) PGD files,
// which is the common case. Games work because ISOs typically have DRM stripped.
// We match PPSSPP's behavior exactly: return -1 → amctrl returns error → pgd_open fails.

// ── CMD7: AES-128-CBC decrypt (IV=0) ─────────────────────────────────

function kirkCMD7(kirk: KirkState, outbuff: Uint8Array, outOff: number, inbuff: Uint8Array, inOff: number, _inSize: number): number {
  if (!kirk.is_initialized) return KIRK_NOT_INITIALIZED;
  const mode = readI32LE(inbuff, inOff);
  const keyseed = readI32LE(inbuff, inOff + 12);
  const dataSize = readI32LE(inbuff, inOff + 16);
  if (mode !== KIRK_MODE_DECRYPT_CBC) return KIRK_INVALID_MODE;
  if (dataSize === 0) return KIRK_DATA_SIZE_ZERO;

  const key = kirk47GetKey(keyseed);
  if (!key) return KIRK_INVALID_SIZE;

  const ctx = aesCreateCtx();
  aesSetKey(ctx, key, 0, 128);
  aesCbcDecrypt(ctx, inbuff, inOff + KIRK_AES_HDR_SIZE, outbuff, outOff, dataSize);
  return KIRK_OPERATION_SUCCESS;
}

// kirkCMD8 intentionally not implemented — see CMD5/CMD8 comment above

// ── CMD14: PRNG ──────────────────────────────────────────────────────

function kirkCMD14(kirk: KirkState, outbuff: Uint8Array, outOff: number, outsize: number): number {
  if (outsize <= 0) return KIRK_OPERATION_SUCCESS;

  const temp = new Uint8Array(0x104);
  temp.fill(0xaa);
  // KIRK_SHA1_HEADER at temp[0..3] = data_size
  temp.set(kirk.PRNG_DATA, 4);
  const curtime = (Date.now() / 1000) >>> 0;
  temp[0x18] = curtime & 0xff;
  temp[0x19] = (curtime >>> 8) & 0xff;
  temp[0x1a] = (curtime >>> 16) & 0xff;
  temp[0x1b] = (curtime >>> 24) & 0xff;
  temp.set(random_data, 0x1c);

  // data_size = 0x100
  writeI32LE(temp, 0, 0x100);
  kirkCMD11(kirk, kirk.PRNG_DATA, 0, temp, 0, 0x104);

  let remaining = outsize;
  let off = outOff;
  while (remaining > 0) {
    const blockrem = remaining % 0x14;
    const block = (remaining / 0x14) | 0;
    if (block) {
      outbuff.set(kirk.PRNG_DATA, off);
      off += 0x14;
      remaining -= 0x14;
      kirkCMD14(kirk, outbuff, off, remaining);
      return KIRK_OPERATION_SUCCESS; // recursive call handles rest
    } else if (blockrem) {
      outbuff.set(kirk.PRNG_DATA.subarray(0, blockrem), off);
      remaining -= blockrem;
    }
  }
  return KIRK_OPERATION_SUCCESS;
}

// ── Init ─────────────────────────────────────────────────────────────

export function kirkInit(kirk: KirkState): void {
  kirkInit2(kirk, new TextEncoder().encode("Lazy Dev should have initialized!"), 0xbabef00d, 0xdeadbeef);
}

export function kirkInit2(kirk: KirkState, rndSeed: Uint8Array, fuseid90: number, fuseid94: number): void {
  const temp = new Uint8Array(0x104);
  temp.fill(0xaa);

  if (rndSeed.length > 0) {
    const seedbuf = new Uint8Array(rndSeed.length + 4);
    writeI32LE(seedbuf, 0, rndSeed.length);
    seedbuf.set(rndSeed, 4); // This doesn't match C exactly but close enough for PRNG seeding
    // Actually the C code sets seedheader->data_size = seed_size, and the data follows at offset 4
    kirkCMD11(kirk, kirk.PRNG_DATA, 0, seedbuf, 0, seedbuf.length);
  }

  temp.set(kirk.PRNG_DATA, 4);
  const curtime = (Date.now() / 1000) >>> 0;
  temp[0x18] = curtime & 0xff;
  temp[0x19] = (curtime >>> 8) & 0xff;
  temp[0x1a] = (curtime >>> 16) & 0xff;
  temp[0x1b] = (curtime >>> 24) & 0xff;
  temp.set(random_key, 0x1c);
  writeI32LE(temp, 0, 0x100);
  kirkCMD11(kirk, kirk.PRNG_DATA, 0, temp, 0, 0x104);

  kirk.g_fuse90 = fuseid90;
  kirk.g_fuse94 = fuseid94;

  aesSetKey(kirk.aes_kirk1, kirk1_key, 0, 128);
  kirk.is_initialized = true;
}

// ── Dispatcher (sceUtilsBufferCopyWithRange) ─────────────────────────

export function kirkSceUtilsBufferCopyWithRange(
  kirk: KirkState,
  outbuff: Uint8Array, _outsize: number,
  inbuff: Uint8Array, insize: number,
  cmd: number
): number {
  switch (cmd) {
    case KIRK_CMD_ENCRYPT_IV_0:
      return kirkCMD4(kirk, outbuff, inbuff, 0, insize);
    // CMD5/CMD8 (fuse-based) intentionally not implemented — matches PPSSPP
    case KIRK_CMD_DECRYPT_IV_0:
      return kirkCMD7(kirk, outbuff, 0, inbuff, 0, insize);
    case KIRK_CMD_SHA1_HASH:
      return kirkCMD11(kirk, outbuff, 0, inbuff, 0, insize);
    case KIRK_CMD_PRNG:
      return kirkCMD14(kirk, outbuff, 0, _outsize);
    default:
      return -1;
  }
}
