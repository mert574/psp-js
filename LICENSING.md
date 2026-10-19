# Source provenance

Original project code uses MIT. The maintainer describes PSP.js as an independent
reimplementation, with PPSSPP consulted for PSP behavior. Reference comments alone
are not treated as proof of copied code or as permission to copy it.

The comparison baseline is PPSSPP
[`ab1ee21996b78aaac1f82baa390990c8ce9a9936`](https://github.com/hrydgard/ppsspp/tree/ab1ee21996b78aaac1f82baa390990c8ce9a9936).

## Current implementations

| Area | Review result |
| --- | --- |
| `src/memory/block-allocator.ts` | Replaced the linked-list implementation with an ordered interval array. Alignment, fixed-address allocation, coalescing and save-state format have regression coverage. |
| `src/crypto/sha1.ts` | Replaced the SHA1.c-shaped implementation with a byte-buffer implementation of FIPS 180-4 section 6.1. Tests compare padding boundaries, sliced updates and a million-byte input with Node's crypto implementation. |
| `src/crypto/kirk.ts`, `src/loader/kirk.ts` | Replaced the command implementation and private-packet wrapper. Removed the reference emulator's default seed string, filler bytes and PRNG constants. Random bytes now come from the host. CBC, CMAC authentication, in-place buffers and malformed input are tested. |
| `src/crypto/amctrl.ts` | Replaced the shared-workspace helper pipeline with direct CMAC and counter-stream composition. Synthetic PGDs cover both supported MAC variants, supplied/derived keys and later-block decoding. Fixed-key outputs match the previous implementation on synthetic identifiers. |
| `src/loader/prx-decrypter.ts` | Replaced generated transformation code with legacy/modern packet-layout pipelines. Synthetic encrypted files exercise all five supported layouts and altered-payload rejection. |
| `src/audio/sas-core.ts` | Replaced the synthesizer with packet ADPCM decoding, an envelope state machine and a per-voice renderer. Eight synthetic PCM/VAG traces match the previous output across multiple grains and pitches. Undefined ADPCM predictors use zero coefficients instead of the reference's incidental table contents. |
| `src/audio/atrac-ring.ts` | New bounded-ring accounting for the asynchronous audio loader, with wrap, EOF and frame-alignment tests. |
| `src/kernel/psp-registry.ts` | Replaced the reference registry defaults with a generated tree describing the 16 bundled replacement fonts and synthetic zero usage counters. |
| `src/frontend/wave-background.ts` | Replaced the tuned reference background expressions with project-specific animated Bezier curves. |
| `src/crypto/aes.ts`, `aes-tables.ts` | Retain the Rijndael implementation's named authors, public-domain declaration and disclaimer in [LICENSES](LICENSES/rijndael-public-domain.txt). This declaration is specific to Rijndael, not the whole libkirk directory. |
| `ppsspp_niddb.xml` | Regenerated from the project's `src/kernel/nids.ts` declarations using `npm run nids:generate`. It is an index of project declarations, not an independently sourced comprehensive database. |

## Format data and behavioral references

PSP identifiers, register fields, file offsets, fixed decryption keys and tag maps
remain for compatibility. The retained KIRK/PRX table files identify their
reference source. They are separate from the replacement transformation code.

The remaining HLE, PGF, timing, loader and graphics reference comments describe
syscall behavior or binary/hardware interfaces. The targeted review distinguishes
those interfaces from implementation-specific choices such as the old PRNG seed,
registry counters and background curves. It is not a certification of the origin
of every line in the emulator.

The replacements were written with access to the prior and reference code; this
was not a clean-room process. Existing history remains available, including older
implementations and fonts.

## Runtime and assets

The retained FFmpeg core is GPL-2.0-or-later. The wrapper is MIT. Exact versions,
source links and notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
The unused libav.js packages were removed. The docs diagram now uses native
browser animation, replacing the custom-licensed GSAP dependency.

The 16 replacement PGFs use OFL fonts with recorded source/output hashes and
adjacent notices. Gameplay videos and screenshots retain their respective rights.
See [ASSETS.md](ASSETS.md) for the asset inventory and font coverage.
