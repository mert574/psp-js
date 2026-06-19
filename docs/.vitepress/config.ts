import { defineConfig } from "vitepress";

// The app is deployed to GitHub Pages at /psp-js/; the docs live alongside it at
// /psp-js/docs/. In dev the docs serve under /docs/ too, so the app's Vite dev
// proxy can forward /docs to the VitePress dev server (see vite.config.ts).
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? "/psp-js/docs/" : "/docs/",
  title: "psp-js",
  description: "A PSP HLE emulator written in TypeScript, in the browser.",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: "Introduction", link: "/guide/introduction" },
      { text: "User Guide", link: "/user/running-games" },
      { text: "Compatibility", link: "/game-status" },
      { text: "Development", link: "/guide/getting-started" },
      { text: "Reference", link: "/reference/syscalls" },
    ],

    sidebar: [
      {
        text: "Overview",
        items: [
          { text: "Introduction", link: "/guide/introduction" },
        ],
      },
      {
        text: "User Guide",
        items: [
          { text: "Running Games", link: "/user/running-games" },
          { text: "Game Compatibility", link: "/game-status" },
          { text: "Controls", link: "/user/controls" },
          { text: "Settings", link: "/user/settings" },
          { text: "Save States & Savedata", link: "/user/saves" },
          { text: "Debug Panel", link: "/user/debug-panel" },
          { text: "Troubleshooting", link: "/user/troubleshooting" },
        ],
      },
      {
        text: "Development",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Architecture", link: "/guide/architecture" },
        ],
      },
      {
        text: "Subsystems",
        items: [
          { text: "CPU (Allegrex)", link: "/systems/cpu" },
          { text: "Memory", link: "/systems/memory" },
          { text: "Kernel & HLE", link: "/systems/kernel-hle" },
          { text: "GPU (GE)", link: "/systems/gpu-ge" },
          { text: "Core Timing", link: "/systems/timing" },
          { text: "Loader & Crypto", link: "/systems/loader-crypto" },
          { text: "ISO & SFO", link: "/systems/iso-sfo" },
          { text: "Audio & Media", link: "/systems/audio-media" },
          { text: "Background Audio Decoding", link: "/systems/audio-assets" },
          { text: "Storage & Save States", link: "/systems/storage-state" },
          { text: "Frontend", link: "/systems/frontend" },
        ],
      },
      {
        text: "HLE Modules",
        collapsed: true,
        items: [
          { text: "Threads & Callbacks", link: "/systems/hle/thread" },
          { text: "Sync & Memory Pools", link: "/systems/hle/sync" },
          { text: "File I/O", link: "/systems/hle/io" },
          { text: "Display", link: "/systems/hle/display" },
          { text: "Controller", link: "/systems/hle/ctrl" },
          { text: "Audio", link: "/systems/hle/audio" },
          { text: "Power & UMD", link: "/systems/hle/power" },
          { text: "SAS, RTC & Registry", link: "/systems/hle/media" },
          { text: "MPEG", link: "/systems/hle/mpeg" },
          { text: "PSMF Player", link: "/systems/hle/psmf-player" },
          { text: "Network", link: "/systems/hle/net" },
          { text: "Utility Dialogs", link: "/systems/hle/utility" },
          { text: "Font (PGF)", link: "/systems/hle/font" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Syscall Flow & ABI", link: "/reference/syscalls" },
          { text: "CPU Opcodes", link: "/reference/cpu-opcodes" },
          { text: "GE Opcodes", link: "/reference/ge-opcodes" },
          { text: "Testing", link: "/reference/testing" },
          { text: "Conventions", link: "/reference/conventions" },
        ],
      },
    ],

    outline: { level: [2, 3] },
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/mert574/psp-js" },
    ],
  },
});
