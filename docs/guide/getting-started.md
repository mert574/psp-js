# Getting Started

## Prerequisites

- **Node.js 22** (the version used in CI).
- A browser with WebGL and `SharedArrayBuffer` support.

## Install

```bash
npm install
```

## Run the browser app

```bash
npm run dev
```

This starts the Vite dev server. The dev and preview servers send these headers (configured in `vite.config.ts`):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

They are required. Without them `SharedArrayBuffer` is unavailable. Load a game through the library UI by pointing it at an ISO or PBP file.

## Build

```bash
npm run build       # type-check / compile with tsc
npm run build:web   # Vite production build → dist-web/
```

`build:web` is what CI deploys to GitHub Pages.

## Type-check and test

```bash
npm run typecheck                 # tsc --noEmit
npm test                          # vitest run, all tests
npx vitest run src/               # unit tests only (skip ISO integration tests)
npx vitest run src/timing/        # a specific directory
```

See [Testing](/reference/testing) for the full layout, including the pspautotests integration suite.

## Headless tools

The emulator core runs under Node for diagnostics, with no WebGL (the GPU falls back to the software rasterizer):

```bash
npx tsx tools/boot-iso.ts test/fixtures/puzzle-bobble.iso 100   # boot an ISO for N frames
npx tsx tools/game-diag.ts test/fixtures/gta.iso                # headless game diagnostics
npx tsx tools/find-dup-nids.ts                                  # check for duplicate NIDs
```

A save state exported from the browser can be replayed headless, which is the most reliable way to reproduce an in-game bug offline.

## Documentation

To work on these docs:

```bash
npm run docs:dev      # live preview on :5174
npm run docs:build    # static build
npm run docs:preview  # serve the built docs
```

To run the app and the docs together so the in-app docs link (and `localhost:5173/docs/`) works locally:

```bash
npm run dev:all       # app on :5173, docs on :5174, app proxies /docs → docs
```

The app's dev server proxies `/docs` to the VitePress server (see `vite.config.ts`). In production the docs are a real static directory at `/psp-js/docs/`.
