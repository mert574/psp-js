/** PGD authentication and counter-stream decoding using AES-CMAC and CBC.
 * Format constants are separated from the implementation. No shared KIRK
 * workspace or streaming-MAC scratch-buffer pipeline is used here.
 */
import { aesCreateCtx, aesSetKey, aesCbcEncrypt, aesCbcDecrypt, aesCmac } from "./aes.js";
import { type KirkState } from "./kirk.js";
import { keyvault } from "./kirk-keys.js";
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

const read32 = (data: Uint8Array, at: number): number => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);
const xor = (left: Uint8Array, right: Uint8Array): Uint8Array => left.map((byte, i) => byte ^ right[i]!);
function cbc(data: Uint8Array, slot: number, decrypt: boolean): Uint8Array {
  const cipher = aesCreateCtx();
  aesSetKey(cipher, keyvault[slot]!, 0, 128);
  const output = new Uint8Array(data.length);
  if (decrypt) aesCbcDecrypt(cipher, data, 0, output, 0, data.length);
  else aesCbcEncrypt(cipher, data, 0, output, 0, data.length);
  return output;
}
function tag(data: Uint8Array, versionKey: Uint8Array | null): Uint8Array {
  const cipher = aesCreateCtx();
  aesSetKey(cipher, keyvault[0x38]!, 0, 128);
  const digest = new Uint8Array(16);
  aesCmac(cipher, data, 0, data.length, digest, 0);
  const masked = xor(digest, loc_1CD4);
  return versionKey ? cbc(xor(masked, versionKey), 0x38, false) : masked;
}
function storedTag(value: Uint8Array, mode: number): Uint8Array {
  return mode === 3 ? cbc(value, 0x63, true) : value;
}
function matches(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, i) => byte === right[i]);
}
function transform(data: Uint8Array, headerKey: Uint8Array, versionKey: Uint8Array, firstBlock: number): Uint8Array {
  const nonce = xor(cbc(xor(xor(headerKey, versionKey), loc_1CF4), 0x39, true), loc_1CE4);
  const counters = new Uint8Array(data.length);
  const view = new DataView(counters.buffer);
  for (let at = 0; at < data.length; at += 16) {
    counters.set(nonce.subarray(0, 12), at);
    view.setUint32(at + 12, firstBlock + at / 16 + 1, true);
  }
  const stream = cbc(counters, 0x63, true);
  if (firstBlock !== 0) {
    const previous = nonce.slice();
    new DataView(previous.buffer).setUint32(12, firstBlock, true);
    for (let i = 0; i < 16; i++) stream[i]! ^= previous[i]!;
  }
  return xor(data, stream);
}
export function pgdOpen(kirk: KirkState, buffer: Uint8Array, offset: number, flags: number, supplied: Uint8Array | null): PgdDesc | null {
  if (!kirk.is_initialized || offset < 0 || offset + 0x90 > buffer.length || (supplied && supplied.length !== 16)) return null;
  const header = buffer.slice(offset, offset + 0x90);
  const drmType = read32(header, 8);
  if (drmType !== 1) return null; // Fuse-bound PGD keys are not implemented.
  const keyIndex = read32(header, 4);
  const macType = keyIndex > 1 ? 3 : 1;
  const fixed = flags & 1 ? dnas_key1AA0 : flags & 2 ? dnas_key1A90 : null;
  if (!fixed || !matches(tag(header.subarray(0, 0x80), fixed), storedTag(header.subarray(0x80, 0x90), macType))) return null;
  const second = storedTag(header.subarray(0x70, 0x80), macType);
  const vkey = supplied?.slice() ?? xor(tag(header.subarray(0, 0x70), null), cbc(second, 0x38, true));
  if (supplied && !matches(tag(header.subarray(0, 0x70), supplied), second)) return null;
  const descriptor = transform(header.subarray(0x30, 0x60), header.subarray(0x10, 0x20), vkey, 0);
  const dataSize = read32(descriptor, 0x14);
  const blockSize = read32(descriptor, 0x18);
  const dataOffset = read32(descriptor, 0x1c);
  if (blockSize === 0 || blockSize % 16 || blockSize > 16 * 1024 * 1024) return null;
  const alignSize = Math.ceil(dataSize / 16) * 16;
  buffer.set(descriptor, offset + 0x30);
  return {
    vkey, dkey: descriptor.slice(0, 16), openFlag: flags | (macType === 3 ? 12 : 4), keyIndex, drmType,
    macType, cipherType: 1, dataSize, alignSize, blockSize, blockNr: Math.ceil(alignSize / blockSize),
    dataOffset, tableOffset: dataOffset + alignSize, blockBuf: new Uint8Array(blockSize * 2), currentBlock: -1, fileOffset: 0,
  };
}
export function pgdDecryptBlock(kirk: KirkState, pgd: PgdDesc, block: number): number {
  if (!kirk.is_initialized || pgd.cipherType !== 1 || block < 0 || !Number.isInteger(block) || pgd.blockSize % 16) return -1;
  const decoded = transform(pgd.blockBuf.subarray(0, pgd.blockSize), pgd.dkey, pgd.vkey, block * pgd.blockSize / 16);
  pgd.blockBuf.set(decoded);
  return pgd.blockSize;
}
export function sceNpDrmGetFixedKey(kirk: KirkState, output: Uint8Array, offset: number, name: string, type: number): number {
  if (!(type & 0x1000000)) return 0x80550901;
  if (!kirk.is_initialized) return 0x80510311;
  const input = new Uint8Array(48);
  input.set(new TextEncoder().encode(name).subarray(0, 48));
  const derived = tag(input, key_363C);
  output.set(derived, offset);
  const variant = type & 0xff;
  if (variant === 0) return 0;
  if (variant > 3) return 0x80550901;
  const cipher = aesCreateCtx();
  aesSetKey(cipher, key_357C, (variant - 1) * 16, 128);
  aesCbcEncrypt(cipher, derived, 0, output, offset, 16);
  return 0;
}
