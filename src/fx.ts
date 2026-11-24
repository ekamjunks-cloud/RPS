// Particle effects on one full-screen canvas: sparks when cards clash, confetti on a win.
// The animation loop only runs while there is something to draw.

type P = { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string; rot: number; vr: number; kind: 'spark' | 'confetti' };

const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let cv: HTMLCanvasElement | null = null;
let cx: CanvasRenderingContext2D | null = null;
let parts: P[] = [];
let raf = 0, last = 0;

function canvas() {
  if (cv) return cx;
  cv = document.createElement('canvas');
  cv.className = 'fxCanvas';
  document.body.appendChild(cv);
  cx = cv.getContext('2d');
  const fit = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv!.width = innerWidth * dpr; cv!.height = innerHeight * dpr;
    cx && cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  addEventListener('resize', fit); fit();
  return cx;
}

function loop(t: number) {
  const dt = Math.min(0.05, (t - (last || t)) / 1000); last = t;
  const c = cx!;
  c.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter(p => (p.life += dt) < p.max);
  for (const p of parts) {
    const k = 1 - p.life / p.max;
    if (p.kind === 'spark') { p.vx *= 0.92; p.vy = p.vy * 0.92 + 600 * dt; }
    else { p.vx *= 0.99; p.vy = Math.min(p.vy + 380 * dt, 260); p.vx += Math.sin((p.life + p.rot) * 6) * 8; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    c.globalAlpha = p.kind === 'spark' ? k : Math.min(1, k * 3);
    c.fillStyle = p.color;
    if (p.kind === 'spark') {
      c.beginPath(); c.arc(p.x, p.y, p.size * (0.4 + k * 0.6), 0, Math.PI * 2); c.fill();
    } else {
      c.save(); c.translate(p.x, p.y); c.rotate(p.rot);
      c.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2 * (0.4 + Math.abs(Math.sin(p.rot * 2))));
      c.restore();
    }
  }
  c.globalAlpha = 1;
  if (parts.length) raf = requestAnimationFrame(loop);
  else { raf = 0; last = 0; }
}
function run() { if (!raf) raf = requestAnimationFrame(loop); }
// a tab that was in the background shouldn't dump a backlog of effects when it comes back
document.addEventListener('visibilitychange', () => { if (document.hidden) parts = []; });

/** A burst of sparks from a point (page coordinates). */
export function burst(x: number, y: number, colors: string[], n = 28) {
  if (reduced || document.hidden || !canvas()) return;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 220 + Math.random() * 520;
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 120, life: 0, max: 0.5 + Math.random() * 0.5,
      size: 2 + Math.random() * 4, color: colors[i % colors.length]!, rot: 0, vr: 0, kind: 'spark' });
  }
  run();
}
export function burstAt(el: Element | null, colors: string[], n?: number) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, colors, n);
}

/** Confetti falling from the top of the screen. */
export function confetti(n = 160) {
  if (reduced || document.hidden || !canvas()) return;
  const colors = ['#3ee6a0', '#ffc83d', '#ff5a7a', '#6fe0ff', '#ff7ac0', '#ffffff', '#b28cff'];
  for (let i = 0; i < n; i++) {
    parts.push({ x: Math.random() * innerWidth, y: -20 - Math.random() * innerHeight * 0.5,
      vx: (Math.random() - 0.5) * 120, vy: 60 + Math.random() * 160, life: 0, max: 3 + Math.random() * 2.5,
      size: 7 + Math.random() * 7, color: colors[i % colors.length]!, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 10, kind: 'confetti' });
  }
  run();
}

export const vibrate = (ms: number | number[]) => {
  try {
    const ua = (navigator as any).userActivation;
    if (navigator.vibrate && (!ua || ua.hasBeenActive)) navigator.vibrate(ms); // browsers refuse it before the first tap
  } catch {}
};
