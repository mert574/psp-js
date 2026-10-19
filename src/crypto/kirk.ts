/** KIRK command adapter for CBC, SHA-1 and random-byte operations. */
import { aesCreateCtx, aesSetKey, aesCbcEncrypt, aesCbcDecrypt } from "./aes.js";
import { shaInit, shaUpdate, shaFinal } from "./sha1.js";
import { keyvault } from "./kirk-keys.js";
export const KIRK_OPERATION_SUCCESS = 0;
export const KIRK_NOT_INITIALIZED = 0xc;
export const KIRK_INVALID_MODE = 2;
export const KIRK_INVALID_SIZE = 0xf;
export const KIRK_DATA_SIZE_ZERO = 0x10;
export interface KirkState {
  is_initialized: boolean;
  kirk_buf: Uint8Array;
}
export function kirkCreate(): KirkState {
  return { is_initialized: false, kirk_buf: new Uint8Array(0x814) };
}
export function kirkInit(kirk: KirkState): void { kirk.is_initialized = true; }
export function kirkSceUtilsBufferCopyWithRange(
  kirk: KirkState, output: Uint8Array, outputSize: number,
  input: Uint8Array, inputSize: number, command: number,
): number {
  if (command === 14) {
    if (outputSize < 0 || outputSize > output.length) return KIRK_INVALID_SIZE;
    // Device entropy has no deterministic reference-emulator seed or filler.
    for (let at = 0; at < outputSize; at += 65536) {
      const bytes = new Uint8Array(Math.min(65536, outputSize - at));
      crypto.getRandomValues(bytes);
      output.set(bytes, at);
    }
    return KIRK_OPERATION_SUCCESS;
  }
  if (command === 11) {
    if (inputSize < 4 || input.length < 4) return KIRK_INVALID_SIZE;
    const count = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(0, true);
    if (!count) return KIRK_DATA_SIZE_ZERO;
    if (count > inputSize - 4 || count > input.length - 4 || outputSize < 20 || output.length < 20) return KIRK_INVALID_SIZE;
    const hash = shaInit();
    shaUpdate(hash, input, 4, count);
    shaFinal(output, 0, hash);
    return KIRK_OPERATION_SUCCESS;
  }
  if (command !== 4 && command !== 7) return -1; // Fuse-key commands are unsupported.
  if (!kirk.is_initialized) return KIRK_NOT_INITIALIZED;
  if (inputSize < 0 || input.length < 20) return KIRK_INVALID_SIZE;
  const header = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (header.getUint32(0, true) !== (command === 4 ? 4 : 5)) return KIRK_INVALID_MODE;
  const key = keyvault[header.getUint32(12, true)];
  const count = header.getUint32(16, true);
  if (!count) return KIRK_DATA_SIZE_ZERO;
  const at = command === 4 ? 20 : 0;
  // Existing callers pass payload length in inputSize, excluding the header.
  if (!key || count % 16 || count > input.length - 20 || count + at > output.length) return KIRK_INVALID_SIZE;
  const cipher = aesCreateCtx();
  aesSetKey(cipher, key, 0, 128);
  const source = input.slice(20, 20 + count); // Preserve overlapping input/output.
  if (command === 4) aesCbcEncrypt(cipher, source, 0, output, at, count);
  else aesCbcDecrypt(cipher, source, 0, output, at, count);
  return KIRK_OPERATION_SUCCESS;
}
