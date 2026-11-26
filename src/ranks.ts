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
