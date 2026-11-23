// RPS 10 — Spacetime server module.
//
// Every table is private. Players only ever receive what the views at the bottom return for them,
// so a modified client cannot read the opponent's hand, their selected card, or which kind they hold 4 of.
// All game rules, timers, matchmaking and ratings run here; the client only sends intentions.

import { ScheduleAt, Timestamp, type Identity } from 'spacetimedb';
import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { config } from './config';

// ---------- settings ----------
const TIMES = { prep: 20000, readyGo: 600, banner: 1600, pick: 10000, reveal: 3000, result: 3000 }; // ms
const WIN_POINTS = 7;
const DC_GRACE_MS = 15000;       // a disconnected player has this long to come back
const QUEUE_RETRY_MS = 5000;     // re-check the queue this often...
const QUEUE_RETRIES = 3;         // ...this many times (15s), then start a bot match
const CLEANUP_MS = 10 * 60 * 1000;      // finished games are removed after 10 minutes
const SWEEP_EVERY_MICROS = 6n * 3600n * 1_000_000n;
const GUEST_IDLE_MICROS = 30n * 24n * 3600n * 1_000_000n; // unused guest profiles are removed after 30 days
const K_STEPS = [32, 16, 8, 4];         // rating K-factor for the 1st, 2nd... ranked game vs the same opponent in 24h, then 0
const DAY_MICROS = 24n * 3600n * 1_000_000n;

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
  }
);

const game = table(
  { name: 'game' },
  {
    id: t.u64().primaryKey().autoInc(),
    mode: t.string(),               // 'ranked' | 'room' | 'bot' | 'practice'
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

const sweepTimer = table(
  { name: 'sweep_timer' },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() }
);

const spacetimedb = schema({
  player, game, handCard, roundLog, gameTimer, queueEntry, queueTimer, room, pairStat, ladder, matchResult, rngState, sweepTimer, transfer,
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

// ---------- game flow ----------
function startGame(ctx: Ctx, a: PlayerRow, b: PlayerRow | undefined, mode: string) {
  const rng = secretRng(ctx);
  const botName = ['Rocky', 'Snips', 'Papyrus', 'Clutch', 'Nova', 'Blitz', 'Vex', 'Echo'][rng(8)] + '_bot';
  const g = ctx.db.game.insert({
    id: 0n, mode, rated: mode === 'ranked',
    p0: a.identity, p1: b ? b.identity : a.identity, p1Bot: !b,
    name0: a.name, name1: b ? b.name : botName,
    phase: 'prep', seq: 0, deadline: ctx.timestamp, phaseMs: 0, round: 1,
    score0: 0, score1: 0, ready0: false, ready1: false, sel0: 0n, sel1: 0n,
    last0: NONE, last1: NONE, lastWinner: -1,
    over: false, winner: -1, reason: '', ratingDelta: 0,
    conn0: a.conns > 0, conn1: b ? b.conns > 0 : true, dc0: EPOCH, dc1: EPOCH,
  });
  // deal: 3 of two kinds and 4 of a third, shuffled
  for (const seat of [0, 1]) {
    const four = rng(3);
    const hand: number[] = [];
    for (let k = 0; k < 3; k++) for (let i = 0; i < (k === four ? 4 : 3); i++) hand.push(k);
    for (let i = hand.length - 1; i > 0; i--) { const j = rng(i + 1); [hand[i], hand[j]] = [hand[j]!, hand[i]!]; }
    hand.forEach((kind, pos) => ctx.db.handCard.insert({ id: 0n, gameId: g.id, seat, kind, pos }));
  }
  for (const p of b ? [a, b] : [a]) {
    ctx.db.player.identity.update({ ...p, gameId: g.id, waiting: '', roomCode: '' });
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
  g.sel0 = 0n; g.sel1 = 0n;
  g.last0 = NONE; g.last1 = NONE; g.lastWinner = -1;
  setPhase(ctx, g, 'banner', TIMES.banner);
}

function reveal(ctx: Ctx, g: GameRow) {
  const picked = [g.sel0, g.sel1].map((sel, seat) => {
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
  g.sel0 = 0n; g.sel1 = 0n;
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
      setPhase(ctx, g, 'result', TIMES.result);
      break;
    case 'result': {
      const out = g.score0 >= WIN_POINTS || g.score1 >= WIN_POINTS
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
  g.seq += 1; g.sel0 = 0n; g.sel1 = 0n; g.deadline = ctx.timestamp; g.phaseMs = 0;
  const rounds = logsOf(ctx, g.id).length;
  clearTimers(ctx, g.id);
  for (const c of Array.from(ctx.db.handCard.gameId.filter(g.id))) ctx.db.handCard.id.delete(c.id);

  const a = ctx.db.player.identity.find(g.p0);
  const b = g.p1Bot ? undefined : ctx.db.player.identity.find(g.p1);
  let delta = 0;
  if (g.rated && a && b) {
    const k = pairK(ctx, a.identity, b.identity);
    const expected = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
    delta = Math.round(k * ((winner === -1 ? 0.5 : winner === 0 ? 1 : 0) - expected));
  }
  g.ratingDelta = delta;
  const practice = (g.mode === 'practice' || g.mode === 'bot') && reason === 'points';
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
  });
  ctx.db.matchResult.insert({
    id: 0n, at: ctx.timestamp, mode: g.mode, rated: g.rated, name0: g.name0, name1: g.name1,
    winner, reason, score0: g.score0, score1: g.score1, rounds, ratingDelta: delta,
  });
  addTimer(ctx, g, 'cleanup', CLEANUP_MS);
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
    else if (arg.kind === 'botPick' && g.phase === 'pick') g.sel1 = botPick(ctx, g);
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
}
/** Clears whatever the player was waiting for. Returns the updated row (already saved). */
function stopWaiting(ctx: Ctx, p: PlayerRow): PlayerRow {
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
    if (e.identity.isEqual(who)) continue;
    const gap = Math.abs(e.rating - mine.rating);
    if (gap > 150 + 50 * Math.max(waited(mine), waited(e))) continue;
    if (!best || gap < Math.abs(best.rating - mine.rating)) best = e;
  }
  if (!best) return false;
  const a = ctx.db.player.identity.find(best.identity), b = ctx.db.player.identity.find(who);
  dequeue(ctx, best.identity); dequeue(ctx, who);
  if (!a || !b) return false;
  startGame(ctx, a, b, 'ranked'); // the longer-waiting player is seat 0
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

export const joinQueue = spacetimedb.reducer(ctx => {
  let p = me(ctx);
  assertFree(ctx, p);
  if (config.requireAccount && p.isGuest) throw new SenderError('Create an account to play online');
  if (!p.tutorialDone || !p.practiceDone) throw new SenderError('Finish the tutorial and a practice match first');
  if (ctx.db.queueEntry.identity.find(p.identity)) return;
  p = stopWaiting(ctx, p);
  ctx.db.queueEntry.insert({ identity: p.identity, rating: p.rating, joinedAt: ctx.timestamp });
  ctx.db.player.identity.update({ ...p, waiting: 'queue', gameId: 0n });
  if (tryMatch(ctx, p.identity)) return;
  ctx.db.queueTimer.insert({
    scheduledId: 0n, scheduledAt: ScheduleAt.time(addMs(ctx.timestamp, QUEUE_RETRY_MS).microsSinceUnixEpoch),
    identity: p.identity, attempt: 1,
  });
});

export const leaveQueue = spacetimedb.reducer(ctx => {
  stopWaiting(ctx, me(ctx));
});

export const createRoom = spacetimedb.reducer(ctx => {
  let p = me(ctx);
  assertFree(ctx, p);
  p = stopWaiting(ctx, p);
  const rng = secretRng(ctx);
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => ALPHABET[rng(ALPHABET.length)]).join('');
  } while (ctx.db.room.code.find(code));
  ctx.db.room.insert({ code, host: p.identity });
  ctx.db.player.identity.update({ ...p, waiting: 'room', roomCode: code, gameId: 0n });
});

export const closeRoom = spacetimedb.reducer(ctx => {
  stopWaiting(ctx, me(ctx));
});

export const joinRoom = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  let p = me(ctx);
  assertFree(ctx, p);
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
  if (g.phase !== 'pick') return;
  const c = ctx.db.handCard.id.find(cardId);
  if (!c || c.gameId !== g.id || c.seat !== seat) return; // not your card
  if (seat === 0) g.sel0 = cardId; else g.sel1 = cardId;
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

/** Leaves a finished game's end screen. */
export const leaveGame = spacetimedb.reducer(ctx => {
  const p = me(ctx);
  if (p.gameId === 0n || liveGame(ctx, p)) return;
  ctx.db.player.identity.update({ ...p, gameId: 0n });
});

// ---------- connections ----------
export const onConnect = spacetimedb.clientConnected(ctx => {
  if (ctx.db.sweepTimer.count() === 0n) {
    ctx.db.sweepTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(SWEEP_EVERY_MICROS) });
  }
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
      conns: 1, gameId: 0n, waiting: '', roomCode: '', createdAt: ctx.timestamp, lastSeen: ctx.timestamp,
    });
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
    }
  }
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
});

export const myPlayer = spacetimedb.view({ name: 'my_player', public: true }, t.array(meRow), ctx => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  return [{
    identity: p.identity, name: p.name, isGuest: p.isGuest, rating: p.rating, wins: p.wins, losses: p.losses, draws: p.draws,
    tutorialDone: p.tutorialDone, practiceDone: p.practiceDone, waiting: p.waiting, roomCode: p.roomCode,
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
  winPoints: t.u32(),
  pickMs: t.u32(),
  youName: t.string(),
  youScore: t.u32(),
  youReady: t.bool(),
  youSel: t.u64(),
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
    round: g.round, winPoints: WIN_POINTS, pickMs: TIMES.pick,
    youName: you ? g.name0 : g.name1, youScore: you ? g.score0 : g.score1, youReady: you ? g.ready0 : g.ready1,
    youSel: g.phase === 'pick' ? (you ? g.sel0 : g.sel1) : 0n,
    oppName: you ? g.name1 : g.name0, oppIsBot: you && g.p1Bot, oppScore: you ? g.score1 : g.score0,
    oppHandCount: oppHand, oppReady: you ? g.ready1 : g.ready0,
    oppPlaced: g.phase === 'pick' && (you ? g.sel1 : g.sel0) !== 0n,
    oppConnected: you ? g.conn1 : g.conn0,
    revealShown: shown,
    revealYou: shown ? (you ? g.last0 : g.last1) : NONE,
    revealOpp: shown ? (you ? g.last1 : g.last0) : NONE,
    revealResult: shown && g.phase === 'result' ? result(g.lastWinner, seat) : '',
    over: g.over, endResult: g.over ? result(g.winner, seat) : '', endReason: g.reason,
    ratingChange: you ? g.ratingDelta : -g.ratingDelta,
  }];
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

const leaderRow = t.row('LeaderRow', { identity: t.identity(), name: t.string(), rating: t.i32() });

// Same for everyone, so Spacetime computes it once and shares it.
export const leaderboard = spacetimedb.anonymousView({ name: 'leaderboard', public: true }, t.array(leaderRow), ctx => {
  return Array.from(ctx.db.ladder.board.filter(0))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 10)
    .map(l => ({ identity: l.identity, name: l.name, rating: l.rating }));
});
