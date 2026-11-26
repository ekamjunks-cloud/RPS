// Particle effects on one full-screen canvas: sparks when cards clash, confetti on a win.
// The animation loop only runs while there is something to draw.

type P = { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string; rot: number; vr: number;
  kind: 'spark' | 'confetti' | 'meteor' | 'ring' | 'flash' | 'bolt' | 'shard'; pts?: number[]; delay?: number };

const osReduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let reduced = osReduced;
let vibes = true;
let alpha = 1; // win effects shown on the loser's screen play dimmed
/** Settings → Reduce motion (also on when the device asks for it). */
export function setReducedMotion(on: boolean) { reduced = on || osReduced; }
/** Settings → Vibration. */
export function setVibration(on: boolean) { vibes = on; }
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
    if (p.delay && p.life < p.delay) continue;
    const k = 1 - (p.life - (p.delay || 0)) / (p.max - (p.delay || 0));
    if (p.kind === 'flash') { c.globalAlpha = Math.max(0, k * k) * 0.85 * alpha; c.fillStyle = p.color; c.fillRect(0, 0, innerWidth, innerHeight); continue; }
    if (p.kind === 'ring') {
      const r = p.size + (1 - k) * Math.max(innerWidth, innerHeight) * 0.8;
      c.globalAlpha = k * alpha; c.strokeStyle = p.color; c.lineWidth = 10 * k + 2;
      c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.stroke(); continue;
    }
    if (p.kind === 'bolt' && p.pts) {
      c.globalAlpha = (k > 0.6 || (k > 0.3 && k < 0.45) ? 1 : 0.25) * alpha;
      c.strokeStyle = p.color; c.lineWidth = 5; c.shadowColor = '#fff3a0'; c.shadowBlur = 24;
      c.beginPath(); c.moveTo(p.pts[0]!, p.pts[1]!);
      for (let i = 2; i < p.pts.length; i += 2) c.lineTo(p.pts[i]!, p.pts[i + 1]!);
      c.stroke(); c.shadowBlur = 0; continue;
    }
    if (p.kind === 'meteor') {
      p.x += p.vx * dt; p.y += p.vy * dt;
      const g = c.createLinearGradient(p.x, p.y, p.x - p.vx * 0.18, p.y - p.vy * 0.18);
      g.addColorStop(0, p.color); g.addColorStop(1, 'rgba(255,140,40,0)');
      c.globalAlpha = Math.min(1, k * 2) * alpha; c.strokeStyle = g; c.lineWidth = p.size; c.lineCap = 'round';
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x - p.vx * 0.18, p.y - p.vy * 0.18); c.stroke(); continue;
    }
    if (p.kind === 'shard') {
      // a crystal splinter: flies out, slows, tumbles and falls, glinting as it turns
      p.vx *= 0.97; p.vy = p.vy * 0.97 + 520 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      c.globalAlpha = Math.min(1, k * 2.2) * alpha;
      c.save(); c.translate(p.x, p.y); c.rotate(p.rot); c.scale(1, 0.55 + 0.45 * Math.abs(Math.cos(p.rot * 1.7)));
      c.fillStyle = p.color; c.beginPath(); c.moveTo(0, -p.size); c.lineTo(p.size * 0.45, p.size * 0.6); c.lineTo(-p.size * 0.5, p.size * 0.35); c.closePath(); c.fill();
      c.fillStyle = 'rgba(255,255,255,.75)'; c.beginPath(); c.moveTo(0, -p.size); c.lineTo(p.size * 0.12, 0); c.lineTo(-p.size * 0.2, p.size * 0.1); c.closePath(); c.fill();
      c.restore(); continue;
    }
    if (p.kind === 'spark') { p.vx *= 0.92; p.vy = p.vy * 0.92 + 600 * dt; }
    else { p.vx *= 0.99; p.vy = Math.min(p.vy + 380 * dt, 260); p.vx += Math.sin((p.life + p.rot) * 6) * 8; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    c.globalAlpha = (p.kind === 'spark' ? k : Math.min(1, k * 3)) * alpha;
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
  if (!vibes) return;
  try {
    const ua = (navigator as any).userActivation;
    if (navigator.vibrate && (!ua || ua.hasBeenActive)) navigator.vibrate(ms); // browsers refuse it before the first tap
  } catch {}
};

// ---------- win effects: the celebration over the Victory screen (and dimmed on the loser's) ----------
const RAINBOW = ['#ff5a7a', '#ffc83d', '#3ee6a0', '#6fe0ff', '#a78bfa', '#ffffff'];
function sparksAt(x: number, y: number, colors: string[], n: number, delay: number, speed = 1) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.2, sp = (160 + Math.random() * 220) * speed;
    parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: delay + 1 + Math.random() * 0.5,
      size: 2.5 + Math.random() * 3, color: colors[i % colors.length]!, rot: 0, vr: 0, kind: 'spark', delay });
  }
}
function boltPts(x: number) {
  const pts = [x, -10];
  let y = 0, cx = x;
  while (y < innerHeight * 0.55) { y += 30 + Math.random() * 40; cx += (Math.random() - 0.5) * 70; pts.push(cx, y); }
  return pts;
}
/** Plays a win effect over the whole screen. `dim` plays it faintly, for the player who lost. */
export function winEffect(kind: string, dim = false) {
  if (document.hidden || !canvas()) return;
  alpha = dim ? 0.4 : 1;
  const W = innerWidth, H = innerHeight;
  if (reduced) { if (!dim) confetti(40); return; } // a calmer version
  switch (kind) {
    case 'fireworks':
      for (let i = 0; i < 6; i++) sparksAt(W * (0.15 + Math.random() * 0.7), H * (0.12 + Math.random() * 0.35), [RAINBOW[i % 5]!, '#fff'], 46, i * 0.4);
      break;
    case 'lightning':
      for (const [i, x] of [W * 0.3, W * 0.7].entries()) {
        parts.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: i * 0.7 + 0.7, size: 0, color: '#fffbe0', rot: 0, vr: 0, kind: 'bolt', pts: boltPts(x), delay: i * 0.7 });
        parts.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: i * 0.7 + 0.45, size: 0, color: '#fff8d0', rot: 0, vr: 0, kind: 'flash', delay: i * 0.7 });
      }
      break;
    case 'meteor':
      for (let i = 0; i < 16; i++) {
        const sp = 700 + Math.random() * 400;
        parts.push({ x: W * (0.3 + Math.random() * 0.9), y: -40 - Math.random() * 120, vx: -sp * 0.75, vy: sp * 0.65, life: 0,
          max: i * 0.15 + 1.6, size: 3 + Math.random() * 3, color: i % 3 ? '#ffd07a' : '#ffffff', rot: 0, vr: 0, kind: 'meteor', delay: i * 0.15 });
      }
      break;
    case 'supernova':
      parts.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0.7, size: 0, color: '#ffffff', rot: 0, vr: 0, kind: 'flash' });
      RAINBOW.slice(0, 5).forEach((col, i) => parts.push({ x: W / 2, y: H * 0.38, vx: 0, vy: 0, life: 0, max: 0.35 + i * 0.22 + 1.4,
        size: 10, color: col, rot: 0, vr: 0, kind: 'ring', delay: 0.35 + i * 0.22 }));
      sparksAt(W / 2, H * 0.38, RAINBOW, 70, 0.3, 1.8);
      break;
    case 'shatter': {
      // Diamond rank: a cold flash, a ring of light, then crystal shards burst out and fall
      const ICE = ['#e6fdff', '#7fe3ff', '#6f7bff', '#d79cff', '#b9f6ff'];
      const x0 = W / 2, y0 = H * 0.38;
      parts.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0.5, size: 0, color: '#d9f7ff', rot: 0, vr: 0, kind: 'flash' });
      parts.push({ x: x0, y: y0, vx: 0, vy: 0, life: 0, max: 1.5, size: 8, color: '#9fe9ff', rot: 0, vr: 0, kind: 'ring', delay: 0.15 });
      for (let i = 0; i < 70; i++) {
        const a = Math.random() * Math.PI * 2, sp = 260 + Math.random() * 520;
        parts.push({ x: x0, y: y0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120, life: 0, max: 0.2 + 1.6 + Math.random() * 0.9,
          size: 6 + Math.random() * 12, color: ICE[i % ICE.length]!, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 14, kind: 'shard', delay: 0.2 });
      }
      sparksAt(x0, y0, ['#ffffff', '#b9f6ff'], 36, 0.2, 1.4);
      break;
    }
    default:
      if (!dim) confetti(); else confetti(60);
  }
  run();
  setTimeout(() => { alpha = 1; }, 3500);
}
