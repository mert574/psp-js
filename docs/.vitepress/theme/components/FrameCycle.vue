<script setup lang="ts">
// Browser-only animated diagram of one runFrame() of the emulator.
// GSAP and the DOM are only touched inside onMounted, so this is safe to
// import at build time but it never runs during SSR (the page wraps it in
// <ClientOnly>, and the timeline is built after mount).
import { onMounted, onBeforeUnmount, ref } from "vue";

const root = ref<HTMLElement | null>(null);

// Kept so we can kill/observe outside onMounted's closure on unmount.
let cleanup: (() => void) | null = null;

onMounted(async () => {
  const el = root.value;
  if (!el) return;

  const { gsap } = await import("gsap");

  const svg = el.querySelector("svg")!;
  const q = gsap.utils.selector(svg);

  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Framebuffer grid cells (8x5). Filled progressively while the GE "rasterizes".
  const fbCells = q(".fb-cell");
  // Pixels on the presented screen (mirror the framebuffer on VBlank flip).
  const screenCells = q(".screen-cell");

  // Helper: reset the scene to its start state between loops.
  const resetScene = () => {
    gsap.set(fbCells, { fill: "var(--fc-grid)", opacity: 0.18 });
    gsap.set(screenCells, { fill: "var(--fc-grid)", opacity: 0.12 });
    gsap.set(q(".instr"), { opacity: 0 });
    gsap.set(q(".syscall-dot"), { opacity: 0 });
    gsap.set(q(".ge-cmd"), { opacity: 0 });
    gsap.set(q(".vblank-flash"), { opacity: 0 });
    gsap.set(q(".clock-hand"), { rotation: 0, transformOrigin: "50% 100%" });
    gsap.set(q(".pulse"), { opacity: 0, scale: 1, transformOrigin: "center" });
  };

  // Light up a block's glow ring for the duration of its work.
  const activate = (tl: gsap.core.Timeline, sel: string, at: number, dur: number) => {
    tl.to(sel, { opacity: 0.9, duration: 0.25 }, at);
    tl.to(sel, { opacity: 0, duration: 0.35 }, at + dur);
  };

  const tl = gsap.timeline({ repeat: -1, paused: true, defaults: { ease: "power2.inOut" } });

  resetScene();

  // ----- stage 1: instruction stream into the CPU (fetch/decode/execute) -----
  // Instructions flow continuously from the left edge into the CPU block for the
  // whole "CPU runs in slices" portion of the frame.
  activate(tl, ".glow-cpu", 0, 4.4);
  const instrs = q(".instr");
  instrs.forEach((node, i) => {
    const start = i * 0.32;
    tl.fromTo(
      node,
      { opacity: 0, x: -70 },
      { opacity: 1, x: 0, duration: 0.42, ease: "none" },
      start,
    );
    // travel through fetch -> decode -> execute, then consumed
    tl.to(node, { x: 64, duration: 0.6, ease: "none" }, start + 0.42);
    tl.to(node, { x: 120, opacity: 0, duration: 0.45, ease: "power1.in" }, start + 1.0);
  });

  // pipeline stage labels pulse in order as instructions pass
  tl.to(q(".pipe-fetch"), { opacity: 1, duration: 0.2 }, 0.2)
    .to(q(".pipe-decode"), { opacity: 1, duration: 0.2 }, 0.5)
    .to(q(".pipe-exec"), { opacity: 1, duration: 0.2 }, 0.8);

  // ----- stage 2: a SYSCALL peels off into the HLE kernel and returns -----
  // pendingSyscall >= 0 -> hle.dispatch() -> result returns to the CPU.
  activate(tl, ".glow-hle", 1.4, 1.2);
  tl.set(q(".syscall-dot"), { opacity: 1, x: 0, y: 0 }, 1.4)
    .to(q(".syscall-dot"), { x: 50, y: -108, duration: 0.55 }, 1.4)
    .to(q(".syscall-dot"), { fill: "var(--fc-ge)", duration: 0.01 }, 1.95)
    // dispatch result travels back down to the CPU
    .to(q(".syscall-dot"), { x: 0, y: 0, duration: 0.55 }, 2.4)
    .to(q(".glow-cpu"), { opacity: 0.9, duration: 0.2 }, 2.95)
    .to(q(".glow-cpu"), { opacity: 0, duration: 0.3 }, 3.2)
    .to(q(".syscall-dot"), { opacity: 0, duration: 0.2 }, 2.95)
    .set(q(".syscall-dot"), { fill: "var(--fc-syscall)" }, 3.2);

  // ----- stage 3: kernel hands GE display-list commands to the GEProcessor -----
  // The kernel drains queued GE lists into GEProcessor.executeCommand, which
  // rasterizes into the framebuffer (cells fill to make a small triangle shape).
  activate(tl, ".glow-ge", 2.6, 2.4);
  const geCmds = q(".ge-cmd");
  geCmds.forEach((node, i) => {
    const start = 2.6 + i * 0.28;
    tl.fromTo(
      node,
      { opacity: 0, x: -40 },
      { opacity: 1, x: 0, duration: 0.3, ease: "none" },
      start,
    );
    tl.to(node, { x: 60, opacity: 0, duration: 0.4, ease: "power1.in" }, start + 0.3);
  });
  // framebuffer fills in (raster sweep) as commands arrive
  fbCells.forEach((cell, i) => {
    const lit = (cell as HTMLElement).dataset.lit === "1";
    tl.to(
      cell,
      { fill: lit ? "var(--fc-ge)" : "var(--fc-grid)", opacity: lit ? 1 : 0.18, duration: 0.16 },
      2.9 + i * 0.045,
    );
  });

  // ----- stage 4: CoreTiming advances until the VBlank event fires -----
  // coreTiming.advance(ran) moves the clock; the loop repeats stages 1-4 until
  // the scheduled VBlank event is due.
  activate(tl, ".glow-time", 0, 5.4);
  tl.to(q(".clock-hand"), { rotation: 330, duration: 5.0, ease: "none" }, 0.2);
  // tick pulses at the timing block while it advances
  tl.to(q(".tick"), { opacity: 0.9, duration: 0.12, stagger: { each: 0.5, repeat: 9, yoyo: true } }, 0.2);

  // ----- VBlank fires + present: framebuffer flips onto the screen -----
  activate(tl, ".glow-present", 5.2, 1.2);
  tl.to(q(".clock-hand"), { rotation: 360, duration: 0.4, ease: "power3.out" }, 5.2);
  tl.fromTo(q(".vblank-flash"), { opacity: 0, scale: 0.6 }, { opacity: 0.85, scale: 1, duration: 0.3, transformOrigin: "center" }, 5.2)
    .to(q(".vblank-flash"), { opacity: 0, duration: 0.5 }, 5.6);
  // copy each lit framebuffer cell onto the screen (the present)
  fbCells.forEach((cell, i) => {
    const lit = (cell as HTMLElement).dataset.lit === "1";
    const screen = screenCells[i];
    if (!screen) return;
    tl.to(
      screen,
      { fill: lit ? "var(--fc-present)" : "var(--fc-grid)", opacity: lit ? 1 : 0.12, duration: 0.18 },
      5.5 + i * 0.02,
    );
  });
  // hold the presented image, then reset for the next frame
  tl.to({}, { duration: 0.9 }, 6.1);
  tl.add(() => resetScene(), 7.0);

  if (reduced) {
    // Reduced motion: show a representative still (mid-rasterize) and don't loop.
    tl.progress(0.45).pause();
  } else {
    // Only run while the diagram is on screen, to avoid burning CPU.
    if (typeof IntersectionObserver === "function") {
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) tl.play();
            else tl.pause();
          }
        },
        { threshold: 0.2 },
      );
      io.observe(el);
      cleanup = () => {
        io.disconnect();
        tl.kill();
      };
    } else {
      tl.play();
      cleanup = () => tl.kill();
    }
  }

  if (!cleanup) cleanup = () => tl.kill();
});

onBeforeUnmount(() => {
  cleanup?.();
  cleanup = null;
});

// Framebuffer 8x5 grid. A subset of cells form a small triangle so the raster
// "draws" a recognizable shape rather than random noise. lit=1 cells light up.
const COLS = 8;
const ROWS = 5;
const triangle = (c: number, r: number) => {
  // a downward-pointing-ish filled triangle in the grid
  const half = Math.floor(COLS / 2);
  const spread = Math.floor((r / (ROWS - 1)) * half);
  return c >= half - spread && c <= half + spread - (spread > 0 ? 1 : 0);
};
const fb: { x: number; y: number; lit: boolean }[] = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    fb.push({ x: c, y: r, lit: triangle(c, r) });
  }
}
</script>

<template>
  <div ref="root" class="frame-cycle" role="img"
       aria-label="Animated diagram of one emulation frame: a stream of MIPS instructions runs through the CPU fetch, decode and execute pipeline; a syscall peels off into the HLE kernel and returns; the kernel feeds GE commands to the GE processor which rasterizes a shape into a framebuffer; CoreTiming advances a clock until the VBlank event fires; then the framebuffer is presented to the screen and the loop repeats.">
    <svg viewBox="0 0 760 360" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;font-family:inherit">
      <!-- ===================== CPU block ===================== -->
      <g class="block">
        <rect class="glow glow-cpu" x="56" y="120" width="190" height="96" rx="10" />
        <rect class="card" x="56" y="120" width="190" height="96" rx="10" />
        <text class="title" x="151" y="142" text-anchor="middle">AllegrexCPU</text>
        <text class="sub" x="151" y="159" text-anchor="middle">cpu.run(slice)</text>
        <!-- pipeline lanes -->
        <text class="pipe pipe-fetch" x="84" y="196" text-anchor="middle">fetch</text>
        <text class="pipe pipe-decode" x="151" y="196" text-anchor="middle">decode</text>
        <text class="pipe pipe-exec" x="218" y="196" text-anchor="middle">execute</text>
        <line class="lane" x1="68" y1="178" x2="234" y2="178" />
      </g>

      <!-- instruction stream feeding the CPU from the left -->
      <g clip-path="url(#cpuClip)">
        <rect v-for="n in 7" :key="'i' + n" class="instr"
              :x="62" :y="168 + ((n - 1) % 3) * 6" width="22" height="13" rx="3" />
      </g>
      <clipPath id="cpuClip"><rect x="56" y="120" width="190" height="96" rx="10" /></clipPath>
      <text class="flow-label" x="30" y="174" text-anchor="middle">MIPS</text>

      <!-- ===================== HLE kernel block (above CPU) ===================== -->
      <g class="block">
        <rect class="glow glow-hle" x="206" y="20" width="190" height="74" rx="10" />
        <rect class="card" x="206" y="20" width="190" height="74" rx="10" />
        <text class="title" x="301" y="46" text-anchor="middle">HLEKernel</text>
        <text class="sub" x="301" y="65" text-anchor="middle">hle.dispatch(code)</text>
        <text class="sub dim" x="301" y="81" text-anchor="middle">pendingSyscall handoff</text>
      </g>
      <!-- syscall path CPU -> kernel -->
      <path class="conn dashed" d="M156 120 L156 96 Q156 78 206 66" />
      <circle class="syscall-dot" cx="156" cy="174" r="6" />
      <text class="conn-label" x="120" y="108">SYSCALL</text>

      <!-- ===================== GE processor block ===================== -->
      <g class="block">
        <rect class="glow glow-ge" x="430" y="120" width="180" height="96" rx="10" />
        <rect class="card" x="430" y="120" width="180" height="96" rx="10" />
        <text class="title" x="520" y="144" text-anchor="middle">GEProcessor</text>
        <text class="sub" x="520" y="161" text-anchor="middle">executeCommand()</text>
        <text class="sub dim" x="520" y="200" text-anchor="middle">rasterizes inline</text>
      </g>
      <!-- kernel -> GE command flow -->
      <path class="conn" d="M396 58 Q470 58 470 120" />
      <text class="conn-label" x="436" y="50">GE list</text>
      <g clip-path="url(#geClip)">
        <rect v-for="n in 5" :key="'g' + n" class="ge-cmd"
              :x="450" :y="172" width="18" height="11" rx="2" />
      </g>
      <clipPath id="geClip"><rect x="430" y="166" width="180" height="24" /></clipPath>

      <!-- ===================== framebuffer grid (GE target) ===================== -->
      <g class="block">
        <rect class="card thin" x="636" y="120" width="100" height="70" rx="6" />
        <text class="caption" x="686" y="112" text-anchor="middle">framebuffer</text>
        <g>
          <rect v-for="(cell, i) in fb" :key="'f' + i" class="fb-cell"
                :data-lit="cell.lit ? '1' : '0'"
                :x="642 + cell.x * 11.5" :y="126 + cell.y * 11.5"
                width="10" height="10" rx="1.5" />
        </g>
      </g>

      <!-- ===================== CoreTiming clock ===================== -->
      <g class="block">
        <rect class="glow glow-time" x="206" y="244" width="190" height="92" rx="10" />
        <rect class="card" x="206" y="244" width="190" height="92" rx="10" />
        <text class="title" x="270" y="270" text-anchor="middle">CoreTiming</text>
        <text class="sub" x="270" y="288" text-anchor="middle">advance(ran)</text>
        <text class="sub dim" x="270" y="324" text-anchor="middle">until VBlank</text>
        <!-- clock face -->
        <circle class="clock-face" cx="352" cy="290" r="26" />
        <line class="clock-hand" x1="352" y1="290" x2="352" y2="270" />
        <circle class="clock-pin" cx="352" cy="290" r="2.4" />
        <circle class="tick" cx="352" cy="262" r="2.6" />
      </g>

      <!-- ===================== present / screen ===================== -->
      <g class="block">
        <rect class="glow glow-present" x="430" y="244" width="306" height="92" rx="10" />
        <rect class="card" x="430" y="244" width="306" height="92" rx="10" />
        <text class="title" x="488" y="270" text-anchor="middle">Present</text>
        <text class="sub" x="488" y="288" text-anchor="middle">on VBlank</text>
        <text class="sub dim" x="488" y="324" text-anchor="middle">WebGL / software</text>
        <!-- the screen mirrors the framebuffer -->
        <rect class="card thin" x="556" y="256" width="100" height="70" rx="6" />
        <rect class="vblank-flash" x="556" y="256" width="100" height="70" rx="6" />
        <g>
          <rect v-for="(cell, i) in fb" :key="'s' + i" class="screen-cell"
                :x="562 + cell.x * 11.5" :y="262 + cell.y * 11.5"
                width="10" height="10" rx="1.5" />
        </g>
      </g>

      <!-- ===================== connectors ===================== -->
      <!-- GE -> framebuffer -->
      <path class="conn" d="M610 155 L636 155" marker-end="url(#arrow)" />
      <!-- framebuffer -> screen (present) -->
      <path class="conn dashed" d="M686 190 Q686 230 606 256" marker-end="url(#arrow)" />
      <!-- loop back: present -> CPU (next frame) -->
      <path class="conn dashed" d="M430 300 Q140 300 140 216" marker-end="url(#arrow)" />
      <text class="conn-label" x="250" y="318">repeats until VBlank</text>

      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" class="arrow-head" />
        </marker>
      </defs>
    </svg>
  </div>
</template>

<style scoped>
.frame-cycle {
  /* color tokens, theme-aware */
  --fc-card: var(--vp-c-bg-soft);
  --fc-stroke: var(--vp-c-divider);
  --fc-text: var(--vp-c-text-1);
  --fc-dim: var(--vp-c-text-2);
  --fc-cpu: #1f6feb;
  --fc-syscall: #f0883e;
  --fc-ge: #2ea043;
  --fc-time: #a371f7;
  --fc-present: #db61a2;
  --fc-grid: var(--vp-c-divider);
  margin: 1.25rem 0;
  max-width: 100%;
}

.card {
  fill: var(--fc-card);
  stroke: var(--fc-stroke);
  stroke-width: 1.2;
}
.card.thin {
  fill: transparent;
  stroke-width: 1;
}
.glow {
  fill: none;
  opacity: 0;
}
.glow-cpu { stroke: var(--fc-cpu); }
.glow-hle { stroke: var(--fc-syscall); }
.glow-ge { stroke: var(--fc-ge); }
.glow-time { stroke: var(--fc-time); }
.glow-present { stroke: var(--fc-present); }
.glow {
  stroke-width: 2.4;
  filter: drop-shadow(0 0 4px currentColor);
}

.title {
  fill: var(--fc-text);
  font-size: 14px;
  font-weight: 700;
}
.sub {
  fill: var(--fc-text);
  opacity: 0.85;
  font-size: 11px;
}
.sub.dim, .dim { opacity: 0.55; }
.caption {
  fill: var(--fc-dim);
  font-size: 10.5px;
}

.pipe {
  fill: var(--fc-text);
  opacity: 0.35;
  font-size: 10.5px;
}
.lane {
  stroke: var(--fc-stroke);
  stroke-width: 1;
  opacity: 0.5;
}
.flow-label {
  fill: var(--fc-dim);
  font-size: 10px;
}

.instr {
  fill: var(--fc-cpu);
}
.ge-cmd {
  fill: var(--fc-ge);
}
.syscall-dot {
  fill: var(--fc-syscall);
}

.fb-cell { fill: var(--fc-grid); opacity: 0.18; }
.screen-cell { fill: var(--fc-grid); opacity: 0.12; }
.vblank-flash { fill: var(--fc-present); opacity: 0; }

.clock-face {
  fill: none;
  stroke: var(--fc-time);
  stroke-width: 1.6;
  opacity: 0.8;
}
.clock-hand {
  stroke: var(--fc-time);
  stroke-width: 2;
  stroke-linecap: round;
}
.clock-pin { fill: var(--fc-time); }
.tick { fill: var(--fc-time); opacity: 0; }

.conn {
  fill: none;
  stroke: var(--fc-stroke);
  stroke-width: 1.6;
}
.conn.dashed { stroke-dasharray: 5 4; }
.arrow-head { fill: var(--fc-stroke); }
.conn-label {
  fill: var(--fc-dim);
  font-size: 10px;
}
</style>
