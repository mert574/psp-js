<script setup lang="ts">
// Browser-only animated diagram of one runFrame() of the emulator.
// Browser animation runs only after mount; the SVG remains safe for SSR.
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

onMounted(() => {
  const el = root.value;
  if (!el) return;
  const svg = el.querySelector("svg")!;
  const cache = new Map<string, SVGElement[]>();
  const nodes = (selector: string): SVGElement[] => {
    if (!cache.has(selector)) cache.set(selector, Array.from(svg.querySelectorAll<SVGElement>(selector)));
    return cache.get(selector)!;
  };
  const clamp = (n: number): number => Math.max(0, Math.min(1, n));
  const cycle = 7.7;
  const opacity = (selector: string, value: number) => nodes(selector).forEach(node => { node.style.opacity = String(value); });
  const draw = (time: number) => {
    const pulse = (start: number, duration: number): number => Math.min(clamp((time-start)/.25), clamp((start+duration+.35-time)/.35)) * .9;
    const glow = (selector: string, start: number, duration: number) => opacity(selector, pulse(start,duration));
    nodes(".flow-dot,.instr").forEach(node => { node.style.opacity="0";node.style.transform="translate(0px,0px)"; });
    const travel = (selector: string, start: number, x: number, y: number, duration=.4) => {
      const phase=time-start;
      if(phase<0 || phase>duration+.12)return;
      const progress=clamp(phase/duration);
      nodes(selector).forEach(node=>{node.style.opacity=String(1-clamp((phase-duration)/.12));node.style.transform=`translate(${x*progress}px,${y*progress}px)`;});
    };
    glow(".glow-time",0,.5);if(time>1)glow(".glow-time",5.2,.6);
    glow(".glow-cpu",.3,4.4);glow(".glow-hle",1.6,1.4);glow(".glow-ge",2.7,2);glow(".glow-present",5.5,1.3);
    travel(".wake-dot",0,0,-42);
    nodes(".instr").forEach((node,i)=>{
      const t=time-.4-i*.21;
      if(t<0 || t>.8)return;
      let x:number;
      if(t<.21)x=-56+56*clamp(t/.14);
      else if(t<.42)x=63*clamp((t-.21)/.15);
      else if(t<.63)x=63+63*clamp((t-.42)/.15);
      else x=126+63*clamp((t-.63)/.17);
      node.style.transform=`translateX(${x}px)`;node.style.opacity=String(t<.63?clamp(t/.14):1-clamp((t-.63)/.17));
    });
    [".pipe-fetch",".pipe-decode",".pipe-exec"].forEach((selector,i)=>opacity(selector,.35+.65*clamp((time-.45-i*.21)/.2)));
    for(let i=0;i<5;i++){travel(".store-dot",.6+i*.78,108,0,.34);travel(".load-dot",1+i*.78,-108,0,.34);travel(".pixel",3.25+i*.3,0,165,.34);}
    travel(".syscall-dot",1.6,0,-170,.55);
    if(time>=2.6 && time<3.35)nodes(".syscall-dot").forEach(node=>{node.style.opacity=String(1-clamp((time-3.15)/.2));node.style.transform=`translateY(${-170*(1-clamp((time-2.6)/.55))}px)`;});
    travel(".kmem-dot",2.05,122,88);
    if(time>=2.55 && time<3.07)nodes(".kmem-dot").forEach(node=>{const p=1-clamp((time-2.55)/.4);node.style.opacity=String(1-clamp((time-2.95)/.12));node.style.transform=`translate(${122*p}px,${88*p}px)`;});
    travel(".ge-dot",2.7,108,0,.42);
    for(let i=0;i<4;i++)travel(".read-dot",2.95+i*.32,0,-86,.3);
    nodes(".ram-bar").forEach((node,i)=>{node.style.opacity=String(.25+.45*(.5+.5*Math.sin(time*4-i)));});
    nodes(".gpu-core").forEach((node,i)=>{node.style.opacity=String(time>=2.95 && time<4.75?.45+.55*(.5+.5*Math.sin(time*36+i)):.22);});
    for(const [selector,start,step,color,idle] of [[".vram-cell",3.3,.3,"var(--fc-ge)",.18],[".screen-cell",5.6,.12,"var(--fc-present)",.12]] as const){
      nodes(selector).forEach((node,i)=>{const lit=cells[i]!.lit,progress=clamp((time-start-Math.floor(i/COLS)*step)/.2);node.style.fill=lit && progress>0?color:"var(--fc-grid)";node.style.opacity=String(lit?idle+(1-idle)*progress:idle);});
    }
    nodes(".clock-hand").forEach(node=>{node.style.transformBox="fill-box";node.style.transformOrigin="50% 100%";node.style.transform=`rotate(${time<5.2?330*clamp((time-.2)/5):330+30*clamp((time-5.2)/.4)}deg)`;});
    nodes(".tick").forEach((node,i)=>{node.style.opacity=String(.9*clamp(Math.sin((time-.2-i*.4)*Math.PI/.4)));});
    travel(".vblank-dot",5.2,108,0);
    opacity(".present-flash",.5*Math.min(clamp((time-5.55)/.25),1-clamp((time-5.85)/.55)));
    for(let i=0;i<3;i++)travel(".scan-dot",5.5+i*.22,3,86,.36);
  };
  let frame=0, elapsed=0, last=0, running=false;
  const tick=(now:number)=>{if(!running)return;elapsed=(elapsed+(now-last)/1000)%cycle;last=now;draw(elapsed);frame=requestAnimationFrame(tick);};
  const timeline={
    play(){if(!running){running=true;last=performance.now();frame=requestAnimationFrame(tick);}return this;},
    pause(){running=false;cancelAnimationFrame(frame);return this;},
    progress(value:number){elapsed=clamp(value)*cycle;draw(elapsed);return this;},
    kill(){this.pause();},
  };
  (window as unknown as {__fcTimeline?: typeof timeline}).__fcTimeline=timeline;
  draw(0);
  const reduced=window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let observer:IntersectionObserver|undefined;
  if(reduced)timeline.progress(.46);
  else if(typeof IntersectionObserver==="function"){
    observer=new IntersectionObserver(entries=>{for(const entry of entries)entry.isIntersecting?timeline.play():timeline.pause();},{threshold:.2});observer.observe(el);
  }else timeline.play();
  cleanup=()=>{observer?.disconnect();timeline.kill();delete (window as unknown as {__fcTimeline?:unknown}).__fcTimeline;};
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
        <!-- soft colored glow: blur a copy of the shape and lay the sharp shape back on top -->
        <filter id="fc-glow" x="-70%" y="-70%" width="240%" height="240%">
          <feGaussianBlur stdDeviation="1.9" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
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

.instr { fill: var(--fc-cpu); filter: url(#fc-glow); }
.ram-bar { fill: var(--fc-mem); opacity: 0.3; }
.flow-dot { opacity: 0; filter: url(#fc-glow); }
.syscall-dot { fill: var(--fc-syscall); }
.kmem-dot { fill: var(--fc-syscall); }
.ge-dot, .read-dot, .pixel { fill: var(--fc-ge); }
.gpu-core { fill: var(--fc-ge); opacity: 0.22; filter: url(#fc-glow); }
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
