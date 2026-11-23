// Plays whole matches against the real Spacetime datastore, in memory. Run with: npm test
import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp, TimeDuration } from 'spacetimedb';
import { createModuleTestHarness, TestAuth, TestClock } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from './index';
import { config } from './config';

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
        if (g.phase === 'pick' && g.youSel === 0n && p.hand().length) p.call(mod.selectCard, { cardId: p.hand()[0].id });
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
    const { client, playOut } = setup();
    const a = client('a');
    a.call(mod.finishTutorial);
    a.call(mod.startPractice);
    const counts = [0, 0, 0];
    for (const c of a.hand()) counts[c.kind]++;
    expect(a.hand()).toHaveLength(10);
    expect(counts.sort()).toEqual([3, 3, 4]);
    expect(a.game()).toMatchObject({ phase: 'prep', oppHandCount: 10, oppIsBot: true, rated: false, winPoints: 7 });
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
    expect(g.youScore === 7 || g.oppScore === 7 || a.log().length === 10).toBe(true);
    expect(g.endResult).toBe(you > opp ? 'win' : opp > you ? 'loss' : 'draw');
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
    expect(sawPick).toBe(true); // they do see *that* the opponent has placed a card
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
    expect(b.game().oppPlaced).toBe(true);
  });

  it('gives the round to the player who picked when the other is too slow', () => {
    const { client, fireNext } = setup();
    const a = client('a'), b = client('b');
    a.call(mod.createRoom);
    b.call(mod.joinRoom, { code: a.me().roomCode });
    a.call(mod.ready); b.call(mod.ready);
    while (a.game().phase !== 'pick') fireNext();
    a.call(mod.selectCard, { cardId: a.hand()[0].id });
    while (a.game().phase !== 'result') fireNext();
    expect(a.game()).toMatchObject({ revealResult: 'win', revealOpp: -1, youScore: 1 });
    expect(b.game()).toMatchObject({ revealResult: 'loss', revealYou: -1 });
    expect(a.hand()).toHaveLength(9);
    expect(b.hand()).toHaveLength(10); // an unplayed card stays in the hand
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
      a.call(mod.joinQueue); b.call(mod.joinQueue);
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
    a.call(mod.joinQueue); b.call(mod.joinQueue);
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
      a.call(mod.joinQueue); b.call(mod.joinQueue);
      playOut([a, b]);
      if (a.game().endResult !== 'draw') changes.push(Math.abs(a.me().rating - before));
      a.call(mod.leaveGame); b.call(mod.leaveGame);
    }
    expect(changes.length).toBeGreaterThan(2);
    for (let i = 1; i < changes.length; i++) expect(changes[i]!).toBeLessThanOrEqual(changes[i - 1]!);
    expect(changes[changes.length - 1]).toBeLessThanOrEqual(5);
  });

  it('starts a bot match after 15 seconds alone in the queue', () => {
    const { test, a, fireNext } = twoAccounts();
    const start = test.clock.now();
    a.call(mod.joinQueue);
    while (!a.game()) fireNext();
    expect(test.clock.now().since(start).millis).toBe(15000);
    expect(a.game()).toMatchObject({ oppIsBot: true, rated: false, mode: 'bot' });
    expect(a.me().waiting).toBe('');
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
