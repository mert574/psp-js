<script setup lang="ts">
// Browser-only animated diagram of one runFrame() of the emulator.
// GSAP and the DOM are only touched inside onMounted, so this is safe to
// import at build time but it never runs during SSR (the page wraps it in
// <ClientOnly>, and the timeline is built after mount).
import { onMounted, onBeforeUnmount, ref } from "vue";

// ---- shared grid geometry (VRAM grid, screen grid, present flash derive from
// these so they line up by construction) ----
const COLS = 8;
const ROWS = 5;
const PITCH = 11;
const CELL = 10;
const gridW = (COLS - 1) * PITCH + CELL;
const gridH = (ROWS - 1) * PITCH + CELL;

const VGX = 597; // VRAM framebuffer grid origin (inside the VRAM sub-node)
const VGY = 258;
const SGX = 600; // present screen grid origin
const SGY = 434;

const triangle = (c: number, r: number) => {
  const half = Math.floor(COLS / 2);
  const spread = Math.floor((r / (ROWS - 1)) * half);
  return c >= half - spread && c <= half + spread - (spread > 0 ? 1 : 0);
};
const cells: { x: number; y: number; lit: boolean }[] = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) cells.push({ x: c, y: r, lit: triangle(c, r) });
}
// RAM "memory rows" visualization: rows of varying width.
const ramRows = [96, 72, 88, 60, 80, 68];

const root = ref<HTMLElement | null>(null);
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

  const vramCells = q(".vram-cell");
  const screenCells = q(".screen-cell");

  const resetScene = () => {
    gsap.set(vramCells, { fill: "var(--fc-grid)", opacity: 0.18 });
    gsap.set(screenCells, { fill: "var(--fc-grid)", opacity: 0.12 });
    gsap.set(q(".ram-bar"), { opacity: 0.3 });
    gsap.set(q(".flow-dot"), { opacity: 0, x: 0, y: 0 }); // every moving token
    gsap.set(q(".instr"), { opacity: 0 });
    gsap.set(q(".gpu-core"), { opacity: 0.22 });
    gsap.set(q(".present-flash"), { opacity: 0 });
    gsap.set(q(".pipe"), { opacity: 0.35 });
    gsap.set(q(".clock-hand"), { rotation: 0, transformOrigin: "50% 100%" });
  };

  const activate = (sel: string, at: number, dur: number) => {
    tl.to(sel, { opacity: 0.9, duration: 0.25 }, at);
    tl.to(sel, { opacity: 0, duration: 0.35 }, at + dur);
  };
  // a token that travels along an axis from its base, used for ambient motion
  const travel = (sel: string, at: number, dx: number, dy: number, dur = 0.4) => {
    tl.set(q(sel), { opacity: 1, x: 0, y: 0 }, at)
      .to(q(sel), { x: dx, y: dy, duration: dur, ease: "none" }, at)
      .to(q(sel), { opacity: 0, duration: 0.12 }, at + dur);
  };

  const tl = gsap.timeline({ repeat: -1, paused: true, defaults: { ease: "power2.inOut" } });
  resetScene();

  // continuous RAM shimmer (memory is always busy)
  tl.to(q(".ram-bar"), { opacity: "random(0.25, 0.7)", duration: 0.5, stagger: { each: 0.2, repeat: 16, yoyo: true } }, 0);

  // ----- stage 1: CoreTiming wakes the CPU thread, then instructions run -----
  activate(".glow-time", 0, 0.5);
  travel(".wake-dot", 0, 0, -42, 0.4);
  activate(".glow-cpu", 0.3, 4.4);
  // a proper pipeline: each instruction slides into fetch, then steps to decode
  // and execute one stage at a time; staggered so the three lanes stay busy at once
  q(".instr").forEach((node, i) => {
    const start = 0.4 + i * 0.21;
    tl.fromTo(node, { opacity: 0, x: -56 }, { opacity: 1, x: 0, duration: 0.14, ease: "power2.out" }, start);
    tl.to(node, { x: 63, duration: 0.15, ease: "power2.inOut" }, start + 0.21);
    tl.to(node, { x: 126, duration: 0.15, ease: "power2.inOut" }, start + 0.42);
    tl.to(node, { x: 189, opacity: 0, duration: 0.17, ease: "power1.in" }, start + 0.63);
  });
  tl.to(q(".pipe-fetch"), { opacity: 1, duration: 0.2 }, 0.45)
    .to(q(".pipe-decode"), { opacity: 1, duration: 0.2 }, 0.66)
    .to(q(".pipe-exec"), { opacity: 1, duration: 0.2 }, 0.87);
  // CPU <-> RAM: stores flow out, loads flow back (both directions move)
  for (let k = 0; k < 5; k++) {
    travel(".store-dot", 0.6 + k * 0.78, 108, 0, 0.34);
    travel(".load-dot", 1.0 + k * 0.78, -108, 0, 0.34);
  }

  // ----- stage 2: a SYSCALL peels off into the HLE kernel and returns -----
  activate(".glow-hle", 1.6, 1.4);
  tl.set(q(".syscall-dot"), { opacity: 1, x: 0, y: 0, fill: "var(--fc-syscall)" }, 1.6)
    .to(q(".syscall-dot"), { y: -170, duration: 0.55 }, 1.6)
    .to(q(".syscall-dot"), { y: 0, duration: 0.55 }, 2.6)
    .to(q(".glow-cpu"), { opacity: 0.9, duration: 0.2 }, 3.15)
    .to(q(".glow-cpu"), { opacity: 0, duration: 0.3 }, 3.4)
    .to(q(".syscall-dot"), { opacity: 0, duration: 0.2 }, 3.15);
  // the kernel handler reads args from RAM and writes results back
  travel(".kmem-dot", 2.05, 122, 88, 0.4); // kernel -> RAM (read args)
  tl.set(q(".kmem-dot"), { opacity: 1, x: 122, y: 88 }, 2.55)
    .to(q(".kmem-dot"), { x: 0, y: 0, duration: 0.4, ease: "none" }, 2.55)
    .to(q(".kmem-dot"), { opacity: 0, duration: 0.12 }, 2.95);

  // ----- stage 3: kernel dispatches the GE list; GPU reads RAM, writes VRAM -----
  activate(".glow-ge", 2.7, 2.0);
  travel(".ge-dot", 2.7, 108, 0, 0.42);
  for (let k = 0; k < 4; k++) travel(".read-dot", 2.95 + k * 0.32, 0, -86, 0.3);
  // the GPU's many lanes shade in parallel: cores flicker together while it works
  tl.to(q(".gpu-core"), { opacity: "random(0.45, 1)", duration: 0.16, stagger: { each: 0.02, from: "random", repeat: 8, yoyo: true } }, 2.95);
  tl.to(q(".gpu-core"), { opacity: 0.22, duration: 0.3 }, 4.75); // settle to idle once rasterizing is done
  // pixel tokens fan into VRAM in parallel bursts (the three .pixel dots move together)
  for (let k = 0; k < 5; k++) travel(".pixel", 3.25 + k * 0.3, 0, 165, 0.34);
  // framebuffer fills a whole row at a time (parallel), not cell-by-cell
  vramCells.forEach((cell, i) => {
    const lit = (cell as HTMLElement).dataset.lit === "1";
    const row = Math.floor(i / COLS);
    tl.to(cell, { fill: lit ? "var(--fc-ge)" : "var(--fc-grid)", opacity: lit ? 1 : 0.18, duration: 0.2 }, 3.3 + row * 0.3);
  });

  // ----- stage 4: CoreTiming advances; it only lights when it fires a signal -----
  tl.to(q(".clock-hand"), { rotation: 330, duration: 5.0, ease: "none" }, 0.2);
  tl.to(q(".tick"), { opacity: 0.9, duration: 0.12, stagger: { each: 0.4, repeat: 11, yoyo: true } }, 0.2);

  // ----- VBlank fires (CoreTiming) and triggers the present -----
  activate(".glow-time", 5.2, 0.6);
  tl.to(q(".clock-hand"), { rotation: 360, duration: 0.4, ease: "power3.out" }, 5.2);
  travel(".vblank-dot", 5.2, 108, 0, 0.4);
  activate(".glow-present", 5.5, 1.3);
  tl.fromTo(q(".present-flash"), { opacity: 0 }, { opacity: 0.5, duration: 0.25 }, 5.55)
    .to(q(".present-flash"), { opacity: 0, duration: 0.55 }, 5.85);
  for (let k = 0; k < 3; k++) travel(".scan-dot", 5.5 + k * 0.22, 3, 86, 0.36);
  vramCells.forEach((cell, i) => {
    const lit = (cell as HTMLElement).dataset.lit === "1";
    const screen = screenCells[i];
    if (!screen) return;
    const row = Math.floor(i / COLS);
    tl.to(screen, { fill: lit ? "var(--fc-present)" : "var(--fc-grid)", opacity: lit ? 1 : 0.12, duration: 0.18 }, 5.6 + row * 0.12);
  });
  tl.to({}, { duration: 0.9 }, 6.6);
  tl.add(() => resetScene(), 7.7);

  if (reduced) {
    tl.progress(0.46).pause();
  } else if (typeof IntersectionObserver === "function") {
    const io = new IntersectionObserver(
      (entries) => { for (const e of entries) (e.isIntersecting ? tl.play() : tl.pause()); },
      { threshold: 0.2 },
    );
    io.observe(el);
    cleanup = () => { io.disconnect(); tl.kill(); };
  } else {
    tl.play();
    cleanup = () => tl.kill();
  }
  if (!cleanup) cleanup = () => tl.kill();
});

onBeforeUnmount(() => { cleanup?.(); cleanup = null; });
</script>

<template>
  <div ref="root" class="frame-cycle" role="img"
       aria-label="Animated two-column diagram of one emulation frame. Left column (execution): CoreTiming wakes the CPU thread, the CPU runs its fetch/decode/execute pipeline and loads/stores against RAM, and a syscall peels up into the HLE kernel which itself reads arguments from RAM and writes results back. Right column (graphics): the kernel dispatches a GE display list to the GE processor, which is the PSP GPU; it reads the list and vertices from RAM and writes pixels into the VRAM framebuffer of the central MemoryBus. When CoreTiming's scheduled VBlank event fires it triggers Present to scan the VRAM framebuffer out to the screen, then CoreTiming wakes the CPU for the next frame.">
    <svg viewBox="0 0 760 540" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;font-family:inherit">
      <defs>
        <marker id="fc-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" class="arrow-head" />
        </marker>
      </defs>

      <!-- ============ connector lines (under the cards) ============ -->
      <path class="conn dashed" d="M104 412 L104 370" marker-end="url(#fc-arrow)" />
      <text class="conn-label" x="112" y="396" text-anchor="start">wakes CPU</text>
      <path class="conn dashed" d="M214 170 L214 120" marker-end="url(#fc-arrow)" />
      <text class="conn-label" x="222" y="156" text-anchor="start">syscall</text>
      <!-- kernel <-> RAM: handler reads args, writes results (data, both ways) -->
      <path class="conn" d="M312 120 Q400 152 434 208" marker-start="url(#fc-arrow)" marker-end="url(#fc-arrow)" />
      <text class="conn-label" x="372" y="140" text-anchor="middle" transform="rotate(33 372 140)">args / results</text>
      <!-- rung: kernel -> GE dispatch (top) -->
      <path class="conn" d="M326 78 L434 78" marker-end="url(#fc-arrow)" />
      <text class="conn-label" x="380" y="66" text-anchor="middle">dispatch GE list</text>
      <!-- rung: CPU <-> RAM (store out on top, load back on the bottom) -->
      <path class="conn" d="M326 266 L434 266" marker-end="url(#fc-arrow)" />
      <path class="conn" d="M434 278 L326 278" marker-end="url(#fc-arrow)" />
      <text class="conn-label" x="380" y="258" text-anchor="middle">load / store</text>
      <!-- rung: CoreTiming -> Present VBlank (bottom) -->
      <path class="conn dashed" d="M326 458 L434 458" marker-end="url(#fc-arrow)" />
      <text class="conn-label" x="380" y="450" text-anchor="middle">VBlank fires</text>
      <!-- right column: RAM -> GE reads / GE -> VRAM writes / VRAM -> Present scan-out -->
      <path class="conn" d="M510 170 L510 120" marker-end="url(#fc-arrow)" />
      <text class="conn-label" x="502" y="150" text-anchor="end">reads</text>
      <path class="conn" d="M640 120 L640 170" marker-end="url(#fc-arrow)" />
      <text class="conn-label" x="648" y="150" text-anchor="start">writes pixels</text>
      <path class="conn" d="M640 370 L640 412" marker-end="url(#fc-arrow)" />
      <text class="conn-label" x="650" y="392" text-anchor="start">scan-out</text>

      <!-- ===================== HLE kernel (left, top) ===================== -->
      <g class="block">
        <title>HLEKernel: implements the PSP syscalls in TypeScript and schedules threads. Handlers read arguments from RAM and write results back.</title>
        <rect class="glow glow-hle" x="44" y="36" width="282" height="84" rx="10" />
        <rect class="card" x="44" y="36" width="282" height="84" rx="10" />
        <text class="title" x="185" y="64" text-anchor="middle">HLEKernel</text>
        <text class="sub" x="185" y="83" text-anchor="middle">hle.dispatch(code)</text>
        <text class="sub dim" x="185" y="100" text-anchor="middle">pendingSyscall handoff</text>
      </g>

      <!-- ===================== CPU (left, middle) ===================== -->
      <g class="block">
        <title>AllegrexCPU: the MIPS Allegrex interpreter. Fetches, decodes and executes one slice of instructions per call.</title>
        <rect class="glow glow-cpu" x="44" y="170" width="282" height="200" rx="10" />
        <rect class="card" x="44" y="170" width="282" height="200" rx="10" />
        <text class="title" x="185" y="206" text-anchor="middle">AllegrexCPU</text>
        <text class="sub" x="185" y="226" text-anchor="middle">cpu.run(slice)</text>
        <line class="lane" x1="60" y1="318" x2="310" y2="318" />
        <text class="pipe pipe-fetch" x="122" y="338" text-anchor="middle">fetch</text>
        <text class="pipe pipe-decode" x="185" y="338" text-anchor="middle">decode</text>
        <text class="pipe pipe-exec" x="248" y="338" text-anchor="middle">execute</text>
        <!-- little chip glyph so it reads as a processor -->
        <g class="chip chip-cpu">
          <rect class="chip-body" x="294" y="186" width="18" height="18" rx="2" />
          <rect class="chip-die" x="299" y="191" width="8" height="8" rx="1" />
          <line class="chip-pin" x1="298" y1="182" x2="298" y2="186" />
          <line class="chip-pin" x1="303" y1="182" x2="303" y2="186" />
          <line class="chip-pin" x1="308" y1="182" x2="308" y2="186" />
          <line class="chip-pin" x1="298" y1="204" x2="298" y2="208" />
          <line class="chip-pin" x1="303" y1="204" x2="303" y2="208" />
          <line class="chip-pin" x1="308" y1="204" x2="308" y2="208" />
        </g>
      </g>
      <g clip-path="url(#fcCpuClip)">
        <rect v-for="n in 16" :key="'i' + n" class="instr"
              :x="111" y="298" width="22" height="14" rx="3" />
      </g>
      <clipPath id="fcCpuClip"><rect x="44" y="276" width="282" height="44" /></clipPath>

      <!-- ===================== CoreTiming (left, bottom) ===================== -->
      <g class="block">
        <title>CoreTiming: the cycle-based event scheduler. Fires VBlank and wakes the threads that were waiting on it.</title>
        <rect class="glow glow-time" x="44" y="412" width="282" height="90" rx="10" />
        <rect class="card" x="44" y="412" width="282" height="90" rx="10" />
        <text class="title" x="64" y="444" text-anchor="start">CoreTiming</text>
        <text class="sub" x="64" y="463" text-anchor="start">advance(ran)</text>
        <text class="sub dim" x="64" y="481" text-anchor="start">until VBlank</text>
        <circle class="clock-face" cx="256" cy="458" r="26" />
        <line class="clock-hand" x1="256" y1="458" x2="256" y2="437" />
        <circle class="clock-pin" cx="256" cy="458" r="2.6" />
        <circle class="tick" cx="256" cy="434" r="2.8" />
      </g>

      <!-- ===================== GE processor / GPU (right, top) ===================== -->
      <g class="block">
        <title>GEProcessor: the PSP GPU (Graphics Engine). Runs the display-list commands and rasterizes, inline on the main thread.</title>
        <rect class="glow glow-ge" x="434" y="36" width="282" height="84" rx="10" />
        <rect class="card" x="434" y="36" width="282" height="84" rx="10" />
        <text class="title" x="575" y="60" text-anchor="middle">GEProcessor</text>
        <text class="sub" x="575" y="77" text-anchor="middle">the PSP GPU</text>
        <!-- parallel "cores": many lanes shade at once, unlike the CPU's single pipeline -->
        <rect v-for="n in 16" :key="'gc' + n" class="gpu-core"
              :x="470 + (n - 1) * 13" y="88" width="8" height="18" rx="1.5" />
        <!-- little chip glyph so it reads as the GPU -->
        <g class="chip">
          <rect class="chip-body" x="684" y="50" width="18" height="18" rx="2" />
          <rect class="chip-die" x="689" y="55" width="8" height="8" rx="1" />
          <line class="chip-pin" x1="688" y1="46" x2="688" y2="50" />
          <line class="chip-pin" x1="693" y1="46" x2="693" y2="50" />
          <line class="chip-pin" x1="698" y1="46" x2="698" y2="50" />
          <line class="chip-pin" x1="688" y1="68" x2="688" y2="72" />
          <line class="chip-pin" x1="693" y1="68" x2="693" y2="72" />
          <line class="chip-pin" x1="698" y1="68" x2="698" y2="72" />
        </g>
      </g>

      <!-- ===================== MemoryBus (right, middle; RAM + VRAM) ===================== -->
      <g class="block">
        <title>MemoryBus: RAM holds code, GE display lists and vertices; VRAM holds the framebuffer the GPU draws into.</title>
        <rect class="glow glow-mem" x="434" y="170" width="282" height="200" rx="10" />
        <rect class="card" x="434" y="170" width="282" height="200" rx="10" />
        <text class="title" x="575" y="192" text-anchor="middle">MemoryBus</text>
        <!-- RAM sub-node (left half) with a "memory rows" visualization -->
        <rect class="subcard" x="450" y="206" width="120" height="148" rx="6" />
        <text class="subtitle" x="462" y="226" text-anchor="start">RAM</text>
        <text class="note" x="462" y="241" text-anchor="start">code, lists, verts</text>
        <rect v-for="(w, r) in ramRows" :key="'r' + r" class="ram-bar"
              :x="462" :y="252 + r * 15" :width="w" height="8" rx="2" />
        <!-- VRAM sub-node (right half; holds the framebuffer) -->
        <rect class="subcard" x="580" y="206" width="120" height="148" rx="6" />
        <text class="subtitle" x="592" y="226" text-anchor="start">VRAM</text>
        <text class="note" x="592" y="241" text-anchor="start">framebuffer</text>
        <rect v-for="(c, i) in cells" :key="'v' + i" class="vram-cell"
              :data-lit="c.lit ? '1' : '0'"
              :x="VGX + c.x * PITCH" :y="VGY + c.y * PITCH" :width="CELL" :height="CELL" rx="1.5" />
      </g>

      <!-- ===================== Present / screen (right, bottom) ===================== -->
      <g class="block">
        <title>Present: copies the finished VRAM framebuffer to the screen, via WebGL or the software rasterizer, each VBlank.</title>
        <rect class="glow glow-present" x="434" y="412" width="282" height="90" rx="10" />
        <rect class="card" x="434" y="412" width="282" height="90" rx="10" />
        <text class="title" x="454" y="444" text-anchor="start">Present</text>
        <text class="sub" x="454" y="463" text-anchor="start">on VBlank</text>
        <text class="sub dim" x="454" y="481" text-anchor="start">WebGL / software</text>
        <rect class="grid-border" :x="SGX - 4" :y="SGY - 4" :width="gridW + 8" :height="gridH + 8" rx="4" />
        <rect v-for="(c, i) in cells" :key="'s' + i" class="screen-cell"
              :x="SGX + c.x * PITCH" :y="SGY + c.y * PITCH" :width="CELL" :height="CELL" rx="1.5" />
        <rect class="present-flash" :x="SGX" :y="SGY" :width="gridW" :height="gridH" rx="2" />
      </g>

      <!-- ============ moving tokens (on top of everything) ============ -->
      <circle class="flow-dot wake-dot" cx="104" cy="412" r="5" />
      <circle class="flow-dot syscall-dot" cx="210" cy="250" r="6" />
      <circle class="flow-dot kmem-dot" cx="312" cy="120" r="5" />
      <circle class="flow-dot ge-dot" cx="326" cy="78" r="5" />
      <circle class="flow-dot store-dot" cx="326" cy="266" r="5" />
      <circle class="flow-dot load-dot" cx="434" cy="278" r="5" />
      <circle class="flow-dot read-dot" cx="510" cy="206" r="5" />
      <circle class="flow-dot pixel" cx="640" cy="120" r="5" />
      <circle class="flow-dot pixel" cx="622" cy="120" r="4" />
      <circle class="flow-dot pixel" cx="658" cy="120" r="4" />
      <circle class="flow-dot scan-dot" cx="640" cy="354" r="5" />
      <circle class="flow-dot vblank-dot" cx="326" cy="458" r="5" />
    </svg>
  </div>
</template>

<style scoped>
.frame-cycle {
  --fc-card: var(--vp-c-bg-soft);
  --fc-stroke: var(--vp-c-divider);
  --fc-wire: var(--vp-c-text-2);
  --fc-cpu: #1f6feb;
  --fc-syscall: #f0883e;
  --fc-ge: #2ea043;
  --fc-mem: #6e7681;
  --fc-time: #a371f7;
  --fc-present: #db61a2;
  --fc-grid: var(--vp-c-divider);
  margin: 1.25rem 0;
  max-width: 100%;
}

.block { cursor: help; }
.card { fill: var(--fc-card); stroke: var(--fc-stroke); stroke-width: 1.2; }
.subcard { fill: var(--vp-c-bg); stroke: var(--fc-stroke); stroke-width: 1; opacity: 0.85; }
.glow { fill: none; opacity: 0; stroke-width: 2.4; filter: drop-shadow(0 0 4px currentColor); }
.glow-cpu { stroke: var(--fc-cpu); }
.glow-hle { stroke: var(--fc-syscall); }
.glow-ge { stroke: var(--fc-ge); }
.glow-mem { stroke: var(--fc-mem); }
.glow-time { stroke: var(--fc-time); }
.glow-present { stroke: var(--fc-present); }

.title { fill: var(--vp-c-text-1); font-size: 14px; font-weight: 700; }
.subtitle { fill: var(--vp-c-text-1); font-size: 11px; font-weight: 600; }
.sub { fill: var(--vp-c-text-1); opacity: 0.85; font-size: 11px; }
.sub.dim, .dim { opacity: 0.55; }
.note { fill: var(--vp-c-text-2); font-size: 9.5px; }

.pipe { fill: var(--vp-c-text-1); opacity: 0.35; font-size: 10.5px; }
.lane { stroke: var(--fc-stroke); stroke-width: 1; opacity: 0.5; }

.instr { fill: var(--fc-cpu); }
.ram-bar { fill: var(--fc-mem); opacity: 0.3; }
.flow-dot { opacity: 0; }
.syscall-dot { fill: var(--fc-syscall); }
.kmem-dot { fill: var(--fc-syscall); }
.ge-dot, .read-dot, .pixel { fill: var(--fc-ge); }
.gpu-core { fill: var(--fc-ge); opacity: 0.22; }
.store-dot, .load-dot { fill: var(--fc-cpu); }
.scan-dot { fill: var(--fc-present); }
.vblank-dot, .wake-dot { fill: var(--fc-time); }

.vram-cell { fill: var(--fc-grid); opacity: 0.18; }
.screen-cell { fill: var(--fc-grid); opacity: 0.12; }
.grid-border { fill: none; stroke: var(--fc-stroke); stroke-width: 1; opacity: 0.6; }
.present-flash { fill: var(--fc-present); opacity: 0; }

.chip-body { fill: none; stroke: var(--fc-ge); stroke-width: 1.4; opacity: 0.85; }
.chip-die { fill: var(--fc-ge); opacity: 0.3; }
.chip-pin { stroke: var(--fc-ge); stroke-width: 1.4; opacity: 0.85; }
.chip-cpu .chip-body, .chip-cpu .chip-pin { stroke: var(--fc-cpu); }
.chip-cpu .chip-die { fill: var(--fc-cpu); }

.clock-face { fill: none; stroke: var(--fc-time); stroke-width: 1.6; opacity: 0.8; }
.clock-hand { stroke: var(--fc-time); stroke-width: 2; stroke-linecap: round; }
.clock-pin { fill: var(--fc-time); }
.tick { fill: var(--fc-time); opacity: 0; }

/* bolder, theme-aware connectors */
.conn { fill: none; stroke: var(--fc-wire); stroke-width: 2.2; opacity: 0.9; }
.conn.dashed { stroke-dasharray: 6 5; }
.arrow-head { fill: var(--fc-wire); }
.conn-label { fill: var(--vp-c-text-2); font-size: 10px; }
</style>
