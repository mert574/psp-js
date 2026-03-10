import { describe, it, expect } from "vitest";
import { pspDecryptPRX } from "./prx-decrypter.js";
import { kirk7, kirk4, aesCbcEncrypt, aesCbcDecrypt } from "./kirk.js";

describe("kirk7 / kirk4 round-trip", () => {
  it("kirk4 then kirk7 recovers plaintext", async () => {
    const plaintext = new Uint8Array(32);
    for (let i = 0; i < 32; i++) plaintext[i] = i * 3;

    const encrypted = await kirk4(plaintext, 0x63); // keyId = 0x63
    const decrypted = await kirk7(encrypted, 0x63);

    expect(decrypted).toEqual(plaintext);
  });

  it("kirk7 with different key produces different output", async () => {
    const data = new Uint8Array(16).fill(0xAB);

    const a = await kirk7(data.slice(), 0x01);
    const b = await kirk7(data.slice(), 0x02);

    expect(a).not.toEqual(b);
  });
});

describe("aesCbcDecrypt non-aligned", () => {
  it("round-trips aligned data (32 bytes)", async () => {
    const key = new Uint8Array(16).fill(0x42);
    const plain = new Uint8Array(32);
    for (let i = 0; i < 32; i++) plain[i] = i;
    const enc = await aesCbcEncrypt(plain, key);
    const dec = await aesCbcDecrypt(enc, key);
    expect(dec).toEqual(plain);
  });

  it("handles non-aligned data (33 bytes) without throwing", async () => {
    const key = new Uint8Array(16).fill(0x42);
    const plain = new Uint8Array(33);
    for (let i = 0; i < 33; i++) plain[i] = i;
    const enc = await aesCbcEncrypt(plain.slice(0, 32), key);
    // Create 33-byte ciphertext: 32 encrypted bytes + 1 trailing byte
    const nonAligned = new Uint8Array(33);
    nonAligned.set(enc);
    nonAligned[32] = 0xFF;
    const dec = await aesCbcDecrypt(nonAligned, key);
    expect(dec.length).toBe(33);
    // First 32 bytes should match original plaintext
    expect(dec.slice(0, 32)).toEqual(plain.slice(0, 32));
    // Trailing byte preserved as-is
    expect(dec[32]).toBe(0xFF);
  });

  it("handles empty data", async () => {
    const key = new Uint8Array(16).fill(0x42);
    const dec = await aesCbcDecrypt(new Uint8Array(0), key);
    expect(dec.length).toBe(0);
  });

  it("handles sub-block data (< 16 bytes)", async () => {
    const key = new Uint8Array(16).fill(0x42);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const dec = await aesCbcDecrypt(data, key);
    // No full blocks to decrypt; returned as-is
    expect(dec).toEqual(data);
  });
});

describe("pspDecryptPRX", () => {
  it("returns null for random data (no valid tag)", async () => {
    const garbage = new Uint8Array(0x200);
    crypto.getRandomValues(garbage);
    // Set ~PSP magic won't matter — pspDecryptPRX doesn't check magic, it checks tags
    const result = await pspDecryptPRX(garbage);
    expect(result).toBeNull();
  });

  it("returns null for too-small input", async () => {
    const small = new Uint8Array(16);
    const result = await pspDecryptPRX(small);
    expect(result).toBeNull();
  });

  it("returns null for zeroed 0x200-byte buffer (tag 0x00000000 but invalid SHA1)", async () => {
    // Tag 0x00000000 exists in g_tagInfo (g_key0, code 0x42)
    // But the SHA1 verification should fail since data is all zeros
    const buf = new Uint8Array(0x200);
    const result = await pspDecryptPRX(buf);
    expect(result).toBeNull();
  });
});
