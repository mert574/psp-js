/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves project sites under /<repo>/, so the CI build needs a
  // matching base. Local dev/build stays at "/" so nothing changes day to day.
  base: process.env.GITHUB_ACTIONS ? "/psp-js/" : "/",
  build: {
    outDir: "dist-web",
    target: "esnext",
  },
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "libav.js"],
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    testTimeout: 30_000,
    teardownTimeout: 5_000,
    pool: "forks",
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
  },
});
