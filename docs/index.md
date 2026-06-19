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
    details: Runs without a PSP BIOS. It implements the PSP's system calls in TypeScript.
  - title: Boots real games
    details: It decrypts the KIRK EBOOT, reads the ISO or PBP, and runs the real Allegrex CPU and VFPU, drawing the GE over WebGL.
  - title: Audio and video
    details: ATRAC3+ audio decodes through a bundled ffmpeg, and PSMF video through the browser's WebCodecs.
  - title: Browser and headless
    details: Game saves persist in the browser, whole-machine save states export to a file, and the same core also runs headless under Node.
---
