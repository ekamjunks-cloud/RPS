// RPS 10 — browser client for the Spacetime version.
// It only ever sees what the server's views send it: its own hand, the opponent's card count,
// and each round's cards once both are revealed.
import './style.css';
import { DbConnection, tables } from './module_bindings';

const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? 'https://maincloud.spacetimedb.com';
const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'rps-10-b7hi9';
const TOKEN_KEY = `rps10_token:${HOST}/${DB_NAME}`;
// false: guest-only, no sign-in anywhere. true: brings back accounts (Google sign-in / usernames).
// Keep it in step with requireAccount in spacetimedb/src/config.ts.
const ACCOUNTS: boolean = false;
const GOOGLE_KEY = 'rps10_google'; // remembers that this device was signed in with Google

const KINDS = ['rock', 'paper', 'scissors'];
const E: Record<string, string> = { rock: '🪨', paper: '📄', scissors: '✂️' };
const $ = (id: string) => document.getElementById(id) as any;
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

let conn: DbConnection;
let ready = false;         // first data has arrived
let me: any = null;        // my profile, from the my_player view
let G: any = null;         // current game state, built from the my_game / my_hand / my_log views
let dismissed: string | null = null; // a finished game whose end screen was closed
let overlay: 'auth' | 'tut' | null = null; // a screen the player opened themselves
let pendingQueue = false;  // go straight into the queue once the account exists
let prevPhase: any = null, prevRound: any = null;
let localHand: any = null; // [{id,t}] in the order the player sees
let localSel: any = null;
let D: any = null;         // drag state
let clock: any = null;
let phaseKey = '', localDeadline = 0;
let notice = '';           // a one-off message for the home screen
let unlockedBefore = true;

// ---------- screens ----------
function show(id: string) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id)); }
const showing = (id: string) => $(id).classList.contains('on');
function net(msg: string | null) { $('net').textContent = msg || ''; $('net').classList.toggle('on', !!msg); }

// ---------- talking to the server ----------
/** Calls a server reducer. Refusals ("Room not found", ...) are shown to the player. */
function call(name: string, args: any = {}): Promise<boolean> {
  const fn = (conn.reducers as any)[name];
  return Promise.resolve()
    .then(() => fn(args))
    .then(() => true, (err: any) => { showError(String((err && err.message) || err || 'Something went wrong. Try again.')); return false; });
}
function showError(msg: string) {
  msg = msg.replace(/^.*?Error:\s*/, '');
  if (showing('scrAuth')) $('authErr').textContent = msg;
  else if (!$('friendModal').classList.contains('hide')) $('friendErr').textContent = msg;
  else $('lobbyErr').textContent = msg;
}

// Google sign-in (Firebase) loads in the background; guests never wait for it.
type AuthModule = typeof import('./auth');
const authReady: Promise<AuthModule | null> = ACCOUNTS ? import('./auth').catch(() => null) : Promise.resolve(null);
let google: { name: string; email: string; photo: string } | null = null; // set while signed in with Google
let pendingTransfer: string | null = null; // one-time code that moves guest progress to the Google account
let namePrompted = false;

let gen = 0;               // bumped on every (re)connect so callbacks from an old connection are ignored
let triedFreshToken = false;
async function connect() {
  const my = ++gen;
  try { if (conn) conn.disconnect(); } catch {}
  ready = false; me = null; G = null; localHand = null; prevPhase = null; phaseKey = ''; dismissed = null; overlay = null;
  skippingTutorial = false;
  closeModals();
  $('loadMsg').textContent = 'Connecting…';
  show('scrLoad');

  // Signed in with Google: the Firebase ID token is the login. Otherwise: this browser's saved guest token.
  let token: string | undefined, provider: (() => Promise<string>) | undefined;
  const auth = google ? await authReady : null;
  if (google && auth) {
    try { token = await auth.token(); provider = () => auth.token(); }
    catch { google = null; store.set(GOOGLE_KEY, null); }
  }
  if (!google) token = store.get(TOKEN_KEY) || undefined;
  if (my !== gen) return;
  const asGoogle = !!google, saved = token;

  let b = DbConnection.builder().withUri(HOST).withDatabaseName(DB_NAME).withToken(token).withAutomaticReconnect();
  if (provider) b = b.withTokenProvider(provider);
  let connected = false;
  conn = b
    .onConnect((c, _identity, issued) => {
      if (my !== gen) return;
      connected = true;
      if (!asGoogle) store.set(TOKEN_KEY, issued); // this token *is* the guest profile on this device
      net(null);
      c.subscriptionBuilder()
        .onApplied(() => { if (my === gen) { ready = true; afterConnect(); } })
        .onError(() => { if (my === gen) $('loadMsg').textContent = 'Could not load the game. Refresh to try again.'; })
        .subscribe([tables.myPlayer, tables.myGame, tables.myHand, tables.myLog, tables.myTransfer, tables.leaderboard]);
    })
    .onAutomaticReconnect(() => { if (my === gen) net(null); })
    .onDisconnect(() => { if (my === gen && connected) net('Reconnecting…'); })
    .onConnectError(() => {
      if (my !== gen) return;
      if (connected) return net('Reconnecting…');
      if (asGoogle) {
        // the server refused the Google login: carry on as a guest and say so
        google = null; store.set(GOOGLE_KEY, null);
        authReady.then(a => a && a.signOutUser()).catch(() => {});
        notice = 'Google sign-in was not accepted by the game server. You are playing as a guest.';
        connect();
      } else if (saved && !triedFreshToken) {
        // the saved guest login was rejected (for example the database was reset): start as a new guest
        triedFreshToken = true;
        store.set(TOKEN_KEY, null);
        connect();
      } else {
        $('loadMsg').textContent = "Can't reach the game server. Retrying…";
        setTimeout(() => { if (my === gen) connect(); }, 3000);
      }
    })
    .build();

  // any change to what the server shows us: rebuild the screen once the whole update has landed
  let queued = false;
  const changed = () => { if (my === gen && !queued) { queued = true; queueMicrotask(() => { queued = false; if (my === gen) sync(); }); } };
  for (const t of [conn.db.myPlayer, conn.db.myGame, conn.db.myHand, conn.db.myLog, conn.db.myTransfer, conn.db.leaderboard] as any[]) {
    t.onInsert(changed); t.onDelete(changed);
    if (typeof t.onUpdate === 'function') t.onUpdate(changed);
  }
}

/** First data has arrived on a new connection. */
async function afterConnect() {
  if (google && pendingTransfer) {
    const code = pendingTransfer; pendingTransfer = null;
    await call('claimTransfer', { code }); // a new account takes over what the guest had earned
  }
  sync();
}

const first = <T,>(it: Iterable<T>): T | undefined => { for (const x of it) return x; return undefined; };
const kindName = (k: number) => (k >= 0 ? KINDS[k] : null);

/** Turns the server's view rows into the state the screens are drawn from. */
function buildState(gv: any) {
  const key = `${gv.gameId}:${gv.seq}`;
  if (key !== phaseKey) {
    const now = Date.now();
    // A phase we watched begin lasts phaseMs from now. One we joined midway uses the server's deadline,
    // kept within sane bounds in case this device's clock is off.
    const watched = phaseKey.startsWith(`${gv.gameId}:`);
    localDeadline = watched ? now + gv.phaseMs : Math.min(now + gv.phaseMs, Math.max(now, gv.deadline.toDate().getTime()));
    phaseKey = key;
  }
  const hand = Array.from(conn.db.myHand.iter()).sort((a, b) => a.pos - b.pos).map(c => ({ id: String(c.id), t: KINDS[c.kind] }));
  const log = Array.from(conn.db.myLog.iter()).sort((a, b) => a.n - b.n)
    .map(l => ({ n: l.n, you: kindName(l.you), opp: kindName(l.opp), result: l.result }));
  return {
    gameId: String(gv.gameId), phase: gv.phase, deadline: localDeadline, round: gv.round,
    winPoints: gv.winPoints, pickMs: gv.pickMs, rated: gv.rated, ratingChange: gv.ratingChange,
    you: { name: gv.youName, score: gv.youScore, hand, sel: gv.youSel === 0n ? null : String(gv.youSel), ready: gv.youReady },
    opp: { name: gv.oppName, isBot: gv.oppIsBot, score: gv.oppScore, handCount: gv.oppHandCount, ready: gv.oppReady, placed: gv.oppPlaced, connected: gv.oppConnected },
    reveal: gv.revealShown ? { n: gv.round, you: kindName(gv.revealYou), opp: kindName(gv.revealOpp), result: gv.revealResult || null } : null,
    log,
    ended: gv.over ? { result: gv.endResult, reason: gv.endReason } : null,
  };
}

let skippingTutorial = false;
function sync() {
  if (!ready) return;
  const meRow = first(conn.db.myPlayer.iter());
  if (!meRow) return;
  me = meRow;
  renderMe();
  renderBoard();

  const gv = first(conn.db.myGame.iter());
  if (gv && String(gv.gameId) !== dismissed) {
    overlay = null;
    onState(buildState(gv));
    return;
  }
  if (G) { G = null; localHand = null; prevPhase = null; }

  if (!me.tutorialDone) {
    if (store.get('rps10_tut')) { if (!skippingTutorial) { skippingTutorial = true; call('finishTutorial'); } } // already seen on this device
    else if (!showing('scrTut')) openTutorial(true);
    return;
  }
  if (ACCOUNTS && google && me.isGuest && !namePrompted && !overlay) {
    namePrompted = true;
    $('authUser').value = suggestName(google.name);
    return openAuth('Signed in. Pick a username other players will see.');
  }
  if (overlay === 'auth' && me.isGuest) { if (!showing('scrAuth')) show('scrAuth'); return; }
  if (overlay === 'tut') return;
  overlay = null;
  if (me.waiting === 'queue') waitScreen('Finding opponent', '', '');
  else if (me.waiting === 'room') waitScreen('Waiting for friend', me.roomCode, 'Share this code');
  else if (!showing('scrLobby')) toLobby();
}

// ---------- account ----------
const suggestName = (n: string) => n.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
function closeModals() { for (const id of ['acctModal', 'friendModal', 'confirmLeave']) $(id).classList.add('hide'); }

/** Guests sign in with Google to get an account. Their progress moves across with a one-time code. */
async function googleSignIn() {
  const auth = await authReady;
  if (!auth || !auth.configured) { homeMsg("Google sign-in isn't set up yet."); return; }
  const guest = !!(me && me.isGuest);
  if (guest) call('prepareTransfer'); // not awaited: the sign-in window must open straight from the tap
  let profile;
  try { profile = await auth.signIn(); }
  catch (e: any) {
    const code = String((e && e.code) || '');
    if (code.includes('popup-blocked')) homeMsg('Your browser blocked the sign-in window. Allow pop-ups and try again.');
    else if (!code.includes('popup-closed') && !code.includes('cancelled')) homeMsg('Google sign-in failed. Try again.');
    return;
  }
  if (guest) {
    for (let i = 0; i < 20 && !first(conn.db.myTransfer.iter()); i++) await new Promise(r => setTimeout(r, 100));
    const row = first(conn.db.myTransfer.iter());
    pendingTransfer = row ? row.code : null;
  }
  google = profile; namePrompted = false;
  store.set(GOOGLE_KEY, '1');
  connect();
}
async function googleSignOut() {
  const auth = await authReady;
  google = null; pendingQueue = false;
  store.set(GOOGLE_KEY, null);
  try { if (auth) await auth.signOutUser(); } catch {}
  connect(); // back to this browser's guest profile
}

function openAuth(note: string) {
  overlay = 'auth';
  closeModals();
  $('authNote').textContent = note;
  $('authErr').textContent = '';
  show('scrAuth');
  $('authUser').focus();
}
$('authBack').onclick = () => { overlay = null; pendingQueue = false; toLobby(); };
$('authForm').onsubmit = async (e: Event) => {
  e.preventDefault();
  $('authErr').textContent = '';
  $('authSubmit').disabled = true;
  const ok = await call('claimName', { name: $('authUser').value });
  $('authSubmit').disabled = false;
  if (!ok) return;
  overlay = null;
  toLobby();
  if (pendingQueue) { pendingQueue = false; if (me && me.practiceDone) call('joinQueue'); }
};

/** "Get an account": Google sign-in when Firebase is set up, otherwise just a username. */
async function startAccount() {
  const auth = await authReady;
  if (auth && auth.configured && !google) return googleSignIn();
  openAuth(google ? 'Pick a username other players will see.' : 'Pick a name to play ranked. Your stats carry over.');
}
$('btnGoogle').onclick = () => { pendingQueue = false; startAccount(); };
$('btnProfile').onclick = () => { renderAccount(); $('acctModal').classList.remove('hide'); };
$('acctClose').onclick = () => $('acctModal').classList.add('hide');
$('acctSignIn').onclick = () => { $('acctModal').classList.add('hide'); pendingQueue = false; startAccount(); };
$('acctSignOut').onclick = () => { $('acctModal').classList.add('hide'); googleSignOut(); };

function avatar(el: any) {
  el.innerHTML = '';
  if (google && google.photo) {
    const img = document.createElement('img');
    img.src = google.photo; img.alt = ''; img.referrerPolicy = 'no-referrer';
    img.onerror = () => { el.textContent = initial(); };
    el.appendChild(img);
  } else el.textContent = initial();
}
const initial = () => (me ? me.name[0].toUpperCase() : '?');
function renderAccount() {
  if (!me) return;
  avatar($('acctAv'));
  $('acctName').textContent = me.name;
  $('acctSub').textContent = google ? google.email : me.isGuest ? 'Guest — progress is saved on this device only' : 'Account saved on this device';
  $('acctSignIn').classList.toggle('hide', !me.isGuest);
  $('acctSignIn').textContent = google ? 'Choose a username' : googleOn ? 'Continue with Google' : 'Create account';
  $('acctSignOut').classList.toggle('hide', !google);
}

// ---------- lobby ----------
function toLobby() {
  hidePop(); $('banner').classList.remove('on'); $('over').classList.add('hide'); $('confirmLeave').classList.add('hide');
  $('lobbyErr').textContent = '';
  renderMe(); renderBoard();
  show('scrLobby');
}
let googleOn = false; // Firebase values are present
authReady.then(a => { googleOn = !!(a && a.configured); renderMe(); });
function homeMsg(m: string) { $('lobbyErr').textContent = m; }

function renderMe() {
  if (!me) return;
  const played = me.wins + me.losses + me.draws;
  avatar($('meAv')); avatar($('chipAv'));
  $('meName').textContent = me.name;
  $('meTag').textContent = me.isGuest ? 'Guest' : google ? 'Signed in with Google' : 'Account';
  $('meRating').textContent = ACCOUNTS && me.isGuest ? '—' : me.rating;
  $('btnProfile').classList.toggle('hide', !ACCOUNTS);
  $('stPlayed').textContent = played;
  $('stWins').textContent = me.wins;
  $('stRate').textContent = played ? Math.round((me.wins / played) * 100) + '%' : '—';
  // sign-in card: shown to guests
  $('guestCard').classList.toggle('hide', !ACCOUNTS || !me.isGuest);
  $('guestText').textContent = google ? 'Pick a username to finish your account.'
    : googleOn ? 'Sign in to keep your progress on every device and play ranked.'
    : 'Create an account to play ranked. Your stats carry over.';
  $('btnGoogle').textContent = google ? 'Choose a username' : googleOn ? 'Continue with Google' : 'Create account';
  const locked = !me.practiceDone;
  $('btnQuick').classList.toggle('locked', locked);
  $('quickSub').textContent = locked ? 'Finish one practice match to unlock' : ACCOUNTS && me.isGuest ? 'Ranked · needs an account' : 'Ranked · find an opponent';
  if (notice) { homeMsg(notice); notice = ''; }
  if (!$('acctModal').classList.contains('hide')) renderAccount();
}
function renderBoard() {
  const top = Array.from(conn.db.leaderboard.iter()).sort((a, b) => b.rating - a.rating);
  $('board').innerHTML = top.length ? top.map((u, i) =>
    `<div class="lb${me && u.identity.isEqual(me.identity) ? ' mine' : ''}"><span><span class="rk">${i + 1}</span>${esc(u.name)}</span><b>${u.rating}</b></div>`).join('')
    : '<div class="empty">No ranked games yet</div>';
}
function waitScreen(title: string, code: string, sub: string) {
  $('waitTitle').textContent = title; $('waitCode').textContent = code; $('waitSub').textContent = sub;
  $('btnCancelWait').onclick = () => call(code ? 'closeRoom' : 'leaveQueue');
  $('btnShareCode').classList.toggle('hide', !code);
  show('scrWait');
}

$('btnQuick').onclick = () => {
  $('lobbyErr').textContent = '';
  if (!me.practiceDone) { $('lobbyErr').textContent = 'Finish one practice match first'; return; }
  if (ACCOUNTS && me.isGuest) { pendingQueue = true; return startAccount(); }
  call('joinQueue');
};
$('btnFriend').onclick = () => { $('lobbyErr').textContent = ''; $('friendErr').textContent = ''; $('friendModal').classList.remove('hide'); };
$('friendClose').onclick = () => $('friendModal').classList.add('hide');

// ---------- sharing ----------
async function share(text: string, button: any) {
  const url = location.origin + location.pathname;
  try {
    if (navigator.share) { await navigator.share({ title: 'RPS 10', text, url }); return; }
    await navigator.clipboard.writeText(`${text} ${url}`);
    const old = button.textContent; button.textContent = 'Copied'; setTimeout(() => { button.textContent = old; }, 1500);
  } catch { /* the player closed the share sheet */ }
}
$('btnInvite').onclick = () => share('Play me at RPS 10: rock paper scissors with a 10-card hand.', $('btnInvite'));
$('btnShareCode').onclick = () => share(`Join my RPS 10 room with code ${$('waitCode').textContent}.`, $('btnShareCode'));
$('btnPractice').onclick = () => { $('lobbyErr').textContent = ''; dismissed = null; call('startPractice'); };
$('btnCreate').onclick = () => { $('friendModal').classList.add('hide'); call('createRoom'); };
$('btnJoin').onclick = async () => {
  $('friendErr').textContent = '';
  if (await call('joinRoom', { code: $('joinCode').value })) $('friendModal').classList.add('hide');
};
$('btnHow').onclick = () => openTutorial(false);

// ---------- tutorial ----------
const tc = (t: string, cls = '') => `<div class="tc ${cls}">${E[t]}</div>`;
const TUT = [
  { title: '10 cards each',
    text: 'You get 3 of two kinds and 4 of the third. Your opponent can\'t see which one you have 4 of.',
    art: () => tc('rock').repeat(3) + tc('paper').repeat(3) + '<div class="gap"></div>' + tc('scissors', 'hi').repeat(4) },
  { title: 'One card per round',
    text: 'Tap a card to play it. You have 10 seconds. Too slow and you lose the round.',
    art: () => tc('paper', 'big hi') + '<span class="num">10</span>' + '<div class="tc big" style="border-style:dashed"></div>' },
  { title: 'Win the round, score a point',
    text: 'A draw scores nothing. Played cards are gone for good, so keep track of what your opponent has left.',
    art: () => tc('rock', 'big win') + '<span class="txt">beats</span>' + tc('scissors', 'big lose') },
  { title: 'First to 7 wins',
    text: 'If the cards run out first, the higher score takes the match.',
    art: () => '<span class="num">7</span>' },
];
let tutStep = 0, tutFirst = false;
function openTutorial(firstTime: boolean) { tutFirst = firstTime; if (!firstTime) overlay = 'tut'; tutStep = 0; renderTut(); show('scrTut'); }
function renderTut() {
  const t = TUT[tutStep], last = tutStep === TUT.length - 1;
  $('tutArt').innerHTML = t.art();
  $('tutTitle').textContent = t.title;
  $('tutText').textContent = t.text;
  $('tutDots').innerHTML = TUT.map((_, i) => `<i class="${i === tutStep ? 'on' : ''}"></i>`).join('');
  $('tutNext').textContent = !last ? 'Next' : tutFirst ? 'Play a practice match' : 'Got it';
  $('tutNext').disabled = false;
  $('tutBack').style.visibility = tutStep > 0 || !tutFirst ? 'visible' : 'hidden';
}
$('tutNext').onclick = async () => {
  if (tutStep < TUT.length - 1) { tutStep++; return renderTut(); }
  if (!tutFirst) { overlay = null; return toLobby(); }
  $('tutNext').disabled = true;
  store.set('rps10_tut', '1');
  dismissed = null;
  if (await call('finishTutorial')) await call('startPractice');
  $('tutNext').disabled = false;
};
$('tutBack').onclick = () => { if (tutStep > 0) { tutStep--; renderTut(); } else if (!tutFirst) { overlay = null; toLobby(); } };

// ---------- game ----------
function remaining() { return G ? Math.max(0, G.deadline - Date.now()) : 0; }

function onState(s) {
  const firstOfGame = !G || G.gameId !== s.gameId;
  G = s;
  if (firstOfGame) { unlockedBefore = !!(me && me.practiceDone); prevPhase = null; prevRound = null; localHand = null; localSel = null; $('over').classList.add('hide'); }
  show('scrGame');

  // hand: keep local order unless the server's card set changed
  const ids = s.you.hand.map(c => c.id).join();
  const localIds = localHand ? localHand.map(c => c.id).slice().sort().join() : '';
  if (!localHand || localIds !== s.you.hand.map(c => c.id).slice().sort().join()) localHand = s.you.hand.slice();
  if (s.phase === 'pick') { if (s.you.sel !== null) localSel = s.you.sel; } else localSel = null;

  const entering = s.phase !== prevPhase || s.round !== prevRound;
  renderGame(entering, firstOfGame);
  prevPhase = s.phase; prevRound = s.round;
  if (!clock) clock = setInterval(tickClock, 200);
}

function renderGame(entering, first) {
  const s = G;
  $('nameYou').textContent = s.you.name;
  $('nameOpp').textContent = s.opp.name;
  $('winPts').textContent = s.winPoints;
  setNum('sYou', s.you.score); setNum('sOpp', s.opp.score);
  $('round').textContent = `Round ${s.round}`;

  // opponent hand backs
  const backs = Math.max(0, s.opp.handCount - (s.opp.placed ? 1 : 0));
  $('oppHand').innerHTML = '<div class="back"></div>'.repeat(backs);

  // prep
  const prep = s.phase === 'prep';
  $('prep').classList.toggle('on', prep);
  $('readyBtn').classList.toggle('on', prep);
  if (prep) {
    $('chipYou').textContent = s.you.ready ? 'You ✓' : 'You'; $('chipYou').className = 'chip' + (s.you.ready ? ' ok' : '');
    $('chipOpp').textContent = s.opp.name + (s.opp.ready ? ' ✓' : ''); $('chipOpp').className = 'chip' + (s.opp.ready ? ' ok' : '');
    $('readyBtn').disabled = s.you.ready;
    $('readyBtn').textContent = s.you.ready ? (s.opp.ready ? 'Starting…' : 'Waiting for opponent…') : 'Ready';
  }

  // banner
  if (s.phase === 'banner' && entering) {
    $('bn1').textContent = `ROUND ${s.round}`; $('banner').classList.add('on');
  } else if (s.phase !== 'banner') $('banner').classList.remove('on');

  // table
  const tm = $('timer');
  tm.classList.toggle('hide', s.phase !== 'pick');
  $('bar').style.visibility = s.phase === 'pick' ? '' : 'hidden';
  if (s.phase === 'prep' || s.phase === 'banner') { setSlot('slotYou', '', 'You'); setSlot('slotOpp', '', s.opp.name); }
  if (s.phase === 'pick') {
    const sc = localHand.find(c => c.id === localSel);
    setSlot('slotYou', sc ? 'mine' : '', 'You', sc ? E[sc.t] : '');
    setSlot('slotOpp', s.opp.placed ? 'down' : '', s.opp.name);
  }
  if ((s.phase === 'reveal' || s.phase === 'result') && s.reveal) {
    const r = s.reveal;
    if (entering && s.phase === 'reveal') {
      setSlot('slotYou', r.you ? 'face flip' : 'miss', 'You', r.you ? E[r.you] : 'Too<br>slow');
      setSlot('slotOpp', r.opp ? 'face flip' : 'miss', s.opp.name, r.opp ? E[r.opp] : 'Too<br>slow');
    }
    if (s.phase === 'result' && entering) {
      const res = r.result;
      if (r.you) $('slotYou').classList.add(res === 'win' ? 'win' : res === 'loss' ? 'lose' : 'tie');
      if (r.opp) $('slotOpp').classList.add(res === 'loss' ? 'win' : res === 'win' ? 'lose' : 'tie');
      if (res === 'win') bump('sYou'); if (res === 'loss') bump('sOpp');
      showPop(r);
    }
  }
  if (s.phase !== 'result') hidePop();

  // messages
  let m = '';
  if (!s.opp.connected && !s.opp.isBot && s.phase !== 'over') m = 'Opponent disconnected…';
  $('msg').textContent = m;

  renderHand(first && prep);
  renderLog();

  if (s.phase === 'over' && s.ended) showEnd();
}

function setNum(id, v) { $(id).textContent = v; }
function bump(id) { const e = $(id); e.classList.remove('bump'); void e.offsetWidth; e.classList.add('bump'); }
function setSlot(id, cls, lbl, content = '') { const el = $(id); el.className = 'slot' + (cls ? ' ' + cls : ''); el.innerHTML = `${content}<span class="lbl">${esc(lbl)}</span>`; }

function tickClock() {
  if (!G) return;
  const ms = remaining();
  if (G.phase === 'pick') {
    const sec = Math.ceil(ms / 1000);
    const tm = $('timer');
    if (tm.textContent !== String(sec)) tm.textContent = sec;
    tm.classList.toggle('urgent', sec <= 3);
    $('barFill').style.width = Math.min(100, ms / G.pickMs * 100) + '%';
  }
  if (G.phase === 'prep') $('prepT').textContent = Math.ceil(ms / 1000);
}

function showPop(r) {
  const p = $('pop');
  p.className = 'pop ' + r.result;
  $('popRound').textContent = `Round ${r.n}`;
  $('popTitle').textContent = !r.you && r.opp ? 'Too slow' : r.result === 'win' ? 'You win' : r.result === 'loss' ? `${G.opp.name} wins` : 'Draw';
  $('popYou').className = 'pc' + (r.result === 'win' ? ' win' : r.result === 'loss' ? ' lose' : '');
  $('popOpp').className = 'pc' + (r.result === 'loss' ? ' win' : r.result === 'win' ? ' lose' : '');
  $('popYou').firstChild.textContent = r.you ? E[r.you] : '—';
  $('popOpp').firstChild.textContent = r.opp ? E[r.opp] : '—';
  $('popOppName').textContent = G.opp.name;
  $('popScore').textContent = `${G.you.score} – ${G.opp.score}`;
  $('dim').classList.add('on'); p.classList.add('on');
}
function hidePop() { $('pop').classList.remove('on'); $('dim').classList.remove('on'); }

function showEnd() {
  const e = G.ended;
  const t = $('endTitle');
  t.textContent = e.result === 'win' ? 'Victory' : e.result === 'loss' ? 'Defeat' : 'Draw';
  t.style.color = e.result === 'win' ? 'var(--you)' : e.result === 'loss' ? 'var(--opp)' : 'var(--accent)';
  $('endSub').textContent = `${G.you.score} – ${G.opp.score}`;
  $('endNote').textContent = e.reason === 'disconnect' ? (e.result === 'win' ? 'Opponent left' : 'You disconnected')
    : e.reason === 'forfeit' ? (e.result === 'win' ? 'Opponent left' : 'You left') : '';
  if (G.rated) $('endNote').textContent = [$('endNote').textContent, `Rating ${G.ratingChange >= 0 ? '+' : ''}${G.ratingChange}`].filter(Boolean).join(' · ');
  if (!$('endNote').textContent && me && !unlockedBefore && G.opp.isBot && e.reason === 'points') $('endNote').textContent = 'Online play unlocked';
  hidePop(); $('banner').classList.remove('on');
  $('confirmLeave').classList.add('hide');
  $('over').classList.remove('hide');
}
$('btnBack').onclick = () => { if (G) dismissed = G.gameId; call('leaveGame'); toLobby(); };

$('readyBtn').onclick = () => call('ready');
function askExit() {
  if (!G || G.phase === 'over') return;
  $('leaveNote').textContent = G.rated ? 'This is a ranked match. Exiting counts as a loss and costs you rating.'
    : !G.opp.isBot ? 'Your friend wins this match.'
    : me && !me.practiceDone ? 'It counts as a loss, and you still need one finished practice match to unlock online play.'
    : 'It will count as a loss.';
  $('confirmLeave').classList.remove('hide');
}
$('btnLeave').onclick = askExit;
$('btnLeaveNo').onclick = () => $('confirmLeave').classList.add('hide');
$('btnLeaveYes').onclick = async () => {
  // straight back to the main screen; the server records the loss
  if (G) dismissed = G.gameId;
  toLobby();
  if (await call('forfeit')) call('leaveGame');
  else { dismissed = null; sync(); } // could not exit (e.g. offline): return to the match
};

function renderLog() {
  const log = G.log;
  $('logCount').textContent = log.length ? `${log.length} played` : '';
  if (!log.length) { $('logBody').innerHTML = '<div class="empty">No turns yet</div>'; return; }
  const lbl = { win: 'WIN', loss: 'LOSS', draw: 'DRAW' };
  let h = `<table><tr><th>Turn</th><th>You</th><th>${esc(G.opp.name)}</th><th>Result</th></tr>`;
  log.slice().reverse().forEach((r, i) => {
    h += `<tr class="${i === 0 ? 'new' : ''}"><td>${r.n}</td><td class="e">${r.you ? E[r.you] : '—'}</td><td class="e">${r.opp ? E[r.opp] : '—'}</td><td><span class="res ${r.result}">${r.you ? lbl[r.result] : 'MISSED'}</span></td></tr>`;
  });
  $('logBody').innerHTML = h + '</table>';
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }) as any)[c]); }

// ---------- hand: tap to select, drag to reorder ----------
function renderHand(deal = false) {
  if (D && D.moving) return;
  const hand = $('hand'); hand.innerHTML = '';
  hand.classList.toggle('wait', G.phase !== 'pick' && G.phase !== 'prep');
  localHand.forEach((c, i) => {
    const b = document.createElement('div');
    b.className = 'card' + (localSel === c.id ? ' sel' : '') + (deal ? ' deal' : '');
    if (deal) b.style.animationDelay = (i * 60) + 'ms';
    b.textContent = E[c.t];
    b.dataset.id = c.id;
    b.addEventListener('pointerdown', e => startDrag(e, b));
    hand.appendChild(b);
  });
}
function startDrag(e, el) {
  if (!G || G.phase === 'over') return;
  e.preventDefault();
  D = { el, x: e.clientX, y: e.clientY, moving: false, ghost: null, id: e.pointerId };
  window.addEventListener('pointermove', onDrag);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
}
function onDrag(e) {
  if (!D || e.pointerId !== D.id) return;
  if (!D.moving) {
    if (Math.hypot(e.clientX - D.x, e.clientY - D.y) < 8) return;
    D.moving = true;
    D.ghost = document.createElement('div'); D.ghost.className = 'dragGhost'; D.ghost.textContent = D.el.textContent;
    document.body.appendChild(D.ghost);
    D.el.classList.add('ph');
  }
  D.ghost.style.left = e.clientX + 'px'; D.ghost.style.top = e.clientY + 'px';
  const hand = $('hand');
  for (const c of hand.children) {
    if (c === D.el) continue;
    const r = c.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 6 && e.clientY <= r.bottom + 6) {
      hand.insertBefore(D.el, e.clientX > r.left + r.width / 2 ? c.nextSibling : c);
      break;
    }
  }
}
function endDrag(e) {
  if (!D || e.pointerId !== D.id) return;
  window.removeEventListener('pointermove', onDrag);
  window.removeEventListener('pointerup', endDrag);
  window.removeEventListener('pointercancel', endDrag);
  const d = D; D = null;
  if (d.moving) {
    d.ghost.remove();
    const byId = Object.fromEntries(localHand.map(c => [c.id, c]));
    localHand = [...$('hand').children].map(c => byId[c.dataset.id]).filter(Boolean);
    call('reorderHand', { ids: localHand.map((c: any) => BigInt(c.id)) });
    renderHand();
  } else if (G && G.phase === 'pick') {
    localSel = d.el.dataset.id;
    call('selectCard', { cardId: BigInt(localSel) });
    renderGame(false, false);
  }
}

// ---------- boot ----------
(async () => {
  // only wait for Firebase if this device was signed in with Google last time
  if (ACCOUNTS && store.get(GOOGLE_KEY)) {
    try { const auth = await authReady; google = auth ? await auth.restore() : null; } catch { google = null; }
    if (!google) store.set(GOOGLE_KEY, null);
    else namePrompted = false;
  }
  connect();
})();
