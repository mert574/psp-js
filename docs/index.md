---
layout: home

hero:
  name: psp-js
  text: A PSP emulator in TypeScript
  tagline: High-level emulation of the PSP that runs in the browser. It loads and decrypts real game images and runs them without a BIOS.
  actions:
    - theme: brand
      text: Run a Game
      link: /user/running-games
    - theme: alt
      text: How it works
      link: /guide/architecture
    - theme: alt
      text: Developer Docs
      link: /guide/getting-started

features:
  - title: High-level emulation
    details: System calls are implemented in TypeScript instead of running a PSP BIOS, the same approach PPSSPP takes. No firmware image is needed.
  - title: Boots real games
    details: It decrypts KIRK-encrypted EBOOTs, loads ISO and PBP images, and runs the MIPS Allegrex CPU and VFPU. The GE (GPU) renders over WebGL, with a software rasterizer as a fallback.
  - title: Audio, video, and saves
    details: ATRAC3+ audio decodes through an AudioWorklet and PSMF video through WebCodecs. Savedata and whole-machine save states persist in the browser.
  - title: Browser and headless
    details: The frontend is built with Vite and Lit. The same emulator core also runs under Node for diagnostics and tests, using the software rasterizer.
---
