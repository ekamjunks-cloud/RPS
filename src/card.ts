// The shareable result card: a 1080×1920 image (Instagram/WhatsApp story size) drawn on a canvas.

export type CardInfo = {
  result: 'win' | 'loss' | 'draw';
  you: string; opp: string;
  youScore: number; oppScore: number;
  rounds: { you: string | null; result: string }[]; // in round order
  rated: boolean; ratingChange: number;
  link: string; // shown at the bottom, without https://
};

const W = 1080, H = 1920;
const EMOJI: Record<string, string> = { rock: '🪨', paper: '📄', scissors: '✂️' };
const KIND: Record<string, [string, string]> = { rock: ['#ffb25b', '#f0602a'], paper: ['#6fe0ff', '#2a83f0'], scissors: ['#ff7ac0', '#c62a8c'] };
const DISPLAY = '"Lilita One", "Outfit", system-ui, sans-serif';
const BODY = '"Outfit", system-ui, sans-serif';

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
/** Text with the game's chunky drop shadow. */
function chunky(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, shadow: string) {
  c.font = `${size}px ${DISPLAY}`;
  c.fillStyle = shadow; c.fillText(text, x, y + size * 0.07);
  c.fillStyle = color; c.fillText(text, x, y);
}
function fit(c: CanvasRenderingContext2D, text: string, max: number) {
  if (c.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && c.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

export async function drawResultCard(info: CardInfo): Promise<Blob> {
  try { await Promise.all([document.fonts.load(`100px "Lilita One"`), document.fonts.load(`700 40px "Outfit"`)]); } catch {}
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d')!;
  c.textAlign = 'center'; c.textBaseline = 'alphabetic';

  // background: deep purple with a glow behind the result, and a faint grid
  const bg = c.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#2a1f6e'); bg.addColorStop(0.55, '#171340'); bg.addColorStop(1, '#0a0920');
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  const glowColor = info.result === 'win' ? 'rgba(255,200,61,.35)' : info.result === 'loss' ? 'rgba(255,90,122,.3)' : 'rgba(160,140,255,.3)';
  const glow = c.createRadialGradient(W / 2, 760, 40, W / 2, 760, 620);
  glow.addColorStop(0, glowColor); glow.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = glow; c.fillRect(0, 0, W, H);
  c.strokeStyle = 'rgba(255,255,255,.035)'; c.lineWidth = 2;
  for (let x = 0; x <= W; x += 72) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  for (let y = 0; y <= H; y += 72) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }

  // logo: three tilted cards and "RPS 10"
  (['rock', 'paper', 'scissors'] as const).forEach((k, i) => {
    c.save();
    c.translate(W / 2 + (i - 1) * 92, 230 + (i === 1 ? -8 : 6));
    c.rotate((i - 1) * 0.2);
    const g = c.createLinearGradient(-40, -54, 40, 54);
    g.addColorStop(0, KIND[k]![0]); g.addColorStop(1, KIND[k]![1]);
    rr(c, -40, -54, 80, 108, 16); c.fillStyle = g; c.fill();
    c.lineWidth = 4; c.strokeStyle = 'rgba(255,255,255,.4)'; c.stroke();
    c.font = '52px system-ui'; c.textBaseline = 'middle'; c.fillText(EMOJI[k]!, 0, 2); c.textBaseline = 'alphabetic';
    c.restore();
  });
  c.font = `120px ${DISPLAY}`;
  const rps = 'RPS', ten = '10', gap = 22;
  const wR = c.measureText(rps).width, wT = c.measureText(ten).width;
  const x0 = W / 2 - (wR + gap + wT) / 2;
  c.textAlign = 'left';
  chunky(c, rps, x0, 430, 120, '#f5f3ff', 'rgba(0,0,0,.35)');
  chunky(c, ten, x0 + wR + gap, 430, 120, '#ffc83d', '#d98a00');
  c.textAlign = 'center';

  // the result
  const title = info.result === 'win' ? 'VICTORY!' : info.result === 'loss' ? 'DEFEAT' : 'DRAW';
  const tc = info.result === 'win' ? ['#ffc83d', '#d98a00'] : info.result === 'loss' ? ['#ff5a7a', '#c92a4e'] : ['#e6defe', 'rgba(0,0,0,.4)'];
  chunky(c, title, W / 2, 720, 190, tc[0]!, tc[1]!);

  // score panel
  rr(c, 90, 800, W - 180, 400, 48);
  c.fillStyle = 'rgba(8,6,28,.5)'; c.fill();
  c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,.12)'; c.stroke();
  chunky(c, String(info.youScore), 330, 1050, 230, '#3ee6a0', '#14a86c');
  chunky(c, String(info.oppScore), W - 330, 1050, 230, '#ff5a7a', '#c92a4e');
  c.font = `110px ${DISPLAY}`; c.fillStyle = 'rgba(255,255,255,.25)'; c.fillText('–', W / 2, 1020);
  c.font = `700 40px ${BODY}`;
  c.fillStyle = '#3ee6a0'; c.fillText(fit(c, info.you, 360), 330, 1135);
  c.fillStyle = '#ff5a7a'; c.fillText(fit(c, info.opp, 360), W - 330, 1135);

  // the 10 rounds: the card you played, coloured by who won the round
  c.font = `800 30px ${BODY}`; c.fillStyle = '#a9a3d6';
  c.fillText('MY 10 ROUNDS', W / 2, 1300);
  const n = Math.max(10, info.rounds.length), size = 82, gapR = 12;
  const rowW = n * size + (n - 1) * gapR, rx = (W - rowW) / 2;
  for (let i = 0; i < n; i++) {
    const r = info.rounds[i];
    const x = rx + i * (size + gapR), y = 1330;
    rr(c, x, y, size, size, 18);
    c.fillStyle = !r ? 'rgba(255,255,255,.07)' : r.result === 'win' ? '#3ee6a0' : r.result === 'loss' ? '#ff5a7a' : '#ffc83d';
    c.fill();
    if (r) {
      c.font = '46px system-ui'; c.textBaseline = 'middle';
      c.fillText(r.you ? EMOJI[r.you]! : '⏱️', x + size / 2, y + size / 2 + 3);
      c.textBaseline = 'alphabetic';
    }
  }
  if (info.rated && info.ratingChange) {
    c.font = `800 40px ${BODY}`;
    c.fillStyle = info.ratingChange > 0 ? '#3ee6a0' : '#ff5a7a';
    c.fillText(`Rating ${info.ratingChange > 0 ? '+' : ''}${info.ratingChange}`, W / 2, 1520);
  }

  // call to action
  chunky(c, info.result === 'win' ? 'Think you can beat me?' : 'Can you do better?', W / 2, 1650, 78, '#f5f3ff', 'rgba(0,0,0,.35)');
  c.font = `700 40px ${BODY}`;
  const link = fit(c, info.link, W - 260);
  const lw = c.measureText(link).width + 90;
  rr(c, (W - lw) / 2, 1700, lw, 84, 42);
  c.fillStyle = '#ffc83d'; c.fill();
  c.fillStyle = '#3a2100'; c.fillText(link, W / 2, 1756);

  return new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('Could not make the image'))), 'image/png'));
}
