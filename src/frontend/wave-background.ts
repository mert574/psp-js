// XMB-style wave background, ported from PPSSPP's WaveAnimation
// (ppsspp-reference/UI/Background.cpp:80). Two translucent white wave bands
// each fade from their crest line down to the bottom of the screen, driven by
// the same stack of sin() terms PPSSPP uses. The two bands overlap with normal
// alpha blending, which is what gives the layered "aurora" look.
//
// It draws on a fixed full-screen canvas behind the page content and pauses
// itself while a game is running, since emulation already wants every cycle.

// PPSSPP normalizes the wave phase to a 1280-wide reference, so the pattern
// keeps the same wavelength regardless of the real window width.
const REF_WIDTH = 1280;

// color = colorAlpha(0xFFFFFFFF, alpha * 0.2) in PPSSPP, with screen alpha 1.0.
const WAVE_ALPHA = 0.2;

// PPSSPP adds a 3px-tall soft top edge as cheap antialiasing on the crest line.
const AA_PX = 3;

export function initWaveBackground(): void {
  if (document.querySelector("canvas.wave-bg")) return;

  const canvas = document.createElement("canvas");
  canvas.className = "wave-bg";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let w = 0;
  let h = 0;

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  let raf = 0;
  let running = false;

  function frame(): void {
    if (!running) return;
    // performance.now() is ms; PPSSPP feeds seconds with speed 1.0.
    draw(performance.now() / 1000);
    raf = requestAnimationFrame(frame);
  }

  function start(): void {
    if (running) return;
    running = true;
    raf = requestAnimationFrame(frame);
  }

  function stop(): void {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ctx!.clearRect(0, 0, w, h);
  }

  function paintBand(x: number, width: number, top: number): void {
    // Main body: crest line (full color) down to the bottom (transparent).
    const body = ctx!.createLinearGradient(0, top, 0, h);
    body.addColorStop(0, `rgba(255,255,255,${WAVE_ALPHA})`);
    body.addColorStop(1, "rgba(255,255,255,0)");
    ctx!.fillStyle = body;
    ctx!.fillRect(x, top, width, h - top);

    // Soft top edge: transparent up to full color over the last few px.
    const edge = ctx!.createLinearGradient(0, top - AA_PX, 0, top);
    edge.addColorStop(0, "rgba(255,255,255,0)");
    edge.addColorStop(1, `rgba(255,255,255,${WAVE_ALPHA})`);
    ctx!.fillStyle = edge;
    ctx!.fillRect(x, top - AA_PX, width, AA_PX);
  }

  function draw(t: number): void {
    ctx!.clearRect(0, 0, w, h);

    // PPSSPP: steps = clamp(xres, 20, 500). Plenty of columns for any width.
    const steps = Math.max(20, Math.min(Math.round(w), 500));
    const step = w / steps;

    for (let n = 0; n < steps; n++) {
      const x = n * step;
      const i = (x * REF_WIDTH) / w;

      const wave0 =
        (Math.sin(i * 0.005 + t * 0.8) * 0.05 +
          Math.sin(i * 0.002 + t * 0.25) * 0.02 +
          Math.sin(i * 0.001 + t * 0.3) * 0.03 +
          0.625) * h;
      const wave1 =
        (Math.sin(i * 0.0044 + t * 0.4) * 0.07 +
          Math.sin(i * 0.003 + t * 0.1) * 0.02 +
          Math.sin(i * 0.001 + t * 0.3) * 0.01 +
          0.625) * h;

      // +1px so neighbouring columns overlap and leave no seams.
      paintBand(x, step + 1, wave0);
      paintBand(x, step + 1, wave1);
    }
  }

  // Pause while a game is running (gameplay-view visible) and while the tab is
  // hidden, so the waves never compete with the emulator for CPU.
  const gameplayView = document.getElementById("gameplay-view");

  function syncRunning(): void {
    const inGameplay = gameplayView ? !gameplayView.hidden : false;
    if (document.hidden || inGameplay) stop();
    else start();
  }

  if (gameplayView) {
    new MutationObserver(syncRunning).observe(gameplayView, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
  }
  document.addEventListener("visibilitychange", syncRunning);

  syncRunning();
}
