# Testing

## Commands

```bash
npm test                          # vitest run, everything
npx vitest run src/               # unit tests only (skip ISO integration tests)
npx vitest run src/timing/        # a single directory
npx vitest run test/pspautotests/pspautotests.test.ts -t "test/name"   # one autotest
```

Run `npm run typecheck` to check types.

## Unit tests

Unit tests live next to the code under `src/`. CPU tests write programs as `u32` arrays directly into RAM at `0x08000000` and run the interpreter:

- Data addresses must be well past the program end (e.g. `RAM + 100`), or the program overwrites its own data.
- `BEQ` offsets are in **words** from `(PC + 4)`, not bytes.

## pspautotests (integration)

The [pspautotests](https://github.com/hrydgard/pspautotests) suite is real PSP test programs (compiled `.prx` files) that print expected output. The runner boots each `.prx` and compares its **stdout text** against a `.expected` file, line by line.

- Runner: `test/pspautotests/run-autotest.ts` + `test/pspautotests/pspautotests.test.ts`.
- GPU tests are in a separate file: `test/pspautotests/pspautotests-gpu.test.ts`.
- Test `.prx` files come from `ppsspp-reference/pspautotests/tests/`.
- Output is captured via `kernel.stdoutBuffer` and `host0:` file interception in `hle-io.ts`.

Because the comparison is textual (program output, not framebuffer pixels), rendering-internal changes like pixel byte order do not affect these tests.

## Integration tests with ISOs

Some tests boot real ISOs from `test/fixtures/`. These are skipped by `npx vitest run src/`. Puzzle Bobble is a known-good reference game for sanity checks.

## Headless diagnostics

The emulator core runs under Node, where there is no WebGL so the software rasterizer is used. Useful entry points:

```bash
npx tsx tools/boot-iso.ts <iso> <frames>   # boot for N frames, print diagnostics
npx tsx tools/game-diag.ts <iso>           # headless game diagnostics
```

A `.pspstate` save state exported from the browser can be restored headless and run forward. This is a reliable way to reproduce an in-game issue offline. See [Storage & Save States](/systems/storage-state).
