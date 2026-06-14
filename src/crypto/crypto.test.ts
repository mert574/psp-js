/**
 * Tests for the KIRK crypto engine port.
 * SHA1 and AES test vectors from NIST/RFC standards.
 */

import { describe, it, expect } from "vitest";
import { shaInit, shaUpdate, shaFinal } from "./sha1.js";
import { aesCreateCtx, aesSetKey, aesEncryptBlock, aesDecryptBlock, aesCbcEncrypt, aesCbcDecrypt, aesCmac } from "./aes.js";
import { kirkCreate, kirkInit } from "./kirk.js";

// ── SHA1 tests (RFC 3174 test vectors) ───────────────────────────────

describe("SHA1", () => {
  function sha1hex(data: Uint8Array): string {
    const ctx = shaInit();
    shaUpdate(ctx, data, 0, data.length);
    const out = new Uint8Array(20);
    shaFinal(out, 0, ctx);
    return Array.from(out).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  it("hashes empty string", () => {
    expect(sha1hex(new Uint8Array(0))).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  it("hashes 'abc'", () => {
    const data = new TextEncoder().encode("abc");
    expect(sha1hex(data)).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  it("hashes 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'", () => {
    const data = new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq");
    expect(sha1hex(data)).toBe("84983e441c3bd26ebaae4aa1f95129e5e54670f1");
  });
});

// ── AES tests (NIST FIPS 197 test vectors) ───────────────────────────

describe("AES-128", () => {
  function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  it("encrypts NIST FIPS 197 Appendix B test vector", () => {
    // Key: 2b7e151628aed2a6abf7158809cf4f3c
    // Plaintext: 3243f6a8885a308d313198a2e0370734
    // Expected: 3925841d02dc09fbdc118597196a0b32
    const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");
    const pt = hexToBytes("3243f6a8885a308d313198a2e0370734");
    const ctx = aesCreateCtx();
    aesSetKey(ctx, key, 0, 128);
    const ct = new Uint8Array(16);
    aesEncryptBlock(ctx, pt, 0, ct, 0);
    expect(bytesToHex(ct)).toBe("3925841d02dc09fbdc118597196a0b32");
  });

  it("decrypts back to plaintext", () => {
    const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");
    const ct = hexToBytes("3925841d02dc09fbdc118597196a0b32");
    const ctx = aesCreateCtx();
    aesSetKey(ctx, key, 0, 128);
    const pt = new Uint8Array(16);
    aesDecryptBlock(ctx, ct, 0, pt, 0);
    expect(bytesToHex(pt)).toBe("3243f6a8885a308d313198a2e0370734");
  });

  it("CBC encrypt with IV=0 (KIRK style)", () => {
    // Two blocks of zeros encrypted with all-zero key
    const key = new Uint8Array(16);
    const pt = new Uint8Array(32);
    const ctx = aesCreateCtx();
    aesSetKey(ctx, key, 0, 128);
    const ct = new Uint8Array(32);
    aesCbcEncrypt(ctx, pt, 0, ct, 0, 32);
    // Block 1: E(0) = 66e94bd4ef8a2c3b884cfa59ca342b2e
    // Block 2: E(block1 ^ 0) = E(block1) — no XOR with IV since IV=0
    expect(bytesToHex(ct.subarray(0, 16))).toBe("66e94bd4ef8a2c3b884cfa59ca342b2e");
  });

  it("CBC decrypt roundtrips", () => {
    const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");
    const pt = new TextEncoder().encode("0123456789abcdef0123456789ABCDEF");
    const ctx = aesCreateCtx();
    aesSetKey(ctx, key, 0, 128);
    const ct = new Uint8Array(32);
    aesCbcEncrypt(ctx, pt, 0, ct, 0, 32);
    const dec = new Uint8Array(32);
    aesCbcDecrypt(ctx, ct, 0, dec, 0, 32);
    expect(dec).toEqual(pt);
  });

  it("CMAC (RFC 4493 test vector 1: empty message)", () => {
    const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");
    const ctx = aesCreateCtx();
    aesSetKey(ctx, key, 0, 128);
    const mac = new Uint8Array(16);
    aesCmac(ctx, new Uint8Array(0), 0, 0, mac, 0);
    expect(bytesToHex(mac)).toBe("bb1d6929e95937287fa37d129b756746");
  });

  it("CMAC (RFC 4493 test vector 2: 16-byte message)", () => {
    const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");
    const msg = hexToBytes("6bc1bee22e409f96e93d7e117393172a");
    const ctx = aesCreateCtx();
    aesSetKey(ctx, key, 0, 128);
    const mac = new Uint8Array(16);
    aesCmac(ctx, msg, 0, msg.length, mac, 0);
    expect(bytesToHex(mac)).toBe("070a16b46b4d4144f79bdd9dd04a287c");
  });

  it("CMAC (RFC 4493 test vector 3: 40-byte message)", () => {
    const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");
    const msg = hexToBytes("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411");
    const ctx = aesCreateCtx();
    aesSetKey(ctx, key, 0, 128);
    const mac = new Uint8Array(16);
    aesCmac(ctx, msg, 0, msg.length, mac, 0);
    expect(bytesToHex(mac)).toBe("dfa66747de9ae63030ca32611497c827");
  });

  it("CMAC (RFC 4493 test vector 4: 64-byte message)", () => {
    const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");
    const msg = hexToBytes("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710");
    const ctx = aesCreateCtx();
    aesSetKey(ctx, key, 0, 128);
    const mac = new Uint8Array(16);
    aesCmac(ctx, msg, 0, msg.length, mac, 0);
    expect(bytesToHex(mac)).toBe("51f0bebf7e3b9d92fc49741779363cfe");
  });
});

// ── KIRK init test ───────────────────────────────────────────────────

describe("KIRK", () => {
  it("initializes without error", () => {
    const kirk = kirkCreate();
    kirkInit(kirk);
    expect(kirk.is_initialized).toBe(true);
  });
});
