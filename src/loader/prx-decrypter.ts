/** PRX decoding expressed as two packet-layout pipelines (legacy and modern). */
import { kirk7, kirkCMD1 } from "./kirk.js";
import { legacyTags, modernTags } from "./prx-key-data.js";
import { shaInit, shaUpdate, shaFinal } from "../crypto/sha1.js";
const word = (bytes: Uint8Array, at: number): number => new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(at, true);
function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, p) => size + p.length, 0));
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}
function mask(bytes: Uint8Array, key: Uint8Array, offset = 0): Uint8Array {
  return bytes.map((byte, i) => byte ^ key[(i + offset) % key.length]!);
}
function digest(bytes: Uint8Array): Uint8Array {
  const state = shaInit(), result = new Uint8Array(20);
  shaUpdate(state, bytes, 0, bytes.length); shaFinal(result, 0, state); return result;
}
function verify(bytes: Uint8Array, expected: Uint8Array): void {
  if (!digest(bytes).every((byte, i) => byte === expected[i])) throw new Error("PRX digest mismatch");
}
async function finish(source: Uint8Array, header: Uint8Array): Promise<Uint8Array> {
  const packet = source.slice(0x40);
  packet.set(header);
  packet.set(source.subarray(0, 0x80), 0x90);
  const decoded = await kirkCMD1(packet);
  const size = word(source, 0xb0);
  if (size > decoded.length) throw new Error("PRX payload size exceeds decoded data");
  return decoded.slice(0, size);
}
async function legacy(source: Uint8Array, record: typeof legacyTags[number], wrapped: boolean): Promise<Uint8Array> {
  const state = join(source.slice(0xd4, 0xe8), source.slice(0xe8, 0x110), source.slice(0x110, 0x150), source.slice(0x80, 0xd0));
  if (wrapped) state.set(await kirk7(state.slice(12, 12 + 0xa0), record.code), 12);
  verify(join(record.key.slice(0, 20), state.subarray(20), source.subarray(0, 0x80)), state.subarray(0, 20));
  const header = state.slice(60);
  const decrypted = await kirk7(mask(header.subarray(0, 0x70), record.key, 0x14), record.code);
  header.set(mask(decrypted, record.key, 0x20));
  return finish(source, header);
}
async function modern(source: Uint8Array, record: typeof modernTags[number], kind: 2 | 5 | 6, bonus?: Uint8Array): Promise<Uint8Array> {
  const reservedEnd = kind === 6 ? 0x10c : 0x12c;
  if (source.subarray(kind === 5 ? 0xd5 : 0xd4, reservedEnd).some(byte => byte !== 0)) throw new Error("PRX reserved bytes are nonzero");
  const seed = new Uint8Array(0x90);
  for (let block = 0; block < 9; block++) { seed.set(record.key, block * 16); seed[block * 16] = block; }
  let expanded = await kirk7(seed, record.code);
  if (kind === 5 && bonus) expanded = mask(expanded, bonus);
  let header = join(source.slice(0x80, 0xb0), source.slice(0xc0, 0xd0));
  const expected = source.slice(0x12c, 0x140);
  if (kind === 5) {
    let wrapped = join(header, expected.subarray(0, 16));
    if (record.seed) wrapped = mask(wrapped, record.seed);
    if (bonus) wrapped = mask(wrapped, bonus);
    const decoded = await kirk7(wrapped, record.code);
    header = decoded.slice(0, 64); expected.set(decoded.subarray(64), 0);
  }
  const identity = join(source.slice(0x140, 0x150), expected, header);
  let wrapped: Uint8Array = identity.slice(0, 0x60);
  if (kind === 5 && record.seed) wrapped = mask(wrapped, record.seed);
  identity.set(await kirk7(wrapped, record.code));
  header = identity.slice(36);
  const signature = kind === 6 ? source.slice(0x10c, 0x12c) : new Uint8Array();
  verify(join(source.subarray(0xd0, 0xd4), expanded.subarray(0, 16), new Uint8Array(kind === 6 ? 0x38 : 0x58), signature,
    identity.subarray(0, 16), header, source.subarray(0xb0, 0xc0), source.subarray(0, 0x80)), identity.subarray(16, 36));
  const packetHeader = new Uint8Array(0x90);
  if (kind === 6) { packetHeader.set(signature, 0x40); packetHeader[0x64] = 1; }
  packetHeader.set(source.subarray(0xb0, 0xc0), 0x70);
  packetHeader[0x60] = 1;
  packetHeader.set(mask(await kirk7(mask(header, expanded, 16), record.code), expanded, 80));
  return finish(source, packetHeader);
}
export async function pspDecryptPRX(source: Uint8Array, seed?: Uint8Array): Promise<Uint8Array | null> {
  if (source.length < 0x150 || (seed && seed.length !== 16)) return null;
  const tag = word(source, 0xd0);
  const older = legacyTags.find(record => record.tag === tag);
  const newer = modernTags.find(record => record.tag === tag);
  const candidates: Array<() => Promise<Uint8Array>> = [];
  if (older) for (const wrapped of [false, true]) candidates.push(() => legacy(source, older, wrapped));
  if (newer) for (const kind of [2, 5, 6] as const) candidates.push(() => modern(source, newer, kind, seed));
  for (const decode of candidates) { try { return await decode(); } catch { /* Try another packet layout. */ } }
  return null;
}
