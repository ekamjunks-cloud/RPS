// The shareable result card ("face-off poster"): both players face to face, the score, and your 10 cards.
// Drawn on a canvas in two sizes: Story 1080×1920 (Instagram/WhatsApp stories) and Square 1080×1080 (posts).
// The avatars, rank badges and card art are the game's own SVG drawings, turned into images.
import { ICON } from './art';
import { tierOf } from './ranks';

export type CardFormat = 'story' | 'square';
export type CardInfo = {
  format: CardFormat;
  result: 'win' | 'loss' | 'draw';
  you: string; opp: string;
  youScore: number; oppScore: number;
  youAvatar: string; oppAvatar: string;
  youRating: number; oppRating: number; oppIsBot: boolean;
  mode: string; // shown as a chip: "Ranked", "Unranked", "Practice"…
  rounds: { you: string | null; result: string }[]; // in round order
  rated: boolean; ratingChange: number;
  link: string; // shown at the bottom, without https://
};

const W = 1080;
const KIND: Record<string, [string, string]> = { rock: ['#ffb25b', '#f0602a'], paper: ['#6fe0ff', '#2a83f0'], scissors: ['#ff7ac0', '#c62a8c'] };
const GREEN = ['#3ee6a0', '#14a86c'], RED = ['#ff5a7a', '#c92a4e'], GOLD = ['#ffc83d', '#d98a00'];
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

// ---------- the game's SVG drawings as images ----------
const imgCache = new Map<string, Promise<HTMLImageElement | null>>();
function svgImage(key: string, xml: string): Promise<HTMLImageElement | null> {
  if (!imgCache.has(key)) {
    imgCache.set(key, new Promise(res => {
      const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = url;
    }));
  }
  return imgCache.get(key)!;
}
/** A <symbol> from the page's sprites (avatars, rank badges), with the gradients it uses. */
function symbolImage(id: string): Promise<HTMLImageElement | null> {
  const sym = document.getElementById(id);
  const defs = sym && sym.closest('defs');
  if (!sym || !defs) return Promise.resolve(null);
  const ser = new XMLSerializer();
  const inner = Array.from(defs.children).map(n => ser.serializeToString(n)).join('');
  const vb = sym.getAttribute('viewBox') || '0 0 100 100';
  return svgImage(id, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${vb}" width="512" height="512"><defs>${inner}</defs><use href="#${id}" xlink:href="#${id}"/></svg>`);
}
/** A card's icon in white, as on the cards in your hand. */
function kindImage(kind: string): Promise<HTMLImageElement | null> {
  const src = ICON[kind];
  if (!src) return Promise.resolve(null);
  const xml = src.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"').replace(/currentColor/g, '#fff');
  return svgImage('k-' + kind, xml);
}

/** A playing card: the kind's gradient, its white icon, and an edge coloured by who won the round. */
function drawCard(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, kind: string | null, edge: string, icon: HTMLImageElement | null) {
  const r = w * 0.2;
  rr(c, x, y, w, h, r);
  if (kind && KIND[kind]) {
    const g = c.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, KIND[kind]![0]); g.addColorStop(1, KIND[kind]![1]);
    c.fillStyle = g;
  } else c.fillStyle = 'rgba(255,255,255,.08)';
  c.fill();
  c.lineWidth = Math.max(4, w * 0.07); c.strokeStyle = edge; c.stroke();
  if (icon) { const s = w * 0.62; c.drawImage(icon, x + (w - s) / 2, y + (h - s) / 2, s, s); }
  else if (!kind) { // missed turn: a small clock
    c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = w * 0.06;
    c.beginPath(); c.arc(x + w / 2, y + h / 2, w * 0.22, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(x + w / 2, y + h / 2 - w * 0.13); c.lineTo(x + w / 2, y + h / 2); c.lineTo(x + w / 2 + w * 0.1, y + h / 2 + w * 0.06); c.stroke();
  }
}
/** An avatar with a coloured ring: green for you, red for them. */
function drawAvatar(c: CanvasRenderingContext2D, cx: number, cy: number, size: number, img: HTMLImageElement | null, ring: string) {
  const x = cx - size / 2, y = cy - size / 2, r = size * 0.24;
  c.save();
  c.shadowColor = ring; c.shadowBlur = size * 0.18;
  rr(c, x - 10, y - 10, size + 20, size + 20, r + 8); c.fillStyle = ring; c.fill();
  c.restore();
  rr(c, x, y, size, size, r); c.save(); c.clip();
  if (img) c.drawImage(img, x, y, size, size); else { c.fillStyle = '#4a4386'; c.fillRect(x, y, size, size); }
  c.restore();
}
/** Name, then a rank badge and rating (or BOT) under it. */
function drawWho(c: CanvasRenderingContext2D, cx: number, y: number, name: string, color: string, rating: number, bot: boolean, badge: HTMLImageElement | null, size: number) {
  c.font = `800 ${size}px ${BODY}`; c.fillStyle = color;
  c.fillText(fit(c, name, 380), cx, y);
  const y2 = y + size * 1.35, small = Math.round(size * 0.8);
  c.font = `800 ${small}px ${BODY}`;
  if (bot) {
    const tw = c.measureText('BOT').width + 36;
    rr(c, cx - tw / 2, y2 - small * 0.95, tw, small * 1.35, 12); c.fillStyle = 'rgba(167,139,250,.25)'; c.fill();
    c.fillStyle = '#d9ccff'; c.fillText('BOT', cx, y2);
    return;
  }
  const t = tierOf(rating), label = `${t.name} ${rating.toLocaleString('en-US')}`;
  const bs = small * 1.5, tw = c.measureText(label).width, total = bs + 8 + tw;
  const x0 = cx - total / 2;
  if (badge) c.drawImage(badge, x0, y2 - small * 1.1, bs, bs);
  c.textAlign = 'left'; c.fillStyle = t.c1; c.fillText(label, x0 + bs + 8, y2); c.textAlign = 'center';
}
/** Small rounded chips in a centred row. */
function drawChips(c: CanvasRenderingContext2D, cy: number, chips: { text: string; color: string }[], size: number) {
  c.font = `800 ${size}px ${BODY}`;
  const pad = size * 0.9, gap = size * 0.6, h = size * 2;
  const ws = chips.map(ch => c.measureText(ch.text).width + pad * 2);
  let x = W / 2 - (ws.reduce((a, b) => a + b, 0) + gap * (chips.length - 1)) / 2;
  chips.forEach((ch, i) => {
    rr(c, x, cy - h / 2, ws[i]!, h, h / 2); c.fillStyle = 'rgba(8,6,28,.6)'; c.fill();
    c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,.1)'; c.stroke();
    c.fillStyle = ch.color; c.fillText(ch.text, x + ws[i]! / 2, cy + size * 0.36);
    x += ws[i]! + gap;
  });
}
function bestStreak(rounds: { result: string }[]) {
  let best = 0, run = 0;
  for (const r of rounds) { run = r.result === 'win' ? run + 1 : 0; best = Math.max(best, run); }
  return best;
}

export async function drawResultCard(info: CardInfo): Promise<Blob> {
  try { await Promise.all([document.fonts.load(`100px "Lilita One"`), document.fonts.load(`800 40px "Outfit"`)]); } catch {}
  const story = info.format === 'story', H = story ? 1920 : 1080;
  const [avYou, avOpp, rkYou, rkOpp, kRock, kPaper, kScissors] = await Promise.all([
    symbolImage('av-' + info.youAvatar).then(i => i || symbolImage('av-rocky')),
    symbolImage('av-' + info.oppAvatar).then(i => i || symbolImage('av-rocky')),
    symbolImage('rk-' + tierOf(info.youRating).key), symbolImage('rk-' + tierOf(info.oppRating).key),
    kindImage('rock'), kindImage('paper'), kindImage('scissors'),
  ]);
  const kinds: Record<string, HTMLImageElement | null> = { rock: kRock, paper: kPaper, scissors: kScissors };

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d')!;
  c.textAlign = 'center'; c.textBaseline = 'alphabetic';

  // layout for each size
  const L = story
    ? { logoY: 190, logoCard: 76, logoText: 96, titleY: 560, title: 180, faceY: 820, av: 230, avX: 225, score: 170, nameY: 1040, name: 44,
        roundsLbl: 1180, roundsY: 1215, tile: 84, tileH: 112, chipsY: 1450, chip: 30, ctaY: 1650, cta: 76, pillY: 1715, pill: 40, glowY: 760 }
    : { logoY: 96, logoCard: 50, logoText: 64, titleY: 290, title: 130, faceY: 470, av: 190, avX: 210, score: 140, nameY: 650, name: 38,
        roundsLbl: 752, roundsY: 776, tile: 76, tileH: 98, chipsY: 0, chip: 26, ctaY: 1000, cta: 54, pillY: 1022, pill: 34, glowY: 440 };

  // background: deep purple, a glow in the result's colour, and a faint grid
  const bg = c.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#2a1f6e'); bg.addColorStop(0.55, '#171340'); bg.addColorStop(1, '#0a0920');
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  const glowColor = info.result === 'win' ? 'rgba(255,200,61,.36)' : info.result === 'loss' ? 'rgba(255,90,122,.3)' : 'rgba(160,140,255,.3)';
  const glow = c.createRadialGradient(W / 2, L.glowY, 40, W / 2, L.glowY, story ? 680 : 520);
  glow.addColorStop(0, glowColor); glow.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = glow; c.fillRect(0, 0, W, H);
  c.strokeStyle = 'rgba(255,255,255,.035)'; c.lineWidth = 2;
  for (let x = 0; x <= W; x += 72) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  for (let y = 0; y <= H; y += 72) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }

  // logo: three tilted cards and "RPS 10" (story), or "RPS 10" with the cards beside it (square)
  const lc = L.logoCard, lch = lc * 1.35;
  c.font = `${L.logoText}px ${DISPLAY}`;
  const wR = c.measureText('RPS').width, wT = c.measureText('10').width, gapT = L.logoText * 0.18;
  if (story) {
    (['rock', 'paper', 'scissors'] as const).forEach((k, i) => {
      c.save(); c.translate(W / 2 + (i - 1) * lc * 1.12, L.logoY + (i === 1 ? -8 : 6)); c.rotate((i - 1) * 0.2);
      drawCard(c, -lc / 2, -lch / 2, lc, lch, k, 'rgba(255,255,255,.45)', kinds[k]!); c.restore();
    });
    const x0 = W / 2 - (wR + gapT + wT) / 2, ty = L.logoY + lch / 2 + L.logoText * 0.95;
    c.textAlign = 'left';
    chunky(c, 'RPS', x0, ty, L.logoText, '#f5f3ff', 'rgba(0,0,0,.35)');
    chunky(c, '10', x0 + wR + gapT, ty, L.logoText, GOLD[0]!, GOLD[1]!);
    c.textAlign = 'center';
  } else {
    const cardsW = lc * 2.3 + lc, total = cardsW + 24 + wR + gapT + wT, x0 = W / 2 - total / 2;
    (['rock', 'paper', 'scissors'] as const).forEach((k, i) => {
      c.save(); c.translate(x0 + lc / 2 + i * lc * 1.15, L.logoY - L.logoText * 0.32); c.rotate((i - 1) * 0.2);
      drawCard(c, -lc / 2, -lch / 2, lc, lch, k, 'rgba(255,255,255,.45)', kinds[k]!); c.restore();
    });
    c.textAlign = 'left';
    chunky(c, 'RPS', x0 + cardsW + 24, L.logoY, L.logoText, '#f5f3ff', 'rgba(0,0,0,.35)');
    chunky(c, '10', x0 + cardsW + 24 + wR + gapT, L.logoY, L.logoText, GOLD[0]!, GOLD[1]!);
    c.textAlign = 'center';
  }

  // the result
  const title = info.result === 'win' ? 'VICTORY!' : info.result === 'loss' ? 'DEFEAT' : 'DRAW';
  const tc = info.result === 'win' ? GOLD : info.result === 'loss' ? RED : ['#e6defe', 'rgba(0,0,0,.4)'];
  chunky(c, title, W / 2, L.titleY, L.title, tc[0]!, tc[1]!);

  // face to face: avatars, the score between them, names and ranks underneath
  drawAvatar(c, L.avX, L.faceY, L.av, avYou, GREEN[0]!);
  drawAvatar(c, W - L.avX, L.faceY, L.av, avOpp, RED[0]!);
  c.font = `${L.score}px ${DISPLAY}`;
  const sY = String(info.youScore), sO = String(info.oppScore), dash = '–';
  const wy = c.measureText(sY).width, wo = c.measureText(sO).width, wd = c.measureText(dash).width, sg = L.score * 0.14;
  const sx = W / 2 - (wy + wd + wo + sg * 2) / 2, sy = L.faceY + L.score * 0.36;
  c.textAlign = 'left';
  chunky(c, sY, sx, sy, L.score, GREEN[0]!, GREEN[1]!);
  c.font = `${L.score * 0.62}px ${DISPLAY}`; c.fillStyle = 'rgba(255,255,255,.3)'; c.fillText(dash, sx + wy + sg, sy - L.score * 0.1);
  chunky(c, sO, sx + wy + wd + sg * 2, sy, L.score, RED[0]!, RED[1]!);
  c.textAlign = 'center';
  drawWho(c, L.avX, L.nameY, info.you, GREEN[0]!, info.youRating, false, rkYou, L.name);
  drawWho(c, W - L.avX, L.nameY, info.opp, RED[0]!, info.oppRating, info.oppIsBot, rkOpp, L.name);

  // your 10 cards, edged by who won each round
  c.font = `800 ${Math.round(L.name * 0.68)}px ${BODY}`; c.fillStyle = '#a9a3d6';
  c.fillText('MY 10 ROUNDS', W / 2, L.roundsLbl);
  const n = Math.max(10, info.rounds.length), size = L.tile, gapR = story ? 14 : 12;
  const rowW = n * size + (n - 1) * gapR, rx = (W - rowW) / 2;
  for (let i = 0; i < n; i++) {
    const r = info.rounds[i];
    const edge = !r ? 'rgba(255,255,255,.12)' : r.result === 'win' ? GREEN[0]! : r.result === 'loss' ? RED[0]! : GOLD[0]!;
    drawCard(c, rx + i * (size + gapR), L.roundsY, size, L.tileH, r ? r.you : null, edge, r && r.you ? kinds[r.you] || null : null);
  }

  // chips: rating change, match type, best run of round wins
  const chips: { text: string; color: string }[] = [];
  if (info.rated && info.ratingChange) chips.push({ text: `Rating ${info.ratingChange > 0 ? '+' : ''}${info.ratingChange}`, color: info.ratingChange > 0 ? GREEN[0]! : RED[0]! });
  if (info.mode) chips.push({ text: info.mode, color: '#d9d4ff' });
  const streak = bestStreak(info.rounds);
  if (streak >= 2) chips.push({ text: `Best streak ${streak}`, color: GOLD[0]! });
  if (story && chips.length) drawChips(c, L.chipsY, chips, L.chip);

  // call to action and the link
  const cta = info.result === 'win' ? 'Think you can beat me?' : 'Can you do better?';
  c.font = `800 ${L.pill}px ${BODY}`;
  const link = fit(c, info.link, W - 300);
  const lw = c.measureText(link).width + L.pill * 2.2, lh = L.pill * 2.1;
  if (story) {
    chunky(c, cta, W / 2, L.ctaY, L.cta, '#f5f3ff', 'rgba(0,0,0,.35)');
    rr(c, (W - lw) / 2, L.pillY, lw, lh, lh / 2); c.fillStyle = GOLD[0]!; c.fill();
    c.font = `800 ${L.pill}px ${BODY}`; c.fillStyle = '#3a2100'; c.fillText(link, W / 2, L.pillY + lh * 0.66);
  } else {
    // square: the chips, then the call to action and the link side by side along the bottom
    if (chips.length) drawChips(c, 930, chips, L.chip);
    c.font = `${L.cta}px ${DISPLAY}`;
    const cw = c.measureText(cta).width, total = cw + 30 + lw, x0 = W / 2 - total / 2;
    c.textAlign = 'left';
    chunky(c, cta, x0, L.ctaY + L.cta * 0.32, L.cta, '#f5f3ff', 'rgba(0,0,0,.35)');
    rr(c, x0 + cw + 30, L.pillY - lh / 2 - 22, lw, lh, lh / 2); c.fillStyle = GOLD[0]!; c.fill();
    c.font = `800 ${L.pill}px ${BODY}`; c.fillStyle = '#3a2100'; c.textAlign = 'center';
    c.fillText(link, x0 + cw + 30 + lw / 2, L.pillY - lh / 2 - 22 + lh * 0.66);
  }

  return new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('Could not make the image'))), 'image/png'));
}
