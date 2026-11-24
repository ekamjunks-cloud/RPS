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

export type Skin = { key: string; name: string; how: string; open: (p: { played: number; wins: number; ach: number }) => boolean };
export const SKINS: Skin[] = [
  { key: 'classic', name: 'Classic', how: '', open: () => true },
  { key: 'neon', name: 'Neon', how: 'Play 10 matches', open: p => p.played >= 10 },
  { key: 'wood', name: 'Wood', how: 'Win 15 matches', open: p => p.wins >= 15 },
  { key: 'pixel', name: 'Pixel', how: 'Unlock 5 achievements', open: p => p.ach >= 5 },
];

export const REPORT_REASONS = ['Offensive name', 'Spam in chat', 'Stalling or quitting', 'Other'];

function hue(name: string) { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
const escAttr = (s: string) => s.replace(/[&<>"']/g, c => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as any)[c]);

/** An avatar as HTML: the chosen emoji, or the name's first letter on a coloured tile. */
export function avatarHtml(name: string, emoji: string, frame: string, cls = ''): string {
  const inner = emoji ? `<span class="emo">${emoji}</span>` : escAttr((name[0] || '?').toUpperCase());
  return `<span class="av ${cls}${emoji ? ' hasEmo' : ''}${frame ? ' fr-' + frame : ''}" style="--h:${hue(name)}">${inner}</span>`;
}
