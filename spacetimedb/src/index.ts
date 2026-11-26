// RPS 10 — Spacetime server module.
//
// Every table is private. Players only ever receive what the views at the bottom return for them,
// so a modified client cannot read the opponent's hand, their selected card, or which kind they hold 4 of.
// All game rules, timers, matchmaking and ratings run here; the client only sends intentions.

import { ScheduleAt, Timestamp, type Identity } from 'spacetimedb';
import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { config } from './config';
import {
  ITEM, ITEMS, itemOf, REACTIONS, PHRASES, REACTION_SLOTS, PHRASE_SLOTS, DEFAULT_REACTIONS, DEFAULT_PHRASES,
  COINS, COIN_MULT, BIG_ACHIEVEMENTS, FOR_SALE, type ItemKind,
} from './catalog';

// ---------- settings ----------
const TIMES = { prep: 20000, readyGo: 600, banner: 1600, pick: 10000, reveal: 3000, result: 3000 }; // ms
const ROUNDS = 10;               // every match is this many rounds (one per card); most rounds won takes it
const DC_GRACE_MS = 15000;       // a disconnected player has this long to come back
const QUEUE_RETRY_MS = 5000;     // re-check the queue this often...
const QUEUE_RETRIES = 3;         // ...this many times (15s), then start a bot match
const CLEANUP_MS = 10 * 60 * 1000;      // finished games are removed after 10 minutes
const SWEEP_EVERY_MICROS = 6n * 3600n * 1_000_000n;
const GUEST_IDLE_MICROS = 30n * 24n * 3600n * 1_000_000n; // unused guest profiles are removed after 30 days
const K_STEPS = [32, 16, 8, 4];         // rating K-factor for the 1st, 2nd... ranked game vs the same opponent in 24h, then 0
const DAY_MICROS = 24n * 3600n * 1_000_000n;
const HISTORY_KEEP = 20;         // matches kept in each player's history
// rank tiers by rating. Keep in step with TIERS in src/ranks.ts.
const GOLD = 1200, DIAMOND = 1350;
const DAILY_STAT_KEEP_DAYS = 3;

// XP for a finished match, before the mode multiplier. Forfeits and disconnects give the winner a little, the loser nothing.
const XP = { win: 30, draw: 15, loss: 10, walkover: 10, dailyBonus: 25 };
const XP_MULT: Record<string, number> = { ranked: 1.5, casual: 1, room: 1, daily: 1, bot: 0.5, practice: 0.5 };
const BUG_REPORTS_PER_DAY = 5;
// looks saved before custom avatars and auras existed are shown as their nearest new equivalent
const OLD_AURA: Record<string, string> = { fire: 'blaze', daily: 'sunrise' };
/** Level from total XP. Level n needs 100 + 25 × (n − 1) XP to reach level n + 1. */
function levelOf(xp: number) {
  let level = 1, need = 100;
  while (xp >= need) { xp -= need; level += 1; need = 100 + 25 * (level - 1); }
  return { level, into: xp, need };
}
const FRIENDS_MAX = 100;
const REPORT_REASONS = ['Offensive name', 'Spam in chat', 'Stalling or quitting', 'Other'];

// chat: only the reactions and phrases in src/catalog.ts can be sent, so there is no free typing between strangers.
const CHAT_KEEP = 40;            // messages kept per game
const CHAT_BURST = 4;            // at most this many messages...
const CHAT_BURST_MS = 4000;      // ...in this long, per player

// card kinds: 0 rock, 1 paper, 2 scissors
const beats = (a: number, b: number) => (a - b + 3) % 3 === 1;
const NONE = -2;   // no card revealed yet
const MISSED = -1; // player was too slow

// ---------- tables (all private) ----------
const player = table(
  { name: 'player' },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    nameKey: t.string().unique(),   // lowercase name: "Bob" and "bob" can't both exist
    isGuest: t.bool(),
    rating: t.i32(),
    wins: t.u32(),
    losses: t.u32(),
    draws: t.u32(),
    tutorialDone: t.bool(),
    practiceDone: t.bool(),
    conns: t.u32(),                 // open connections (tabs/devices)
    gameId: t.u64(),                // 0 = not in a game
    waiting: t.string(),            // '' | 'queue' | 'room'
    roomCode: t.string(),
    createdAt: t.timestamp(),
    lastSeen: t.timestamp(),
    banned: t.bool().default(false), // suspended by an admin: can't play online or chat
  }
);

const game = table(
  { name: 'game' },
  {
    id: t.u64().primaryKey().autoInc(),
    mode: t.string(),               // 'ranked' | 'casual' | 'room' | 'bot' | 'practice' | 'daily'
    rated: t.bool(),
    p0: t.identity(),
    p1: t.identity(),               // ignored when p1Bot
    p1Bot: t.bool(),
    name0: t.string(),
    name1: t.string(),
    phase: t.string(),              // 'prep' | 'banner' | 'pick' | 'reveal' | 'result' | 'over'
    seq: t.u32(),                   // bumped on every phase change; stale timers are ignored
    deadline: t.timestamp(),
    phaseMs: t.u32(),
    round: t.u32(),
    score0: t.u32(),
    score1: t.u32(),
    ready0: t.bool(),
    ready1: t.bool(),
    sel0: t.u64(),                  // selected card id this round, 0 = none. Never sent to the opponent.
    sel1: t.u64(),
    last0: t.i8(),                  // cards of the current reveal: NONE, MISSED or a kind
    last1: t.i8(),
    lastWinner: t.i8(),             // -1 draw, 0, 1
    over: t.bool(),
    winner: t.i8(),                 // -1 draw, 0, 1
    reason: t.string(),             // 'points' | 'forfeit' | 'disconnect'
    ratingDelta: t.i32(),           // rating change of p0 (p1 gets the opposite)
    conn0: t.bool(),
    conn1: t.bool(),
    dc0: t.timestamp(),             // when a disconnected player forfeits; epoch = connected
    dc1: t.timestamp(),
    lock0: t.bool().default(false), // locked in this round's card. New columns go last, with a default.
    lock1: t.bool().default(false),
    rematch0: t.bool().default(false), // asked for a rematch on the end screen
    rematch1: t.bool().default(false),
    xp0: t.u32().default(0),           // XP each player earned from this match
    xp1: t.u32().default(0),
    coins0: t.u32().default(0),        // coins each player earned from this match (bonuses included)
    coins1: t.u32().default(0),
  }
);

const handCard = table(
  { name: 'hand_card' },
  {
    id: t.u64().primaryKey().autoInc(),
    gameId: t.u64().index('btree'),
    seat: t.u8(),
    kind: t.u8(),
    pos: t.u32(),                   // the order the owner arranged their hand in
  }
);

const roundLog = table(
  { name: 'round_log' },
  {
    id: t.u64().primaryKey().autoInc(),
    gameId: t.u64().index('btree'),
    n: t.u32(),
    c0: t.i8(),
    c1: t.i8(),
    winner: t.i8(),
  }
);

const gameTimer = table(
  { name: 'game_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    gameId: t.u64().index('btree'),
    kind: t.string(),               // 'phase' | 'botReady' | 'botPick' | 'dc0' | 'dc1' | 'cleanup'
    seq: t.u32(),
  }
);

const queueEntry = table(
  { name: 'queue_entry' },
  {
    identity: t.identity().primaryKey(),
    rating: t.i32(),
    joinedAt: t.timestamp(),
    casual: t.bool().default(false), // unranked queue: only matched with other unranked players
  }
);

const queueTimer = table(
  { name: 'queue_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    identity: t.identity().index('btree'),
    attempt: t.u32(),
  }
);

const room = table(
  { name: 'room' },
  {
    code: t.string().primaryKey(),
    host: t.identity().unique(),
  }
);

// How many ranked games a pair of players has played in the current 24h window.
const pairStat = table(
  { name: 'pair_stat' },
  {
    key: t.string().primaryKey(),
    count: t.u32(),
    windowStart: t.timestamp(),
  }
);

// One row per account that has played ranked. Kept apart from `player` so the leaderboard
// is only recomputed when a rating changes, not every time someone connects.
const ladder = table(
  { name: 'ladder' },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    rating: t.i32(),
    games: t.u32(),
    board: t.u8().index('btree'),   // always 0: lets the leaderboard view read every row through an index
  }
);

// Match history, for your own monitoring (query it from the Spacetime dashboard).
const matchResult = table(
  { name: 'match_result' },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.timestamp(),
    mode: t.string(),
    rated: t.bool(),
    name0: t.string(),
    name1: t.string(),
    winner: t.i8(),
    reason: t.string(),
    score0: t.u32(),
    score1: t.u32(),
    rounds: t.u32(),
    ratingDelta: t.i32(),
  }
);

// Private random state for dealing hands. The built-in ctx.random is seeded from the clock alone,
// which a determined cheater could reconstruct from their own hand; this mixes in a secret.
const rngState = table({ name: 'rng_state' }, { id: t.u8().primaryKey(), state: t.u64() });

// A one-time code that lets a guest hand their progress to the Google account they sign in with.
const transfer = table(
  { name: 'transfer' },
  {
    code: t.string().primaryKey(),
    guest: t.identity().unique(),
    createdAt: t.timestamp(),
  }
);

// Chat and emoji reactions inside one game. Only the two players in that game can read them.
const chatMsg = table(
  { name: 'chat_msg' },
  {
    id: t.u64().primaryKey().autoInc(),
    gameId: t.u64().index('btree'),
    seat: t.u8(),
    kind: t.string(),               // 'emoji' | 'phrase'
    body: t.string(),
    at: t.timestamp(),
  }
);

const sweepTimer = table(
  { name: 'sweep_timer' },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() }
);

// Lifetime numbers behind the stats screen, the daily streak and achievements. One row per player who has played.
const stats = table(
  { name: 'stats' },
  {
    identity: t.identity().primaryKey(),
    plays0: t.u32(), plays1: t.u32(), plays2: t.u32(),   // rounds played with rock, paper, scissors
    wins0: t.u32(), wins1: t.u32(), wins2: t.u32(),      // ...and won
    opens0: t.u32(), opens1: t.u32(), opens2: t.u32(),   // first card of a match
    streak: t.u32(), bestStreak: t.u32(),                // match wins in a row
    perfects: t.u32(),
    dailyLast: t.u32(),     // UTC day number of the last daily challenge started (0 = never)
    dailyStreak: t.u32(), dailyBest: t.u32(), dailyWins: t.u32(),
    dailyResult: t.string(), // '' while today's is being played, then 'win' | 'loss' | 'draw'
    dailyYou: t.u32(), dailyThem: t.u32(),
    lastSeason: t.i32(),    // rating at the end of the previous season (0 = didn't play it)
    xp: t.u32().default(0), // lifetime experience: levels unlock card styles
  }
);

// Each player's recent matches, newest kept.
const history = table(
  { name: 'history' },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity().index('btree'),
    at: t.timestamp(),
    mode: t.string(),
    opp: t.string(),
    oppBot: t.bool(),
    result: t.string(),     // 'win' | 'loss' | 'draw'
    reason: t.string(),
    you: t.u32(),
    them: t.u32(),
    ratingChange: t.i32(),
    cards: t.string(),      // your card each round: r, p, s, or - for too slow
    outcomes: t.string(),   // each round: w, l or d
  }
);

const achievement = table(
  { name: 'achievement' },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity().index('btree'),
    key: t.string(),
    at: t.timestamp(),
  }
);

// Ranked seasons run by calendar month (UTC). At the start of a month ratings move halfway back to 1000
// and the leaderboard starts empty.
const season = table(
  { name: 'season' },
  { id: t.u8().primaryKey(), key: t.u32(), champ: t.string(), champRating: t.i32(), week: t.u32().default(0), day: t.u32().default(0) }
);

// How many people played and beat each day's challenge.
const dailyStat = table(
  { name: 'daily_stat' },
  { day: t.u32().primaryKey(), plays: t.u32(), wins: t.u32(), board: t.u8().index('btree') }
);

// How a player shows up to others, and their in-match chat loadout. `frame` is the aura.
const look = table(
  { name: 'look' },
  {
    identity: t.identity().primaryKey(), avatar: t.string(), frame: t.string(), skin: t.string(),
    back: t.string().default('classic'),
    color: t.string().default('green'),
    fx: t.string().default('confetti'),
    title: t.string().default(''),
    reactions: t.string().default(DEFAULT_REACTIONS), // comma-separated reaction ids, up to 6
    phrases: t.string().default(DEFAULT_PHRASES),     // '|'-separated phrases, up to 4
  }
);

// Coins. Kept on the server, so they are never lost. Nobody can buy coins (yet): every coin is earned by playing.
const wallet = table(
  { name: 'wallet' },
  { identity: t.identity().primaryKey(), coins: t.u32(), earned: t.u32(), spent: t.u32(), firstWinDay: t.u32() }
);

// Things bought in the Store. Free, Level-road and achievement items are worked out, not stored.
const owned = table(
  { name: 'owned' },
  { id: t.u64().primaryKey().autoInc(), identity: t.identity().index('btree'), item: t.string(), at: t.timestamp() }
);

// This week's points (ranked only: 3 a win, 1 a draw). Emptied every Monday 00:00 UTC.
const weekly = table(
  { name: 'weekly' },
  { identity: t.identity().primaryKey(), name: t.string(), points: t.u32(), at: t.timestamp(), board: t.u8().index('btree') }
);

// "Report a bug" from Settings, for you to read on the admin page.
const bug = table(
  { name: 'bug' },
  {
    id: t.u64().primaryKey().autoInc(), identity: t.identity().index('btree'), name: t.string(),
    text: t.string(), version: t.string(), device: t.string(), at: t.timestamp(),
  }
);

// Daily numbers for the admin page.
const dayCount = table(
  { name: 'day_count' },
  { day: t.u32().primaryKey(), matches: t.u32(), newPlayers: t.u32(), board: t.u8().index('btree') }
);

// A message the admin page can show everyone, e.g. planned maintenance.
const notice = table(
  { name: 'notice' },
  { id: t.u8().primaryKey(), maintenance: t.bool(), message: t.string(), at: t.timestamp() }
);

// Friendships, two rows each: owner's view of other. 'out' = owner asked, 'in' = other asked, 'friends'.
const friend = table(
  { name: 'friend' },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity().index('btree'),
    other: t.identity().index('btree'),
    state: t.string(),
    at: t.timestamp(),
  }
);

// "Come play": a friend's invitation into their room. Disappears when the room closes.
const invite = table(
  { name: 'invite' },
  {
    id: t.u64().primaryKey().autoInc(),
    from: t.identity().index('btree'),
    to: t.identity().index('btree'),
    code: t.string(),
    at: t.timestamp(),
  }
);

// Player reports, for you to review (see README).
const report = table(
  { name: 'report' },
  {
    id: t.u64().primaryKey().autoInc(),
    reporter: t.identity().index('btree'),
    reported: t.identity(),
    reportedName: t.string(),
    gameId: t.u64(),
    reason: t.string(),
    at: t.timestamp(),
  }
);

// Someone watching a friend's matches. Follows the friend from match to match.
const watcher = table(
  { name: 'watcher' },
  { identity: t.identity().primaryKey(), target: t.identity().index('btree'), since: t.timestamp() }
);

const spacetimedb = schema({
  player, game, handCard, roundLog, gameTimer, queueEntry, queueTimer, room, pairStat, ladder, matchResult, rngState, sweepTimer, transfer, chatMsg,
  stats, history, achievement, season, dailyStat, look, friend, invite, report, watcher,
  wallet, owned, weekly, bug, dayCount, notice,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type PlayerRow = NonNullable<ReturnType<Ctx['db']['player']['identity']['find']>>;
type GameRow = NonNullable<ReturnType<Ctx['db']['game']['id']['find']>>;

// ---------- small helpers ----------
const EPOCH = new Timestamp(0n);
const addMs = (ts: Timestamp, ms: number) => new Timestamp(ts.microsSinceUnixEpoch + BigInt(Math.round(ms)) * 1000n);
const isSet = (ts: Timestamp) => ts.microsSinceUnixEpoch !== 0n;

/** True when the caller is signed in with Google through your Firebase project. */
function isGoogle(ctx: Ctx): boolean {
  const pid = config.firebaseProjectId;
  const jwt = ctx.senderAuth.jwt;
  return !!pid && !!jwt && jwt.issuer === `https://securetoken.google.com/${pid}` && jwt.audience.includes(pid);
}

function me(ctx: Ctx): PlayerRow {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) throw new SenderError('Not connected. Refresh the page.');
  return p;
}
function seatOf(g: GameRow, who: Identity): 0 | 1 | -1 {
  if (g.p0.isEqual(who)) return 0;
  if (!g.p1Bot && g.p1.isEqual(who)) return 1;
  return -1;
}
function liveGame(ctx: Ctx, p: PlayerRow): GameRow | undefined {
  if (p.gameId === 0n) return undefined;
  const g = ctx.db.game.id.find(p.gameId);
  return g && !g.over ? g : undefined;
}
function cardsOf(ctx: Ctx, gameId: bigint, seat: number) {
  return Array.from(ctx.db.handCard.gameId.filter(gameId)).filter(c => c.seat === seat).sort((a, b) => a.pos - b.pos);
}
function logsOf(ctx: Ctx, gameId: bigint) {
  return Array.from(ctx.db.roundLog.gameId.filter(gameId)).sort((a, b) => a.n - b.n);
}

const MASK64 = (1n << 64n) - 1n;
function mix64(x: bigint): bigint {
  let z = (x + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}
/** Returns next(n): a secret random integer in [0, n). */
function secretRng(ctx: Ctx): (n: number) => number {
  const row = ctx.db.rngState.id.find(0);
  const fresh = (BigInt(ctx.random.uint32()) << 32n) | BigInt(ctx.random.uint32());
  let s = mix64((row ? row.state : mix64(fresh)) ^ (ctx.timestamp.microsSinceUnixEpoch & MASK64) ^ fresh);
  const stored = mix64(s ^ 0xa5a5a5a5a5a5a5a5n);
  if (row) ctx.db.rngState.id.update({ id: 0, state: stored });
  else ctx.db.rngState.insert({ id: 0, state: stored });
  return (n: number) => {
    s = mix64(s);
    return Number(s % BigInt(n));
  };
}

// ---------- timers ----------
function clearTimers(ctx: Ctx, gameId: bigint, kinds?: string[]) {
  for (const tm of Array.from(ctx.db.gameTimer.gameId.filter(gameId))) {
    if (!kinds || kinds.includes(tm.kind)) ctx.db.gameTimer.scheduledId.delete(tm.scheduledId);
  }
}
function addTimer(ctx: Ctx, g: GameRow, kind: string, ms: number) {
  ctx.db.gameTimer.insert({
    scheduledId: 0n, scheduledAt: ScheduleAt.time(addMs(ctx.timestamp, ms).microsSinceUnixEpoch),
    gameId: g.id, kind, seq: g.seq,
  });
}
function setPhase(ctx: Ctx, g: GameRow, phase: string, ms: number) {
  g.phase = phase;
  g.seq += 1;
  g.phaseMs = ms;
  g.deadline = addMs(ctx.timestamp, ms);
  clearTimers(ctx, g.id, ['phase', 'botReady', 'botPick']);
  addTimer(ctx, g, 'phase', ms);
}

// ---------- chat ----------
function postChat(ctx: Ctx, gameId: bigint, seat: number, kind: string, body: string) {
  ctx.db.chatMsg.insert({ id: 0n, gameId, seat, kind, body, at: ctx.timestamp });
  const all = Array.from(ctx.db.chatMsg.gameId.filter(gameId)).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const m of all.slice(0, Math.max(0, all.length - CHAT_KEEP))) ctx.db.chatMsg.id.delete(m.id);
}
/** Now and then the bot reacts to how a round went. */
function botReact(ctx: Ctx, g: GameRow) {
  if (!g.p1Bot || ctx.random() > 0.3) return;
  const pool = g.lastWinner === 1 ? ['cool', 'evil', 'fire'] : g.lastWinner === 0 ? ['grr', 'sob', 'whoa'] : ['hmm', 'nice'];
  postChat(ctx, g.id, 1, 'emoji', pool[ctx.random.integerInRange(0, pool.length - 1)]!);
}

// ---------- seasons, stats, daily challenge and achievements ----------
type StatsRow = NonNullable<ReturnType<Ctx['db']['stats']['identity']['find']>>;
/** UTC day number: the daily challenge changes at midnight UTC. */
const dayOf = (ts: Timestamp) => Number(ts.microsSinceUnixEpoch / DAY_MICROS);
/** Season = calendar month (UTC), as year * 12 + month. */
function seasonKeyOf(ts: Timestamp) {
  const d = new Date(Number(ts.microsSinceUnixEpoch / 1000n));
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}
function statsOf(ctx: Ctx, who: Identity): StatsRow {
  return ctx.db.stats.identity.find(who) ?? {
    identity: who, plays0: 0, plays1: 0, plays2: 0, wins0: 0, wins1: 0, wins2: 0, opens0: 0, opens1: 0, opens2: 0,
    streak: 0, bestStreak: 0, perfects: 0, dailyLast: 0, dailyStreak: 0, dailyBest: 0, dailyWins: 0,
    dailyResult: '', dailyYou: 0, dailyThem: 0, lastSeason: 0, xp: 0,
  };
}
function saveStats(ctx: Ctx, s: StatsRow) {
  if (ctx.db.stats.identity.find(s.identity)) ctx.db.stats.identity.update(s); else ctx.db.stats.insert(s);
}
/** Gives an achievement (once) and its coins. Returns the coins paid, 0 if it was already earned. */
function award(ctx: Ctx, who: Identity, key: string): number {
  for (const a of ctx.db.achievement.identity.filter(who)) if (a.key === key) return 0;
  ctx.db.achievement.insert({ id: 0n, identity: who, key, at: ctx.timestamp });
  const coins = BIG_ACHIEVEMENTS.includes(key) ? COINS.achBig : COINS.ach;
  addCoins(ctx, who, coins);
  return coins;
}

// ---------- coins and owned items ----------
type WalletRow = NonNullable<ReturnType<Ctx['db']['wallet']['identity']['find']>>;
/** A player's wallet. Everyone starts with the welcome gift, including players from before coins existed. */
function walletOf(ctx: Ctx, who: Identity): WalletRow {
  return ctx.db.wallet.identity.find(who) ?? { identity: who, coins: COINS.welcome, earned: COINS.welcome, spent: 0, firstWinDay: 0 };
}
function saveWallet(ctx: Ctx, w: WalletRow) {
  if (ctx.db.wallet.identity.find(w.identity)) ctx.db.wallet.identity.update(w); else ctx.db.wallet.insert(w);
}
function addCoins(ctx: Ctx, who: Identity, n: number) {
  if (n <= 0) return;
  const w = walletOf(ctx, who);
  saveWallet(ctx, { ...w, coins: w.coins + n, earned: w.earned + n });
}
/** Coins for reaching each level from `from`+1 to `to`: 100 a level, 300 on every fifth. */
function levelCoins(from: number, to: number) {
  let n = 0;
  for (let l = from + 1; l <= to; l++) n += l % 5 === 0 ? COINS.level5 : COINS.level;
  return n;
}
const isVip = (who: Identity) => config.allSkins.includes(who.toHexString().replace(/^0x/, '').toLowerCase());
const isAdmin = (who: Identity) => config.admins.includes(who.toHexString().replace(/^0x/, '').toLowerCase());
const levelFor = (ctx: Ctx, who: Identity) => levelOf(statsOf(ctx, who).xp).level;

/** Every item id this player owns: free ones, ones their level or achievements unlock, and ones they bought. */
function ownedItems(ctx: Ctx, who: Identity): Set<string> {
  if (isVip(who)) return new Set(ITEMS.map(i => i.id));
  const level = levelFor(ctx, who);
  const achs = new Set(Array.from(ctx.db.achievement.identity.filter(who), a => a.key));
  const out = new Set<string>();
  for (const i of ITEMS) {
    if (i.free || (i.level !== undefined && level >= i.level) || (i.ach && achs.has(i.ach))) out.add(i.id);
  }
  for (const o of ctx.db.owned.identity.filter(who)) out.add(o.item);
  return out;
}

/** The Store's daily deal: one item a day, 20% off, the same for everyone. */
function dealOf(day: number) {
  const item = FOR_SALE[Number(mix64(BigInt(day) * 0x2545f491n) % BigInt(FOR_SALE.length))]!;
  return { item, price: Math.round(item.price! * (1 - COINS.dealOff)) };
}
/** The week number for the weekly leaderboard: weeks start on Monday 00:00 UTC. */
const weekOf = (day: number) => Math.floor((day + 3) / 7);

/** Removes a player's stats, history, achievements, coins, items and leaderboard places. */
function dropProgress(ctx: Ctx, who: Identity) {
  ctx.db.stats.identity.delete(who);
  ctx.db.wallet.identity.delete(who);
  for (const o of Array.from(ctx.db.owned.identity.filter(who))) ctx.db.owned.id.delete(o.id);
  ctx.db.weekly.identity.delete(who);
  for (const h of Array.from(ctx.db.history.identity.filter(who))) ctx.db.history.id.delete(h.id);
  for (const x of Array.from(ctx.db.achievement.identity.filter(who))) ctx.db.achievement.id.delete(x.id);
  ctx.db.look.identity.delete(who);
  ctx.db.watcher.identity.delete(who);
  for (const f of Array.from(ctx.db.friend.owner.filter(who))) ctx.db.friend.id.delete(f.id);
  for (const f of Array.from(ctx.db.friend.other.filter(who))) ctx.db.friend.id.delete(f.id);
  for (const i of Array.from(ctx.db.invite.from.filter(who))) ctx.db.invite.id.delete(i.id);
  for (const i of Array.from(ctx.db.invite.to.filter(who))) ctx.db.invite.id.delete(i.id);
}
/** Counts matches and new players for today, for the admin page. */
function bumpDay(ctx: Ctx, matches: number, newPlayers: number) {
  const day = dayOf(ctx.timestamp);
  const row = ctx.db.dayCount.day.find(day);
  if (row) ctx.db.dayCount.day.update({ ...row, matches: row.matches + matches, newPlayers: row.newPlayers + newPlayers });
  else ctx.db.dayCount.insert({ day, matches, newPlayers, board: 0 });
}
function bumpDaily(ctx: Ctx, day: number, plays: number, wins: number) {
  const row = ctx.db.dailyStat.day.find(day);
  if (row) ctx.db.dailyStat.day.update({ ...row, plays: row.plays + plays, wins: row.wins + wins });
  else ctx.db.dailyStat.insert({ day, plays, wins, board: 0 });
}

/** Starts a new season when the month has changed: ratings move halfway back to 1000 and the leaderboard empties. */
function checkSeason(ctx: Ctx) {
  const key = seasonKeyOf(ctx.timestamp);
  const day = dayOf(ctx.timestamp);
  const week = weekOf(day);
  let row = ctx.db.season.id.find(0);
  if (!row) { ctx.db.season.insert({ id: 0, key, champ: '', champRating: 0, week, day }); return; }
  if (row.day !== day) { row = { ...row, day }; ctx.db.season.id.update(row); }
  if (row.week !== week) {
    // a new week: the weekly board starts empty
    for (const w of Array.from(ctx.db.weekly.iter())) ctx.db.weekly.identity.delete(w.identity);
    row = { ...row, week };
    ctx.db.season.id.update(row);
  }
  if (row.key === key) return;
  const ranked = Array.from(ctx.db.ladder.iter()).sort((a, b) => b.rating - a.rating);
  for (const s of Array.from(ctx.db.stats.iter())) if (s.lastSeason !== 0) ctx.db.stats.identity.update({ ...s, lastSeason: 0 });
  for (const l of ranked) {
    saveStats(ctx, { ...statsOf(ctx, l.identity), lastSeason: l.rating });
    const p = ctx.db.player.identity.find(l.identity);
    if (p) ctx.db.player.identity.update({ ...p, rating: 1000 + Math.round((p.rating - 1000) / 2) });
    ctx.db.ladder.identity.delete(l.identity);
  }
  const top = ranked[0];
  ctx.db.season.id.update({ ...row, key, champ: top ? top.name : '', champRating: top ? top.rating : 0 });
}

/** Saves a finished match to a player's history and stats, and hands out any achievements it earned. */
function recordMatch(ctx: Ctx, g: GameRow, seat: number, p: PlayerRow, ratingChange: number) {
  const logs = logsOf(ctx, g.id);
  const mine = (l: { c0: number; c1: number }) => (seat === 0 ? l.c0 : l.c1);
  const won = g.winner === seat, lost = g.winner === 1 - seat;
  const res = won ? 'win' : lost ? 'loss' : 'draw';
  const you = seat === 0 ? g.score0 : g.score1, them = seat === 0 ? g.score1 : g.score0;

  ctx.db.history.insert({
    id: 0n, identity: p.identity, at: ctx.timestamp, mode: g.mode, opp: seat === 0 ? g.name1 : g.name0, oppBot: g.p1Bot,
    result: res, reason: g.reason, you, them, ratingChange,
    cards: logs.map(l => (mine(l) >= 0 ? 'rps'[mine(l)] : '-')).join(''),
    outcomes: logs.map(l => (l.winner === -1 ? 'd' : l.winner === seat ? 'w' : 'l')).join(''),
  });
  const old = Array.from(ctx.db.history.identity.filter(p.identity)).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const h of old.slice(0, Math.max(0, old.length - HISTORY_KEEP))) ctx.db.history.id.delete(h.id);

  const s = statsOf(ctx, p.identity);
  const plays = [s.plays0, s.plays1, s.plays2], wins = [s.wins0, s.wins1, s.wins2], opens = [s.opens0, s.opens1, s.opens2];
  const counts = [0, 0, 0];
  for (const l of logs) {
    const c = mine(l);
    if (c < 0) continue;
    plays[c]! += 1; counts[c]! += 1;
    if (l.winner === seat) wins[c]! += 1;
  }
  if (logs[0] && mine(logs[0]) >= 0) opens[mine(logs[0])]! += 1;
  const perfect = won && logs.length === ROUNDS && logs.every(l => l.winner === seat);
  const streak = won ? s.streak + 1 : 0;
  const full = g.reason === 'points';
  const gained = Math.round(((full ? (won ? XP.win : lost ? XP.loss : XP.draw) : won ? XP.walkover : 0)
    + (g.mode === 'daily' && full ? XP.dailyBonus : 0)) * (XP_MULT[g.mode] ?? 1));
  if (seat === 0) g.xp0 = gained; else g.xp1 = gained;
  const next: StatsRow = {
    ...s, plays0: plays[0]!, plays1: plays[1]!, plays2: plays[2]!, wins0: wins[0]!, wins1: wins[1]!, wins2: wins[2]!,
    opens0: opens[0]!, opens1: opens[1]!, opens2: opens[2]!,
    streak, bestStreak: Math.max(s.bestStreak, streak), perfects: s.perfects + (perfect ? 1 : 0),
    xp: s.xp + gained,
  };
  if (g.mode === 'daily') {
    next.dailyResult = res; next.dailyYou = you; next.dailyThem = them;
    if (won) { next.dailyWins += 1; bumpDaily(ctx, s.dailyLast, 0, 1); }
  }
  saveStats(ctx, next);

  // coins: the match itself, the first win of the day, the daily challenge and any level-ups
  const today = dayOf(ctx.timestamp);
  const w = walletOf(ctx, p.identity);
  let coins = Math.round((full ? (won ? COINS.win : lost ? COINS.loss : COINS.draw) : won ? COINS.walkover : 0) * (COIN_MULT[g.mode] ?? 1));
  let firstWinDay = w.firstWinDay;
  if (won && w.firstWinDay !== today) { coins += COINS.firstWin; firstWinDay = today; }
  if (g.mode === 'daily' && won) coins += COINS.dailyWin;
  coins += levelCoins(levelOf(s.xp).level, levelOf(next.xp).level);
  saveWallet(ctx, { ...w, coins: w.coins + coins, earned: w.earned + coins, firstWinDay });

  // the weekly board: ranked matches only
  const pts = !g.rated ? 0 : won ? 3 : full && !lost ? 1 : 0;
  if (pts > 0) {
    const wk = ctx.db.weekly.identity.find(p.identity);
    if (wk) ctx.db.weekly.identity.update({ ...wk, name: p.name, points: wk.points + pts, at: ctx.timestamp });
    else ctx.db.weekly.insert({ identity: p.identity, name: p.name, points: pts, at: ctx.timestamp, board: 0 });
  }

  const got = (key: string) => { coins += award(ctx, p.identity, key); };
  if (won) got('first_win');
  if (perfect) got('perfect');
  let a = 0, b = 0, behind = 0;
  for (const l of logs) {
    if (l.winner === seat) a++; else if (l.winner === 1 - seat) b++;
    behind = Math.max(behind, b - a);
  }
  if (won && behind >= 3) got('comeback');
  const last = logs[logs.length - 1];
  if (won && logs.length === ROUNDS && last && last.winner === seat && you - 1 === them) got('clutch');
  const four = counts.indexOf(4);
  if (won && four >= 0 && logs.filter(l => mine(l) === four).every(l => l.winner === seat)) got('full_house');
  if (streak >= 5) got('streak5');
  if (p.wins >= 50) got('wins50');
  if (won && g.rated) got('ranked_win');
  if (g.rated && p.rating >= GOLD) got('gold');
  if (g.rated && p.rating >= DIAMOND) got('diamond');
  if (g.mode === 'room' && g.reason === 'points') got('friend');
  if (g.mode === 'daily' && won) got('daily_win');
  if (seat === 0) g.coins0 = coins; else g.coins1 = coins;
}

/** A random-number source that gives the same numbers for the same seed (the daily challenge deal). */
function seededRng(seed: bigint): (n: number) => number {
  let s = seed & MASK64;
  return (n: number) => { s = mix64(s); return Number(s % BigInt(n)); };
}
const BOT_NAMES = ['Rocky', 'Snips', 'Papyrus', 'Clutch', 'Nova', 'Blitz', 'Vex', 'Echo'];

// ---------- game flow ----------
function startGame(ctx: Ctx, a: PlayerRow, b: PlayerRow | undefined, mode: string, bot?: string, seed?: bigint) {
  const rng = secretRng(ctx);
  const deal = seed === undefined ? rng : seededRng(seed);
  const botName = bot || BOT_NAMES[rng(BOT_NAMES.length)] + '_bot';
  const g = ctx.db.game.insert({
    id: 0n, mode, rated: mode === 'ranked',
    p0: a.identity, p1: b ? b.identity : a.identity, p1Bot: !b,
    name0: a.name, name1: b ? b.name : botName,
    phase: 'prep', seq: 0, deadline: ctx.timestamp, phaseMs: 0, round: 1,
    score0: 0, score1: 0, ready0: false, ready1: false, sel0: 0n, sel1: 0n,
    last0: NONE, last1: NONE, lastWinner: -1,
    over: false, winner: -1, reason: '', ratingDelta: 0,
    conn0: a.conns > 0, conn1: b ? b.conns > 0 : true, dc0: EPOCH, dc1: EPOCH,
    lock0: false, lock1: false, rematch0: false, rematch1: false, xp0: 0, xp1: 0, coins0: 0, coins1: 0,
  });
  // deal: 3 of two kinds and 4 of a third, shuffled
  for (const seat of [0, 1]) {
    const four = deal(3);
    const hand: number[] = [];
    for (let k = 0; k < 3; k++) for (let i = 0; i < (k === four ? 4 : 3); i++) hand.push(k);
    for (let i = hand.length - 1; i > 0; i--) { const j = deal(i + 1); [hand[i], hand[j]] = [hand[j]!, hand[i]!]; }
    hand.forEach((kind, pos) => ctx.db.handCard.insert({ id: 0n, gameId: g.id, seat, kind, pos }));
  }
  for (const p of b ? [a, b] : [a]) {
    ctx.db.player.identity.update({ ...p, gameId: g.id, waiting: '', roomCode: '' });
    ctx.db.watcher.identity.delete(p.identity); // playing now, not watching
  }
  setPhase(ctx, g, 'prep', TIMES.prep);
  if (g.p1Bot) addTimer(ctx, g, 'botReady', 3000 + rng(6000));
  // a player who is already gone when the game starts gets the same grace period as any disconnect
  if (!g.conn0) { g.dc0 = addMs(ctx.timestamp, DC_GRACE_MS); addTimer(ctx, g, 'dc0', DC_GRACE_MS); }
  if (!g.conn1) { g.dc1 = addMs(ctx.timestamp, DC_GRACE_MS); addTimer(ctx, g, 'dc1', DC_GRACE_MS); }
  ctx.db.game.id.update(g);
}

function markReady(ctx: Ctx, g: GameRow, seat: number) {
  if (g.phase !== 'prep') return;
  if (seat === 0) { if (g.ready0) return; g.ready0 = true; } else { if (g.ready1) return; g.ready1 = true; }
  if (g.ready0 && g.ready1) {
    clearTimers(ctx, g.id, ['phase', 'botReady']);
    g.seq += 1;
    g.phaseMs = TIMES.readyGo;
    g.deadline = addMs(ctx.timestamp, TIMES.readyGo);
    addTimer(ctx, g, 'phase', TIMES.readyGo);
  }
}

function startRound(ctx: Ctx, g: GameRow) {
  g.sel0 = 0n; g.sel1 = 0n; g.lock0 = false; g.lock1 = false;
  g.last0 = NONE; g.last1 = NONE; g.lastWinner = -1;
  setPhase(ctx, g, 'banner', TIMES.banner);
}

function reveal(ctx: Ctx, g: GameRow) {
  // only a locked-in card counts; a card that was picked but not locked in time is "too slow"
  const picked = [g.lock0 ? g.sel0 : 0n, g.lock1 ? g.sel1 : 0n].map((sel, seat) => {
    const c = sel !== 0n ? ctx.db.handCard.id.find(sel) : undefined;
    if (!c || c.gameId !== g.id || c.seat !== seat) return MISSED;
    ctx.db.handCard.id.delete(c.id);
    return c.kind;
  });
  const [a, b] = picked as [number, number];
  let winner = -1;
  if (a >= 0 && b >= 0) winner = beats(a, b) ? 0 : beats(b, a) ? 1 : -1;
  else if (a >= 0) winner = 0;      // opponent was too slow
  else if (b >= 0) winner = 1;
  g.last0 = a; g.last1 = b; g.lastWinner = winner;
  g.sel0 = 0n; g.sel1 = 0n; g.lock0 = false; g.lock1 = false;
  setPhase(ctx, g, 'reveal', TIMES.reveal);
}

/** Moves the game on when its phase timer fires. */
function advance(ctx: Ctx, g: GameRow) {
  switch (g.phase) {
    case 'prep':
      startRound(ctx, g);
      break;
    case 'banner':
      setPhase(ctx, g, 'pick', TIMES.pick);
      if (g.p1Bot) addTimer(ctx, g, 'botPick', 700 + ctx.random.integerInRange(0, 3500));
      break;
    case 'pick':
      reveal(ctx, g);
      break;
    case 'reveal':
      if (g.lastWinner === 0) g.score0 += 1;
      if (g.lastWinner === 1) g.score1 += 1;
      ctx.db.roundLog.insert({ id: 0n, gameId: g.id, n: g.round, c0: g.last0, c1: g.last1, winner: g.lastWinner });
      botReact(ctx, g);
      setPhase(ctx, g, 'result', TIMES.result);
      break;
    case 'result': {
      const out = g.round >= ROUNDS
        || cardsOf(ctx, g.id, 0).length === 0 || cardsOf(ctx, g.id, 1).length === 0;
      if (out) finish(ctx, g, 'points');
      else { g.round += 1; startRound(ctx, g); }
      break;
    }
  }
}

function pairK(ctx: Ctx, a: Identity, b: Identity): number {
  const key = [a.toHexString(), b.toHexString()].sort().join('|');
  const row = ctx.db.pairStat.key.find(key);
  const fresh = !row || ctx.timestamp.microsSinceUnixEpoch - row.windowStart.microsSinceUnixEpoch > DAY_MICROS;
  const count = fresh ? 0 : row!.count;
  const next = { key, count: count + 1, windowStart: fresh ? ctx.timestamp : row!.windowStart };
  if (row) ctx.db.pairStat.key.update(next); else ctx.db.pairStat.insert(next);
  return K_STEPS[count] ?? 0;
}

/** Ends the game, saves results and ratings. Mutates g; the caller writes it back. */
function finish(ctx: Ctx, g: GameRow, reason: string, forcedWinner?: number) {
  if (g.over) return;
  const winner = forcedWinner ?? (g.score0 > g.score1 ? 0 : g.score1 > g.score0 ? 1 : -1);
  g.over = true; g.phase = 'over'; g.winner = winner; g.reason = reason;
  g.seq += 1; g.sel0 = 0n; g.sel1 = 0n; g.lock0 = false; g.lock1 = false; g.deadline = ctx.timestamp; g.phaseMs = 0;
  const rounds = logsOf(ctx, g.id).length;
  clearTimers(ctx, g.id);
  for (const c of Array.from(ctx.db.handCard.gameId.filter(g.id))) ctx.db.handCard.id.delete(c.id);

  if (g.rated) checkSeason(ctx);
  const a = ctx.db.player.identity.find(g.p0);
  const b = g.p1Bot ? undefined : ctx.db.player.identity.find(g.p1);
  let delta = 0;
  if (g.rated && a && b) {
    const k = pairK(ctx, a.identity, b.identity);
    const expected = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
    delta = Math.round(k * ((winner === -1 ? 0.5 : winner === 0 ? 1 : 0) - expected));
  }
  g.ratingDelta = delta;
  const practice = (g.mode === 'practice' || g.mode === 'bot' || g.mode === 'daily') && reason === 'points';
  [a, b].forEach((p, seat) => {
    if (!p) return;
    const updated = {
      ...p,
      wins: p.wins + (winner === seat ? 1 : 0),
      losses: p.losses + (winner === 1 - seat ? 1 : 0),
      draws: p.draws + (winner === -1 ? 1 : 0),
      rating: p.rating + (seat === 0 ? delta : -delta),
      practiceDone: p.practiceDone || practice,
    };
    ctx.db.player.identity.update(updated);
    if (g.rated) {
      const l = ctx.db.ladder.identity.find(p.identity);
      const row = { identity: p.identity, name: p.name, rating: updated.rating, games: (l ? l.games : 0) + 1, board: 0 };
      if (l) ctx.db.ladder.identity.update(row); else ctx.db.ladder.insert(row);
    }
    recordMatch(ctx, g, seat, updated, seat === 0 ? delta : -delta);
  });
  ctx.db.matchResult.insert({
    id: 0n, at: ctx.timestamp, mode: g.mode, rated: g.rated, name0: g.name0, name1: g.name1,
    winner, reason, score0: g.score0, score1: g.score1, rounds, ratingDelta: delta,
  });
  bumpDay(ctx, 1, 0);
  addTimer(ctx, g, 'cleanup', CLEANUP_MS);
  if (g.p1Bot && reason === 'points' && ctx.random() < 0.6) {
    const lines = winner === 1 ? ['gg', 'Too easy'] : ['gg', 'Well played', 'Nice one!'];
    postChat(ctx, g.id, 1, 'phrase', lines[ctx.random.integerInRange(0, lines.length - 1)]!);
  }
}

function botPick(ctx: Ctx, g: GameRow): bigint {
  const mine = cardsOf(ctx, g.id, 1);
  const oppLeft = Math.max(1, cardsOf(ctx, g.id, 0).length);
  const played = [0, 0, 0];
  for (const l of logsOf(ctx, g.id)) if (l.c0 >= 0) played[l.c0]! += 1;
  // weigh each kind by how many the opponent can still hold, over every "which kind do they have 4 of" that fits
  const w = [0, 0, 0];
  for (let four = 0; four < 3; four++) {
    if (![0, 1, 2].every(x => played[x]! <= (x === four ? 4 : 3))) continue;
    for (let k = 0; k < 3; k++) w[k]! += Math.max(0, (k === four ? 4 : 3) - played[k]!) / oppLeft;
  }
  const total = w[0]! + w[1]! + w[2]! || 1;
  let best = 0n, bestValue = -9;
  for (const c of mine) {
    let v = 0;
    for (let y = 0; y < 3; y++) {
      if (beats(c.kind, y)) v += w[y]! / total;
      else if (beats(y, c.kind)) v -= w[y]! / total;
    }
    v += (ctx.random() - 0.5) * 0.4;
    if (v > bestValue) { bestValue = v; best = c.id; }
  }
  return best;
}

export const gameTick = spacetimedb.reducer({ onSchedule: gameTimer }, { arg: gameTimer.rowType }, (ctx, { arg }) => {
  const g = ctx.db.game.id.find(arg.gameId);
  if (!g) return;
  if (arg.kind === 'cleanup') {
    for (const l of Array.from(ctx.db.roundLog.gameId.filter(g.id))) ctx.db.roundLog.id.delete(l.id);
    for (const m of Array.from(ctx.db.chatMsg.gameId.filter(g.id))) ctx.db.chatMsg.id.delete(m.id);
    for (const who of g.p1Bot ? [g.p0] : [g.p0, g.p1]) {
      const p = ctx.db.player.identity.find(who);
      if (p && p.gameId === g.id) ctx.db.player.identity.update({ ...p, gameId: 0n });
    }
    clearTimers(ctx, g.id);
    ctx.db.game.id.delete(g.id);
    return;
  }
  if (g.over) return;
  if (arg.kind === 'dc0' || arg.kind === 'dc1') {
    const seat = arg.kind === 'dc0' ? 0 : 1;
    if (seat === 0 ? g.conn0 : g.conn1) return; // came back in time
    finish(ctx, g, 'disconnect', 1 - seat);
  } else {
    if (arg.seq !== g.seq) return; // the game has moved on since this timer was set
    if (arg.kind === 'phase') advance(ctx, g);
    else if (arg.kind === 'botReady') markReady(ctx, g, 1);
    else if (arg.kind === 'botPick' && g.phase === 'pick') {
      // the daily bot plays its hand in a fixed order, the same for everyone that day
      g.sel1 = g.mode === 'daily' ? (cardsOf(ctx, g.id, 1)[0]?.id ?? 0n) : botPick(ctx, g);
      g.lock1 = g.sel1 !== 0n;
      if (g.lock0 && g.lock1) reveal(ctx, g);
    }
  }
  ctx.db.game.id.update(g);
});

// ---------- queue and rooms ----------
function dequeue(ctx: Ctx, who: Identity) {
  ctx.db.queueEntry.identity.delete(who);
  for (const tm of Array.from(ctx.db.queueTimer.identity.filter(who))) ctx.db.queueTimer.scheduledId.delete(tm.scheduledId);
}
function closeOwnRoom(ctx: Ctx, p: PlayerRow) {
  if (p.roomCode) ctx.db.room.code.delete(p.roomCode);
  for (const i of Array.from(ctx.db.invite.from.filter(p.identity))) ctx.db.invite.id.delete(i.id);
}
/** Clears whatever the player was waiting for. Returns the updated row (already saved). */
function stopWaiting(ctx: Ctx, p: PlayerRow): PlayerRow {
  ctx.db.watcher.identity.delete(p.identity);
  dequeue(ctx, p.identity);
  closeOwnRoom(ctx, p);
  if (p.waiting === '' && p.roomCode === '') return p;
  const next = { ...p, waiting: '', roomCode: '' };
  ctx.db.player.identity.update(next);
  return next;
}
function assertFree(ctx: Ctx, p: PlayerRow) {
  if (liveGame(ctx, p)) throw new SenderError('You are already in a game');
}

/** Pairs this player with the closest-rated waiting player. The allowed gap widens the longer either has waited. */
function tryMatch(ctx: Ctx, who: Identity): boolean {
  const mine = ctx.db.queueEntry.identity.find(who);
  if (!mine) return false;
  const waited = (e: { joinedAt: Timestamp }) => Number(ctx.timestamp.microsSinceUnixEpoch - e.joinedAt.microsSinceUnixEpoch) / 1e6;
  let best: typeof mine | undefined;
  for (const e of ctx.db.queueEntry.iter()) {
    if (e.identity.isEqual(who) || e.casual !== mine.casual) continue;
    const gap = Math.abs(e.rating - mine.rating);
    if (gap > 150 + 50 * Math.max(waited(mine), waited(e))) continue;
    if (!best || gap < Math.abs(best.rating - mine.rating)) best = e;
  }
  if (!best) return false;
  const a = ctx.db.player.identity.find(best.identity), b = ctx.db.player.identity.find(who);
  dequeue(ctx, best.identity); dequeue(ctx, who);
  if (!a || !b) return false;
  startGame(ctx, a, b, mine.casual ? 'casual' : 'ranked'); // the longer-waiting player is seat 0
  return true;
}

export const queueTick = spacetimedb.reducer({ onSchedule: queueTimer }, { arg: queueTimer.rowType }, (ctx, { arg }) => {
  if (!ctx.db.queueEntry.identity.find(arg.identity)) return;
  if (tryMatch(ctx, arg.identity)) return;
  if (arg.attempt < QUEUE_RETRIES) {
    ctx.db.queueTimer.insert({
      scheduledId: 0n, scheduledAt: ScheduleAt.time(addMs(ctx.timestamp, QUEUE_RETRY_MS).microsSinceUnixEpoch),
      identity: arg.identity, attempt: arg.attempt + 1,
    });
    return;
  }
  // nobody around: give them a bot so they are never left waiting
  dequeue(ctx, arg.identity);
  const p = ctx.db.player.identity.find(arg.identity);
  if (!p) return;
  if (p.conns > 0 && !liveGame(ctx, p)) startGame(ctx, p, undefined, 'bot');
  else ctx.db.player.identity.update({ ...p, waiting: '' });
});

// ---------- what clients may call ----------
export const finishTutorial = spacetimedb.reducer(ctx => {
  const p = me(ctx);
  if (!p.tutorialDone) ctx.db.player.identity.update({ ...p, tutorialDone: true });
});

/** Turns the guest profile into an account by claiming a unique name. Stats and progress stay. */
export const claimName = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const p = me(ctx);
  if (!p.isGuest) throw new SenderError('You already have an account');
  if (config.firebaseProjectId && !isGoogle(ctx)) throw new SenderError('Sign in with Google first');
  name = name.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new SenderError('Username: 3–16 letters, numbers or _');
  const key = name.toLowerCase();
  if (/^guest_/.test(key) || /_bot$/.test(key) || ctx.db.player.nameKey.find(key)) throw new SenderError('Username taken');
  ctx.db.player.identity.update({ ...p, name, nameKey: key, isGuest: false });
});

/** Called by a guest just before they sign in with Google: issues a one-time code for their progress. */
export const prepareTransfer = spacetimedb.reducer(ctx => {
  const p = me(ctx);
  if (!p.isGuest) return;
  const old = ctx.db.transfer.guest.find(p.identity);
  if (old) ctx.db.transfer.code.delete(old.code);
  const rng = secretRng(ctx);
  const code = Array.from({ length: 32 }, () => rng(16).toString(16)).join('');
  ctx.db.transfer.insert({ code, guest: p.identity, createdAt: ctx.timestamp });
});

/** Called right after signing in with Google: a brand-new account takes over the guest's stats and progress. */
export const claimTransfer = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  if (!isGoogle(ctx)) throw new SenderError('Sign in with Google first');
  const p = me(ctx);
  const row = ctx.db.transfer.code.find(code);
  if (!row) return;
  ctx.db.transfer.code.delete(row.code);
  let guest = ctx.db.player.identity.find(row.guest);
  if (!guest || !guest.isGuest || guest.identity.isEqual(p.identity)) return;
  // only a fresh account takes the guest's progress; a returning player keeps their own
  const fresh = p.isGuest && p.wins + p.losses + p.draws === 0 && !p.practiceDone;
  if (!fresh || liveGame(ctx, guest) || liveGame(ctx, p)) return;
  guest = stopWaiting(ctx, guest);
  ctx.db.player.identity.delete(guest.identity);
  dropProgress(ctx, p.identity);
  const gs = ctx.db.stats.identity.find(guest.identity);
  if (gs) { ctx.db.stats.identity.delete(gs.identity); ctx.db.stats.insert({ ...gs, identity: p.identity }); }
  for (const h of Array.from(ctx.db.history.identity.filter(guest.identity))) ctx.db.history.id.update({ ...h, identity: p.identity });
  for (const x of Array.from(ctx.db.achievement.identity.filter(guest.identity))) ctx.db.achievement.id.update({ ...x, identity: p.identity });
  const gl = ctx.db.look.identity.find(guest.identity);
  if (gl) { ctx.db.look.identity.delete(gl.identity); ctx.db.look.insert({ ...gl, identity: p.identity }); }
  const gw = ctx.db.wallet.identity.find(guest.identity);
  if (gw) { ctx.db.wallet.identity.delete(gw.identity); ctx.db.wallet.insert({ ...gw, identity: p.identity }); }
  for (const o of Array.from(ctx.db.owned.identity.filter(guest.identity))) ctx.db.owned.id.update({ ...o, identity: p.identity });
  for (const f of Array.from(ctx.db.friend.owner.filter(guest.identity))) ctx.db.friend.id.update({ ...f, owner: p.identity });
  for (const f of Array.from(ctx.db.friend.other.filter(guest.identity))) ctx.db.friend.id.update({ ...f, other: p.identity });
  ctx.db.watcher.identity.delete(guest.identity);
  ctx.db.player.identity.update({
    ...p, wins: guest.wins, losses: guest.losses, draws: guest.draws,
    tutorialDone: p.tutorialDone || guest.tutorialDone, practiceDone: guest.practiceDone,
  });
});

export const startPractice = spacetimedb.reducer(ctx => {
  let p = me(ctx);
  assertFree(ctx, p);
  p = stopWaiting(ctx, p);
  startGame(ctx, p, undefined, 'practice');
});

/**
 * Today's daily challenge: a bot whose hand and play order are the same for everyone today, and so is your hand.
 * One try a day. Playing on consecutive days builds a streak.
 */
export const startDaily = spacetimedb.reducer(ctx => {
  let p = me(ctx);
  assertFree(ctx, p);
  if (!p.tutorialDone) throw new SenderError('Finish the tutorial first');
  const today = dayOf(ctx.timestamp);
  const s = statsOf(ctx, p.identity);
  if (s.dailyLast === today) throw new SenderError("You've played today's challenge. A new one starts at midnight UTC.");
  const dailyStreak = s.dailyLast === today - 1 ? s.dailyStreak + 1 : 1;
  saveStats(ctx, { ...s, dailyLast: today, dailyStreak, dailyBest: Math.max(s.dailyBest, dailyStreak), dailyResult: '', dailyYou: 0, dailyThem: 0 });
  if (dailyStreak >= 7) award(ctx, p.identity, 'daily7');
  bumpDaily(ctx, today, 1, 0);
  addCoins(ctx, p.identity, COINS.dailyPlay);
  p = stopWaiting(ctx, p);
  startGame(ctx, p, undefined, 'daily', BOT_NAMES[today % BOT_NAMES.length] + '_daily', mix64(BigInt(today) * 0x9e3779b1n + 0x5eedn));
});

function assertNotBanned(p: PlayerRow) {
  if (p.banned) throw new SenderError('This account is suspended. Contact us from Settings if you think this is a mistake.');
}
/** During maintenance no new online matches start; matches already running carry on. */
function assertOpen(ctx: Ctx) {
  const n = ctx.db.notice.id.find(0);
  if (n && n.maintenance) throw new SenderError(n.message || 'The game is being updated. Back in a few minutes!');
}

/** Ranked: rated, and counts on the leaderboards. */
export const joinQueue = spacetimedb.reducer(ctx => enqueue(ctx, false));
/** Unranked: a real opponent, normal XP and coins, no rating change, not on the leaderboards. */
export const joinCasual = spacetimedb.reducer(ctx => enqueue(ctx, true));

function enqueue(ctx: Ctx, casual: boolean) {
  let p = me(ctx);
  assertFree(ctx, p);
  assertNotBanned(p);
  assertOpen(ctx);
  if (config.requireAccount && p.isGuest) throw new SenderError('Create an account to play online');
  if (!p.tutorialDone || !p.practiceDone) throw new SenderError('Finish the tutorial and a practice match first');
  const queued = ctx.db.queueEntry.identity.find(p.identity);
  if (queued && queued.casual === casual) return;
  checkSeason(ctx);
  p = me(ctx); // the season change may have moved this player's rating
  p = stopWaiting(ctx, p);
  ctx.db.queueEntry.insert({ identity: p.identity, rating: p.rating, joinedAt: ctx.timestamp, casual });
  ctx.db.player.identity.update({ ...p, waiting: 'queue', gameId: 0n });
  if (tryMatch(ctx, p.identity)) return;
  ctx.db.queueTimer.insert({
    scheduledId: 0n, scheduledAt: ScheduleAt.time(addMs(ctx.timestamp, QUEUE_RETRY_MS).microsSinceUnixEpoch),
    identity: p.identity, attempt: 1,
  });
}

export const leaveQueue = spacetimedb.reducer(ctx => {
  stopWaiting(ctx, me(ctx));
});

export const createRoom = spacetimedb.reducer(ctx => {
  const p = me(ctx);
  assertFree(ctx, p);
  assertNotBanned(p);
  assertOpen(ctx);
  openRoom(ctx, stopWaiting(ctx, p));
});

/** Opens a friend room for p (who is free and not waiting) and returns its code. */
function openRoom(ctx: Ctx, p: PlayerRow): string {
  const rng = secretRng(ctx);
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => ALPHABET[rng(ALPHABET.length)]).join('');
  } while (ctx.db.room.code.find(code));
  ctx.db.room.insert({ code, host: p.identity });
  ctx.db.player.identity.update({ ...p, waiting: 'room', roomCode: code, gameId: 0n });
  return code;
}

export const closeRoom = spacetimedb.reducer(ctx => {
  stopWaiting(ctx, me(ctx));
});

export const joinRoom = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  let p = me(ctx);
  assertFree(ctx, p);
  assertNotBanned(p);
  assertOpen(ctx);
  const r = ctx.db.room.code.find(code.trim().toUpperCase().slice(0, 5));
  if (!r) throw new SenderError('Room not found');
  if (r.host.isEqual(p.identity)) throw new SenderError("That's your own room");
  const host = ctx.db.player.identity.find(r.host);
  if (!host || host.conns === 0 || liveGame(ctx, host)) throw new SenderError('Room not available');
  p = stopWaiting(ctx, p);
  startGame(ctx, stopWaiting(ctx, host), p, 'room');
});

/** Runs fn on the caller's live game, then saves it. Does nothing if they aren't in one. */
function inGame(ctx: Ctx, fn: (g: GameRow, seat: 0 | 1) => void) {
  const g = liveGame(ctx, me(ctx));
  if (!g) return;
  const seat = seatOf(g, ctx.sender);
  if (seat === -1) return;
  fn(g, seat);
  ctx.db.game.id.update(g);
}

export const ready = spacetimedb.reducer(ctx => inGame(ctx, (g, seat) => markReady(ctx, g, seat)));

export const selectCard = spacetimedb.reducer({ cardId: t.u64() }, (ctx, { cardId }) => inGame(ctx, (g, seat) => {
  if (g.phase !== 'pick' || (seat === 0 ? g.lock0 : g.lock1)) return; // can't change a locked-in card
  const c = ctx.db.handCard.id.find(cardId);
  if (!c || c.gameId !== g.id || c.seat !== seat) return; // not your card
  if (seat === 0) g.sel0 = cardId; else g.sel1 = cardId;
}));

/** Locks in the selected card. Once both players have locked in, the round is revealed straight away. */
export const lockIn = spacetimedb.reducer(ctx => inGame(ctx, (g, seat) => {
  if (g.phase !== 'pick') return;
  if (seat === 0) { if (g.sel0 === 0n) return; g.lock0 = true; } else { if (g.sel1 === 0n) return; g.lock1 = true; }
  if (g.lock0 && g.lock1) reveal(ctx, g);
}));

export const reorderHand = spacetimedb.reducer({ ids: t.array(t.u64()) }, (ctx, { ids }) => {
  const g = liveGame(ctx, me(ctx));
  if (!g) return;
  const seat = seatOf(g, ctx.sender);
  const hand = seat === -1 ? [] : cardsOf(ctx, g.id, seat);
  if (ids.length !== hand.length || new Set(ids).size !== ids.length) return;
  const byId = new Map(hand.map(c => [c.id, c]));
  if (ids.some(id => !byId.has(id))) return;
  ids.forEach((id, pos) => {
    const c = byId.get(id)!;
    if (c.pos !== pos) ctx.db.handCard.id.update({ ...c, pos });
  });
});

export const forfeit = spacetimedb.reducer(ctx => inGame(ctx, (g, seat) => finish(ctx, g, 'forfeit', 1 - seat)));

/** True while the opponent of seat `seat` is still on this finished game's end screen. */
function oppStillHere(ctx: Ctx, g: GameRow, seat: number): boolean {
  if (g.p1Bot) return true;
  const o = ctx.db.player.identity.find(seat === 0 ? g.p1 : g.p0);
  return !!o && o.gameId === g.id && o.conns > 0;
}

/**
 * Asks for a rematch from a finished game's end screen. Against a bot it starts straight away.
 * Against a person it starts once both have asked, in the same mode (a ranked rematch is rated,
 * and repeat games against the same opponent already count for less).
 */
export const rematch = spacetimedb.reducer(ctx => {
  const p = me(ctx);
  const g = p.gameId === 0n ? undefined : ctx.db.game.id.find(p.gameId);
  if (!g || !g.over) throw new SenderError('That match is no longer available');
  const seat = seatOf(g, ctx.sender);
  if (seat === -1) return;
  if (g.mode === 'daily') throw new SenderError('One daily challenge a day. Come back tomorrow!');
  if (g.p1Bot) { startGame(ctx, stopWaiting(ctx, p), undefined, g.mode, g.name1); return; }
  if (!oppStillHere(ctx, g, seat)) throw new SenderError('Your opponent has left');
  if (seat === 0) g.rematch0 = true; else g.rematch1 = true;
  ctx.db.game.id.update(g);
  if (!g.rematch0 || !g.rematch1) return;
  const a = ctx.db.player.identity.find(g.p0)!, b = ctx.db.player.identity.find(g.p1)!;
  award(ctx, a.identity, 'rematch'); award(ctx, b.identity, 'rematch');
  startGame(ctx, stopWaiting(ctx, b), stopWaiting(ctx, a), g.mode); // swap seats so the other player is seat 0
});

/**
 * Sends one of the fixed emoji or phrases to the other player in your current game (also on the end screen).
 * Anything not on the lists is refused, and players are rate-limited.
 */
export const sendChat = spacetimedb.reducer({ kind: t.string(), body: t.string() }, (ctx, { kind, body }) => {
  const p = me(ctx);
  const g = p.gameId === 0n ? undefined : ctx.db.game.id.find(p.gameId);
  if (!g) throw new SenderError('You are not in a match');
  const seat = seatOf(g, ctx.sender);
  if (seat === -1) return;
  assertNotBanned(p);
  const pack = kind === 'emoji' ? REACTIONS[body] : kind === 'phrase' ? PHRASES[body] : undefined;
  if (kind !== 'emoji' && kind !== 'phrase') throw new SenderError('Unknown message type');
  if (!pack) throw new SenderError(kind === 'emoji' ? 'Unknown reaction' : 'Pick one of the phrases');
  if (!ownedItems(ctx, p.identity).has(`pack:${pack}`)) throw new SenderError('Unlock that chat pack first');
  const since = ctx.timestamp.microsSinceUnixEpoch - BigInt(CHAT_BURST_MS) * 1000n;
  let recent = 0;
  for (const m of ctx.db.chatMsg.gameId.filter(g.id)) if (m.seat === seat && m.at.microsSinceUnixEpoch > since) recent++;
  if (recent >= CHAT_BURST) throw new SenderError('Slow down a little');
  postChat(ctx, g.id, seat, kind, body);
});

// ---------- looks, friends, invites, reports, watching ----------
type LookRow = NonNullable<ReturnType<Ctx['db']['look']['identity']['find']>>;
const lookRowOf = (ctx: Ctx, who: Identity): LookRow => ctx.db.look.identity.find(who) ?? {
  identity: who, avatar: 'rocky', frame: '', skin: 'classic', back: 'classic', color: 'green', fx: 'confetti', title: '',
  reactions: DEFAULT_REACTIONS, phrases: DEFAULT_PHRASES,
};
function saveLook(ctx: Ctx, row: LookRow) {
  if (ctx.db.look.identity.find(row.identity)) ctx.db.look.identity.update(row); else ctx.db.look.insert(row);
}
// which look field each kind of item goes in
const SLOT: Partial<Record<ItemKind, keyof LookRow>> = {
  avatar: 'avatar', aura: 'frame', skin: 'skin', back: 'back', color: 'color', fx: 'fx', title: 'title',
};

/** Wears an item you own: an avatar, aura, card style, card back, message colour, win effect or title. */
export const equip = spacetimedb.reducer({ kind: t.string(), key: t.string() }, (ctx, { kind, key }) => {
  const p = me(ctx);
  const slot = SLOT[kind as ItemKind];
  const item = itemOf(kind as ItemKind, key);
  if (!slot || !item) throw new SenderError('Unknown item');
  if (!ownedItems(ctx, p.identity).has(item.id)) throw new SenderError('Unlock that first, on the Level road or in the Store');
  saveLook(ctx, { ...lookRowOf(ctx, p.identity), [slot]: key });
});

/** Sets which reactions (up to 6) and phrases (up to 4) show in your quick chat during a match. */
export const setLoadout = spacetimedb.reducer({ reactions: t.array(t.string()), phrases: t.array(t.string()) }, (ctx, { reactions, phrases }) => {
  const p = me(ctx);
  if (reactions.length > REACTION_SLOTS || phrases.length > PHRASE_SLOTS) throw new SenderError('Too many chat items');
  if (new Set(reactions).size !== reactions.length || new Set(phrases).size !== phrases.length) throw new SenderError('Each chat item can only be used once');
  const mine = ownedItems(ctx, p.identity);
  for (const r of reactions) if (!REACTIONS[r] || !mine.has(`pack:${REACTIONS[r]}`)) throw new SenderError('Unlock that reaction first');
  for (const ph of phrases) if (!PHRASES[ph] || !mine.has(`pack:${PHRASES[ph]}`)) throw new SenderError('Unlock that phrase first');
  saveLook(ctx, { ...lookRowOf(ctx, p.identity), reactions: reactions.join(','), phrases: phrases.join('|') });
});

/** Buys an item from the Store with coins. Today's deal is 20% off. */
export const buyItem = spacetimedb.reducer({ item: t.string() }, (ctx, { item: id }) => {
  const p = me(ctx);
  const item = ITEM.get(id);
  if (!item || item.price === undefined) throw new SenderError("That isn't for sale");
  if (ownedItems(ctx, p.identity).has(id)) throw new SenderError('You already own that');
  const deal = dealOf(dayOf(ctx.timestamp));
  const price = deal.item.id === id ? deal.price : item.price;
  const w = walletOf(ctx, p.identity);
  if (w.coins < price) throw new SenderError(`You need ${price - w.coins} more coins`);
  saveWallet(ctx, { ...w, coins: w.coins - price, spent: w.spent + price });
  ctx.db.owned.insert({ id: 0n, identity: p.identity, item: id, at: ctx.timestamp });
});

function relation(ctx: Ctx, owner: Identity, other: Identity) {
  for (const f of ctx.db.friend.owner.filter(owner)) if (f.other.isEqual(other)) return f;
  return undefined;
}
function befriend(ctx: Ctx, p: PlayerRow, o: PlayerRow) {
  if (o.identity.isEqual(p.identity)) throw new SenderError("That's you!");
  const mine = relation(ctx, p.identity, o.identity);
  if (mine) {
    if (mine.state === 'friends') throw new SenderError(`You and ${o.name} are already friends`);
    if (mine.state === 'out') throw new SenderError(`Friend request already sent to ${o.name}`);
    // they already asked: this accepts
    ctx.db.friend.id.update({ ...mine, state: 'friends', at: ctx.timestamp });
    const theirs = relation(ctx, o.identity, p.identity);
    if (theirs) ctx.db.friend.id.update({ ...theirs, state: 'friends', at: ctx.timestamp });
    return;
  }
  if (Array.from(ctx.db.friend.owner.filter(p.identity)).length >= FRIENDS_MAX) throw new SenderError('Your friends list is full');
  if (Array.from(ctx.db.friend.owner.filter(o.identity)).length >= FRIENDS_MAX) throw new SenderError(`${o.name}'s friends list is full`);
  ctx.db.friend.insert({ id: 0n, owner: p.identity, other: o.identity, state: 'out', at: ctx.timestamp });
  ctx.db.friend.insert({ id: 0n, owner: o.identity, other: p.identity, state: 'in', at: ctx.timestamp });
}
/** The other person in your current or just-finished match. */
function opponentOf(ctx: Ctx, p: PlayerRow): { g: GameRow; o: PlayerRow } {
  const g = p.gameId === 0n ? undefined : ctx.db.game.id.find(p.gameId);
  const seat = g ? seatOf(g, p.identity) : -1;
  if (!g || seat === -1 || g.p1Bot) throw new SenderError('There is no opponent to do that with');
  const o = ctx.db.player.identity.find(seat === 0 ? g.p1 : g.p0);
  if (!o) throw new SenderError('That player is no longer around');
  return { g, o };
}

/** Sends a friend request by username (or accepts theirs, if they asked first). */
export const addFriend = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const p = me(ctx);
  const o = ctx.db.player.nameKey.find(name.trim().toLowerCase());
  if (!o) throw new SenderError('No player with that name');
  befriend(ctx, p, o);
});

/** Sends a friend request to the person you're playing or just played. */
export const addOpponent = spacetimedb.reducer(ctx => {
  const p = me(ctx);
  befriend(ctx, p, opponentOf(ctx, p).o);
});

export const acceptFriend = spacetimedb.reducer({ other: t.identity() }, (ctx, { other }) => {
  const p = me(ctx);
  const mine = relation(ctx, p.identity, other);
  if (!mine || mine.state !== 'in') return;
  const o = ctx.db.player.identity.find(other);
  if (o) befriend(ctx, p, o);
});

/** Declines a request, cancels yours, or removes a friend. */
export const removeFriend = spacetimedb.reducer({ other: t.identity() }, (ctx, { other }) => {
  const p = me(ctx);
  const a = relation(ctx, p.identity, other), b = relation(ctx, other, p.identity);
  if (a) ctx.db.friend.id.delete(a.id);
  if (b) ctx.db.friend.id.delete(b.id);
  if (ctx.db.watcher.identity.find(p.identity)?.target.isEqual(other)) ctx.db.watcher.identity.delete(p.identity);
  if (ctx.db.watcher.identity.find(other)?.target.isEqual(p.identity)) ctx.db.watcher.identity.delete(other);
  for (const i of Array.from(ctx.db.invite.from.filter(p.identity))) if (i.to.isEqual(other)) ctx.db.invite.id.delete(i.id);
  for (const i of Array.from(ctx.db.invite.from.filter(other))) if (i.to.isEqual(p.identity)) ctx.db.invite.id.delete(i.id);
});

/** Invites a friend into your room (opening one if you aren't in one yet). */
export const inviteFriend = spacetimedb.reducer({ other: t.identity() }, (ctx, { other }) => {
  let p = me(ctx);
  assertFree(ctx, p);
  const f = relation(ctx, p.identity, other);
  if (!f || f.state !== 'friends') throw new SenderError('You can only invite friends');
  const o = ctx.db.player.identity.find(other);
  if (!o || o.conns === 0) throw new SenderError('Your friend is offline');
  let code = p.waiting === 'room' && p.roomCode && ctx.db.room.code.find(p.roomCode) ? p.roomCode : '';
  if (!code) { p = stopWaiting(ctx, p); code = openRoom(ctx, p); }
  for (const i of Array.from(ctx.db.invite.from.filter(p.identity))) if (i.to.isEqual(other)) ctx.db.invite.id.delete(i.id);
  ctx.db.invite.insert({ id: 0n, from: p.identity, to: other, code, at: ctx.timestamp });
});

export const dismissInvite = spacetimedb.reducer({ id: t.u64() }, (ctx, { id }) => {
  const i = ctx.db.invite.id.find(id);
  if (i && i.to.isEqual(ctx.sender)) ctx.db.invite.id.delete(id);
});

/** Reports the person you're playing or just played. One report per match. */
export const reportPlayer = spacetimedb.reducer({ reason: t.string() }, (ctx, { reason }) => {
  const p = me(ctx);
  if (!REPORT_REASONS.includes(reason)) throw new SenderError('Pick a reason');
  const { g, o } = opponentOf(ctx, p);
  for (const r of ctx.db.report.reporter.filter(p.identity)) if (r.gameId === g.id) throw new SenderError('You already reported this player');
  ctx.db.report.insert({ id: 0n, reporter: p.identity, reported: o.identity, reportedName: o.name, gameId: g.id, reason, at: ctx.timestamp });
});

/** Watches a friend's matches. Only what both players can already see is shown; never anyone's hand. */
export const watchFriend = spacetimedb.reducer({ other: t.identity() }, (ctx, { other }) => {
  let p = me(ctx);
  assertFree(ctx, p);
  const f = relation(ctx, p.identity, other);
  if (!f || f.state !== 'friends') throw new SenderError('You can only watch friends');
  const o = ctx.db.player.identity.find(other);
  if (!o || !liveGame(ctx, o)) throw new SenderError('Your friend is not in a match right now');
  p = stopWaiting(ctx, p);
  if (p.gameId !== 0n) ctx.db.player.identity.update({ ...p, gameId: 0n }); // leave any end screen
  ctx.db.watcher.identity.delete(p.identity);
  ctx.db.watcher.insert({ identity: p.identity, target: other, since: ctx.timestamp });
});

export const stopWatching = spacetimedb.reducer(ctx => {
  ctx.db.watcher.identity.delete(ctx.sender);
});

/** Leaves a finished game's end screen. */
export const leaveGame = spacetimedb.reducer(ctx => {
  const p = me(ctx);
  if (p.gameId === 0n || liveGame(ctx, p)) return;
  ctx.db.player.identity.update({ ...p, gameId: 0n });
});

// ---------- account, help and admin ----------
/** Deletes your account and everything on it. Reports you made about others are kept for moderation. */
export const deleteAccount = spacetimedb.reducer({ confirm: t.string() }, (ctx, { confirm }) => {
  if (confirm !== 'DELETE') throw new SenderError('Type DELETE to confirm');
  let p = me(ctx);
  const g = liveGame(ctx, p);
  if (g) {
    const seat = seatOf(g, p.identity);
    if (seat !== -1) { finish(ctx, g, 'forfeit', 1 - seat); ctx.db.game.id.update(g); }
  }
  p = stopWaiting(ctx, me(ctx));
  ctx.db.transfer.guest.delete(p.identity);
  ctx.db.ladder.identity.delete(p.identity);
  dropProgress(ctx, p.identity);
  ctx.db.player.identity.delete(p.identity);
});

/** "Report a bug" from Settings. A few a day, so it can't be used to flood the admin page. */
export const reportBug = spacetimedb.reducer({ text: t.string(), version: t.string(), device: t.string() }, (ctx, { text, version, device }) => {
  const p = me(ctx);
  text = text.trim();
  if (text.length < 5) throw new SenderError('Tell us a little more about what happened');
  const since = ctx.timestamp.microsSinceUnixEpoch - DAY_MICROS;
  let today = 0;
  for (const b of ctx.db.bug.identity.filter(p.identity)) if (b.at.microsSinceUnixEpoch > since) today++;
  if (today >= BUG_REPORTS_PER_DAY) throw new SenderError('Thanks! You have sent a few today already. Try again tomorrow.');
  ctx.db.bug.insert({
    id: 0n, identity: p.identity, name: p.name, text: text.slice(0, 1000),
    version: version.slice(0, 40), device: device.slice(0, 200), at: ctx.timestamp,
  });
});

function admin(ctx: Ctx) {
  if (!isAdmin(ctx.sender)) throw new SenderError('Admins only');
}
function playerNamed(ctx: Ctx, name: string): PlayerRow {
  const p = ctx.db.player.nameKey.find(name.trim().toLowerCase());
  if (!p) throw new SenderError('No player with that name');
  return p;
}

/** Admin: renames a player (for offensive names). */
export const adminRename = spacetimedb.reducer({ name: t.string(), newName: t.string() }, (ctx, { name, newName }) => {
  admin(ctx);
  const p = playerNamed(ctx, name);
  newName = newName.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(newName)) throw new SenderError('Username: 3–16 letters, numbers or _');
  const key = newName.toLowerCase();
  const taken = ctx.db.player.nameKey.find(key);
  if (taken && !taken.identity.isEqual(p.identity)) throw new SenderError('Username taken');
  ctx.db.player.identity.update({ ...p, name: newName, nameKey: key });
  const l = ctx.db.ladder.identity.find(p.identity);
  if (l) ctx.db.ladder.identity.update({ ...l, name: newName });
  const w = ctx.db.weekly.identity.find(p.identity);
  if (w) ctx.db.weekly.identity.update({ ...w, name: newName });
});

/** Admin: suspends a player (no online play or chat) or lifts it. */
export const adminBan = spacetimedb.reducer({ name: t.string(), banned: t.bool() }, (ctx, { name, banned }) => {
  admin(ctx);
  let p = playerNamed(ctx, name);
  if (banned) {
    p = stopWaiting(ctx, p);
    ctx.db.ladder.identity.delete(p.identity);
    ctx.db.weekly.identity.delete(p.identity);
  }
  ctx.db.player.identity.update({ ...p, banned });
});

/** Admin: gives a player coins and/or an item (e.g. to make up for a bug). */
export const adminGrant = spacetimedb.reducer({ name: t.string(), coins: t.u32(), item: t.string() }, (ctx, { name, coins, item }) => {
  admin(ctx);
  const p = playerNamed(ctx, name);
  if (item) {
    if (!ITEM.has(item)) throw new SenderError('Unknown item');
    if (!ownedItems(ctx, p.identity).has(item)) ctx.db.owned.insert({ id: 0n, identity: p.identity, item, at: ctx.timestamp });
  }
  addCoins(ctx, p.identity, coins);
});

/** Admin: removes a report or bug report once it has been dealt with. */
export const adminDismiss = spacetimedb.reducer({ kind: t.string(), id: t.u64() }, (ctx, { kind, id }) => {
  admin(ctx);
  if (kind === 'report') ctx.db.report.id.delete(id);
  else if (kind === 'bug') ctx.db.bug.id.delete(id);
});

/** Admin: shows a message to everyone. With maintenance on, matches can't start. */
export const adminNotice = spacetimedb.reducer({ maintenance: t.bool(), message: t.string() }, (ctx, { maintenance, message }) => {
  admin(ctx);
  const row = { id: 0, maintenance, message: message.trim().slice(0, 200), at: ctx.timestamp };
  if (ctx.db.notice.id.find(0)) ctx.db.notice.id.update(row); else ctx.db.notice.insert(row);
});

// ---------- connections ----------
export const onConnect = spacetimedb.clientConnected(ctx => {
  if (ctx.db.sweepTimer.count() === 0n) {
    ctx.db.sweepTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(SWEEP_EVERY_MICROS) });
  }
  checkSeason(ctx);
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) {
    // first visit: a guest profile, so they can play before signing up
    let name = '';
    for (let digits = 5; ; digits++) {
      name = 'Guest_' + ctx.random.integerInRange(10 ** (digits - 1), 10 ** digits - 1);
      if (!ctx.db.player.nameKey.find(name.toLowerCase())) break;
    }
    ctx.db.player.insert({
      identity: ctx.sender, name, nameKey: name.toLowerCase(), isGuest: true,
      rating: 1000, wins: 0, losses: 0, draws: 0, tutorialDone: false, practiceDone: false,
      conns: 1, gameId: 0n, waiting: '', roomCode: '', createdAt: ctx.timestamp, lastSeen: ctx.timestamp, banned: false,
    });
    bumpDay(ctx, 0, 1);
    return;
  }
  ctx.db.player.identity.update({ ...p, conns: p.conns + 1, lastSeen: ctx.timestamp });
  const g = liveGame(ctx, p);
  if (!g) return;
  const seat = seatOf(g, ctx.sender);
  if (seat === 0) { g.conn0 = true; g.dc0 = EPOCH; } else if (seat === 1) { g.conn1 = true; g.dc1 = EPOCH; } else return;
  clearTimers(ctx, g.id, ['dc' + seat]);
  ctx.db.game.id.update(g);
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  let p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  p = { ...p, conns: p.conns > 0 ? p.conns - 1 : 0, lastSeen: ctx.timestamp };
  ctx.db.player.identity.update(p);
  if (p.conns > 0) return; // still open in another tab
  ctx.db.watcher.identity.delete(p.identity);
  p = stopWaiting(ctx, p);
  const g = liveGame(ctx, p);
  if (!g) return;
  const seat = seatOf(g, ctx.sender);
  if (seat === -1) return;
  const until = addMs(ctx.timestamp, DC_GRACE_MS);
  if (seat === 0) { g.conn0 = false; g.dc0 = until; } else { g.conn1 = false; g.dc1 = until; }
  clearTimers(ctx, g.id, ['dc' + seat]);
  addTimer(ctx, g, 'dc' + seat, DC_GRACE_MS);
  ctx.db.game.id.update(g);
});

/** Housekeeping every few hours: removes guest profiles nobody has used for 30 days. */
export const sweep = spacetimedb.reducer({ onSchedule: sweepTimer }, { arg: sweepTimer.rowType }, ctx => {
  const cutoff = ctx.timestamp.microsSinceUnixEpoch - GUEST_IDLE_MICROS;
  for (const p of Array.from(ctx.db.player.iter())) {
    if (p.isGuest && p.conns === 0 && p.gameId === 0n && p.lastSeen.microsSinceUnixEpoch < cutoff) {
      ctx.db.player.identity.delete(p.identity);
      dropProgress(ctx, p.identity);
    }
  }
  checkSeason(ctx);
  const today = dayOf(ctx.timestamp);
  for (const d of Array.from(ctx.db.dailyStat.iter())) if (d.day + DAILY_STAT_KEEP_DAYS <= today) ctx.db.dailyStat.day.delete(d.day);
  for (const d of Array.from(ctx.db.dayCount.iter())) if (d.day + 90 <= today) ctx.db.dayCount.day.delete(d.day);
  const dayAgo = ctx.timestamp.microsSinceUnixEpoch - DAY_MICROS;
  for (const tr of Array.from(ctx.db.transfer.iter())) {
    if (tr.createdAt.microsSinceUnixEpoch < dayAgo) ctx.db.transfer.code.delete(tr.code);
  }
  for (const s of Array.from(ctx.db.pairStat.iter())) {
    if (s.windowStart.microsSinceUnixEpoch < dayAgo) ctx.db.pairStat.key.delete(s.key);
  }
});

// ---------- views: the only things a client can read ----------
const meRow = t.row('Me', {
  identity: t.identity(),
  name: t.string(),
  isGuest: t.bool(),
  rating: t.i32(),
  wins: t.u32(),
  losses: t.u32(),
  draws: t.u32(),
  tutorialDone: t.bool(),
  practiceDone: t.bool(),
  waiting: t.string(),
  roomCode: t.string(),
  avatar: t.string(),
  frame: t.string(),      // the aura
  skin: t.string(),
  back: t.string(),
  color: t.string(),
  fx: t.string(),
  title: t.string(),
  reactions: t.string(),  // comma-separated
  phrases: t.string(),    // '|'-separated
  watching: t.string(),   // the friend you're watching, '' if none
  allSkins: t.bool(),     // everything unlocked (special accounts)
  coins: t.u32(),
  casual: t.bool(),       // waiting in the unranked queue (rather than ranked)
  banned: t.bool(),
  isAdmin: t.bool(),
});

export const myPlayer = spacetimedb.view({ name: 'my_player', public: true }, t.array(meRow), ctx => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  const l = lookFields(ctx, p.identity);
  return [{
    identity: p.identity, name: p.name, isGuest: p.isGuest, rating: p.rating, wins: p.wins, losses: p.losses, draws: p.draws,
    tutorialDone: p.tutorialDone, practiceDone: p.practiceDone, waiting: p.waiting, roomCode: p.roomCode,
    ...l,
    watching: (() => { const w = ctx.db.watcher.identity.find(p.identity); return w ? ctx.db.player.identity.find(w.target)?.name ?? '' : ''; })(),
    allSkins: isVip(p.identity),
    coins: (ctx.db.wallet.identity.find(p.identity)?.coins) ?? COINS.welcome,
    casual: ctx.db.queueEntry.identity.find(p.identity)?.casual ?? false,
    banned: p.banned,
    isAdmin: isAdmin(p.identity),
  }];
});

/** A player's look, with anything from before custom avatars and auras moved to its new equivalent. */
function lookFields(ctx: any, who: Identity) {
  const l = ctx.db.look.identity.find(who);
  const pick = (kind: ItemKind, key: string | undefined, fallback: string) => (key !== undefined && itemOf(kind, key) ? key : fallback);
  const aura = l ? (OLD_AURA[l.frame] ?? l.frame) : '';
  return {
    avatar: pick('avatar', l?.avatar, 'rocky'),
    frame: pick('aura', aura, ''),
    skin: pick('skin', l?.skin, 'classic'),
    back: pick('back', l?.back, 'classic'),
    color: pick('color', l?.color, 'green'),
    fx: pick('fx', l?.fx, 'confetti'),
    title: pick('title', l?.title, ''),
    reactions: l ? l.reactions : DEFAULT_REACTIONS,
    phrases: l ? l.phrases : DEFAULT_PHRASES,
  };
}
const BOT_LOOK = { avatar: 'clank', frame: '', skin: 'classic', back: 'classic', color: 'green', fx: 'confetti', title: '' };

const itemRow = t.row('OwnedItem', { item: t.string() });
/** Every item you own (free, Level road, achievements and bought). */
export const myItems = spacetimedb.view({ name: 'my_items', public: true }, t.array(itemRow), ctx => {
  if (!ctx.db.player.identity.find(ctx.sender)) return [];
  return Array.from(ownedItems(ctx as any, ctx.sender), item => ({ item }));
});

const serverInfoRow = t.row('ServerInfoRow', {
  maintenance: t.bool(), message: t.string(), day: t.u32(), week: t.u32(), dealItem: t.string(), dealPrice: t.u32(),
});
/** Things everyone sees: today's Store deal and any notice from the admin. */
export const serverInfo = spacetimedb.anonymousView({ name: 'server_info', public: true }, t.array(serverInfoRow), ctx => {
  const s = ctx.db.season.id.find(0);
  const n = ctx.db.notice.id.find(0);
  const day = s ? s.day : 0;
  const deal = dealOf(day);
  return [{
    maintenance: n ? n.maintenance : false, message: n ? n.message : '',
    day, week: s ? s.week : 0, dealItem: deal.item.id, dealPrice: deal.price,
  }];
});

const transferRow = t.row('TransferCode', { code: t.string() });

/** A guest's own pending transfer code. Nobody else can read it. */
export const myTransfer = spacetimedb.view({ name: 'my_transfer', public: true }, t.array(transferRow), ctx => {
  const row = ctx.db.transfer.guest.find(ctx.sender);
  return row ? [{ code: row.code }] : [];
});

const gameViewRow = t.row('GameView', {
  gameId: t.u64(),
  mode: t.string(),
  rated: t.bool(),
  phase: t.string(),
  seq: t.u32(),
  deadline: t.timestamp(),
  phaseMs: t.u32(),
  round: t.u32(),
  totalRounds: t.u32(),
  pickMs: t.u32(),
  youName: t.string(),
  youScore: t.u32(),
  youReady: t.bool(),
  youSel: t.u64(),
  youLocked: t.bool(),
  oppName: t.string(),
  oppIsBot: t.bool(),
  oppScore: t.u32(),
  oppHandCount: t.u32(),
  oppReady: t.bool(),
  oppPlaced: t.bool(),
  oppConnected: t.bool(),
  revealShown: t.bool(),
  revealYou: t.i8(),
  revealOpp: t.i8(),
  revealResult: t.string(),   // '' until the result phase, then 'win' | 'loss' | 'draw'
  over: t.bool(),
  endResult: t.string(),
  endReason: t.string(),
  ratingChange: t.i32(),
  youRematch: t.bool(),       // end screen: you've asked for a rematch
  oppRematch: t.bool(),       // end screen: your opponent has asked for one
  oppLeft: t.bool(),          // end screen: your opponent has left, so no rematch
  oppRating: t.i32(),         // 0 for a bot
  oppAvatar: t.string(),
  oppFrame: t.string(),
  oppSkin: t.string(),
  oppFriend: t.string(),      // '' | 'out' | 'in' | 'friends'
  watchers: t.u32(),          // friends watching this match
  xpGain: t.u32(),            // end screen: XP you earned
  coinGain: t.u32(),          // end screen: coins you earned (bonuses included)
  oppBack: t.string(),
  oppColor: t.string(),
  oppFx: t.string(),
  oppTitle: t.string(),
});

const result = (winner: number, seat: number) => (winner === -1 ? 'draw' : winner === seat ? 'win' : 'loss');

export const myGame = spacetimedb.view({ name: 'my_game', public: true }, t.array(gameViewRow), ctx => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p || p.gameId === 0n) return [];
  const g = ctx.db.game.id.find(p.gameId);
  if (!g) return [];
  const seat = g.p0.isEqual(ctx.sender) ? 0 : !g.p1Bot && g.p1.isEqual(ctx.sender) ? 1 : -1;
  if (seat === -1) return [];
  const you = seat === 0;
  let oppHand = 0;
  for (const c of ctx.db.handCard.gameId.filter(g.id)) if (c.seat !== seat) oppHand += 1;
  // the opponent's card only leaves the server once both cards are locked in
  const shown = (g.phase === 'reveal' || g.phase === 'result') && g.last0 !== NONE;
  return [{
    gameId: g.id, mode: g.mode, rated: g.rated, phase: g.phase, seq: g.seq, deadline: g.deadline, phaseMs: g.phaseMs,
    round: g.round, totalRounds: ROUNDS, pickMs: TIMES.pick,
    youName: you ? g.name0 : g.name1, youScore: you ? g.score0 : g.score1, youReady: you ? g.ready0 : g.ready1,
    youSel: g.phase === 'pick' ? (you ? g.sel0 : g.sel1) : 0n,
    youLocked: g.phase === 'pick' && (you ? g.lock0 : g.lock1),
    oppName: you ? g.name1 : g.name0, oppIsBot: you && g.p1Bot, oppScore: you ? g.score1 : g.score0,
    oppHandCount: oppHand, oppReady: you ? g.ready1 : g.ready0,
    oppPlaced: g.phase === 'pick' && (you ? g.lock1 : g.lock0),
    oppConnected: you ? g.conn1 : g.conn0,
    revealShown: shown,
    revealYou: shown ? (you ? g.last0 : g.last1) : NONE,
    revealOpp: shown ? (you ? g.last1 : g.last0) : NONE,
    revealResult: shown && g.phase === 'result' ? result(g.lastWinner, seat) : '',
    over: g.over, endResult: g.over ? result(g.winner, seat) : '', endReason: g.reason,
    ratingChange: you ? g.ratingDelta : -g.ratingDelta,
    youRematch: g.over && (you ? g.rematch0 : g.rematch1),
    oppRematch: g.over && (you ? g.rematch1 : g.rematch0),
    oppLeft: g.over && !oppStillHere(ctx as any, g, seat),
    oppRating: g.p1Bot ? 0 : (ctx.db.player.identity.find(you ? g.p1 : g.p0)?.rating ?? 0),
    ...(({ avatar, frame, skin, back, color, fx, title }) => ({
      oppAvatar: avatar, oppFrame: frame, oppSkin: skin, oppBack: back, oppColor: color, oppFx: fx, oppTitle: title,
    }))(g.p1Bot && you ? BOT_LOOK : lookFields(ctx, you ? g.p1 : g.p0)),
    oppFriend: g.p1Bot ? '' : (() => { for (const f of ctx.db.friend.owner.filter(ctx.sender)) if (f.other.isEqual(you ? g.p1 : g.p0)) return f.state; return ''; })(),
    xpGain: you ? g.xp0 : g.xp1,
    coinGain: you ? g.coins0 : g.coins1,
    watchers: Array.from(ctx.db.watcher.target.filter(g.p0)).length + (g.p1Bot ? 0 : Array.from(ctx.db.watcher.target.filter(g.p1)).length),
  }];
});

const chatViewRow = t.row('ChatView', { id: t.u64(), mine: t.bool(), kind: t.string(), body: t.string() });

/** Chat in the game you're in: yours and your opponent's. */
export const myChat = spacetimedb.view({ name: 'my_chat', public: true }, t.array(chatViewRow), ctx => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p || p.gameId === 0n) return [];
  const g = ctx.db.game.id.find(p.gameId);
  if (!g) return [];
  const seat = g.p0.isEqual(ctx.sender) ? 0 : !g.p1Bot && g.p1.isEqual(ctx.sender) ? 1 : -1;
  if (seat === -1) return [];
  return Array.from(ctx.db.chatMsg.gameId.filter(g.id), m => ({ id: m.id, mine: m.seat === seat, kind: m.kind, body: m.body }));
});

const handViewRow = t.row('HandCardView', { id: t.u64(), kind: t.u8(), pos: t.u32() });

export const myHand = spacetimedb.view({ name: 'my_hand', public: true }, t.array(handViewRow), ctx => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p || p.gameId === 0n) return [];
  const g = ctx.db.game.id.find(p.gameId);
  if (!g) return [];
  const seat = g.p0.isEqual(ctx.sender) ? 0 : !g.p1Bot && g.p1.isEqual(ctx.sender) ? 1 : -1;
  const out: { id: bigint; kind: number; pos: number }[] = [];
  for (const c of ctx.db.handCard.gameId.filter(g.id)) if (c.seat === seat) out.push({ id: c.id, kind: c.kind, pos: c.pos });
  return out;
});

const logViewRow = t.row('RoundView', { n: t.u32(), you: t.i8(), opp: t.i8(), result: t.string() });

export const myLog = spacetimedb.view({ name: 'my_log', public: true }, t.array(logViewRow), ctx => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p || p.gameId === 0n) return [];
  const g = ctx.db.game.id.find(p.gameId);
  if (!g) return [];
  const seat = g.p0.isEqual(ctx.sender) ? 0 : !g.p1Bot && g.p1.isEqual(ctx.sender) ? 1 : -1;
  if (seat === -1) return [];
  return Array.from(ctx.db.roundLog.gameId.filter(g.id), l => ({
    n: l.n, you: seat === 0 ? l.c0 : l.c1, opp: seat === 0 ? l.c1 : l.c0, result: result(l.winner, seat),
  }));
});

const leaderRow = t.row('LeaderRow', {
  identity: t.identity(), name: t.string(), rating: t.i32(), avatar: t.string(), frame: t.string(), title: t.string(),
});

// This month's top 10 by rating. Same for everyone, so Spacetime computes it once and shares it.
export const leaderboard = spacetimedb.anonymousView({ name: 'leaderboard', public: true }, t.array(leaderRow), ctx => {
  return Array.from(ctx.db.ladder.board.filter(0))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 10)
    .map(l => {
      const k = lookFields(ctx, l.identity);
      return { identity: l.identity, name: l.name, rating: l.rating, avatar: k.avatar, frame: k.frame, title: k.title };
    });
});

const weeklyRow = t.row('WeeklyRow', {
  identity: t.identity(), name: t.string(), points: t.u32(), avatar: t.string(), frame: t.string(), title: t.string(),
});
const byPoints = (a: { points: number; at: Timestamp }, b: { points: number; at: Timestamp }) =>
  b.points - a.points || (a.at.microsSinceUnixEpoch < b.at.microsSinceUnixEpoch ? -1 : a.at.microsSinceUnixEpoch > b.at.microsSinceUnixEpoch ? 1 : 0);

// This week's top 10 by points. Ties go to whoever got there first.
export const weeklyBoard = spacetimedb.anonymousView({ name: 'weekly_board', public: true }, t.array(weeklyRow), ctx => {
  return Array.from(ctx.db.weekly.board.filter(0))
    .sort(byPoints)
    .slice(0, 10)
    .map(w => {
      const k = lookFields(ctx, w.identity);
      return { identity: w.identity, name: w.name, points: w.points, avatar: k.avatar, frame: k.frame, title: k.title };
    });
});

const myRankRow = t.row('MyRankRow', {
  weekRank: t.u32(), weekPoints: t.u32(), weekPlayers: t.u32(), monthRank: t.u32(), monthPlayers: t.u32(),
});
/** Where you are on both boards (rank 0 = not on it yet). */
export const myRank = spacetimedb.view({ name: 'my_rank', public: true }, t.array(myRankRow), ctx => {
  const weeks = Array.from(ctx.db.weekly.board.filter(0)).sort(byPoints);
  const months = Array.from(ctx.db.ladder.board.filter(0)).sort((a, b) => b.rating - a.rating);
  const wi = weeks.findIndex(w => w.identity.isEqual(ctx.sender));
  const mi = months.findIndex(m => m.identity.isEqual(ctx.sender));
  return [{
    weekRank: wi + 1, weekPoints: wi >= 0 ? weeks[wi]!.points : 0, weekPlayers: weeks.length,
    monthRank: mi + 1, monthPlayers: months.length,
  }];
});

const friendBoardRow = t.row('FriendBoardRow', {
  identity: t.identity(), name: t.string(), me: t.bool(), points: t.u32(), rating: t.i32(), ranked: t.bool(),
  avatar: t.string(), frame: t.string(), title: t.string(),
});
/** You and your friends, for the leaderboard's Friends button. */
export const friendsBoard = spacetimedb.view({ name: 'friends_board', public: true }, t.array(friendBoardRow), ctx => {
  const ids = [ctx.sender];
  for (const f of ctx.db.friend.owner.filter(ctx.sender)) if (f.state === 'friends') ids.push(f.other);
  const out: any[] = [];
  for (const who of ids) {
    const p = ctx.db.player.identity.find(who);
    if (!p) continue;
    const k = lookFields(ctx, who);
    out.push({
      identity: who, name: p.name, me: who.isEqual(ctx.sender),
      points: ctx.db.weekly.identity.find(who)?.points ?? 0,
      rating: p.rating, ranked: !!ctx.db.ladder.identity.find(who),
      avatar: k.avatar, frame: k.frame, title: k.title,
    });
  }
  return out;
});

const statsViewRow = t.row('StatsView', {
  plays0: t.u32(), plays1: t.u32(), plays2: t.u32(), wins0: t.u32(), wins1: t.u32(), wins2: t.u32(),
  opens0: t.u32(), opens1: t.u32(), opens2: t.u32(), streak: t.u32(), bestStreak: t.u32(), perfects: t.u32(),
  dailyLast: t.u32(), dailyStreak: t.u32(), dailyBest: t.u32(), dailyWins: t.u32(),
  dailyResult: t.string(), dailyYou: t.u32(), dailyThem: t.u32(), lastSeason: t.i32(), xp: t.u32(),
});

/** Your own lifetime stats and daily challenge state. */
export const myStats = spacetimedb.view({ name: 'my_stats', public: true }, t.array(statsViewRow), ctx => {
  const s = ctx.db.stats.identity.find(ctx.sender);
  if (!s) return [];
  const { identity: _, ...rest } = s;
  return [rest];
});

const historyViewRow = t.row('HistoryView', {
  id: t.u64(), at: t.timestamp(), mode: t.string(), opp: t.string(), oppBot: t.bool(), result: t.string(), reason: t.string(),
  you: t.u32(), them: t.u32(), ratingChange: t.i32(), cards: t.string(), outcomes: t.string(),
});

/** Your last 20 matches. */
export const myHistory = spacetimedb.view({ name: 'my_history', public: true }, t.array(historyViewRow), ctx => {
  return Array.from(ctx.db.history.identity.filter(ctx.sender), ({ identity: _, ...h }) => h);
});

const achievementViewRow = t.row('AchievementView', { key: t.string(), at: t.timestamp() });

export const myAchievements = spacetimedb.view({ name: 'my_achievements', public: true }, t.array(achievementViewRow), ctx => {
  return Array.from(ctx.db.achievement.identity.filter(ctx.sender), a => ({ key: a.key, at: a.at }));
});

const seasonViewRow = t.row('SeasonView', { key: t.u32(), champ: t.string(), champRating: t.i32() });

/** The current season and last season's winner. */
export const seasonInfo = spacetimedb.anonymousView({ name: 'season_info', public: true }, t.array(seasonViewRow), ctx => {
  const s = ctx.db.season.id.find(0);
  return s ? [{ key: s.key, champ: s.champ, champRating: s.champRating }] : [];
});

const dailyViewRow = t.row('DailyView', { day: t.u32(), plays: t.u32(), wins: t.u32() });

/** How many played and beat the last few daily challenges. */
export const dailyStats = spacetimedb.anonymousView({ name: 'daily_stats', public: true }, t.array(dailyViewRow), ctx => {
  return Array.from(ctx.db.dailyStat.board.filter(0), d => ({ day: d.day, plays: d.plays, wins: d.wins }));
});

const friendViewRow = t.row('FriendView', {
  identity: t.identity(), name: t.string(), state: t.string(), online: t.bool(), playing: t.bool(),
  rating: t.i32(), avatar: t.string(), frame: t.string(),
});

/** Your friends and friend requests, with who is online or mid-match. */
export const myFriends = spacetimedb.view({ name: 'my_friends', public: true }, t.array(friendViewRow), ctx => {
  const out: any[] = [];
  for (const f of ctx.db.friend.owner.filter(ctx.sender)) {
    const o = ctx.db.player.identity.find(f.other);
    if (!o) continue;
    const g = f.state === 'friends' && o.gameId !== 0n ? ctx.db.game.id.find(o.gameId) : undefined;
    const k = lookFields(ctx, o.identity);
    out.push({
      identity: o.identity, name: o.name, state: f.state, online: f.state === 'friends' && o.conns > 0,
      playing: !!g && !g.over, rating: o.rating, avatar: k.avatar, frame: k.frame,
    });
  }
  return out;
});

const inviteViewRow = t.row('InviteView', { id: t.u64(), fromName: t.string(), avatar: t.string(), code: t.string() });

/** Friends inviting you into their room right now. */
export const myInvites = spacetimedb.view({ name: 'my_invites', public: true }, t.array(inviteViewRow), ctx => {
  const out: any[] = [];
  for (const i of ctx.db.invite.to.filter(ctx.sender)) {
    const r = ctx.db.room.code.find(i.code);
    const from = ctx.db.player.identity.find(i.from);
    if (!r || !from || !r.host.isEqual(i.from)) continue;
    out.push({ id: i.id, fromName: from.name, avatar: lookFields(ctx, i.from).avatar, code: i.code });
  }
  return out;
});

const watchViewRow = t.row('WatchView', {
  gameId: t.u64(), mode: t.string(), phase: t.string(), seq: t.u32(), deadline: t.timestamp(), phaseMs: t.u32(),
  round: t.u32(), totalRounds: t.u32(),
  aName: t.string(), aScore: t.u32(), aCards: t.u32(), aLocked: t.bool(), aAvatar: t.string(), aSkin: t.string(), aRating: t.i32(),
  bName: t.string(), bScore: t.u32(), bCards: t.u32(), bLocked: t.bool(), bAvatar: t.string(), bSkin: t.string(), bRating: t.i32(), bIsBot: t.bool(),
  revealShown: t.bool(), revealA: t.i8(), revealB: t.i8(), revealResult: t.string(),
  over: t.bool(), endResult: t.string(), endReason: t.string(),
});
/** The game the friend you're watching is in, from their side ("a"), and the seat they're in. */
function watchedGame(ctx: any): { g: GameRow; seat: 0 | 1 } | undefined {
  const w = ctx.db.watcher.identity.find(ctx.sender);
  if (!w) return undefined;
  const target = ctx.db.player.identity.find(w.target);
  if (!target || target.gameId === 0n) return undefined;
  const g = ctx.db.game.id.find(target.gameId);
  if (!g) return undefined;
  const seat = seatOf(g, target.identity);
  return seat === -1 ? undefined : { g, seat };
}

/** The match of the friend you're watching. Only public information: scores, card counts and revealed cards. */
export const watchGame = spacetimedb.view({ name: 'watch_game', public: true }, t.array(watchViewRow), ctx => {
  const w = watchedGame(ctx);
  if (!w) return [];
  const { g, seat } = w;
  const a = seat === 0;
  let c0 = 0, c1 = 0;
  for (const c of ctx.db.handCard.gameId.filter(g.id)) if (c.seat === 0) c0++; else c1++;
  const shown = (g.phase === 'reveal' || g.phase === 'result') && g.last0 !== NONE;
  const la = lookFields(ctx, a ? g.p0 : g.p1);
  const lb = g.p1Bot ? BOT_LOOK : lookFields(ctx, a ? g.p1 : g.p0);
  const rating = (who: Identity) => ctx.db.player.identity.find(who)?.rating ?? 0;
  return [{
    gameId: g.id, mode: g.mode, phase: g.phase, seq: g.seq, deadline: g.deadline, phaseMs: g.phaseMs, round: g.round, totalRounds: ROUNDS,
    aName: a ? g.name0 : g.name1, aScore: a ? g.score0 : g.score1, aCards: a ? c0 : c1, aLocked: g.phase === 'pick' && (a ? g.lock0 : g.lock1),
    aAvatar: la.avatar, aSkin: la.skin, aRating: rating(a ? g.p0 : g.p1),
    bName: a ? g.name1 : g.name0, bScore: a ? g.score1 : g.score0, bCards: a ? c1 : c0, bLocked: g.phase === 'pick' && (a ? g.lock1 : g.lock0),
    bAvatar: lb.avatar, bSkin: lb.skin, bRating: g.p1Bot ? 0 : rating(a ? g.p1 : g.p0), bIsBot: g.p1Bot,
    revealShown: shown, revealA: shown ? (a ? g.last0 : g.last1) : NONE, revealB: shown ? (a ? g.last1 : g.last0) : NONE,
    revealResult: shown && g.phase === 'result' ? result(g.lastWinner, seat) : '',
    over: g.over, endResult: g.over ? result(g.winner, seat) : '', endReason: g.reason,
  }];
});

/** Rounds played so far in the match you're watching. */
export const watchLog = spacetimedb.view({ name: 'watch_log', public: true }, t.array(logViewRow), ctx => {
  const w = watchedGame(ctx);
  if (!w) return [];
  const { g, seat } = w;
  return Array.from(ctx.db.roundLog.gameId.filter(g.id), l => ({
    n: l.n, you: seat === 0 ? l.c0 : l.c1, opp: seat === 0 ? l.c1 : l.c0, result: result(l.winner, seat),
  }));
});

// ---------- admin views: empty for everyone but the admins in config.ts ----------
const adminReportRow = t.row('AdminReport', {
  id: t.u64(), at: t.timestamp(), reporter: t.string(), reported: t.string(), reason: t.string(), reportsAgainst: t.u32(), banned: t.bool(),
});
export const adminReports = spacetimedb.view({ name: 'admin_reports', public: true }, t.array(adminReportRow), ctx => {
  if (!isAdmin(ctx.sender)) return [];
  const all = Array.from(ctx.db.report.iter());
  const count = new Map<string, number>();
  for (const r of all) count.set(r.reported.toHexString(), (count.get(r.reported.toHexString()) ?? 0) + 1);
  return all.map(r => {
    const reported = ctx.db.player.identity.find(r.reported);
    return {
      id: r.id, at: r.at, reporter: ctx.db.player.identity.find(r.reporter)?.name ?? '(deleted)',
      reported: reported?.name ?? r.reportedName, reason: r.reason,
      reportsAgainst: count.get(r.reported.toHexString()) ?? 0, banned: reported?.banned ?? false,
    };
  });
});

const adminBugRow = t.row('AdminBug', { id: t.u64(), at: t.timestamp(), name: t.string(), text: t.string(), version: t.string(), device: t.string() });
export const adminBugs = spacetimedb.view({ name: 'admin_bugs', public: true }, t.array(adminBugRow), ctx => {
  if (!isAdmin(ctx.sender)) return [];
  return Array.from(ctx.db.bug.iter(), ({ identity: _, ...b }) => b);
});

const adminDayRow = t.row('AdminDay', { day: t.u32(), matches: t.u32(), newPlayers: t.u32() });
export const adminDays = spacetimedb.view({ name: 'admin_days', public: true }, t.array(adminDayRow), ctx => {
  if (!isAdmin(ctx.sender)) return [];
  return Array.from(ctx.db.dayCount.board.filter(0), ({ board: _, ...d }) => d);
});

const adminSummaryRow = t.row('AdminSummaryRow', {
  players: t.u32(), accounts: t.u32(), online: t.u32(), inMatch: t.u32(), activeToday: t.u32(), banned: t.u32(), coinsInWallets: t.u64(),
});
export const adminSummary = spacetimedb.view({ name: 'admin_summary', public: true }, t.array(adminSummaryRow), ctx => {
  if (!isAdmin(ctx.sender)) return [];
  const s = ctx.db.season.id.find(0);
  const today = s ? s.day : 0;
  let players = 0, accounts = 0, online = 0, inMatch = 0, activeToday = 0, banned = 0;
  for (const p of ctx.db.player.iter()) {
    players++;
    if (!p.isGuest) accounts++;
    if (p.conns > 0) online++;
    if (p.gameId !== 0n) inMatch++;
    if (dayOf(p.lastSeen) === today) activeToday++;
    if (p.banned) banned++;
  }
  let coins = 0n;
  for (const w of ctx.db.wallet.iter()) coins += BigInt(w.coins);
  return [{ players, accounts, online, inMatch, activeToday, banned, coinsInWallets: coins }];
});
