# PSP.js roadmap

The emulator has an Allegrex CPU/VFPU implementation, HLE kernel, loaders,
WebGL/software graphics, audio/media paths, browser storage, and diagnostic tools.
The GE worker exists but is currently disabled; GE commands run inline.

## Source and assets

Source provenance and runtime licenses are recorded in [LICENSING.md](LICENSING.md)
and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The default PGFs use OFL
replacement fonts; see [ASSETS.md](ASSETS.md) for their coverage and notices.

## Proposed emulator work

These slices describe remaining development, not claimed completed work.

| Work | Done when |
| --- | --- |
| GE worker transport | A bounded command ring preserves command/stall/finish order, avoids races with RAM block transfers, and agrees with the inline path on synthetic command traces. |
| Interpreter/GE profiling and optimization | A reproducible synthetic workload records CPU/GE costs before and after changes; correctness tests still pass and the measured improvement is documented. |
| Utility-dialog state transitions | msgdialog, netconf, and OSK follow initialize/run/finish/shutdown ordering; tests cover polling and repeated initialization without relying on commercial games. |
| Media demux and timing regressions | Synthetic or explicitly licensed media fixtures exercise timestamps, truncation, and decode failures; fixture source and license records accompany each file. |

Existing compatibility observations remain in [docs/game-status.md](docs/game-status.md);
they are observations from earlier testing. Recheck affected titles after
changes to fonts, audio or decryption.

## Reviewer-friendly reproduction

Prioritize a self-authored minimal homebrew demo and synthetic instruction/GE
fixtures. Keep commercial game images, firmware, private save states, game art,
and unlicensed recordings out of the source tree and build artifacts.
