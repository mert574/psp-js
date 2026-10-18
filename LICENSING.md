# Licensing and implementation provenance

## Status

The maintainer's intended project license is MIT. The maintainer states that the
emulator was independently reimplemented, with PPSSPP consulted as a behavioral
reference. That distinction matters: consulting a reference does not by itself
establish that an implementation is a derivative of its source.

However, the checked-in code and documentation contain explicit "port" statements
and some implementation-specific matches. Those need a concrete provenance review
before a blanket MIT license can be published. The original `package.json` ISC
field is metadata, not evidence that these questions have been resolved. No GPL
license has been applied by this preparation, and no upstream license notice has
been removed or silently relabeled.

## Reference baseline

The `ppsspp-reference` git submodule points to:

`https://github.com/hrydgard/ppsspp/tree/ab1ee21996b78aaac1f82baa390990c8ce9a9936`

Its components have different terms. The top-level PPSSPP license is not a
substitute for reading each relevant source header.

## Findings to resolve

| Local implementation | Reference / observed evidence | Status |
| --- | --- | --- |
| `src/crypto/kirk.ts`, `src/loader/kirk.ts` | `ext/libkirk/kirk_engine.c` declares GPL-3.0-or-later. Local comments call these ports. The PRNG/default initialization also matches implementation-specific upstream choices, including its default seed string, filler byte, and random-data constants; these are more specific than PSP command IDs. | Review origin of those implementations and replace source-derived expression or obtain permission if necessary. |
| `src/audio/sas-core.ts` | `Core/HW/SasAudio.cpp` declares GPL-2.0-or-later. The local file identifies itself as a port; decoder state/update ordering closely follows the reference. ADPCM behavior and hardware constants alone are not proof of copying. | Review source origin at function level. |
| `src/memory/block-allocator.ts` | `Core/Util/BlockAllocator.cpp` declares GPL-2.0-or-later. Similar public operations and a linked-list allocator can also arise independently. | Establish whether this is independently written code or a source translation; comments alone are insufficient. |
| `src/frontend/wave-background.ts` | `UI/Background.cpp` uses the same two tuned sinusoidal expressions in the original checkout. This concerns visual implementation choices, not PSP hardware behavior. | A project-specific replacement is prepared locally and is not included in this documentation change. |
| `src/crypto/aes.ts`, `aes-tables.ts` | `ext/libkirk/AES.c` contains a public-domain declaration for the Rijndael implementation, unlike KIRK's GPL header. | Preserve the exact applicable author/disclaimer notice; do not call every file in libkirk GPL. |
| `src/crypto/sha1.ts`, `src/crypto/amctrl.ts` | Their reference files carry separate authorship/history text; a complete permission determination was not established by this review. | Trace original terms or independently replace; do not infer permission from the directory name. |
| `src/kernel/psp-registry.ts`, `hle-audio.ts`, `hle-font.ts`, `hle-kernel.ts`, loaders and other HLE handlers | Comments and docs cite PPSSPP. Some may describe behavior; some may indicate translated implementation. | Record concrete source comparisons instead of treating all reference citations as copied code. |
| `ppsspp_niddb.xml` | Checked-in reference database. | Record its original source and applicable redistribution terms. |
| FFmpeg/libav runtime dependencies | Wrapper package licenses and the exact loaded WASM build can differ. | Inventory the selected core build, source and notices before claiming an entirely permissive distribution. |

## Closing the review

For each item, record the original implementation inputs, reference revision,
what was independently written, copied/adapted portions if any, and applicable
license/permission evidence. Hardware formats, algorithms, and required constants
must be distinguished from expressive source code. Similarity is evidence to
investigate, not an automated legal determination.

The MIT route requires resolving retained third-party code and distribution
dependencies, not merely changing comments or deleting attributions. Any needed
replacement should be written against a behavioral specification and validated
with synthetic tests. Do not describe such work as a clean-room process unless
that process was actually followed.

## Artwork and fonts

The original architecture illustration is separately available under
`LICENSES/illustration-MIT.txt`. The two retained browser UI fonts keep their
adjacent OFL notices. Gameplay recordings retain underlying third-party rights;
they are not covered by the MIT illustration license. PGF font provenance remains
under review. Asset and runtime changes are not included in this documentation change.
