# Contributing

PSP.js is a TypeScript PSP HLE emulator for browsers, with headless diagnostics
and Vitest tests. Start with the README and [ROADMAP.md](ROADMAP.md).

## Setup and checks

Use Node.js 22 or later and `npm ci`. Run `npm run dev` for the emulator and
`npm run docs:dev` for documentation. The dev server supplies the headers needed
for SharedArrayBuffer. A plain static file server does not provide these headers.

- `npm run typecheck`: TypeScript checks.
- `npx vitest run src/`: unit tests using synthetic data.
- `npm run check:assets`: distribution asset policy.
- `npm run build:web` and `npm run docs:build`: app and documentation builds.

Some integration tests require external fixtures. Do not claim they passed if
the fixtures were unavailable. Prefer a synthetic regression test for CPU,
loader, timing, and GE behavior changes.

## References and implementation provenance

PPSSPP is a valuable behavioral reference. Its source has multiple licenses;
it is not blanket permission to translate implementation code into a permissive
project. Describe the intended hardware behavior and cite the reference used.
Record copied/adapted source separately from independently implemented behavior,
and preserve upstream notices when copying is authorized.

The current provenance review is recorded in [LICENSING.md](LICENSING.md).
Do not change "port" to "reference" simply to make a licensing warning disappear.

## Assets and reports

Follow [ASSETS.md](ASSETS.md). Do not add commercial-game dumps, firmware, PGF
fonts, private saves, or screenshots/recordings without redistribution evidence.
Bug reports should use synthetic programs or licensed homebrew and should omit
private directory paths and personal data.
