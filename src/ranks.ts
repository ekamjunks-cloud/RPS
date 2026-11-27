// Rank tiers, achievements and the daily/season calendar. The server decides who earns what;
// this file only names and draws it. Keep the tier lines in step with GOLD and DIAMOND in spacetimedb/src/index.ts.

export type Tier = { key: string; name: string; min: number; c1: string; c2: string };
export const TIERS: Tier[] = [
  { key: 'bronze', name: 'Bronze', min: -Infinity, c1: '#ffb98a', c2: '#b8622c' },
  { key: 'silver', name: 'Silver', min: 1100, c1: '#f2f4ff', c2: '#8f97bf' },
  { key: 'gold', name: 'Gold', min: 1200, c1: '#ffe27a', c2: '#e09a00' },
  { key: 'diamond', name: 'Diamond', min: 1350, c1: '#b9f6ff', c2: '#3d8cff' },
];
export function tierOf(rating: number): Tier {
  let t = TIERS[0]!;
  for (const x of TIERS) if (rating >= x.min) t = x;
  return t;
}
export function nextTier(rating: number): Tier | null {
  return TIERS.find(x => x.min > rating) ?? null;
}

// The rank badges (design board 27): each rank has its own shape, so they stay recognisable even when tiny.
// Drawn once into a hidden sprite; every badge is a <use> of it. The soft glow behind Gold and Diamond
// is dropped at small sizes through --rk-glow.
const RANK_SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"><defs>
<linearGradient id="rkBr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc49b"/><stop offset=".55" stop-color="#d27a3d"/><stop offset="1" stop-color="#8a4318"/></linearGradient>
<linearGradient id="rkBrD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9c5424"/><stop offset="1" stop-color="#5a2a0c"/></linearGradient>
<linearGradient id="rkSi" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#c3c9e6"/><stop offset="1" stop-color="#7a82a8"/></linearGradient>
<linearGradient id="rkSiD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8c94b8"/><stop offset="1" stop-color="#4a5175"/></linearGradient>
<linearGradient id="rkGo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3b0"/><stop offset=".45" stop-color="#ffc83d"/><stop offset="1" stop-color="#c47a00"/></linearGradient>
<linearGradient id="rkGoD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d99400"/><stop offset="1" stop-color="#7a4700"/></linearGradient>
<linearGradient id="rkDi" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e6fdff"/><stop offset=".4" stop-color="#7fe3ff"/><stop offset=".75" stop-color="#6f7bff"/><stop offset="1" stop-color="#d79cff"/></linearGradient>
<linearGradient id="rkDiD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d63d6"/><stop offset="1" stop-color="#22206e"/></linearGradient>
<radialGradient id="rkGlowGo"><stop offset="0" stop-color="#ffc83d" stop-opacity=".55"/><stop offset="1" stop-color="#ffc83d" stop-opacity="0"/></radialGradient>
<radialGradient id="rkGlowDi"><stop offset="0" stop-color="#7fe3ff" stop-opacity=".6"/><stop offset="1" stop-color="#7fe3ff" stop-opacity="0"/></radialGradient>
<symbol id="rk-bronze" viewBox="0 0 100 100"><path d="M50 8 84 20v26c0 22-15 36-34 44C31 82 16 68 16 46V20Z" fill="url(#rkBrD)"/><path d="M50 12 80 23v23c0 19-13 31-30 38C33 77 20 65 20 46V23Z" fill="url(#rkBr)"/><path d="M33 50 50 39 67 50" fill="none" stroke="#fff4ea" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M50 16 76 25" stroke="#fff" stroke-opacity=".45" stroke-width="3" stroke-linecap="round"/></symbol>
<symbol id="rk-silver" viewBox="0 0 100 100"><path d="M18 40C8 38 3 30 3 22c7 5 13 6 17 6M18 52C9 52 5 46 4 40c6 4 11 4 15 4" fill="url(#rkSi)" stroke="#4a5175" stroke-width="2"/><path d="M82 40c10-2 15-10 15-18-7 5-13 6-17 6M82 52c9 0 13-6 14-12-6 4-11 4-15 4" fill="url(#rkSi)" stroke="#4a5175" stroke-width="2"/><path d="M50 8 82 19v27c0 22-14 36-32 44C32 82 18 68 18 46V19Z" fill="url(#rkSiD)"/><path d="M50 12 78 22v24c0 19-12 31-28 38C34 77 22 65 22 46V22Z" fill="url(#rkSi)"/><path d="M34 44 50 34 66 44M34 58 50 48 66 58" fill="none" stroke="#3c4266" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="rk-gold" viewBox="0 0 100 100"><circle cx="50" cy="54" r="46" fill="url(#rkGlowGo)" style="opacity:var(--rk-glow,1)"/><path d="M20 40c-6 10-4 24 6 34M17 48c-2 2-6 2-8 0 2-3 6-3 8 0ZM18 59c-3 2-7 1-9-2 3-2 7-1 9 2ZM23 69c-3 1-7-1-8-4 3-1 7 1 8 4Z" fill="#ffc83d" stroke="#ffc83d" stroke-width="2" stroke-linecap="round"/><path d="M80 40c6 10 4 24-6 34M83 48c2 2 6 2 8 0-2-3-6-3-8 0ZM82 59c3 2 7 1 9-2-3-2-7-1-9 2ZM77 69c3 1 7-1 8-4-3-1-7 1-8 4Z" fill="#ffc83d" stroke="#ffc83d" stroke-width="2" stroke-linecap="round"/><path d="M50 20 78 30v20c0 19-12 31-28 38C34 81 22 69 22 50V30Z" fill="url(#rkGoD)"/><path d="M50 24 74 33v17c0 16-10 27-24 33C36 77 26 66 26 50V33Z" fill="url(#rkGo)"/><path d="M50 36l4.6 9.4 10.4 1.5-7.5 7.3 1.8 10.3L50 59.6l-9.3 4.9 1.8-10.3-7.5-7.3 10.4-1.5Z" fill="#fff8db" stroke="#c47a00" stroke-width="1.5" stroke-linejoin="round"/><path d="M34 22 38 8 46 16 50 5 54 16 62 8 66 22Z" fill="url(#rkGo)" stroke="#a86400" stroke-width="2" stroke-linejoin="round"/><circle cx="50" cy="15" r="2.6" fill="#ff4d6d"/></symbol>
<symbol id="rk-diamond" viewBox="0 0 100 100"><circle cx="50" cy="54" r="48" fill="url(#rkGlowDi)" style="opacity:var(--rk-glow,1)"/><path d="M24 46C12 44 4 34 3 22c9 7 17 9 23 9M24 58c-10 0-17-7-19-15 8 5 15 6 21 6M28 69c-9 1-15-4-18-11 7 3 13 3 19 2" fill="url(#rkDi)" stroke="#2b2f86" stroke-width="2" stroke-linejoin="round"/><path d="M76 46c12-2 20-12 21-24-9 7-17 9-23 9M76 58c10 0 17-7 19-15-8 5-15 6-21 6M72 69c9 1 15-4 18-11-7 3-13 3-19 2" fill="url(#rkDi)" stroke="#2b2f86" stroke-width="2" stroke-linejoin="round"/><path d="M30 36h40l12 15-32 38-32-38Z" fill="url(#rkDiD)"/><path d="M32 39h36l9 12-27 32-27-32Z" fill="url(#rkDi)"/><path d="M23 51h54M41 39l-5 12 14 32M59 39l5 12-14 32M41 39l9 12 9-12" fill="none" stroke="#2b2f86" stroke-opacity=".55" stroke-width="2"/><path d="M35 42l4 6" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><path d="M38 33 41 21 46 27 50 17 54 27 59 21 62 33Z" fill="url(#rkDi)" stroke="#2b2f86" stroke-width="2" stroke-linejoin="round"/><path d="M83 20l2 5 5 2-5 2-2 5-2-5-5-2 5-2ZM15 76l1.5 3.5 3.5 1.5-3.5 1.5L15 86l-1.5-3.5L10 81l3.5-1.5Z" fill="#fff" style="opacity:var(--rk-glow,1)"/></symbol>
</defs></svg>`;
if (typeof document !== 'undefined' && !document.getElementById('rk-bronze')) {
  const add = () => document.body.insertAdjacentHTML('afterbegin', RANK_SPRITE);
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
}

/** A rank badge. `cls` sets the size (xs, sm, or the default). */
export function tierBadge(t: Tier, cls = ''): string {
  return `<span class="tb ${cls}" title="${t.name}"><svg viewBox="0 0 100 100" aria-hidden="true"><use href="#rk-${t.key}"/></svg></span>`;
}

export type Achievement = { key: string; icon: string; name: string; how: string };
export const ACHIEVEMENTS: Achievement[] = [
  { key: 'first_win', icon: '🏆', name: 'First win', how: 'Win any match' },
  { key: 'perfect', icon: '💯', name: 'Perfect 10', how: 'Win all 10 rounds' },
  { key: 'comeback', icon: '🧗', name: 'Comeback', how: 'Win after being 3 rounds behind' },
  { key: 'clutch', icon: '🎯', name: 'Clutch', how: 'Level before the last round, then win it' },
  { key: 'full_house', icon: '🃏', name: 'Full house', how: 'Win every round with the kind you hold 4 of' },
  { key: 'streak5', icon: '🔥', name: 'On fire', how: 'Win 5 matches in a row' },
  { key: 'wins50', icon: '🎖️', name: 'Veteran', how: 'Win 50 matches' },
  { key: 'ranked_win', icon: '⚔️', name: 'Ranked win', how: 'Win a ranked match' },
  { key: 'silver', icon: '🥈', name: 'Silver', how: 'Reach Silver rank (1100)' },
  { key: 'gold', icon: '🥇', name: 'Gold', how: 'Reach Gold rank (1200)' },
  { key: 'diamond', icon: '💎', name: 'Diamond', how: 'Reach Diamond rank (1350)' },
  { key: 'friend', icon: '🤝', name: 'Friendly', how: 'Finish a match against a friend' },
  { key: 'rematch', icon: '🔁', name: 'Run it back', how: 'Play a rematch against a person' },
  { key: 'daily_win', icon: '📅', name: 'Daily winner', how: 'Beat a daily challenge' },
  { key: 'daily7', icon: '📆', name: 'Week streak', how: 'Play the daily challenge 7 days in a row' },
];
export const achievementOf = (key: string) => ACHIEVEMENTS.find(a => a.key === key);

// ---------- award medals (design board 30, A): bronze for everyday awards, silver for harder, gold for the big ones ----------
const MEDAL_TIER: Record<string, 'br' | 'si' | 'go' | 'di'> = {
  first_win: 'br', friend: 'br', rematch: 'br', ranked_win: 'br', daily_win: 'br',
  clutch: 'si', streak5: 'si', silver: 'si',
  perfect: 'go', comeback: 'go', full_house: 'go', wins50: 'go', daily7: 'go', gold: 'go',
  diamond: 'di',
};
const W = 'fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const T = (t: string, size: number, y = 17.5) => `<text x="12" y="${y}" text-anchor="middle" font-family="Lilita One, sans-serif" font-size="${size}" fill="#fff">${t}</text>`;
const GLYPH: Record<string, string> = {
  first_win: `<path d="M7 3.5h10v4.5a5 5 0 0 1-10 0Z M5 4.5H3v2a3.5 3.5 0 0 0 3.5 3.5 M19 4.5h2v2a3.5 3.5 0 0 1-3.5 3.5 M12 13v4 M8 20.5h8 M9.5 17h5v3.5h-5Z" ${W}/>`,
  perfect: T('10', 15) + '<path d="M4 20.5h16" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  comeback: `<path d="M3 18 8 13l3.5 3L20 7.5 M14.5 7.5H20V13" ${W} stroke-width="2.4"/>`,
  clutch: `<circle cx="12" cy="12" r="8" ${W}/><circle cx="12" cy="12" r="3.5" ${W}/><path d="M12 1.5v4 M12 18.5v4 M1.5 12h4 M18.5 12h4" ${W}/>`,
  full_house: `<rect x="3.5" y="6" width="9" height="13" rx="2" ${W} transform="rotate(-12 8 12.5)"/><rect x="11" y="5" width="9" height="13" rx="2" fill="#fff" fill-opacity=".25" stroke="#fff" stroke-width="2.2" transform="rotate(10 15.5 11.5)"/>`,
  streak5: `<path d="M12 2.5c1 4.2 6 5.6 6 11a6 6 0 0 1-12 0c0-3.2 2-4.6 2.6-7.4 1.3 1.3 2.2 2.6 2.8 4.4C13.5 8.6 12.8 5.2 12 2.5Z" ${W} stroke-width="2"/><path d="M12 21a2.6 2.6 0 0 1-2.6-2.6c0-1.7 1.6-2.4 2.6-4.4 1 2 2.6 2.7 2.6 4.4A2.6 2.6 0 0 1 12 21Z" fill="#fff"/>`,
  wins50: T('50', 14, 16) + `<path d="M5 19.5l3.5 2 3.5-2 3.5 2 3.5-2" ${W} stroke-width="1.8"/>`,
  ranked_win: `<path d="M4 4l11 11 M15 15l-2 2 M15 15l2-2 M20 4 9 15 M9 15l2 2 M9 15l-2-2 M4 20l3-3 M20 20l-3-3" ${W}/>`,
  silver: `<path d="M12 2.5 19.5 5.5v6c0 5-3.4 8.2-7.5 10-4.1-1.8-7.5-5-7.5-10v-6Z" ${W} stroke-width="2"/><path d="M8.5 11 12 8.5l3.5 2.5 M8.5 15 12 12.5l3.5 2.5" ${W} stroke-width="1.9"/>`,
  gold: `<path d="M3.5 18 2.5 7l5.5 4.5L12 4.5l4 7L21.5 7l-1 11Z M4 21h16" ${W}/><circle cx="12" cy="14" r="1.6" fill="#fff"/>`,
  diamond: `<path d="M6.5 4h11l4 5.5L12 21 2.5 9.5Z M2.5 9.5h19 M9 4 7.5 9.5 12 21 M15 4l1.5 5.5L12 21" ${W} stroke-width="1.9"/>`,
  friend: `<circle cx="8.5" cy="8" r="3.2" ${W} stroke-width="2.1"/><circle cx="16" cy="9" r="2.6" ${W} stroke-width="2"/><path d="M2.5 19.5c0-3.4 2.7-5.7 6-5.7s6 2.3 6 5.7 M15 14.3c3.3-.3 6.5 1.7 6.5 5.2" ${W} stroke-width="2.1"/>`,
  rematch: `<path d="M4 11a8 8 0 0 1 13.7-5.6L20 7.5 M20 3v4.5h-4.5 M20 13a8 8 0 0 1-13.7 5.6L4 16.5 M4 21v-4.5h4.5" ${W}/>`,
  daily_win: `<rect x="3.5" y="5" width="17" height="15.5" rx="2.5" ${W} stroke-width="2.1"/><path d="M3.5 10h17 M8 3v4 M16 3v4" ${W} stroke-width="2.1"/><path d="M8.5 15l2.5 2.5 4.5-4.5" ${W} stroke-width="2.1"/>`,
  daily7: `<rect x="3.5" y="5" width="17" height="15.5" rx="2.5" ${W} stroke-width="2.1"/><path d="M3.5 10h17 M8 3v4 M16 3v4" ${W} stroke-width="2.1"/>` + T('7', 8.5, 18.6),
};
const LOCK = `<rect x="5" y="11" width="14" height="9.5" rx="2.5" ${W}/><path d="M8 11V8a4 4 0 0 1 8 0v3" ${W}/>`;
const MEDAL_SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"><defs>
<linearGradient id="amBr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc49b"/><stop offset="1" stop-color="#9c5424"/></linearGradient>
<linearGradient id="amSi" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#7a82a8"/></linearGradient>
<linearGradient id="amGo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3b0"/><stop offset="1" stop-color="#d98a00"/></linearGradient>
<linearGradient id="amDi" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e6fdff"/><stop offset=".45" stop-color="#7fe3ff"/><stop offset="1" stop-color="#6f7bff"/></linearGradient>
<linearGradient id="amGrey" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5d5790"/><stop offset="1" stop-color="#2b2660"/></linearGradient>
<symbol id="am-ribbon" viewBox="0 0 64 64"><path d="M20 38 13 60l9-4 5 7 6-21Z" fill="#ff5a7a"/><path d="M44 38l7 22-9-4-5 7-6-21Z" fill="#6f7bff"/></symbol>
</defs></svg>`;
if (typeof document !== 'undefined' && !document.getElementById('amBr')) {
  const add = () => document.body.insertAdjacentHTML('afterbegin', MEDAL_SPRITE);
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
}
const RIM: Record<string, string> = { br: '#5a2a0c', si: '#4a5175', go: '#7a4700', di: '#22206e' };
/** An award's medal, `size` pixels across. Locked: a grey medal with a lock, and no ribbon. */
export function achIcon(key: string, size = 48, locked = false): string {
  const tier = MEDAL_TIER[key] || 'br';
  const name = achievementOf(key)?.name || key;
  if (locked) return `<svg class="achSvg locked" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${name} (not earned yet)"><circle cx="32" cy="29" r="22" fill="url(#amGrey)" stroke="#1d1850" stroke-width="2.5"/><g transform="translate(21 18) scale(.92)" opacity=".6">${LOCK}</g></svg>`;
  const fill = { br: 'amBr', si: 'amSi', go: 'amGo', di: 'amDi' }[tier];
  return `<svg class="achSvg" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${name}"><use href="#am-ribbon"/>`
    + `<circle cx="32" cy="27" r="22" fill="url(#${fill})" stroke="${RIM[tier]}" stroke-width="2.5"/>`
    + `<circle cx="32" cy="27" r="16.5" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.5"/>`
    + `<g transform="translate(20 15)" style="filter:drop-shadow(0 1px 0 rgba(0,0,0,.3))">${GLYPH[key] || GLYPH.first_win}</g></svg>`;
}

const DAY_MS = 86_400_000;
/** The UTC day number the daily challenge uses. */
export const today = () => Math.floor(Date.now() / DAY_MS);
/** Milliseconds until the next daily challenge (midnight UTC). */
export const msToNextDay = () => (today() + 1) * DAY_MS - Date.now();
/** Milliseconds until the season ends (the start of next month, UTC). */
export function msToSeasonEnd(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - Date.now();
}
export const seasonName = (key: number) =>
  new Date(Date.UTC(Math.floor(key / 12), key % 12, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' });

export function shortTime(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}
