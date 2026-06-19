<script setup>
import { withBase } from "vitepress";
</script>

# Introduction

**psp-js** is a PSP emulator written in TypeScript that runs in the browser. It uses **high-level emulation** (HLE), the same approach as [PPSSPP](https://www.ppsspp.org/): instead of running a real PSP BIOS, the system calls a game makes are intercepted and implemented directly in TypeScript. No BIOS ROM is required.

<video :src="withBase('/videos/ridge-racer.mp4')" controls muted autoplay loop playsinline preload="metadata" style="width:100%;max-width:640px;border-radius:8px;display:block;margin:1.5rem auto"></video>

<p style="text-align:center;font-size:13px;opacity:0.7;margin-top:-0.75rem">Ridge Racer running in psp-js, captured from the in-game replay.</p>

## What it does

It boots real commercial games, taking them through the full pipeline a PSP would:

- **Decrypts** KIRK-encrypted `EBOOT.BIN` modules and decompresses them.
- **Loads** games from ISO or PBP containers.
- **Runs** the MIPS Allegrex CPU and the VFPU (vector FPU).
- **Renders** the GE (Graphics Engine / GPU) over WebGL, with a software rasterizer as an alternative.
- **Decodes** ATRAC3+ audio and MPEG/PSMF video for in-game sound and cutscenes.
- **Persists** savedata in the browser.

## How HLE works here

A PSP game runs as MIPS code, but when it needs the operating system (to create a thread, allocate memory, draw to the screen, read a file) it issues a `syscall` instruction. In real hardware that traps into the kernel. Here, the CPU flags the syscall and the HLE kernel dispatches it to a TypeScript handler that implements the behaviour. The behaviour is matched against the PPSSPP source, which is treated as the authoritative reference for PSP behaviour.

See [Syscall Flow & ABI](/reference/syscalls) for the mechanics.

## Where it runs

- **Browser** is the main target. A Vite and [Lit](https://lit.dev/) frontend hosts the game library, input mapping, debug panel, and the canvas. The GE renders over WebGL and audio plays through an AudioWorklet.
- **Headless (Node)** runs the same emulator core under `tsx` and `vitest` for diagnostics and tests. There is no WebGL in Node, so the GPU uses the software rasterizer.

## Target hardware

The emulator models the PSP-2000/3000 (Slim):

| Component | Value |
| --- | --- |
| RAM | 32 MB by default, 64 MB for games that request it (`0x08000000`) |
| VRAM | 2 MB (`0x04000000`) |
| CPU | 222 MHz default; games switch to 333 MHz via `scePowerSetClockFrequency` |
| Display | 480 × 272 |

If you just want to play, head to [Running Games](/user/running-games). To build the project, see [Getting Started](/guide/getting-started); for the big picture, [Architecture](/guide/architecture).
