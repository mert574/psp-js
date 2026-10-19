// Original project-specific ambient background. MIT License.
// Its curves use a small set of animated Bezier control points.
export const WAVE_COLOR_KEY = "psp-js:wave-color";
let color = "#ffffff";

function normalizeColor(value: string): string | null {
  const hex = value.replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex.toLowerCase()}`;
  if (/^[0-9a-f]{3}$/i.test(hex)) return `#${[...hex].map((c) => c + c).join("").toLowerCase()}`;
  return null;
}

export function getStoredWaveColor(): string {
  try {
    return normalizeColor(localStorage.getItem(WAVE_COLOR_KEY) || "") || "#ffffff";
  } catch {
    return "#ffffff";
  }
}

export function setWaveColor(value: string): void {
  const normalized = normalizeColor(value);
  if (!normalized) return;
  color = normalized;
  try { localStorage.setItem(WAVE_COLOR_KEY, normalized); } catch { /* optional persistence */ }
}

export function initWaveBackground(): void {
  if (document.querySelector("canvas.wave-bg")) return;
  color = getStoredWaveColor();
  const canvas = document.createElement("canvas");
  canvas.className = "wave-bg";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const context = canvas.getContext("2d");
  if (!context) return;
  const ctx = context;
  let width = 0;
  let height = 0;
  let request = 0;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const gameplay = document.getElementById("gameplay-view");

  function resize(): void {
    width = window.innerWidth;
    height = window.innerHeight;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function draw(milliseconds: number): void {
    ctx.clearRect(0, 0, width, height);
    const phase = milliseconds / 6000;
    for (let band = 0; band < 3; band++) {
      const base = height * (0.48 + band * 0.13);
      const drift = Math.sin(phase + band * 2) * height * 0.055;
      const gradient = ctx.createLinearGradient(0, base - height * 0.2, 0, height);
      gradient.addColorStop(0, color + "24");
      gradient.addColorStop(1, color + "00");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(0, base + drift);
      ctx.bezierCurveTo(width * 0.28, base - height * 0.18 - drift,
        width * 0.72, base + height * 0.16 + drift, width, base - drift);
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fill();
    }
  }

  function frame(time: number): void {
    draw(time);
    request = requestAnimationFrame(frame);
  }

  function sync(): void {
    cancelAnimationFrame(request);
    request = 0;
    const visible = !document.hidden && (!gameplay || gameplay.hidden);
    if (!visible) {
      ctx.clearRect(0, 0, width, height);
    } else if (motion.matches) {
      draw(0);
    } else {
      request = requestAnimationFrame(frame);
    }
  }

  window.addEventListener("resize", () => { resize(); sync(); });
  document.addEventListener("visibilitychange", sync);
  motion.addEventListener("change", sync);
  if (gameplay) new MutationObserver(sync).observe(gameplay, { attributes: true, attributeFilter: ["hidden"] });
  resize();
  sync();
}
