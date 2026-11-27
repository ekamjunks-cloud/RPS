// Plays whole matches against the real Spacetime datastore, in memory. Run with: npm test
import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp, TimeDuration } from 'spacetimedb';
import { createModuleTestHarness, TestAuth, TestClock } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from './index';
import { config } from './config';

config.firebaseProjectId = ''; // the Google checks set their own project below
config.requireAccount = true; // most checks cover the accounts-on rules; the guest-only mode has its own check below
let nextConn = 1n;
function setup() {
  const test = createModuleTestHarness(spacetimedb, mod, {
    rngSeed: 7n, clock: new TestClock(Timestamp.fromDate(new Date('2026-11-14T12:00:00Z'))),
  });
  const client = (sub: string, google = false) => {
    const payload = google ? { iss: 'https://securetoken.google.com/demo-project', aud: 'demo-project', sub } : { iss: 'https://test', sub };
    const auth = TestAuth.fromJwtPayload(JSON.stringify(payload), new ConnectionId(nextConn++));
    const call = (fn: any, args: any = {}) => test.withReducerTx(auth, ctx => fn(ctx, args));
    call(mod.onConnect);
    const c = {
      auth, call,
      me: () => (mod.myPlayer as any)(test.viewContext(auth))[0],
      game: () => (mod.myGame as any)(test.viewContext(auth))[0],
      hand: () => ((mod.myHand as any)(test.viewContext(auth)) as any[]).sort((a, b) => a.pos - b.pos),
      log: () => ((mod.myLog as any)(test.viewContext(auth)) as any[]).sort((a, b) => a.n - b.n),
      /** queued players search for a few seconds first: runs the timers until this player is in a live match */
      waitMatch: () => { for (let i = 0; i < 12 && !(c.game() && !c.game().over); i++) fireNext(); },
      /** tutorial + one practice match, played to the end */
      qualify: () => { call(mod.finishTutorial); call(mod.startPractice); playOut([c]); call(mod.leaveGame); },
    };
    return c;
  };
  /** Fires the next due timer (game or queue), moving the clock to it. Returns false if none are pending. */
  const fireNext = (skipCleanup = true) => {
    const due: { at: bigint; run: () => void }[] = [];
    for (const row of test.db.gameTimer.iter()) {
      if (row.scheduledAt.tag !== 'Time' || (skipCleanup && row.kind === 'cleanup')) continue;
      due.push({ at: row.scheduledAt.value.microsSinceUnixEpoch, run: () => {
        test.db.gameTimer.scheduledId.delete(row.scheduledId); // one-shot timers are removed once they run
        test.withReducerTx(TestAuth.internal(), ctx => (mod.gameTick as any)(ctx, { arg: row }));
      } });
    }
    for (const row of test.db.queueTimer.iter()) {
      if (row.scheduledAt.tag !== 'Time') continue;
      due.push({ at: row.scheduledAt.value.microsSinceUnixEpoch, run: () => {
        test.db.queueTimer.scheduledId.delete(row.scheduledId);
        test.withReducerTx(TestAuth.internal(), ctx => (mod.queueTick as any)(ctx, { arg: row }));
      } });
    }
    if (!due.length) return false;
    due.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const next = due[0]!;
    if (next.at > test.clock.now().microsSinceUnixEpoch) test.clock.set(new Timestamp(next.at));
    next.run();
    return true;
  };
  /** Players ready up and always play their first card until their game is over. */
  const playOut = (players: ReturnType<typeof client>[], onState?: () => void) => {
    for (let i = 0; i < 2000; i++) {
      if (players.every(p => !p.game() || p.game().over)) return;
      for (const p of players) {
        const g = p.game();
        if (!g || g.over) continue;
        if (g.phase === 'prep' && !g.youReady) p.call(mod.ready);
        if (g.phase === 'pick' && g.youSel === 0n && p.hand().length) { p.call(mod.selectCard, { cardId: p.hand()[0].id }); p.call(mod.lockIn); }
      }
      onState?.();
      if (!fireNext()) throw new Error('game stalled: no timers pending');
    }
    throw new Error('game did not finish');
  };
  return { test, client, fireNext, playOut };
}

describe('guests, tutorial and practice gate', () => {
  it('gives a first-time visitor a guest profile', () => {
    const { client } = setup();
    const a = client('a');
    expect(a.me()).toMatchObject({ isGuest: true, rating: 1000, tutorialDone: false, practiceDone: false });
    expect(a.me().name).toMatch(/^Guest_\d{5}$/);
  });

  it('refuses the online queue to guests and to accounts that skipped the tutorial or practice', () => {
    const { client } = setup();
    const a = client('a');
    expect(() => a.call(mod.joinQueue)).toThrow('Create an account');
    a.call(mod.claimName, { name: 'alice' });
    expect(() => a.call(mod.joinQueue)).toThrow('Finish the tutorial');
    a.call(mod.finishTutorial);
    expect(() => a.call(mod.joinQueue)).toThrow('Finish the tutorial');
    a.qualify();
    expect(a.me()).toMatchObject({ practiceDone: true, isGuest: false, name: 'alice' });
    a.call(mod.joinQueue);
    expect(a.me().waiting).toBe('queue');
  });

  it('does not count a forfeited practice match', () => {
    const { client } = setup();
    const a = client('a');
    a.call(mod.startPractice);
    a.call(mod.forfeit);
    expect(a.game()).toMatchObject({ over: true, endResult: 'loss', endReason: 'forfeit' });
    expect(a.me()).toMatchObject({ practiceDone: false, losses: 1 });
  });

  it('keeps stats when a guest claims a name, and keeps names unique', () => {
    const { client } = setup();
    const a = client('a'), b = client('b');
    a.qualify();
    const before = a.me();
    a.call(mod.claimName, { name: 'Alice_1' });
    expect(a.me()).toMatchObject({ name: 'Alice_1', isGuest: false, wins: before.wins, losses: before.losses, practiceDone: true });
    expect(() => b.call(mod.claimName, { name: 'ALICE_1' })).toThrow('Username taken');
    expect(() => b.call(mod.claimName, { name: 'x' })).toThrow('Username:');
    expect(() => b.call(mod.claimName, { name: 'Guest_12345' })).toThrow('Username taken');
    expect(() => a.call(mod.claimName, { name: 'another' })).toThrow('already have an account');
  });
});

describe('Google sign-in', () => {
  const withFirebase = (fn: () => void) => { config.firebaseProjectId = 'demo-project'; try { fn(); } finally { config.firebaseProjectId = ''; } };

  it('requires a Google sign-in to create an account once Firebase is configured', () => withFirebase(() => {
    const { client } = setup();
    const guest = client('g'), user = client('u', true);
    expect(() => guest.call(mod.claimName, { name: 'sneaky' })).toThrow('Sign in with Google first');
    user.call(mod.claimName, { name: 'ekam' });
    expect(user.me()).toMatchObject({ name: 'ekam', isGuest: false });
  }));

  it('rejects sign-in tokens from another Firebase project', () => withFirebase(() => {
    const { test } = setup();
    const other = TestAuth.fromJwtPayload(JSON.stringify({ iss: 'https://securetoken.google.com/someone-else', aud: 'someone-else', sub: 'x' }), new ConnectionId(900n));
    test.withReducerTx(other, ctx => (mod.onConnect as any)(ctx, {}));
    expect(() => test.withReducerTx(other, ctx => (mod.claimName as any)(ctx, { name: 'intruder' }))).toThrow('Sign in with Google first');
  }));

  it('moves a guest\'s progress to the new Google account, once', () => withFirebase(() => {
    const { test, client } = setup();
    const guest = client('g');
    guest.qualify();
    const stats = guest.me();
    guest.call(mod.prepareTransfer);
    const code = (mod.myTransfer as any)(test.viewContext(guest.auth))[0].code;
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    const user = client('u', true), thief = client('t', true);
    expect((mod.myTransfer as any)(test.viewContext(user.auth))).toEqual([]); // codes are private to the guest
    thief.call(mod.claimTransfer, { code: 'f'.repeat(32) });                  // a wrong code does nothing
    expect(thief.me().practiceDone).toBe(false);
    user.call(mod.claimTransfer, { code });
    expect(user.me()).toMatchObject({ wins: stats.wins, losses: stats.losses, draws: stats.draws, tutorialDone: true, practiceDone: true, isGuest: true });
    expect(guest.me()).toBeUndefined();                                       // the guest profile is gone
    thief.call(mod.claimTransfer, { code });                                  // the code cannot be reused
    expect(thief.me().practiceDone).toBe(false);
    user.call(mod.claimName, { name: 'ekam' });
    user.call(mod.joinQueue);
    expect(user.me().waiting).toBe('queue');
  }));

  it('keeps a returning player\'s own account instead of overwriting it with guest progress', () => withFirebase(() => {
    const { test, client } = setup();
    const user = client('u', true);
    user.call(mod.claimName, { name: 'ekam' });
    user.qualify();
    const mine = user.me();
    const guest = client('g');
    guest.call(mod.prepareTransfer);
    const code = (mod.myTransfer as any)(test.viewContext(guest.auth))[0].code;
    user.call(mod.claimTransfer, { code });
    expect(user.me()).toMatchObject({ name: 'ekam', wins: mine.wins, losses: mine.losses, practiceDone: true });
  }));

  it('does not allow transfers by callers who are not signed in with Google', () => withFirebase(() => {
    const { client } = setup();
    const a = client('a');
    expect(() => a.call(mod.claimTransfer, { code: 'x' })).toThrow('Sign in with Google first');
  }));
});

describe('a match', () => {
  it('deals 10 cards split 3/3/4 and follows the rules to the end', () => {
    const { client, playOut, fireNext } = setup();
    const a = client('a');
    a.call(mod.finishTutorial);
    a.call(mod.startPractice);
    const counts = [0, 0, 0];
    for (const c of a.hand()) counts[c.kind]++;
    expect(a.hand()).toHaveLength(10);
    expect(counts.sort()).toEqual([3, 3, 4]);
    // "Opponent found" first (3 seconds, bots too), then arranging the hand
    expect(a.game()).toMatchObject({ phase: 'intro', phaseMs: 3000, oppHandCount: 10, oppIsBot: true, rated: false, totalRounds: 10 });
    fireNext();
    expect(a.game().phase).toBe('prep');
    playOut([a]);
    const g = a.game();
    expect(g.over).toBe(true);
    expect(g.endReason).toBe('points');
    // every logged round matches rock-paper-scissors, and the score is the number of rounds won
    const beats = (x: number, y: number) => (x - y + 3) % 3 === 1;
    let you = 0, opp = 0;
    for (const r of a.log()) {
      const expected = r.you < 0 ? (r.opp < 0 ? 'draw' : 'loss') : r.opp < 0 ? 'win' : beats(r.you, r.opp) ? 'win' : beats(r.opp, r.you) ? 'loss' : 'draw';
      expect(r.result).toBe(expected);
      if (r.result === 'win') you++; if (r.result === 'loss') opp++;
    }
    expect([g.youScore, g.oppScore]).toEqual([you, opp]);
    expect(a.log()).toHaveLength(10); // always all 10 rounds
    expect(g.endResult).toBe(you > opp ? 'win' : opp > you ? 'loss' : 'draw');
  });

  it('plays all 10 rounds, and outside Ranked plays a random card for a player who never picks', () => {
    const { client, playOut } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    playOut([a]); // b never plays a card: one is played for them each round
    expect(a.log()).toHaveLength(10);
    expect(b.log().every(r => r.youAuto && r.you >= 0 && r.youGone === -2)).toBe(true);
    expect(a.log().every(r => r.oppAuto)).toBe(true);
    expect(b.hand()).toHaveLength(0);
    const g = a.game();
    expect(g).toMatchObject({ over: true, endReason: 'points' });
    expect(g.youScore + g.oppScore).toBe(a.log().filter(r => r.result !== 'draw').length);
  });

  it('never shows a player the opponent\'s pick before both cards are revealed', () => {
    const { client, playOut } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode.toLowerCase() });
    let sawPick = false;
    playOut([a, b], () => {
      for (const p of [a, b]) {
        const g = p.game();
        if (g.phase === 'pick' || g.phase === 'banner' || g.phase === 'prep') {
          if (g.phase === 'pick' && g.oppPlaced) sawPick = true;
          expect(g.revealShown).toBe(false);
          expect(g.revealOpp).toBe(-2);
          expect(Object.keys(g).some(k => /sel/i.test(k) && k !== 'youSel')).toBe(false);
        }
      }
    });
    void sawPick; // seeing *that* the opponent has locked in is covered by the lock-in checks
    expect(a.game().rated).toBe(false);
    expect(a.game().endResult === 'draw' ? b.game().endResult === 'draw' : a.game().endResult !== b.game().endResult).toBe(true);
  });

  it('ignores attempts to play a card from the other hand or outside the pick phase', () => {
    const { test, client, fireNext } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    const bCard = b.hand()[0].id, aCard = a.hand()[0].id;
    a.call(mod.selectCard, { cardId: aCard });             // still in prep
    expect([...test.db.game.iter()][0]!.sel0).toBe(0n);
    a.call(mod.ready); b.call(mod.ready);
    while (a.game().phase !== 'pick') fireNext();
    a.call(mod.selectCard, { cardId: bCard });             // opponent's card
    expect(a.game().youSel).toBe(0n);
    a.call(mod.selectCard, { cardId: aCard });
    expect(a.game().youSel).toBe(aCard);
    expect(b.game().oppPlaced).toBe(false); // a pick is private until locked in
    a.call(mod.lockIn);
    expect(a.game().youLocked).toBe(true);
    expect(b.game().oppPlaced).toBe(true);
    a.call(mod.selectCard, { cardId: a.hand()[1].id }); // locked: can't change
    expect(a.game().youSel).toBe(aCard);
  });

  it('reveals as soon as both players lock in, without waiting for the timer', () => {
    const { test, client, fireNext } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    a.call(mod.ready); b.call(mod.ready);
    while (a.game().phase !== 'pick') fireNext();
    const started = test.clock.now();
    a.call(mod.selectCard, { cardId: a.hand()[0].id }); a.call(mod.lockIn);
    expect(a.game().phase).toBe('pick');
    b.call(mod.selectCard, { cardId: b.hand()[0].id }); b.call(mod.lockIn);
    expect(a.game().phase).toBe('reveal');
    expect(test.clock.now().since(started).millis).toBe(0);
    expect(a.game().revealYou).toBeGreaterThanOrEqual(0);
    expect(a.game().revealOpp).toBeGreaterThanOrEqual(0);
  });

  it('counts a picked card that was not locked in time as too slow', () => {
    const { client, fireNext } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    a.call(mod.ready); b.call(mod.ready);
    while (a.game().phase !== 'pick') fireNext();
    a.call(mod.selectCard, { cardId: a.hand()[0].id });                       // picked, never locked
    b.call(mod.selectCard, { cardId: b.hand()[0].id }); b.call(mod.lockIn);
    while (a.game().phase !== 'result') fireNext();
    // not Ranked: a random card was played for them instead
    expect(a.game()).toMatchObject({ revealYouAuto: true, revealYouGone: -2 });
    expect(a.game().revealYou).toBeGreaterThanOrEqual(0);
    expect(a.hand()).toHaveLength(9);
  });

  it('lets the bot lock in, and reveals right away once the player locks in too', () => {
    const { client, fireNext } = setup();
    const a = client('a');
    a.call(mod.startPractice); a.call(mod.ready);
    while (a.game().phase !== 'pick') fireNext();
    while (!a.game().oppPlaced) fireNext();
    a.call(mod.selectCard, { cardId: a.hand()[0].id }); a.call(mod.lockIn);
    expect(a.game().phase).toBe('reveal');
  });

  it('in Ranked, a player who misses their turn loses the round and a random card, shown to both', () => {
    const { client, fireNext } = setup();
    const a = client('a'), b = client('b');
    for (const [p, n] of [[a, 'anna'], [b, 'bert']] as const) { p.call(mod.claimName, { name: n }); p.qualify(); }
    a.call(mod.joinQueue); b.call(mod.joinQueue); b.waitMatch();
    expect(a.game()).toMatchObject({ mode: 'ranked', phase: 'intro' });
    while (a.game().phase !== 'prep') fireNext();
    a.call(mod.ready); b.call(mod.ready);
    while (a.game().phase !== 'pick') fireNext();
    a.call(mod.selectCard, { cardId: a.hand()[0].id }); a.call(mod.lockIn);
    while (a.game().phase !== 'result') fireNext();
    expect(a.game()).toMatchObject({ revealResult: 'win', revealOpp: -1, youScore: 1, revealOppAuto: false });
    expect(b.game()).toMatchObject({ revealResult: 'loss', revealYou: -1 });
    const lost = b.game().revealYouGone;
    expect(lost).toBeGreaterThanOrEqual(0);
    expect(a.game().revealOppGone).toBe(lost);  // the opponent sees which card it was
    expect(a.hand()).toHaveLength(9);
    expect(b.hand()).toHaveLength(9);           // the missed turn still cost a card
    while (a.log().length === 0) fireNext();
    expect(a.log()[0]).toMatchObject({ opp: -1, oppGone: lost });
  });

  it('lets a player rearrange their hand, and only their own', () => {
    const { client } = setup();
    const a = client('a');
    a.call(mod.startPractice);
    const ids = a.hand().map(c => c.id).reverse();
    a.call(mod.reorderHand, { ids });
    expect(a.hand().map(c => c.id)).toEqual(ids);
    a.call(mod.reorderHand, { ids: [...ids.slice(1), 999999n] }); // not their card: ignored
    expect(a.hand().map(c => c.id)).toEqual(ids);
  });
});

describe('guest-only mode (accounts switched off)', () => {
  it('lets guests play ranked once they have done the tutorial and a practice match', () => {
    config.requireAccount = false;
    try {
      const { test, client, playOut } = setup();
      const a = client('a'), b = client('b');
      expect(() => a.call(mod.joinQueue)).toThrow('Finish the tutorial');
      a.qualify(); b.qualify();
      a.call(mod.joinQueue); b.call(mod.joinQueue); b.waitMatch();
      expect(a.game().rated).toBe(true);
      playOut([a, b]);
      expect(a.me().isGuest).toBe(true);
      expect(a.me().rating + b.me().rating).toBe(2000);
      expect(((mod.leaderboard as any)(test.anonymousViewContext()) as any[]).length).toBe(2);
    } finally { config.requireAccount = true; }
  });
});

describe('ranked play', () => {
  const twoAccounts = () => {
    const s = setup();
    const a = s.client('a'), b = s.client('b');
    a.call(mod.claimName, { name: 'alice' }); b.call(mod.claimName, { name: 'bob' });
    a.qualify(); b.qualify();
    return { ...s, a, b };
  };

  it('matches two queued accounts, updates ratings and the leaderboard', () => {
    const { test, a, b, playOut } = twoAccounts();
    a.call(mod.joinQueue); b.call(mod.joinQueue); b.waitMatch();
    expect(a.game().rated && b.game().rated).toBe(true);
    expect(a.game().oppName).toBe('bob');
    expect(a.me().waiting).toBe('');
    playOut([a, b]);
    const d = a.me().rating - 1000;
    expect(b.me().rating - 1000).toBe(-d);
    expect(a.game().ratingChange).toBe(d);
    expect(a.game().endResult === 'draw' ? d === 0 : Math.abs(d) === 16).toBe(true);
    const board = (mod.leaderboard as any)(test.anonymousViewContext()) as any[];
    expect(board.map(r => r.name).sort()).toEqual(['alice', 'bob']);
    expect(board[0].rating).toBeGreaterThanOrEqual(board[1].rating);
    expect([...test.db.matchResult.iter()].filter(m => m.rated)).toHaveLength(1);
  });

  it('makes repeat games against the same opponent worth less', () => {
    const { a, b, playOut } = twoAccounts();
    const changes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = a.me().rating;
      a.call(mod.joinQueue); b.call(mod.joinQueue); b.waitMatch();
      playOut([a, b]);
      if (a.game().endResult !== 'draw') changes.push(Math.abs(a.me().rating - before));
      a.call(mod.leaveGame); b.call(mod.leaveGame);
    }
    expect(changes.length).toBeGreaterThan(2);
    for (let i = 1; i < changes.length; i++) expect(changes[i]!).toBeLessThanOrEqual(changes[i - 1]!);
    expect(changes[changes.length - 1]).toBeLessThanOrEqual(5);
  });

  it('starts a bot match after about 13.5 seconds alone in the queue', () => {
    const { test, a, fireNext } = twoAccounts();
    const start = test.clock.now();
    a.call(mod.joinQueue);
    while (!a.game()) fireNext();
    expect(test.clock.now().since(start).millis).toBe(13500); // 3.5s first search, then two 5s retries
    expect(a.game()).toMatchObject({ oppIsBot: true, rated: false, mode: 'bot' });
    expect(a.me().waiting).toBe('');
  });

  it('keeps a player searching for 3.5 seconds even when an opponent is already waiting', () => {
    const { test, a, b, fireNext } = twoAccounts();
    a.call(mod.joinQueue);
    test.clock.advance(TimeDuration.fromMillis(10000));
    b.call(mod.joinQueue);
    expect(b.game()).toBeUndefined();               // not straight into a match
    expect(b.me().waiting).toBe('queue');
    const joined = test.clock.now();
    b.waitMatch();
    expect(b.game()).toMatchObject({ mode: 'ranked', phase: 'intro' });
    expect(test.clock.now().since(joined).millis).toBeGreaterThanOrEqual(3500);
    void fireNext;
  });

  it('removes a player who cancels or disconnects from the queue', () => {
    const { test, a, b } = twoAccounts();
    a.call(mod.joinQueue);
    a.call(mod.leaveQueue);
    expect(a.me().waiting).toBe('');
    a.call(mod.joinQueue);
    a.call(mod.onDisconnect);
    expect(test.db.queueEntry.count()).toBe(0n);
    expect(test.db.queueTimer.count()).toBe(0n);
    b.call(mod.joinQueue);
    expect(b.game()).toBeUndefined(); // not matched with the player who left
  });
});

describe('rooms, disconnects and cleanup', () => {
  it('rejects bad room codes and joining your own room', () => {
    const { client } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.createRoom);
    expect(a.me().roomCode).toMatch(/^[A-Z2-9]{5}$/);
    expect(() => a.call(mod.joinRoom, { code: a.me().roomCode })).toThrow('your own room');
    expect(() => b.call(mod.joinRoom, { code: 'ZZZZZ' })).toThrow('Room not found');
    a.call(mod.closeRoom);
    expect(a.me()).toMatchObject({ waiting: '', roomCode: '' });
  });

  it('forfeits a player who stays disconnected for 15 seconds, but not one who returns', () => {
    const { test, client, fireNext } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.createRoom); b.call(mod.joinRoom, { code: a.me().roomCode });
    b.call(mod.onDisconnect);
    expect(a.game().oppConnected).toBe(false);
    test.clock.advance(TimeDuration.fromMillis(5000));
    b.call(mod.onConnect);
    expect(a.game().oppConnected).toBe(true);
    expect([...test.db.gameTimer.iter()].some(tm => tm.kind.startsWith('dc'))).toBe(false);
    b.call(mod.onDisconnect);
    const left = test.clock.now();
    while (!a.game().over) fireNext();
    expect(test.clock.now().since(left).millis).toBeLessThanOrEqual(15000);
    expect(a.game()).toMatchObject({ endResult: 'win', endReason: 'disconnect' });
    expect(a.me().wins).toBe(1);
  });

  it('stops a player from starting a second game while one is running', () => {
    const { client } = setup();
    const a = client('a');
    a.call(mod.startPractice);
    expect(() => a.call(mod.startPractice)).toThrow('already in a game');
    expect(() => a.call(mod.createRoom)).toThrow('already in a game');
  });

  it('clears finished games and leaves no timers or cards behind', () => {
    const { test, client, playOut, fireNext } = setup();
    const a = client('a');
    a.call(mod.startPractice);
    playOut([a]);
    expect(test.db.handCard.count()).toBe(0n);
    expect(a.game().over).toBe(true);   // end screen is still available
    while (fireNext(false)) { /* run the cleanup timer */ }
    expect(a.game()).toBeUndefined();
    expect(test.db.game.count()).toBe(0n);
    expect(test.db.roundLog.count()).toBe(0n);
    expect(test.db.gameTimer.count()).toBe(0n);
    expect(test.db.matchResult.count()).toBe(1n); // history is kept
  });
});

describe('rematch', () => {
  const finishedRoom = () => {
    const s = setup();
    const a = s.client('a'), b = s.client('b');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    s.playOut([a, b]);
    return { ...s, a, b };
  };

  it('starts a new room match once both players ask, with seats swapped', () => {
    const { a, b } = finishedRoom();
    const old = a.game().gameId;
    a.call(mod.rematch);
    expect(a.game()).toMatchObject({ gameId: old, over: true, youRematch: true, oppRematch: false, oppLeft: false });
    expect(b.game()).toMatchObject({ youRematch: false, oppRematch: true });
    b.call(mod.rematch);
    const g = a.game();
    expect(g.gameId).not.toBe(old);
    expect(g).toMatchObject({ mode: 'room', over: false, phase: 'intro', round: 1, youScore: 0, oppScore: 0, youRematch: false, oppRematch: false });
    expect(b.game().gameId).toBe(g.gameId);
    expect(a.hand()).toHaveLength(10);
    expect(b.hand()).toHaveLength(10);
  });

  it('refuses a rematch once the opponent has left the end screen or disconnected', () => {
    const { a, b } = finishedRoom();
    a.call(mod.rematch);
    b.call(mod.leaveGame);
    expect(a.game().oppLeft).toBe(true);
    expect(() => a.call(mod.rematch)).toThrow('opponent has left');
    expect(() => b.call(mod.rematch)).toThrow('no longer available');

    const s2 = finishedRoom();
    s2.test.withReducerTx(s2.b.auth, ctx => (mod.onDisconnect as any)(ctx, {}));
    expect(s2.a.game().oppLeft).toBe(true);
    expect(() => s2.a.call(mod.rematch)).toThrow('opponent has left');
  });

  it('keeps a ranked rematch rated', () => {
    const s = setup();
    const a = s.client('a'), b = s.client('b');
    a.call(mod.claimName, { name: 'alice' }); b.call(mod.claimName, { name: 'bob' });
    a.qualify(); b.qualify();
    a.call(mod.joinQueue); b.call(mod.joinQueue); b.waitMatch();
    s.playOut([a, b]);
    a.call(mod.rematch); b.call(mod.rematch);
    expect(a.game()).toMatchObject({ mode: 'ranked', rated: true, over: false });
  });

  it('starts a bot rematch straight away, against the same bot', () => {
    const { client, playOut } = setup();
    const a = client('a');
    a.call(mod.startPractice);
    playOut([a]);
    const bot = a.game().oppName;
    a.call(mod.rematch);
    expect(a.game()).toMatchObject({ mode: 'practice', over: false, phase: 'intro', oppName: bot, oppIsBot: true });
  });
});

describe('chat', () => {
  const room = () => {
    const s = setup();
    const a = s.client('a'), b = s.client('b'), c = s.client('c');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    const chat = (p: any) => ((mod.myChat as any)(s.test.viewContext(p.auth)) as any[]).sort((x, y) => (x.id < y.id ? -1 : 1));
    return { ...s, a, b, c, chat };
  };

  it('delivers reactions and phrases to both players, and only to them', () => {
    const { a, b, c, chat } = room();
    a.call(mod.sendChat, { kind: 'phrase', body: 'Good luck!' });
    b.call(mod.sendChat, { kind: 'emoji', body: 'lol' });
    expect(chat(a).map(m => [m.mine, m.kind, m.body])).toEqual([[true, 'phrase', 'Good luck!'], [false, 'emoji', 'lol']]);
    expect(chat(b).map(m => [m.mine, m.body])).toEqual([[false, 'Good luck!'], [true, 'lol']]);
    expect(chat(c)).toEqual([]);
    expect(() => c.call(mod.sendChat, { kind: 'emoji', body: 'nice' })).toThrow('not in a match');
  });

  it('refuses anything typed, and anything not on the lists', () => {
    const { a, chat } = room();
    expect(() => a.call(mod.sendChat, { kind: 'text', body: 'hello' })).toThrow('Unknown message type');
    expect(() => a.call(mod.sendChat, { kind: 'phrase', body: 'you are bad' })).toThrow('Pick one of the phrases');
    expect(() => a.call(mod.sendChat, { kind: 'phrase', body: 'good luck!' })).toThrow('Pick one of the phrases');
    expect(() => a.call(mod.sendChat, { kind: 'emoji', body: '💩' })).toThrow('Unknown reaction');
    // packs you haven't unlocked can't be used
    expect(() => a.call(mod.sendChat, { kind: 'emoji', body: 'king' })).toThrow('Unlock that chat pack');
    expect(() => a.call(mod.sendChat, { kind: 'phrase', body: 'Too easy' })).toThrow('Unlock that chat pack');
    expect(chat(a)).toEqual([]);
    for (const e of ['nice', 'lol', 'whoa', 'grr']) a.call(mod.sendChat, { kind: 'emoji', body: e });
    expect(chat(a).map(m => m.body)).toEqual(['nice', 'lol', 'whoa', 'grr']);
  });

  it('slows down a player who sends too fast', () => {
    const { a, b, test } = room();
    for (let i = 0; i < 4; i++) a.call(mod.sendChat, { kind: 'emoji', body: 'whoa' });
    expect(() => a.call(mod.sendChat, { kind: 'emoji', body: 'whoa' })).toThrow('Slow down');
    b.call(mod.sendChat, { kind: 'emoji', body: 'nice' }); // the other player isn't affected
    test.clock.set(new Timestamp(test.clock.now().microsSinceUnixEpoch + 5_000_000n));
    a.call(mod.sendChat, { kind: 'phrase', body: 'Nice one!' });
  });

  it('keeps chat on the end screen, and removes it with the game', () => {
    const { a, b, chat, playOut, fireNext, test } = room();
    playOut([a, b]);
    b.call(mod.sendChat, { kind: 'phrase', body: 'gg' });
    expect(chat(a)[chat(a).length - 1]).toMatchObject({ mine: false, body: 'gg' });
    while (fireNext(false)) { /* run the cleanup timer */ }
    expect(test.db.chatMsg.count()).toBe(0n);
  });

  it('works against a bot, which sometimes reacts', () => {
    const { client, playOut, test } = setup();
    const a = client('a');
    a.call(mod.startPractice);
    a.call(mod.sendChat, { kind: 'phrase', body: 'gg' });
    playOut([a]);
    const msgs = (mod.myChat as any)(test.viewContext(a.auth)) as any[];
    expect(msgs.some(m => !m.mine)).toBe(true); // the bot said something over a whole match
  });
});

describe('stats, history and achievements', () => {
  const view = (test: any, c: any, v: any) => (v as any)(test.viewContext(c.auth)) as any[];

  it('records each match in the history and the per-card stats', () => {
    const { test, client } = setup();
    const a = client('a');
    a.qualify();
    const [h] = view(test, a, mod.myHistory);
    expect(h).toMatchObject({ mode: 'practice', oppBot: true, reason: 'points' });
    expect(h.cards).toMatch(/^[rps]{10}$/);
    expect(h.outcomes).toMatch(/^[wld]{10}$/);
    const s = view(test, a, mod.myStats)[0];
    expect(s.plays0 + s.plays1 + s.plays2).toBe(10);
    expect(s.opens0 + s.opens1 + s.opens2).toBe(1);
    expect(s.wins0 + s.wins1 + s.wins2).toBe([...h.outcomes].filter((o: string) => o === 'w').length);
    const keys = view(test, a, mod.myAchievements).map(x => x.key);
    expect(keys.includes('first_win')).toBe(h.result === 'win');
    expect(view(test, client('b'), mod.myHistory)).toEqual([]); // private to each player
  });

  it('keeps only the last 20 matches and tracks win streaks', () => {
    const { test, client } = setup();
    const a = client('a');
    for (let i = 0; i < 22; i++) { a.call(mod.startPractice); a.call(mod.forfeit); }
    const hist = view(test, a, mod.myHistory);
    expect(hist).toHaveLength(20);
    expect(hist.every(h => h.result === 'loss' && h.reason === 'forfeit')).toBe(true);
    expect(view(test, a, mod.myStats)[0]).toMatchObject({ streak: 0, bestStreak: 0 });
  });

  it('gives friend-room and rematch achievements to both players', () => {
    const s = setup();
    const a = s.client('a'), b = s.client('b');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    s.playOut([a, b]);
    for (const c of [a, b]) expect(view(s.test, c, mod.myAchievements).map(x => x.key)).toContain('friend');
    a.call(mod.rematch); b.call(mod.rematch);
    for (const c of [a, b]) expect(view(s.test, c, mod.myAchievements).map(x => x.key)).toContain('rematch');
  });

  it('moves stats, history and achievements to the new Google account', () => {
    config.firebaseProjectId = 'demo-project';
    try {
      const { test, client } = setup();
      const guest = client('g');
      guest.qualify();
      const hist = view(test, guest, mod.myHistory);
      guest.call(mod.prepareTransfer);
      const code = (mod.myTransfer as any)(test.viewContext(guest.auth))[0].code;
      const user = client('u', true);
      user.call(mod.claimTransfer, { code });
      expect(view(test, user, mod.myHistory)).toHaveLength(hist.length);
      expect(view(test, user, mod.myStats)[0].plays0 + view(test, user, mod.myStats)[0].plays1 + view(test, user, mod.myStats)[0].plays2).toBe(10);
      expect([...test.db.stats.iter()]).toHaveLength(1);
    } finally { config.firebaseProjectId = ''; }
  });
});

describe('daily challenge', () => {
  const DAY = 24n * 3600n * 1_000_000n;
  const later = (test: any, days: number) => test.clock.set(new Timestamp(test.clock.now().microsSinceUnixEpoch + BigInt(days) * DAY));
  const stats = (test: any, c: any) => (mod.myStats as any)(test.viewContext(c.auth))[0];

  it('deals everyone the same hands, allows one try a day, and refuses a rematch', () => {
    const { test, client, playOut } = setup();
    const a = client('a'), b = client('b');
    expect(() => a.call(mod.startDaily)).toThrow('tutorial');
    a.call(mod.finishTutorial); b.call(mod.finishTutorial);
    a.call(mod.startDaily);
    expect(a.game()).toMatchObject({ mode: 'daily', rated: false, oppIsBot: true });
    expect(a.game().oppName).toMatch(/_daily$/);
    const handA = a.hand().map((c: any) => c.kind), botA = a.game().oppName;
    playOut([a]);
    b.call(mod.startDaily);
    expect(b.hand().map((c: any) => c.kind)).toEqual(handA);
    expect(b.game().oppName).toBe(botA);
    playOut([b]);
    // same hands, same choices, and the bot plays in a fixed order: the same match
    expect(a.log().map((l: any) => [l.you, l.opp])).toEqual(b.log().map((l: any) => [l.you, l.opp]));
    expect(a.game().youScore).toBe(b.game().youScore);
    expect(() => a.call(mod.rematch)).toThrow('One daily challenge a day');
    expect(() => a.call(mod.startDaily)).toThrow("played today's challenge");
    const s = stats(test, a);
    expect(s).toMatchObject({ dailyStreak: 1, dailyBest: 1, dailyResult: a.game().endResult, dailyYou: a.game().youScore });
    const today = (mod.dailyStats as any)(test.anonymousViewContext()) as any[];
    expect(today).toHaveLength(1);
    expect(today[0]).toMatchObject({ plays: 2, wins: a.game().endResult === 'win' ? 2 : 0 });
    expect(a.me().practiceDone).toBe(true);
  });

  it('builds a streak on consecutive days and resets it after a missed day', () => {
    const { test, client } = setup();
    const a = client('a');
    a.call(mod.finishTutorial);
    a.call(mod.startDaily); a.call(mod.forfeit);   // quitting still uses up the day's try
    expect(stats(test, a)).toMatchObject({ dailyStreak: 1, dailyResult: 'loss' });
    later(test, 1);
    a.call(mod.startDaily);
    const dealt = a.hand().map((c: any) => c.kind).join();
    a.call(mod.forfeit);
    expect(stats(test, a).dailyStreak).toBe(2);
    later(test, 2);
    a.call(mod.startDaily);
    expect(a.hand().map((c: any) => c.kind).join()).not.toBe(dealt); // a new day, a new deal (all but certainly)
    a.call(mod.forfeit);
    expect(stats(test, a)).toMatchObject({ dailyStreak: 1, dailyBest: 2 });
  });
});

describe('seasons', () => {
  it('starts a new season each month: ratings move halfway back to 1000 and the leaderboard empties', () => {
    const { test, client, playOut } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.claimName, { name: 'alice' }); b.call(mod.claimName, { name: 'bob' });
    a.qualify(); b.qualify();
    a.call(mod.joinQueue); b.call(mod.joinQueue); b.waitMatch();
    playOut([a, b]);
    const ra = a.me().rating, rb = b.me().rating;
    expect(((mod.leaderboard as any)(test.anonymousViewContext()) as any[])).toHaveLength(2);
    test.clock.set(Timestamp.fromDate(new Date('2026-12-01T00:05:00Z')));
    client('c'); // anyone connecting starts the new season
    expect(a.me().rating).toBe(1000 + Math.round((ra - 1000) / 2));
    expect(b.me().rating).toBe(1000 + Math.round((rb - 1000) / 2));
    expect(((mod.leaderboard as any)(test.anonymousViewContext()) as any[])).toEqual([]);
    expect((mod.myStats as any)(test.viewContext(a.auth))[0].lastSeason).toBe(ra);
    const info = ((mod.seasonInfo as any)(test.anonymousViewContext()) as any[])[0];
    expect(info.key).toBe(2026 * 12 + 11);
    expect(info.champ).toBe(ra >= rb ? 'alice' : 'bob');
  });
});

describe('looks', () => {
  it('starts everyone as Rocky with the free items, and shows the opponent your look', () => {
    const { client } = setup();
    const a = client('a'), b = client('b');
    expect(a.me()).toMatchObject({ avatar: 'rocky', frame: '', skin: 'classic', back: 'classic', color: 'green', fx: 'confetti', title: '' });
    a.call(mod.equip, { kind: 'avatar', key: 'snip' });
    expect(a.me().avatar).toBe('snip');
    expect(() => a.call(mod.equip, { kind: 'avatar', key: 'hello' })).toThrow('Unknown item');
    expect(() => a.call(mod.equip, { kind: 'aura', key: 'gold' })).toThrow('Unlock that first');
    expect(() => a.call(mod.equip, { kind: 'skin', key: 'neon' })).toThrow('Unlock that first');
    expect(() => a.call(mod.equip, { kind: 'title', key: 'legend' })).toThrow('Unlock that first');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    expect(b.game()).toMatchObject({ oppAvatar: 'snip', oppSkin: 'classic', oppFx: 'confetti', oppTitle: '' });
    expect(a.game()).toMatchObject({ oppAvatar: 'rocky' });
  });

  it('moves old emoji avatars to Rocky and old frames to their new auras', () => {
    const { test, client } = setup();
    const a = client('a');
    test.db.look.insert({ identity: a.me().identity, avatar: '🦊', frame: 'fire', skin: 'classic', back: 'classic', color: 'green', fx: 'confetti', title: '', reactions: 'nice', phrases: 'gg' });
    expect(a.me()).toMatchObject({ avatar: 'rocky', frame: 'blaze' });
  });

  it('sets a chat loadout from owned packs only', () => {
    const { client } = setup();
    const a = client('a');
    a.call(mod.setLoadout, { reactions: ['grr', 'nice'], phrases: ['gg'] });
    expect(a.me()).toMatchObject({ reactions: 'grr,nice', phrases: 'gg' });
    expect(() => a.call(mod.setLoadout, { reactions: ['king'], phrases: [] })).toThrow('Unlock that reaction');
    expect(() => a.call(mod.setLoadout, { reactions: [], phrases: ['Too easy'] })).toThrow('Unlock that phrase');
    expect(() => a.call(mod.setLoadout, { reactions: ['nice', 'nice'], phrases: [] })).toThrow('only be used once');
    expect(() => a.call(mod.setLoadout, { reactions: ['nice', 'lol', 'whoa', 'grr', 'nice', 'lol', 'whoa'], phrases: [] })).toThrow('Too many');
  });
});

describe('friends, invites and reports', () => {
  const friends = (test: any, c: any) => (mod.myFriends as any)(test.viewContext(c.auth)) as any[];
  const invites = (test: any, c: any) => (mod.myInvites as any)(test.viewContext(c.auth)) as any[];

  it('sends, accepts and removes friend requests', () => {
    const { test, client } = setup();
    const a = client('a'), b = client('b');
    expect(() => a.call(mod.addFriend, { name: 'nobody_here' })).toThrow('No player');
    expect(() => a.call(mod.addFriend, { name: a.me().name })).toThrow("That's you");
    a.call(mod.addFriend, { name: b.me().name.toUpperCase() });
    expect(friends(test, a)).toMatchObject([{ name: b.me().name, state: 'out', online: false }]);
    expect(friends(test, b)).toMatchObject([{ name: a.me().name, state: 'in' }]);
    expect(() => a.call(mod.addFriend, { name: b.me().name })).toThrow('already sent');
    b.call(mod.acceptFriend, { other: a.me().identity });
    expect(friends(test, a)).toMatchObject([{ state: 'friends', online: true, playing: false }]);
    expect(friends(test, b)).toMatchObject([{ state: 'friends' }]);
    expect(() => b.call(mod.addFriend, { name: a.me().name })).toThrow('already friends');
    a.call(mod.removeFriend, { other: b.me().identity });
    expect(friends(test, a)).toEqual([]);
    expect(friends(test, b)).toEqual([]);
  });

  it('befriends an opponent from the match, and asking back accepts', () => {
    const { test, client, playOut } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    a.call(mod.addOpponent);
    expect(b.game().oppFriend).toBe('in');
    playOut([a, b]);
    b.call(mod.addOpponent); // on the end screen
    expect(friends(test, a)[0].state).toBe('friends');
    expect(a.game().oppFriend).toBe('friends');
    a.call(mod.leaveGame);
    a.call(mod.startPractice);
    expect(() => a.call(mod.addOpponent)).toThrow('no opponent');
  });

  it('invites a friend into a room, and drops the invite when the room closes', () => {
    const { test, client } = setup();
    const a = client('a'), b = client('b'), c = client('c');
    a.call(mod.addFriend, { name: b.me().name }); b.call(mod.addFriend, { name: a.me().name });
    expect(() => a.call(mod.inviteFriend, { other: c.me().identity })).toThrow('only invite friends');
    a.call(mod.inviteFriend, { other: b.me().identity });
    expect(a.me().waiting).toBe('room');
    const [inv] = invites(test, b);
    expect(inv).toMatchObject({ fromName: a.me().name, code: a.me().roomCode });
    a.call(mod.closeRoom);
    expect(invites(test, b)).toEqual([]);
    a.call(mod.inviteFriend, { other: b.me().identity });
    b.call(mod.joinRoom, { code: invites(test, b)[0].code });
    expect(a.game().oppName).toBe(b.me().name);
    expect(invites(test, b)).toEqual([]);
  });

  it('takes one report per match, about a person', () => {
    const { test, client } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    expect(() => a.call(mod.reportPlayer, { reason: 'whatever' })).toThrow('Pick a reason');
    a.call(mod.reportPlayer, { reason: 'Offensive name' });
    expect(() => a.call(mod.reportPlayer, { reason: 'Other' })).toThrow('already reported');
    const rows = [...test.db.report.iter()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reportedName: b.me().name, reason: 'Offensive name' });
    a.call(mod.forfeit); a.call(mod.leaveGame);
    a.call(mod.startPractice);
    expect(() => a.call(mod.reportPlayer, { reason: 'Other' })).toThrow('no opponent');
  });
});

describe('player profiles and recent opponents', () => {
  const v = (test: any, c: any, view: any) => (view as any)(test.viewContext(c.auth)) as any[];

  it('shows a profile with stats, form and your record against them, and hides private details', () => {
    const { test, client, playOut } = setup();
    const a = client('a'), b = client('b'), c = client('c');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    playOut([a, b]);
    const res = a.game().endResult;
    a.call(mod.leaveGame); b.call(mod.leaveGame);
    expect(() => c.call(mod.viewProfile, { name: 'nobody_here' })).toThrow('no longer around');
    // a stranger sees stats but not whether they're online
    c.call(mod.viewProfile, { name: a.me().name.toUpperCase() });
    const pc = v(test, c, mod.playerProfile)[0];
    expect(pc).toMatchObject({ name: a.me().name, isMe: false, relation: '', online: false, lastPlayed: 0n, vsWins: 0 });
    expect(pc.form).toHaveLength(1);
    expect(pc.wins + pc.losses + pc.draws).toBe(1);
    expect(pc).not.toHaveProperty('coins');
    // the opponent sees the head-to-head
    b.call(mod.viewProfile, { name: a.me().name });
    const pb = v(test, b, mod.playerProfile)[0];
    expect(pb.vsWins + pb.vsLosses + pb.vsDraws).toBe(1);
    expect(pb.vsLastResult).toBe(res === 'win' ? 'loss' : res === 'loss' ? 'win' : 'draw');
    // friends also see online and last played
    a.call(mod.addFriend, { name: b.me().name }); b.call(mod.addFriend, { name: a.me().name });
    const pf = v(test, b, mod.playerProfile)[0];
    expect(pf).toMatchObject({ relation: 'friends', online: true });
    expect(pf.lastPlayed > 0n).toBe(true);
    // your own profile
    a.call(mod.viewProfile, { name: a.me().name });
    expect(v(test, a, mod.playerProfile)[0].isMe).toBe(true);
  });

  it('lists the real people you played recently, once each, with friend state', () => {
    const { test, client, playOut } = setup();
    const a = client('a'), b = client('b');
    for (let i = 0; i < 2; i++) {
      a.call(mod.createRoom);
      b.call(mod.joinRoom, { code: a.me().roomCode });
      playOut([a, b]);
      a.call(mod.leaveGame); b.call(mod.leaveGame);
    }
    a.call(mod.startPractice); playOut([a]); a.call(mod.leaveGame); // bots aren't listed
    expect(v(test, a, mod.myRecent)).toMatchObject([{ name: b.me().name, relation: '', mode: 'room' }]);
    a.call(mod.addFriend, { name: b.me().name });
    expect(v(test, a, mod.myRecent)[0].relation).toBe('out');
    const [f] = v(test, a, mod.myFriends);
    expect(f.since > 0n).toBe(true);
    expect(f.level).toBeGreaterThanOrEqual(1);
  });
});

describe('watching a friend', () => {
  const watch = (test: any, c: any) => (mod.watchGame as any)(test.viewContext(c.auth))[0];
  it('shows only public information, follows rematches, and stops when the watcher plays', () => {
    const { test, client, fireNext } = setup();
    const a = client('a'), b = client('b'), c = client('c');
    a.call(mod.addFriend, { name: b.me().name }); b.call(mod.addFriend, { name: a.me().name });
    expect(() => a.call(mod.watchFriend, { other: b.me().identity })).toThrow('not in a match');
    b.call(mod.startPractice);
    expect(() => c.call(mod.watchFriend, { other: b.me().identity })).toThrow('only watch friends');
    a.call(mod.watchFriend, { other: b.me().identity });
    expect(a.me().watching).toBe(b.me().name);
    let w = watch(test, a);
    expect(w).toMatchObject({ aName: b.me().name, bIsBot: true, aCards: 10, bCards: 10, revealShown: false });
    expect(Object.keys(w).some(k => /hand|sel/i.test(k))).toBe(false); // nobody's cards or picks
    expect(b.game().watchers).toBe(1);
    // play a round: the watcher sees the cards only once they are revealed
    b.call(mod.ready);
    while (b.game().phase !== 'pick') fireNext();
    b.call(mod.selectCard, { cardId: b.hand()[0].id }); b.call(mod.lockIn);
    expect(watch(test, a).revealA).toBe(-2);
    while (!watch(test, a).revealShown) fireNext();
    expect(watch(test, a).revealA).toBeGreaterThanOrEqual(0);
    b.call(mod.forfeit);
    expect(watch(test, a)).toMatchObject({ over: true, endResult: 'loss' });
    const old = watch(test, a).gameId;
    b.call(mod.rematch);
    expect(watch(test, a).gameId).not.toBe(old); // follows the friend into the next match
    expect((mod.watchLog as any)(test.viewContext(a.auth))).toEqual([]);
    a.call(mod.startPractice);
    expect(a.me().watching).toBe('');
    expect(b.game().watchers).toBe(0);
  });
});

describe('XP and card style unlocks', () => {
  const xpOf = (test: any, c: any) => ((mod.myStats as any)(test.viewContext(c.auth))[0] || { xp: 0 }).xp;
  const setXp = (test: any, c: any, xp: number) => {
    const row = test.db.stats.identity.find(c.me().identity);
    test.db.stats.identity.update({ ...row, xp });
  };

  it('gives half XP for bot matches, nothing to a player who quits, and more for ranked', () => {
    const { test, client, playOut } = setup();
    const a = client('a');
    a.call(mod.startPractice); playOut([a]);
    const r = a.game().endResult;
    expect(a.game().xpGain).toBe(r === 'win' ? 15 : r === 'draw' ? 8 : 5);
    expect(xpOf(test, a)).toBe(a.game().xpGain);
    a.call(mod.leaveGame);
    a.call(mod.startPractice); a.call(mod.forfeit);
    expect(a.game().xpGain).toBe(0);

    const s = setup();
    const x = s.client('x'), y = s.client('y');
    x.call(mod.claimName, { name: 'xena' }); y.call(mod.claimName, { name: 'yuri' });
    x.qualify(); y.qualify();
    const before = xpOf(s.test, x);
    x.call(mod.joinQueue); y.call(mod.joinQueue); y.waitMatch();
    s.playOut([x, y]);
    const res = x.game().endResult;
    expect(x.game().xpGain).toBe(res === 'win' ? 45 : res === 'draw' ? 23 : 15);
    expect(xpOf(s.test, x) - before).toBe(x.game().xpGain);
  });

  it('unlocks Level-road items by level', () => {
    const { test, client } = setup();
    const a = client('a');
    a.call(mod.startPractice); a.call(mod.forfeit); // creates the stats row
    setXp(test, a, 549);  // just short of level 5
    expect(() => a.call(mod.equip, { kind: 'skin', key: 'neon' })).toThrow('Unlock that first');
    setXp(test, a, 550);  // level 5: 100 + 125 + 150 + 175
    a.call(mod.equip, { kind: 'skin', key: 'neon' });
    expect(a.me().skin).toBe('neon');
    expect(() => a.call(mod.equip, { kind: 'skin', key: 'wood' })).toThrow('Unlock that first');
    const items = (mod.myItems as any)(test.viewContext(a.auth)).map((r: any) => r.item);
    expect(items).toContain('pack:hype');      // level 4
    expect(items).not.toContain('aura:ruby');  // level 7
  });

  it('gives everything to the accounts listed in the config', () => {
    const { client } = setup();
    const a = client('a'), b = client('b');
    const saved = config.allSkins;
    config.allSkins = [a.me().identity.toHexString().replace(/^0x/, '').toLowerCase()];
    try {
      expect(a.me().allSkins).toBe(true);
      expect(b.me().allSkins).toBe(false);
      a.call(mod.equip, { kind: 'skin', key: 'gold' });
      a.call(mod.equip, { kind: 'aura', key: 'diamond' });
      a.call(mod.equip, { kind: 'title', key: 'legend' });
      expect(a.me()).toMatchObject({ skin: 'gold', frame: 'diamond', title: 'legend' });
      expect(() => b.call(mod.equip, { kind: 'skin', key: 'gold' })).toThrow('Unlock that first');
    } finally { config.allSkins = saved; }
  });
});

describe('rank rewards', () => {
  const items = (test: any, c: any) => ((mod.myItems as any)(test.viewContext(c.auth)) as any[]).map(r => r.item);
  const achs = (test: any, c: any) => ((mod.myAchievements as any)(test.viewContext(c.auth)) as any[]).map(x => x.key);

  it('reaching Silver in Ranked unlocks the Silver aura and Contender title, kept after the rating drops', () => {
    const { test, client, playOut } = setup();
    const a = client('a'), b = client('b');
    for (const [p, n] of [[a, 'anna'], [b, 'bert']] as const) { p.call(mod.claimName, { name: n }); p.qualify(); }
    expect(items(test, a)).not.toContain('aura:silver');
    for (const p of [a, b]) test.db.player.identity.update({ ...test.db.player.identity.find(p.me().identity)!, rating: 1095 });
    a.call(mod.joinQueue); b.call(mod.joinQueue); b.waitMatch();
    playOut([a, b]);
    const winner = a.game().endResult === 'win' ? a : b.game().endResult === 'win' ? b : null;
    if (!winner) return; // a draw moves nobody over the line
    expect(winner.me().rating).toBeGreaterThanOrEqual(1100);
    expect(achs(test, winner)).toContain('silver');
    expect(items(test, winner)).toEqual(expect.arrayContaining(['aura:silver', 'title:contender']));
    winner.call(mod.equip, { kind: 'title', key: 'contender' });
    test.db.player.identity.update({ ...test.db.player.identity.find(winner.me().identity)!, rating: 1000 });
    expect(items(test, winner)).toContain('aura:silver');
  });

  it('gives Silver on connect to players who reached a rank before it existed, and Gold or Diamond rewards from their awards', () => {
    const { test, client } = setup();
    const a = client('a');
    const id = a.me().identity;
    test.db.achievement.insert({ id: 0n, identity: id, key: 'diamond', at: test.clock.now() });
    expect(items(test, a)).toEqual(expect.arrayContaining(['aura:diamond', 'back:prism', 'title:diamond', 'fx:shatter']));
    expect(items(test, a)).not.toContain('back:goldcrest');
    a.call(mod.onConnect);
    expect(achs(test, a)).toContain('silver');
    expect(items(test, a)).toContain('title:contender');
    expect(() => a.call(mod.equip, { kind: 'back', key: 'goldcrest' })).toThrow('Unlock that first');
    a.call(mod.equip, { kind: 'fx', key: 'shatter' });
  });
});

describe('coins and the Store', () => {
  const coinsOf = (c: any) => c.me().coins;

  it('starts everyone with the 300-coin welcome gift and pays coins for matches', () => {
    const { client, playOut } = setup();
    const a = client('a');
    expect(coinsOf(a)).toBe(300);
    a.call(mod.startPractice); playOut([a]);
    const g = a.game();
    // practice pays half: 10 a win, 5 a draw, 3 a loss; a first win of the day adds 50; level 2 adds 100
    const base = g.endResult === 'win' ? 10 + 50 : g.endResult === 'draw' ? 5 : 3;
    expect(g.coinGain).toBeGreaterThanOrEqual(base);
    expect(coinsOf(a)).toBe(300 + g.coinGain);
    a.call(mod.leaveGame);
    a.call(mod.startPractice); a.call(mod.forfeit);
    expect(a.game().coinGain).toBe(0); // quitting pays nothing
  });

  it('pays the first win of the day once, and level-up coins', () => {
    const { test, client, playOut } = setup();
    const a = client('a');
    // play until a win
    for (let i = 0; i < 20; i++) {
      a.call(mod.startPractice); playOut([a]);
      if (a.game().endResult === 'win') break;
      a.call(mod.leaveGame);
    }
    expect(a.game().endResult).toBe('win');
    const w = test.db.wallet.identity.find(a.me().identity)!;
    expect(w.firstWinDay).toBeGreaterThan(0);
    // level-ups pay 100, and 300 on every fifth level
    a.call(mod.leaveGame);
    const row = test.db.stats.identity.find(a.me().identity)!;
    test.db.stats.identity.update({ ...row, xp: 545 }); // level 4, 5 XP short of level 5
    const before = coinsOf(a);
    a.call(mod.startPractice); playOut([a]);
    const g = a.game();
    const matchCoins = g.endResult === 'win' ? 10 : g.endResult === 'draw' ? 5 : 3;
    expect(g.coinGain - matchCoins).toBeGreaterThanOrEqual(300); // reached level 5
    expect(coinsOf(a) - before).toBe(g.coinGain);
  });

  it('pays coins for achievements: 100, or 250 for the big ones', () => {
    const { test, client, playOut } = setup();
    const a = client('a');
    const wallet = () => test.db.wallet.identity.find(a.me().identity)?.coins ?? 300;
    a.call(mod.startPractice); playOut([a]);
    const got = ((mod.myAchievements as any)(test.viewContext(a.auth)) as any[]).map(x => x.key);
    expect(wallet()).toBe(300 + a.game().coinGain);
    if (got.includes('first_win')) expect(a.game().coinGain).toBeGreaterThanOrEqual(100);
  });

  it('sells items, refuses what you can\'t afford or already own, and takes 20% off the daily deal', () => {
    const { test, client } = setup();
    const a = client('a');
    const info = () => (mod.serverInfo as any)(test.viewContext(a.auth))[0];
    const items = () => ((mod.myItems as any)(test.viewContext(a.auth)) as any[]).map(r => r.item);
    expect(() => a.call(mod.buyItem, { item: 'title:legend' })).toThrow("isn't for sale");
    expect(() => a.call(mod.buyItem, { item: 'skin:classic' })).toThrow("isn't for sale");
    expect(() => a.call(mod.buyItem, { item: 'skin:gold' })).toThrow('more coins');
    const cheap = info().dealItem === 'pack:goodsport' ? 'pack:hype' : 'pack:goodsport';
    a.call(mod.buyItem, { item: cheap });
    expect(items()).toContain(cheap);
    expect(a.me().coins).toBe(300 - (cheap === 'pack:hype' ? 250 : 150));
    expect(() => a.call(mod.buyItem, { item: cheap })).toThrow('already own');
    // the deal
    const deal = info();
    const w = test.db.wallet.identity.find(a.me().identity)!;
    test.db.wallet.identity.update({ ...w, coins: 100000 });
    if (!items().includes(deal.dealItem)) {
      a.call(mod.buyItem, { item: deal.dealItem });
      expect(a.me().coins).toBe(100000 - deal.dealPrice);
    }
    // bought items can be worn
    if (!items().includes('avatar:ace')) a.call(mod.buyItem, { item: 'avatar:ace' });
    a.call(mod.equip, { kind: 'avatar', key: 'ace' });
    expect(a.me().avatar).toBe('ace');
  });
});

describe('unranked matches', () => {
  it('pairs unranked players only with each other: normal XP, no rating change, not on the boards', () => {
    const { test, client, playOut } = setup();
    const a = client('a'), b = client('b'), c = client('c');
    for (const [p, n] of [[a, 'anna'], [b, 'bert'], [c, 'cara']] as const) { p.call(mod.claimName, { name: n }); p.qualify(); }
    a.call(mod.joinCasual);
    c.call(mod.joinQueue);        // ranked: must not be paired with a
    expect(a.game()).toBeUndefined();
    expect(a.me()).toMatchObject({ waiting: 'queue', casual: true });
    b.call(mod.joinCasual); b.waitMatch();
    expect(a.game()).toMatchObject({ mode: 'casual', rated: false });
    expect(c.game()).toBeUndefined(); // the ranked player is still searching
    playOut([a, b]);
    const g = a.game();
    expect(g.ratingChange).toBe(0);
    expect(a.me().rating).toBe(1000);
    expect(g.xpGain).toBe(g.endResult === 'win' ? 30 : g.endResult === 'draw' ? 15 : 10);
    expect(test.db.weekly.identity.find(a.me().identity)).toBeFalsy();
    expect(test.db.ladder.identity.find(a.me().identity)).toBeFalsy();
  });
});

describe('weekly leaderboard', () => {
  it('gives 3 points a win and 1 a draw in ranked, and empties every Monday', () => {
    const { test, client, playOut } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.claimName, { name: 'anna' }); b.call(mod.claimName, { name: 'bert' });
    a.qualify(); b.qualify();
    a.call(mod.joinQueue); b.call(mod.joinQueue); b.waitMatch();
    playOut([a, b]);
    const r = a.game().endResult;
    const board = () => (mod.weeklyBoard as any)(test.viewContext(a.auth)) as any[];
    const rank = (c: any) => (mod.myRank as any)(test.viewContext(c.auth))[0];
    const expectA = r === 'win' ? 3 : r === 'draw' ? 1 : 0;
    const expectB = r === 'loss' ? 3 : r === 'draw' ? 1 : 0;
    expect(rank(a).weekPoints).toBe(expectA);
    expect(rank(b).weekPoints).toBe(expectB);
    expect(board()[0].points).toBe(Math.max(expectA, expectB));
    expect(rank(a).monthRank).toBeGreaterThan(0);
    // 2026-11-14 is a Saturday: two days later is Monday
    test.clock.set(Timestamp.fromDate(new Date('2026-11-16T00:00:01Z')));
    client('z'); // anyone connecting starts the new week
    expect(board()).toEqual([]);
  });

  it('shows you and your friends', () => {
    const { test, client } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.claimName, { name: 'anna' }); b.call(mod.claimName, { name: 'bert' });
    a.call(mod.addFriend, { name: 'bert' }); b.call(mod.addFriend, { name: 'anna' });
    const rows = (mod.friendsBoard as any)(test.viewContext(a.auth)) as any[];
    expect(rows.map(r => [r.name, r.me]).sort()).toEqual([['anna', true], ['bert', false]]);
  });
});

describe('account, help and admin', () => {
  it('deletes an account and everything on it, keeping reports about others', () => {
    const { test, client, playOut } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    playOut([a, b]);
    a.call(mod.reportPlayer, { reason: 'Other' });
    expect(() => a.call(mod.deleteAccount, { confirm: 'delete' })).toThrow('Type DELETE');
    const id = a.me().identity;
    a.call(mod.deleteAccount, { confirm: 'DELETE' });
    expect(test.db.player.identity.find(id)).toBeFalsy();
    expect(test.db.stats.identity.find(id)).toBeFalsy();
    expect(test.db.wallet.identity.find(id)).toBeFalsy();
    expect(test.db.report.count()).toBe(1n);
  });

  it('forfeits a running match when an account is deleted mid-game', () => {
    const { client } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    a.call(mod.deleteAccount, { confirm: 'DELETE' });
    expect(b.game()).toMatchObject({ over: true, endResult: 'win', endReason: 'forfeit' });
  });

  it('takes a few bug reports a day', () => {
    const { test, client } = setup();
    const a = client('a');
    expect(() => a.call(mod.reportBug, { text: 'bad', version: '2', device: 'x' })).toThrow('a little more');
    for (let i = 0; i < 5; i++) a.call(mod.reportBug, { text: 'The timer froze', version: '2', device: 'iPhone' });
    expect(() => a.call(mod.reportBug, { text: 'The timer froze', version: '2', device: 'iPhone' })).toThrow('Try again tomorrow');
    expect(test.db.bug.count()).toBe(5n);
  });

  it('lets only admins rename, suspend, grant and post notices', () => {
    const { test, client } = setup();
    const a = client('a'), b = client('b');
    b.call(mod.claimName, { name: 'badname' });
    expect(() => b.call(mod.adminBan, { name: 'badname', banned: true })).toThrow('Admins only');
    expect((mod.adminReports as any)(test.viewContext(b.auth))).toEqual([]);
    const saved = config.admins;
    config.admins = [a.me().identity.toHexString().replace(/^0x/, '').toLowerCase()];
    try {
      expect(a.me().isAdmin).toBe(true);
      a.call(mod.adminRename, { name: 'badname', newName: 'nicename' });
      expect(b.me().name).toBe('nicename');
      a.call(mod.adminGrant, { name: 'nicename', coins: 500, item: 'skin:royal' });
      expect(b.me().coins).toBe(800);
      b.call(mod.equip, { kind: 'skin', key: 'royal' });
      a.call(mod.adminBan, { name: 'nicename', banned: true });
      expect(b.me().banned).toBe(true);
      expect(() => b.call(mod.createRoom)).toThrow('suspended');
      a.call(mod.adminBan, { name: 'nicename', banned: false });
      a.call(mod.adminNotice, { maintenance: true, message: 'Back at 5pm', backInMinutes: 30, hideAfterHours: 0 });
      expect((mod.serverInfo as any)(test.viewContext(b.auth))[0]).toMatchObject({ maintenance: true, message: 'Back at 5pm' });
      expect(() => b.call(mod.createRoom)).toThrow('Back at 5pm');
      b.call(mod.startPractice); // practice still works during maintenance
      expect((mod.adminSummary as any)(test.viewContext(a.auth))[0].players).toBe(2);
    } finally { config.admins = saved; }
  });
});

describe('admin dashboard tools', () => {
  const asAdmin = (c: any, fn: () => void) => {
    const saved = config.admins;
    config.admins = [c.me().identity.toHexString().replace(/^0x/, '').toLowerCase()];
    try { fn(); } finally { config.admins = saved; }
  };
  const view = (test: any, c: any, v: any) => (v as any)(test.viewContext(c.auth)) as any[];

  it('suspends for a while with a reason, mutes chat, and lifts both', () => {
    const { test, client } = setup();
    const a = client('a'), b = client('b'), c = client('c');
    b.call(mod.claimName, { name: 'bert' });
    asAdmin(a, () => {
      a.call(mod.adminSuspend, { name: 'bert', hours: 24, reason: 'offensive name' });
      expect(() => b.call(mod.createRoom)).toThrow(/suspended for about 24 more hours \(offensive name\)/);
      test.clock.set(new Timestamp(test.clock.now().microsSinceUnixEpoch + 25n * 3600n * 1_000_000n));
      b.call(mod.createRoom); // the suspension ran out
      b.call(mod.closeRoom);
      a.call(mod.adminMute, { name: 'bert', hours: 2 });
      c.call(mod.createRoom); b.call(mod.joinRoom, { code: c.me().roomCode });
      expect(() => b.call(mod.sendChat, { kind: 'emoji', body: 'nice' })).toThrow('muted');
      a.call(mod.adminMute, { name: 'bert', hours: 0 });
      b.call(mod.sendChat, { kind: 'emoji', body: 'nice' });
      const log = view(test, a, mod.adminLogView).map(l => l.action);
      expect(log).toEqual(expect.arrayContaining(['suspend', 'mute chat', 'unmute chat']));
    });
  });

  it('lets moderators handle reports and short suspensions, but not coins or events', () => {
    const { test, client } = setup();
    const a = client('a'), m = client('m'), b = client('b');
    m.call(mod.claimName, { name: 'modder' }); b.call(mod.claimName, { name: 'bert' });
    asAdmin(a, () => a.call(mod.adminSetRole, { name: 'modder', role: 'mod' }));
    expect(m.me()).toMatchObject({ isMod: true, isAdmin: false });
    m.call(mod.adminSuspend, { name: 'bert', hours: 48, reason: '' });
    expect(() => m.call(mod.adminSuspend, { name: 'bert', hours: 500, reason: '' })).toThrow('up to 7 days');
    expect(() => m.call(mod.adminGrant, { name: 'bert', coins: 10, item: '' })).toThrow('Admins only');
    expect(() => m.call(mod.adminEvent, { name: 'x', coinPct: 200, xpPct: 100, hours: 1, startInHours: 0 })).toThrow('Admins only');
    expect(view(test, m, mod.adminPlayers).length).toBe(3);
    expect(view(test, b, mod.adminPlayers)).toEqual([]);
  });

  it('opens a full player profile, and gives and takes coins and items', () => {
    const { test, client, playOut } = setup();
    const a = client('a'), b = client('b');
    b.call(mod.claimName, { name: 'bert' });
    b.call(mod.startPractice); playOut([b]); b.call(mod.leaveGame);
    asAdmin(a, () => {
      a.call(mod.adminOpenPlayer, { name: 'bert' });
      const before = view(test, a, mod.adminProfile)[0];
      expect(before.name).toBe('bert');
      expect(JSON.parse(before.history).length).toBe(1);
      a.call(mod.adminGrant, { name: 'bert', coins: 1000, item: 'skin:royal' });
      a.call(mod.adminTakeCoins, { name: 'bert', coins: 500 });
      expect(view(test, a, mod.adminProfile)[0].coins).toBe(before.coins + 500);
      expect(view(test, a, mod.adminProfile)[0].bought).toContain('skin:royal');
      a.call(mod.adminTakeItem, { name: 'bert', item: 'skin:royal' });
      expect(view(test, a, mod.adminProfile)[0].bought).not.toContain('skin:royal');
      expect(() => a.call(mod.adminDeleteAccount, { name: 'bert', confirm: 'nope' })).toThrow('Type the username');
      a.call(mod.adminDeleteAccount, { name: 'bert', confirm: 'bert' });
      expect(view(test, a, mod.adminPlayers).map(p => p.name)).not.toContain('bert');
    });
  });

  it('runs double coins and XP events, and lets the admin pick the deal', () => {
    const { test, client, playOut } = setup();
    const a = client('a'), b = client('b');
    asAdmin(a, () => {
      a.call(mod.adminEvent, { name: 'Double weekend', coinPct: 200, xpPct: 200, hours: 48, startInHours: 0 });
      a.call(mod.adminSetDeal, { daysFromToday: 0, item: 'skin:gold' });
      expect(() => a.call(mod.adminSetDeal, { daysFromToday: 0, item: 'title:legend' })).toThrow("isn't sold");
    });
    const info = (mod.serverInfo as any)(test.viewContext(b.auth))[0];
    expect(info).toMatchObject({ eventName: 'Double weekend', eventCoinPct: 200, dealItem: 'skin:gold', dealPrice: 20000 });
    b.call(mod.startPractice); b.call(mod.forfeit); b.call(mod.leaveGame); // creates stats
    b.call(mod.startPractice); playOut([b]);
    const g = b.game();
    expect(g.xpGain).toBe(2 * (g.endResult === 'win' ? 15 : g.endResult === 'draw' ? 8 : 5) - (g.endResult === 'draw' ? 1 : 0));
  });

  it('counts matches by mode, visits, sales and coins for the charts', () => {
    const { test, client, playOut } = setup();
    const a = client('a'), b = client('b');
    b.call(mod.startPractice); playOut([b]); b.call(mod.leaveGame);
    b.call(mod.buyItem, { item: 'pack:goodsport' });
    asAdmin(a, () => {
      const day = view(test, a, mod.adminDays)[0];
      expect(day).toMatchObject({ matches: 1, practice: 1, newPlayers: 2, active: 2, sales: 1 });
      expect(Number(day.coinsSpent)).toBe(150);
      expect(Number(day.coinsEarned)).toBeGreaterThan(0);
      expect(view(test, a, mod.adminSales)[0]).toMatchObject({ item: 'pack:goodsport', sold: 1 });
      expect(view(test, a, mod.adminRetention)[0]).toMatchObject({ joined: 2 });
      expect(view(test, a, mod.adminHours)[0].matches).toBe(1);
      expect(view(test, a, mod.adminSummary)[0]).toMatchObject({ players: 2 });
    });
  });

  it('saves the match chat with a report', () => {
    const { test, client } = setup();
    const a = client('a'), b = client('b'), x = client('x');
    a.call(mod.createRoom); b.call(mod.joinRoom, { code: a.me().roomCode });
    b.call(mod.sendChat, { kind: 'phrase', body: 'gg' });
    a.call(mod.reportPlayer, { reason: 'Spam in chat' });
    asAdmin(x, () => {
      expect(view(test, x, mod.adminReports)[0].chat).toContain(': gg');
    });
  });
});
