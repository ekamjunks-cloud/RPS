// Avatars, frames and card styles. The server checks unlocks; keep these lists in step with
// AVATARS, FRAME_UNLOCK and SKINS in spacetimedb/src/index.ts.

export const AVATARS = ['😎', '🤖', '🦊', '🐼', '🐯', '🦁', '🐸', '🐙', '🦄', '🐲', '👻', '👽', '🤠', '🥷', '🧙', '🧛', '🐵', '🐧', '🦈', '🌵', '🍕', '⚡', '🌙', '🔥'];

export type Frame = { key: string; name: string; ach: string; how: string };
export const FRAMES: Frame[] = [
  { key: '', name: 'None', ach: '', how: '' },
  { key: 'rookie', name: 'Rookie', ach: 'first_win', how: 'Win a match' },
  { key: 'fire', name: 'Blaze', ach: 'streak5', how: 'Win 5 in a row' },
  { key: 'daily', name: 'Devoted', ach: 'daily7', how: '7-day daily streak' },
  { key: 'gold', name: 'Gold', ach: 'gold', how: 'Reach Gold' },
  { key: 'diamond', name: 'Diamond', ach: 'diamond', how: 'Reach Diamond' },
];

// Card styles are the long grind: each unlocks at a level, and levels come from XP earned in matches.
// Keep levels in step with SKIN_LEVEL in spacetimedb/src/index.ts.
export type Skin = { key: string; name: string; level: number };
export const SKINS: Skin[] = [
  { key: 'classic', name: 'Classic', level: 1 },
  { key: 'neon', name: 'Neon', level: 5 },
  { key: 'wood', name: 'Wood', level: 10 },
  { key: 'pixel', name: 'Pixel', level: 15 },
  { key: 'ice', name: 'Ice', level: 20 },
  { key: 'lava', name: 'Lava', level: 30 },
  { key: 'galaxy', name: 'Galaxy', level: 40 },
  { key: 'gold', name: 'Gold', level: 50 },
];

/** Level from total XP, the same sum as the server: level n needs 100 + 25 × (n − 1) XP to go up. */
export function levelOf(xp: number) {
  let level = 1, need = 100;
  while (xp >= need) { xp -= need; level += 1; need = 100 + 25 * (level - 1); }
  return { level, into: xp, need };
}
export const nextSkin = (level: number) => SKINS.find(k => k.level > level) ?? null;

export const REPORT_REASONS = ['Offensive name', 'Spam in chat', 'Stalling or quitting', 'Other'];

function hue(name: string) { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
const escAttr = (s: string) => s.replace(/[&<>"']/g, c => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as any)[c]);

/** An avatar as HTML: the chosen emoji, or the name's first letter on a coloured tile. */
export function avatarHtml(name: string, emoji: string, frame: string, cls = ''): string {
  const inner = emoji ? `<span class="emo">${emoji}</span>` : escAttr((name[0] || '?').toUpperCase());
  return `<span class="av ${cls}${emoji ? ' hasEmo' : ''}${frame ? ' fr-' + frame : ''}" style="--h:${hue(name)}">${inner}</span>`;
}
