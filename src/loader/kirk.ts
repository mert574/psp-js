/** PSP KIRK private-block and key-vault operations. */
import { aesCreateCtx, aesSetKey, aesCbcEncrypt as encrypt, aesCbcDecrypt as decrypt, aesCmac as cmac } from "../crypto/aes.js";
export { keyvault } from "../crypto/kirk-keys.js";
import { keyvault } from "../crypto/kirk-keys.js";
export const kirk1_key = Uint8Array.of(0x98,0xc9,0x40,0x97,0x5c,0x1d,0x10,0xe8,0x7f,0xe6,0x0e,0xa3,0xfd,0x03,0xa8,0xba);
export const kirk16_key = Uint8Array.of(0x47,0x5e,0x09,0xf4,0xa2,0x37,0xda,0x9b,0xef,0xff,0x3b,0xc0,0x77,0x14,0x3d,0x8a);
const ZERO = new Uint8Array(16);
async function cbc(data: Uint8Array, key: Uint8Array, iv: Uint8Array, encode: boolean): Promise<Uint8Array> {
  if (iv.length !== 16) throw new RangeError("CBC IV must have 16 bytes");
  const length = data.length - data.length % 16;
  const ctx = aesCreateCtx();
  aesSetKey(ctx, key, 0, key.length * 8);
  const output = data.slice();
  const source = data.slice(0, length);
  if (encode) {
    for (let i = 0; i < Math.min(16, length); i++) source[i]! ^= iv[i]!;
    encrypt(ctx, source, 0, output, 0, length);
  } else {
    decrypt(ctx, source, 0, output, 0, length);
    for (let i = 0; i < Math.min(16, length); i++) output[i]! ^= iv[i]!;
  }
  return output;
}
export function aesCbcDecrypt(data: Uint8Array, key: Uint8Array, iv = ZERO): Promise<Uint8Array> { return cbc(data, key, iv, false); }
export function aesCbcEncrypt(data: Uint8Array, key: Uint8Array, iv = ZERO): Promise<Uint8Array> { return cbc(data, key, iv, true); }
export async function aesCmac(data: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const ctx = aesCreateCtx();
  aesSetKey(ctx, key, 0, key.length * 8);
  const output = new Uint8Array(16);
  cmac(ctx, data, 0, data.length, output, 0);
  return output;
}
function vaultKey(id: number): Uint8Array {
  const key = keyvault[id];
  if (!key) throw new RangeError(`Unknown KIRK key slot ${id}`);
  return key;
}
export function kirk7(data: Uint8Array, id: number): Promise<Uint8Array> { return aesCbcDecrypt(data, vaultKey(id)); }
export function kirk4(data: Uint8Array, id: number): Promise<Uint8Array> { return aesCbcEncrypt(data, vaultKey(id)); }
interface PrivatePacket { header: Uint8Array; size: number; offset: number; payloadEnd: number; cmacEnd: number }
function packet(input: Uint8Array): PrivatePacket {
  if (input.length < 0x90) throw new RangeError("KIRK packet header is truncated");
  const header = input.slice(0, 0x90);
  const view = new DataView(header.buffer);
  const size = view.getUint32(0x70, true);
  const offset = view.getUint32(0x74, true);
  const payloadEnd = 0x90 + offset + size;
  const cmacEnd = 0x90 + offset + Math.ceil(size / 16) * 16;
  if (payloadEnd > input.length) throw new RangeError("KIRK payload is truncated");
  return { header, size, offset, payloadEnd, cmacEnd };
}
async function authentic(input: Uint8Array, p: PrivatePacket, key: Uint8Array): Promise<boolean> {
  if (p.cmacEnd > input.length) return false;
  for (const [start, end, expected] of [[0x60, 0x90, 0x20], [0x60, p.cmacEnd, 0x30]]) {
    const tag = await aesCmac(input.subarray(start, end), key);
    if (!tag.every((byte, i) => byte === p.header[expected! + i])) return false;
  }
  return true;
}
export async function kirkCMD1(input: Uint8Array): Promise<Uint8Array> {
  const p = packet(input);
  const keys = await aesCbcDecrypt(p.header.subarray(0, 32), kirk1_key);
  if (new DataView(p.header.buffer).getUint32(0x60, true) === 1 && !await authentic(input, p, keys.subarray(16))) {
    throw new Error("KIRK packet authentication failed");
  }
  return aesCbcDecrypt(input.subarray(0x90 + p.offset, p.payloadEnd), keys.subarray(0, 16));
}
export async function kirkCMD10(input: Uint8Array): Promise<boolean> {
  try {
    const p = packet(input);
    const keys = await aesCbcDecrypt(p.header.subarray(0, 32), kirk1_key);
    return authentic(input, p, keys.subarray(16));
  } catch { return false; }
}
