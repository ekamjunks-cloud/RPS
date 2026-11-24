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

/** A small shield badge in the tier's colours. */
export function tierBadge(t: Tier, cls = ''): string {
  const id = 'tg' + t.key;
  const gem = t.key === 'diamond'
    ? '<path d="M24 17h16l5 7-13 16-13-16Z" fill="#fff" opacity=".85"/><path d="M19 24h26M28 17l-2 7 6 16M36 17l2 7-6 16" stroke="' + t.c2 + '" stroke-width="1.6" fill="none" opacity=".7"/>'
    : t.key === 'gold'
      ? '<path d="M32 15l4.7 9.6 10.5 1.5-7.6 7.4 1.8 10.5L32 39l-9.4 5 1.8-10.5-7.6-7.4 10.5-1.5Z" fill="#fff" opacity=".85"/>'
      : t.key === 'silver'
        ? '<path d="M21 23l11-7 11 7M21 32l11-7 11 7" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>'
        : '<path d="M21 28l11-7 11 7" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>';
  return `<span class="tb ${cls}" title="${t.name}"><svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.c1}"/><stop offset="1" stop-color="${t.c2}"/></linearGradient></defs>`
    + `<path d="M32 4 56 13v18c0 15-10 24-24 29C18 55 8 46 8 31V13Z" fill="url(#${id})" stroke="rgba(0,0,0,.25)" stroke-width="2"/>`
    + `<path d="M32 9 51 16v15c0 12-8 19.5-19 24" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="2"/>${gem}</svg></span>`;
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
