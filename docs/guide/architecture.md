# Architecture

`PSPEmulator` (`src/emulator.ts`) is the top-level facade. It wires the major subsystems together and drives the frame loop.

```
PSPEmulator (src/emulator.ts)
├── AllegrexCPU    MIPS fetch/decode/execute, branch delay slots, VFPU, syscall dispatch    (src/cpu/)
├── MemoryBus      RAM (0x08000000), VRAM (0x04000000), scratchpad                          (src/memory/)
├── HLEKernel      syscall dispatch, thread scheduler, all sceXxx handlers                  (src/kernel/hle-*.ts)
├── CoreTiming     cycle-accurate event scheduler (models PPSSPP CoreTiming.cpp)            (src/timing/)
├── GEProcessor    GE (GPU) command processing, runs INLINE on the main thread             (src/gpu/ge-processor.ts)
└── GeDispatcher   Web Worker GE path: DEAD CODE, never initialized                         (src/gpu/ge-dispatcher.ts)
```

## How a frame runs

Each displayed frame, the emulator runs the CPU interpreter until the threads are all waiting, processing GE display lists inline as the game submits them, and advancing the timing event scheduler. In the browser the frame is then presented to the canvas (WebGL or software); in headless mode the framebuffer just sits in VRAM.

The CPU, kernel, memory, and GE are all **renderer-agnostic** and run identically in the browser and headless. The only thing that differs between the two is how drawn pixels are presented: WebGL draws into GPU framebuffers, the software rasterizer writes straight into VRAM.

## One frame, step by step

A "frame" here is one call to `runFrame()` followed by presenting the result. There is no single hardware cycle to watch; instead the CPU runs in slices and the GE and timing run alongside it, thousands of instructions per displayed frame. The animation below follows the real dataflow: MIPS instructions stream through the CPU (fetch, decode, execute); now and then a SYSCALL peels off into the HLE kernel and the result returns; the kernel feeds GE display-list commands to the GEProcessor, which rasterizes into a framebuffer; CoreTiming advances a clock the whole time. The CPU, kernel and GE keep cycling like this until the scheduled VBlank event is due, and only then is the framebuffer presented to the screen, which kicks off the next frame.

<ClientOnly>
  <FrameCycle />
</ClientOnly>

In code, this is `runFrame()` looping `cpu.run(slice)` (each `step()` is fetch, decode, execute, with the `pendingSyscall` flag handing off to `hle.dispatch`), the kernel draining queued GE lists into `GEProcessor.executeCommand`, and `coreTiming.advance(ran)` firing scheduled events. When the VBlank event fires the loop ends, and the frontend presents the framebuffer.

## The subsystems

| Area | Directory | What it does |
| --- | --- | --- |
| [CPU](/systems/cpu) | `src/cpu/` | Allegrex MIPS interpreter, decoder, executor, 32 GPRs + hi/lo + CP0 + VFPU, branch delay slots. |
| [Memory](/systems/memory) | `src/memory/` | `MemoryBus` (RAM/VRAM/scratchpad routing) and `BlockAllocator` (stacks, heaps, partitions). |
| [Kernel & HLE](/systems/kernel-hle) | `src/kernel/` | `HLEKernel` plus per-module `hle-*.ts` handlers, the NID table, and the thread scheduler. |
| [GPU (GE)](/systems/gpu-ge) | `src/gpu/` | GE command processor, vertex/lighting/texture pipeline, WebGL renderer, software rasterizer. |
| [Core Timing](/systems/timing) | `src/timing/` | Cycle-based event scheduler; VBlank and clock-frequency handling. |
| [Loader & Crypto](/systems/loader-crypto) | `src/loader/`, `src/crypto/` | ELF/PBP loaders, PRX decrypter, and the KIRK/AES/SHA1/AMCTRL primitives behind it. |
| [ISO & SFO](/systems/iso-sfo) | `src/iso/` | ISO9660 reader, `PARAM.SFO` parser, disc metadata. |
| [Audio & Media](/systems/audio-media) | `src/audio/`, `src/media/` | ATRAC3+ decode via an AudioWorklet, and MPEG/PSMF video via WebCodecs. |
| [Storage & Save States](/systems/storage-state) | `src/storage/`, `src/state/` | Browser-persisted savedata/files, and whole-machine `.pspstate` snapshots. |
| [Frontend](/systems/frontend) | `src/frontend/` | The Lit-based browser UI: game library, input, debug panel, renderer wiring. |

## Memory map

| Region | Address | Size |
| --- | --- | --- |
| Scratchpad | `0x00010000` | 16 KB |
| VRAM | `0x04000000` | 2 MB |
| User RAM | `0x08000000` | 32 MB default, 64 MB on request |
| Volatile RAM | `0x08400000` | 4 MB |

All addresses are treated as virtual; `toPhysical()` strips the top bits. See [Memory](/systems/memory) for the routing and allocator details, and the [PSP memory model](/systems/memory#the-psp-memory-model) note on the default 32 MB user space.
