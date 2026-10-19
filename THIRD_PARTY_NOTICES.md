# Third-party notices

Original project code uses the root MIT license. The following components keep
their own terms.

| Component | Version / source | Terms |
| --- | --- | --- |
| FFmpeg WebAssembly core | `@ffmpeg/core` 0.12.10; FFmpeg 5.1.4 | GPL-2.0-or-later, including enabled GPL codecs; [license](LICENSES/FFmpeg-GPL-2.0.txt) |
| ffmpeg.wasm wrapper / utilities | `@ffmpeg/ffmpeg` 0.12.15, `@ffmpeg/util` 0.12.2 | [MIT](LICENSES/ffmpeg-wasm-MIT.txt), Jerome Wu |
| Rijndael primitive and lookup tables | Vincent Rijmen, Antoon Bosselaers, Paulo Barreto | [Public-domain declaration and disclaimer](LICENSES/rijndael-public-domain.txt) |
| Saira / PSP.js Sans | Bundled UI font and generated PGFs | [OFL-1.1](public/flash0/font/OFL-Sans.txt) |
| Inconsolata / PSP.js Mono | Bundled UI font and generated PGFs | [OFL-1.1](public/flash0/font/OFL-Mono.txt) |
| Lit, TWGL, Vue and bundled supporting packages | Installed versions in `package-lock.json` | [Package license notices](public/licenses/dependency-notices.txt) |
| PPSSPP reference checkout | Optional git submodule at `ab1ee21996b78aaac1f82baa390990c8ce9a9936` | Upstream GPL and component-specific notices; reference/test use, not part of the app bundle |

## FFmpeg runtime

The app loads the unmodified single-thread core 0.12.10 from jsDelivr.

- [Runtime source and build scripts](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/71aa99d37c02a7b4c435275ca9ef50e612f6efa1)
- [FFmpeg 5.1.4 source](https://github.com/FFmpeg/FFmpeg/tree/n5.1.4)
- [Dependency sources and configuration](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/71aa99d37c02a7b4c435275ca9ef50e612f6efa1/Dockerfile)
- [Exact downloaded JS/WASM URLs and hashes](public/licenses/runtime.json)

## Demonstration media

Gameplay videos and screenshots retain the rights of their respective owners
and are outside the project's MIT grant.
