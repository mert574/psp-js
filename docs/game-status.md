# Game compatibility status — 2026-06-12 (overnight session)

Headless results from `tools/game-diag.ts`. "Renders" = non-black display framebuffer
via the software rasterizer; browser/WebGL verification still pending for the new ones.

## Per-game status

| Game | Status | Pixels | Notes |
|---|---|---|---|
| puzzle-bobble | **PLAYABLE** (user confirmed: full speed + sound) | high | Regression test: `test/game-boot-regression.test.ts` |
| cladun-rpg | **RENDERS scenes** (was: black) | 73k | Fixed tonight: savedata status machine + VFPU + tex UV |
| metal-slug | **RENDERS** (was: fault at frame 0) | 130k | Fixed tonight: ET_EXEC module info parsing |
| wipeout-pure | **Intro videos PLAY for real** (user confirmed, browser) | 132k | Real WebCodecs decode; menus render; gameplay state past that unverified |
| space-invaders | Black, clears-only | 0 | Loads videocodec/mpegbase modules; almost certainly intro-video wait like wipeout |
| burnout-legends | Partial render, then busy-spin | — | Game loader loop at 0x89b6c50 burns full cycle budget; deep, deferred |
| Duke3D (homebrew) | Not testable headless yet | — | Directory-based homebrew (EBOOT.PBP + data files); harness only mounts ISOs |

## New games added 2026-06-12 (afternoon) — first boot pass

Headless boot, 400-600 frames. Fixtures are now symlinks into `~/Downloads/psp`.

| Game | Status | Pixels | Notes |
|---|---|---|---|
| gta (GTA3) | **RENDERS** | 104k | 600f/18fps clean. MPEG ringbuffer construct/create fires. Best of the new batch. |
| ridge-racer (RRPSP) | Near-black | 139 | 600f/26fps clean. Loads mpeg/videocodec; opens a few module paths that 404. |
| puyo-puyo (FEVER2) | Runs, no headless render | 0 | 600f/178fps clean. ATRAC audio fails in node (`ffmpeg.wasm does not support nodejs`). Needs browser check. |
| lbp (LBPPSP) | Bails immediately | — | `pthread API call made from non-pthread thread` (sce 0x80020198). Our threads are not registered as SCE pthreads. 10 unimplemented NIDs incl sceHttp. |
| gow-sparta (dax) | **FAULTS at frame 11** | 0 | `Bad PC=0x0` (jump through null fn pointer) on thread 1, called from 0x88e512c, right after Suspend/ResumeDispatchThread. |

## MPEG overlay (2026-06-12 afternoon)

The fake `sceMpegAvcDecode` used to fill the frame with plain black. It now draws
the video name (basename of the last opened `.pmf`/`.mps`/etc., else "MPEG VIDEO")
plus resolution and frame counter, via a 5x7 bitmap font in `src/gpu/text-overlay.ts`.
Unit-tested in `src/gpu/text-overlay.test.ts`; preview with `tools/debug-mpeg-overlay-png.ts`.

## Real MPEG video decode (2026-06-12 afternoon) — browser-only, WIP

Decodes the PSMF H.264 stream for real instead of black frames. Pipeline:
- `src/media/psmf-demux.ts` — MPEG-2 Program Stream demuxer (PS -> H.264 access
  units + PTS). Pure TS, unit-tested. Needed because the default libav.js build
  has NO mpeg-PS demuxer and NO h264 decoder (checked in-browser: those strings
  are codec descriptors, not compiled codecs — same wall pmf.ts hit).
- `src/media/mpeg-decoder.ts` — feeds access units to the browser-native
  WebCodecs `VideoDecoder` (Annex-B mode), reads frames back as RGBA via
  OffscreenCanvas. Caches+re-injects SPS/PPS before keyframes.
- `src/media/frame-pack.ts` — packs decoded RGBA into the PSP framebuffer format
  (5650/5551/4444/8888). Unit-tested.
- Wired into `hle-mpeg.ts`: feeds ring PS bytes on `sceMpegRingbufferPut`, pulls
  a decoded frame in `sceMpegAvcDecode` (falls back to black+label if none ready).
  Browser-only (`typeof window`); Node/headless keeps the placeholder path.

AU splitting now frames on real H.264 access-unit boundaries (AUD / param sets
after a finished picture / first slice of a new picture via first_mb_in_slice==0),
not on PES-PTS. The old PES-PTS split packed several pictures into one chunk when
a stream carried fewer PTS than frames, which made WebCodecs throw a "Decoding
error" (seen on the PSMF icon tail and on wipeout's intro). PTS is now just
carried as a per-AU timestamp from the PES headers. See psmf-demux.ts frame().

Decode is PACED, not eager. Disc reads are instant so games burst the whole
ringbuffer at once; decoding every AU on arrival raced ~250 frames ahead and the
queue dropped most of them (a flash of video, then fallback). Now the demuxer
runs eagerly (compressed AUs are cheap to hold in pendingAus) but pump() keeps
only LOOKAHEAD=16 decoded frames in flight; each takeVideoFrame() decodes one
more. WORKING: wipeout's intro videos play for real (user confirmed in browser).
Audio (ATRAC3+) not handled yet, neither WebCodecs nor the libav build does it.
libav.js was the initial plan but its prebuilt variant can't decode H.264/PS.

## Root causes fixed tonight (commit-worthy)

1. **VFPU lv.s/sv.s register mapping** (`src/cpu/executor.ts` `vfpuScalarIndex`)
   Used the raw register code as a flat vfpr index, skipping the voffset mapping
   ALU ops use, and masked `raw & 1` instead of `raw & 3`. Loads landed in wrong
   registers → garbage into gum matrix math → NaN projection matrices → invisible
   geometry in every gum-based game. Also: lv.s/sv.s address must mask the low 2
   offset bits (they're register bits).

2. **mfv/mtv encoding** (`execCOP2`)
   Real encoding is fmt 3 = mfv/mfvc, fmt 7 = mtv/mtvc with the register code in
   the LOW BYTE (PPSSPP Int_Mftv). We had fmt 0/4 with code at bits 8-14, no
   voffset mapping. Real mfv instructions fell into the broken mfvc branch.

3. **VFPU prefixes never applied** (vpfxs/vpfxt/vpfxd)
   Stored + cleared but never honored. Games negate operands via `vpfxs [-x]`
   inside libgum (ortho/perspective). Now applied via readVecS/readVecT/writeVecD
   wrappers (swizzle, abs, constants, negate, saturation, write mask).

4. **Missing VFPU9 ops**: vbfy1, vbfy2, vsrt1-4, vsocp silently NOP'd.
   gumOrtho uses vbfy1 to compute (r+l, r-l, t+b, t-b) → matrices were garbage.

5. **vrot broadcast case**: sin lane == cos lane must broadcast sine to all lanes.

6. **Transform-mode texture UVs** (`src/gpu/ge-texture.ts`)
   `(u * texScaleU + texOffsetU)` is in NORMALIZED space; must multiply by texture
   size for texel coords (PPSSPP TransformUnit). Float-UV games sampled texel (0,0)
   forever → alpha-tested to nothing.

7. **Savedata utility status machine** (`src/kernel/hle-utility.ts`)
   PSP statuses: 0=NONE, 1=INITIALIZE, 2=RUNNING, **3=FINISHED, 4=SHUTDOWN**.
   We used 3=QUIT/4=FINISHED, so Update jumped 2→4 and games polling for 3 hung
   forever (cladun stuck on "Now Loading" pumping Update/GetStatus). Correct flow:
   InitStart→1; GetStatus auto-advances 1→2 and 4→0; Update completes→3; game
   calls ShutdownStart→4. NOTE: msgdialog/netconf/osk still use the old numbering
   (they walk 2→3→4→0 per GetStatus call which happens to expose 3) — align later.

8. **ET_EXEC module info** (`src/loader/elf.ts`)
   Module info/import patching was PRX-only. Decrypted retail EBOOTs are often
   ET_EXEC (metal-slug: tag 0xD9160BF0 decrypts fine to ET_EXEC). PPSSPP parses
   sceModuleInfo for both via the same seg0 paddr formula. Metal-slug went from
   "fault at frame 0, 0 imports" to rendering 130k px.

## Ranked remaining work

1. **sceMpeg intro video** — blocks wipeout-pure AND space-invaders (2 games),
   and most commercial games play intro videos. Options: real decode (big) or
   PPSSPP-style fake-skip (return "stream end" so games skip the video).
2. **Browser verification of cladun + metal-slug** — software raster renders;
   WebGL path may have separate bugs (same UV bug existed there? check
   ge-webgl-renderer/ge-shaders for the same scale issue).
3. **Burnout loader spin** — disassemble loop at 0x89b6c50, find the gate.
4. **Utility dialog status numbering for msgdialog/netconf/osk** — same fix as
   savedata; cheap and may unblock games that check for INITIALIZE(1).
5. **Duke3D headless harness support** — mount a directory as ms0:/PSP/GAME/...
6. **GE signal tests** (6 pre-existing GPU autotest failures) — see
   project_ge_signal_rework.md.
7. **sysmem/sysmem + sysmem/freesize autotests** — pre-existing, StackStart
   value wrong (0xFFFBEF5C vs 0x0003EF7C); low priority for games.

## Test counts (after tonight's fixes)

- Unit tests: 91/91 ✓
- pspautotests main: 34/36 (2 pre-existing sysmem failures)
- pspautotests GPU: 5/11 (6 pre-existing GE-signal failures)
- Puzzle Bobble regression: ✓
