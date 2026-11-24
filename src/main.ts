// RPS 10 — browser client for the Spacetime version.
// It only ever sees what the server's views send it: its own hand, the opponent's card count,
// and each round's cards once both are revealed.
import './style.css';
import { DbConnection, tables } from './module_bindings';
import { KINDS, ICON, face, BACK, mini, TROPHY, SKULL, SHAKE, SPEAKER_ON, SPEAKER_OFF, LOCK, CHAT } from './art';
import { sfx, unlock, isMuted, setMuted } from './sfx';
import { burstAt, confetti, vibrate } from './fx';
import { drawResultCard } from './card';
import { AVATARS, FRAMES, SKINS, REPORT_REASONS, avatarHtml } from './social';
import { tierOf, nextTier, tierBadge, ACHIEVEMENTS, achievementOf, today, msToNextDay, msToSeasonEnd, seasonName, shortTime } from './ranks';

const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? 'https://maincloud.spacetimedb.com';
const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'rps-10-b7hi9';
const TOKEN_KEY = `rps10_token:${HOST}/${DB_NAME}`;
// false: guest-only, no sign-in anywhere. true: brings back accounts (Google sign-in / usernames).
// Keep it in step with requireAccount in spacetimedb/src/config.ts.
const ACCOUNTS: boolean = true;
// true: Play Online needs a signed-in account. false: guests can play online too; signing in just keeps
// progress across devices and gives a chosen name. Keep it in step with requireAccount in spacetimedb/src/config.ts.
const ONLINE_NEEDS_ACCOUNT: boolean = false;
const GOOGLE_KEY = 'rps10_google'; // remembers that this device was signed in with Google

const COLORS: Record<string, string[]> = {
  rock: ['#ffb25b', '#f0602a', '#ffe0b0'],
  paper: ['#6fe0ff', '#2a83f0', '#d8f6ff'],
  scissors: ['#ff7ac0', '#c62a8c', '#ffd6ec'],
};
const beats = (a: string, b: string) => (KINDS.indexOf(a as any) - KINDS.indexOf(b as any) + 3) % 3 === 1;

const $ = (id: string) => document.getElementById(id) as any;
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

// fill every data-icon placeholder with its artwork
const STATIC_ICONS: Record<string, string> = { ...ICON, trophy: TROPHY };
document.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => { el.innerHTML = STATIC_ICONS[el.dataset.icon!] || ''; });

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
let selInFlight = 0;       // selectCard calls the server hasn't confirmed yet
let lockPending = '';      // "gameId:round" while our lockIn is on its way to the server
let D: any = null;         // drag state
let phaseKey = '', localDeadline = 0;
let notice = '';           // a one-off message for the home screen
let unlockedBefore = true;
let clashDone = '';        // "gameId:round" whose clash effect has played
let clashTimer: any = 0;
let endShown = '';         // gameId whose end screen effects have played
let lastSec = -1;
let raf = 0;
let fromWait = false;

// ---------- screens ----------
function show(id: string) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id));
  document.body.dataset.screen = id;
}
const showing = (id: string) => $(id).classList.contains('on');
function net(msg: string | null) { $('net').textContent = msg || ''; $('net').classList.toggle('on', !!msg); }

let toastTimer: any = 0;
function toast(msg: string, kind = '') {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast on ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3200);
}

// ---------- sound toggle ----------
function renderSound() {
  document.querySelectorAll<HTMLElement>('.sndBtn').forEach(b => {
    b.innerHTML = isMuted() ? SPEAKER_OFF : SPEAKER_ON;
    b.classList.toggle('off', isMuted());
    b.setAttribute('aria-pressed', String(!isMuted()));
  });
}
document.querySelectorAll<HTMLElement>('.sndBtn').forEach(b => b.addEventListener('click', () => {
  setMuted(!isMuted()); renderSound(); sfx.tap();
}));
renderSound();
addEventListener('pointerdown', unlock, { capture: true });
addEventListener('keydown', unlock, { capture: true });
// a soft click on every button
document.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button'); if (b && !b.disabled && !b.matches('.sndBtn, .card, #readyBtn, .emo')) sfx.tap(); });

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
  else if (!$('friendsModal').classList.contains('hide')) $('friendsErr').textContent = msg;
  else if (!$('lookModal').classList.contains('hide')) $('lookErr').textContent = msg;
  else if (showing('scrLobby')) $('lobbyErr').textContent = msg;
  else toast(msg, 'bad'); // the error spot isn't on screen: show it anyway
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
  achSeen = null;
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
        .subscribe([tables.myPlayer, tables.myGame, tables.myHand, tables.myLog, tables.myTransfer, tables.leaderboard, tables.myChat,
          tables.myStats, tables.myHistory, tables.myAchievements, tables.seasonInfo, tables.dailyStats,
          tables.myFriends, tables.myInvites, tables.watchGame, tables.watchLog]);
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
  for (const t of [conn.db.myPlayer, conn.db.myGame, conn.db.myHand, conn.db.myLog, conn.db.myTransfer, conn.db.leaderboard, conn.db.myChat,
    conn.db.myStats, conn.db.myHistory, conn.db.myAchievements, conn.db.seasonInfo, conn.db.dailyStats,
    conn.db.myFriends, conn.db.myInvites, conn.db.watchGame, conn.db.watchLog] as any[]) {
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
  if (pendingRoom) {
    // opened from an invite link: straight into the friend's room
    const code = pendingRoom; pendingRoom = null;
    $('loadMsg').textContent = `Joining room ${code}…`;
    const err = await joinFromLink(code);
    if (err) notice = err;
  }
  sync();
}

// ---------- invite links: ?room=CODE drops a friend straight into the room ----------
const ROOM_RE = /^[A-Z0-9]{5}$/;
let pendingRoom: string | null = (() => {
  const params = new URLSearchParams(location.search);
  const code = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (params.has('room')) {
    params.delete('room'); // so a refresh doesn't try to join again
    const q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }
  return ROOM_RE.test(code) ? code : null;
})();
const siteUrl = () => location.origin + location.pathname;
const roomLink = (code: string) => `${siteUrl()}?room=${code}`;
/** Joins a room from an invite link. Returns a message to show if it didn't work. */
async function joinFromLink(code: string): Promise<string | null> {
  try { await (conn.reducers as any).joinRoom({ code }); return null; }
  catch (e: any) {
    const m = String((e && e.message) || e || '');
    if (/own room/i.test(m)) return null; // the host opened their own link
    if (/not found|not available/i.test(m)) return `Room ${code} has closed. Ask your friend for a new invite.`;
    if (/already in a game/i.test(m)) return 'Finish your current match before joining a friend.';
    return m.replace(/^.*?Error:\s*/, '') || 'Could not join that room.';
  }
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
  const lockKey = `${gv.gameId}:${gv.round}`;
  if (gv.phase !== 'pick' || gv.youLocked) lockPending = ''; // the server has caught up
  return {
    gameId: String(gv.gameId), mode: gv.mode, phase: gv.phase, deadline: localDeadline, round: gv.round,
    totalRounds: gv.totalRounds, pickMs: gv.pickMs, phaseMs: gv.phaseMs, rated: gv.rated, ratingChange: gv.ratingChange,
    you: { name: gv.youName, score: gv.youScore, hand, sel: gv.youSel === 0n ? null : String(gv.youSel), ready: gv.youReady,
      locked: gv.youLocked || (gv.phase === 'pick' && lockPending === lockKey) },
    watchers: gv.watchers,
    opp: { name: gv.oppName, isBot: gv.oppIsBot, rating: gv.oppRating, avatar: gv.oppAvatar, frame: gv.oppFrame, skin: gv.oppSkin, friend: gv.oppFriend, score: gv.oppScore, handCount: gv.oppHandCount, ready: gv.oppReady, placed: gv.oppPlaced, connected: gv.oppConnected },
    reveal: gv.revealShown ? { n: gv.round, you: kindName(gv.revealYou), opp: kindName(gv.revealOpp), result: gv.revealResult || null } : null,
    log,
    ended: gv.over ? { result: gv.endResult, reason: gv.endReason } : null,
    rematch: { you: gv.youRematch, opp: gv.oppRematch, oppLeft: gv.oppLeft },
  };
}

let skippingTutorial = false;
function sync() {
  if (!ready) return;
  const meRow = first(conn.db.myPlayer.iter());
  if (!meRow) return;
  me = meRow;
  checkAchievements();
  renderMe();
  renderBoard();
  renderInvites();

  const gv = first(conn.db.myGame.iter());
  if (gv && String(gv.gameId) !== dismissed) {
    overlay = null;
    onState(buildState(gv));
    return;
  }
  if (G) leaveGameScreen();
  if (me.watching) { renderWatch(); return; }
  if (showing('scrWatch')) toLobby();

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
  if (me.waiting === 'queue') waitScreen('Finding opponent', '', 'Matching you with a player near your rating');
  else if (me.waiting === 'room') waitScreen('Waiting for friend', me.roomCode, 'Send this code to your friend');
  else if (!showing('scrLobby')) toLobby();
}

function leaveGameScreen() {
  showLog(false); showChat(false);
  G = null; localHand = null; prevPhase = null; lockPending = ''; selInFlight = 0;
  clearTimeout(clashTimer);
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
}

// ---------- account ----------
const suggestName = (n: string) => n.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
function closeModals() { for (const id of ['acctModal', 'friendModal', 'confirmLeave', 'statsModal', 'lookModal', 'friendsModal', 'reportModal']) $(id).classList.add('hide'); }

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
    else if (code.includes('unauthorized-domain')) homeMsg(`Sign-in isn't allowed on ${location.hostname} yet. Add it under Firebase → Authentication → Settings → Authorized domains.`);
    else if (code.includes('configuration-not-found')) homeMsg('Sign-in isn\'t set up in Firebase yet. Open Authentication there and click Get started.');
    else if (code.includes('operation-not-allowed')) homeMsg('Google sign-in is switched off in Firebase. Turn it on under Authentication → Sign-in method → Google.');
    else if (!code.includes('popup-closed') && !code.includes('cancelled')) homeMsg(`Google sign-in failed (${code || 'unknown error'}). Try again.`);
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

/** A stable colour for a player's initial, so each name keeps its look. */
function hue(name: string) { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
function avatar(el: any, name?: string, photo = true) {
  const n = name ?? (me ? me.name : '?');
  el.innerHTML = '';
  el.style.setProperty('--h', String(hue(n)));
  el.className = el.className.replace(/\s*\b(fr-\S+|hasEmo)\b/g, '');
  const own = name === undefined && me;
  if (own && me.frame) el.classList.add('fr-' + me.frame);
  if (own && me.avatar) { el.classList.add('hasEmo'); el.innerHTML = `<span class="emo">${me.avatar}</span>`; return; }
  if (photo && !name && google && google.photo) {
    const img = document.createElement('img');
    img.src = google.photo; img.alt = ''; img.referrerPolicy = 'no-referrer';
    img.onerror = () => { el.textContent = initialOf(n); };
    el.appendChild(img);
  } else el.textContent = initialOf(n);
}
const initialOf = (n: string) => (n ? n[0]!.toUpperCase() : '?');
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
  $('banner').classList.remove('on'); $('over').classList.add('hide'); $('confirmLeave').classList.add('hide');
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
  $('meRating').textContent = ONLINE_NEEDS_ACCOUNT && me.isGuest ? '—' : me.rating;
  $('btnProfile').classList.toggle('hide', !ACCOUNTS);
  $('stPlayed').textContent = played;
  $('stWins').textContent = me.wins;
  $('stRate').textContent = played ? Math.round((me.wins / played) * 100) + '%' : '—';
  // sign-in card: shown to guests
  $('guestCard').classList.toggle('hide', !ACCOUNTS || !me.isGuest);
  $('guestText').textContent = google ? 'Pick a username to finish your account.'
    : googleOn ? (ONLINE_NEEDS_ACCOUNT ? 'Sign in to keep your progress on every device and play ranked.' : 'Sign in to keep your progress on every device and pick your own name.')
    : 'Create an account to pick your own name. Your stats carry over.';
  $('btnGoogle').textContent = google ? 'Choose a username' : googleOn ? 'Continue with Google' : 'Create account';
  const locked = !me.practiceDone;
  $('btnQuick').classList.toggle('locked', locked);
  $('quickIc').innerHTML = locked ? LOCK : ICON.scissors;
  $('quickSub').textContent = locked ? 'Finish one practice match to unlock' : ONLINE_NEEDS_ACCOUNT && me.isGuest ? 'Ranked · needs an account' : 'Ranked · find an opponent';
  renderTier();
  renderDaily();
  $('achCount').textContent = `${conn.db.myAchievements.count()}/${ACHIEVEMENTS.length} 🏅`;
  if (notice) { homeMsg(notice); notice = ''; }
  if (!$('acctModal').classList.contains('hide')) renderAccount();
  if (!$('statsModal').classList.contains('hide')) renderStats();
  if (!$('lookModal').classList.contains('hide')) renderLook();
}
function renderBoard() {
  const top = Array.from(conn.db.leaderboard.iter()).sort((a, b) => b.rating - a.rating);
  $('board').innerHTML = top.length ? top.map((u, i) =>
    `<div class="lb${me && u.identity.isEqual(me.identity) ? ' mine' : ''}${i < 3 ? ' top t' + (i + 1) : ''}"><span class="rk">${i + 1}</span>${tierBadge(tierOf(u.rating), 'sm')}<span class="lbn">${esc(u.name)}</span><b>${u.rating}</b></div>`).join('')
    : '<div class="empty">No ranked games this season yet. Be the first on the board!</div>';
  const season = first(conn.db.seasonInfo.iter());
  $('seasonLbl').textContent = season ? `${seasonName(season.key)} season · ends in ${shortTime(msToSeasonEnd())}` : 'Top 10';
  const champ = season && season.champ;
  $('champ').classList.toggle('hide', !champ);
  if (champ) $('champ').innerHTML = `👑 Last season's champion: <b>${esc(season!.champ)}</b> <span>${season!.champRating}</span>`;
}

// ---------- rank tier, daily challenge, stats and achievements ----------
const myStats = (): any => first(conn.db.myStats.iter());
function renderTier() {
  const t = tierOf(me.rating), n = nextTier(me.rating);
  $('tierBadge').innerHTML = tierBadge(t);
  $('tierName').innerHTML = `${t.name}<small>rank</small>`;
  $('tierRow').style.setProperty('--tc', t.c1);
  const lo = Number.isFinite(t.min) ? t.min : 1000;
  const frac = n ? Math.max(0.04, Math.min(1, (me.rating - Math.min(lo, me.rating)) / (n.min - Math.min(lo, me.rating)))) : 1;
  $('tierFill').style.width = `${Math.round(frac * 100)}%`;
  const last = myStats()?.lastSeason;
  $('tierNext').textContent = (n ? `${n.min - me.rating} rating to ${n.name}` : 'Top rank. Stay there!')
    + (last ? ` · last season ${tierOf(last).name} (${last})` : '');
}
function dailyState() {
  const s = myStats(), day = today();
  const played = !!s && s.dailyLast === day;
  const streak = s && s.dailyLast >= day - 1 ? s.dailyStreak : 0;
  return { s, played, streak, done: played && !!s.dailyResult };
}
function renderDaily() {
  const { s, played, streak, done } = dailyState();
  const btn = $('btnDaily');
  btn.classList.toggle('done', played);
  btn.classList.toggle('hot', !played && streak > 0);
  $('dailyN').textContent = streak;
  $('dailyStreak').classList.toggle('zero', streak === 0);
  const res = done ? (s.dailyResult === 'win' ? `Won ${s.dailyYou}–${s.dailyThem}` : s.dailyResult === 'loss' ? `Lost ${s.dailyYou}–${s.dailyThem}` : `Drew ${s.dailyYou}–${s.dailyThem}`) : '';
  $('dailySub').textContent = played ? `${res || 'Played'} today · next in ${shortTime(msToNextDay())}`
    : streak > 0 ? `Keep your ${streak}-day streak going!` : 'Same hands for everyone today. One try.';
  const d = Array.from(conn.db.dailyStats.iter()).find(x => x.day === today());
  $('dailyMeta').textContent = d && d.plays ? `${d.plays} played today · ${d.wins} won` : '';
}
setInterval(() => { if (me && showing('scrLobby')) { renderDaily(); renderBoard(); } }, 30000);
$('btnDaily').onclick = () => {
  $('lobbyErr').textContent = '';
  if (dailyState().played) { homeMsg(`You've played today's challenge. The next one is in ${shortTime(msToNextDay())}.`); return; }
  dismissed = null;
  call('startDaily');
};

/** New achievements since this connection loaded: announced with a toast and on the end screen. */
let achSeen: Set<string> | null = null, achNew: string[] = [];
function checkAchievements() {
  const keys = Array.from(conn.db.myAchievements.iter(), a => a.key);
  if (!achSeen) { achSeen = new Set(keys); return; }
  for (const k of keys) {
    if (achSeen.has(k)) continue;
    achSeen.add(k); achNew.push(k);
    const a = achievementOf(k);
    if (a) setTimeout(() => toast(`${a.icon} Achievement unlocked: ${a.name}`, 'ach'), 900);
  }
}

const pct = (w: number, n: number) => (n ? Math.round((w / n) * 100) + '%' : '—');
function renderStats() {
  const s = myStats() || {};
  const played = me.wins + me.losses + me.draws;
  const plays = [s.plays0 || 0, s.plays1 || 0, s.plays2 || 0], wins = [s.wins0 || 0, s.wins1 || 0, s.wins2 || 0];
  const opens = [s.opens0 || 0, s.opens1 || 0, s.opens2 || 0];
  const fav = Math.max(...opens) > 0 ? KINDS[opens.indexOf(Math.max(...opens))] : null;
  const cell = (v: any, l: string) => `<div><b>${v}</b><small>${l}</small></div>`;
  $('stGrid').innerHTML = [
    cell(played, 'Matches'), cell(pct(me.wins, played), 'Win rate'), cell(s.streak || 0, 'Win streak'),
    cell(s.bestStreak || 0, 'Best streak'), cell(s.perfects || 0, 'Perfect 10s'), cell(s.dailyBest || 0, 'Best daily streak'),
  ].join('');
  $('cardRates').innerHTML = KINDS.map((k, i) => {
    const r = plays[i] ? wins[i]! / plays[i]! : 0;
    return `<div class="cr k-${k}"><span class="crIc">${ICON[k]}</span><div class="crBar"><i style="width:${Math.round(r * 100)}%"></i></div>`
      + `<b>${pct(wins[i]!, plays[i]!)}</b><small>${plays[i]} played</small></div>`;
  }).join('') + (fav ? `<div class="crFav">Favourite opening card: ${mini(fav)} <b>${fav}</b></div>` : '');
  const got = new Map(Array.from(conn.db.myAchievements.iter(), a => [a.key, a.at] as const));
  $('achSub').textContent = `${got.size} of ${ACHIEVEMENTS.length}`;
  $('achGrid').innerHTML = ACHIEVEMENTS.map(a => {
    const on = got.has(a.key);
    return `<div class="ach${on ? ' on' : ''}" title="${esc(a.how)}"><span class="achIc">${on ? a.icon : '🔒'}</span><b>${esc(a.name)}</b><small>${esc(a.how)}</small></div>`;
  }).join('');
  const hist = Array.from(conn.db.myHistory.iter()).sort((a, b) => (a.id < b.id ? 1 : -1));
  const MODE: Record<string, string> = { ranked: 'Ranked', room: 'Friend', bot: 'Online · bot', practice: 'Practice', daily: 'Daily' };
  $('histList').innerHTML = hist.length ? hist.map(h => {
    const dots = [...h.outcomes].map((o, i) => `<i class="o${o}" title="Round ${i + 1}: ${h.cards[i] === '-' ? 'too slow' : KINDS['rps'.indexOf(h.cards[i]!)]}"></i>`).join('');
    const rc = h.ratingChange ? `<span class="${h.ratingChange > 0 ? 'up' : 'down'}">${h.ratingChange > 0 ? '+' : ''}${h.ratingChange}</span>` : '';
    return `<div class="hr ${h.result}"><span class="hrRes">${h.result === 'win' ? 'W' : h.result === 'loss' ? 'L' : 'D'}</span>`
      + `<div class="hrMid"><div class="hrTop"><b>${esc(h.opp)}</b><span class="hrMode">${MODE[h.mode] || h.mode}</span></div><div class="hrDots">${dots}</div></div>`
      + `<div class="hrScore"><b>${h.you}–${h.them}</b>${rc}<small>${ago(h.at.toDate().getTime())}</small></div></div>`;
  }).join('') : '<div class="empty">Your matches will show up here</div>';
}
function ago(t: number) {
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
$('btnStats').onclick = () => { renderStats(); $('statsModal').classList.remove('hide'); $('statsModal').scrollTop = 0; };
$('statsClose').onclick = () => $('statsModal').classList.add('hide');
// sheets close with their ✕, their Close/Done button, or a tap on the dimmed area around them
for (const [id, btn] of [['statsModal', 'statsDone'], ['lookModal', 'lookDone'], ['friendsModal', 'friendsDone'], ['reportModal', '']] as const) {
  $(id).addEventListener('click', (e: Event) => { if (e.target === $(id)) $(id).classList.add('hide'); });
  if (btn) $(btn).onclick = () => $(id).classList.add('hide');
}

let waitStart = 0, waitTick: any = 0, waitKey = '';
function waitScreen(title: string, code: string, sub: string) {
  const key = title + code;
  if (key !== waitKey || !showing('scrWait')) { waitKey = key; waitStart = Date.now(); }
  $('waitTitle').textContent = title;
  $('waitCode').innerHTML = code ? [...code].map(c => `<span>${esc(c)}</span>`).join('') : '';
  $('waitCode').dataset.code = code;
  $('waitSub').textContent = sub;
  $('btnCancelWait').onclick = () => call(code ? 'closeRoom' : 'leaveQueue');
  $('btnShareCode').classList.toggle('hide', !code);
  $('linkRow').classList.toggle('hide', !code);
  if (code) $('waitLink').textContent = roomLink(code).replace(/^https?:\/\//, '');
  if (!showing('scrWait')) show('scrWait');
  fromWait = true;
  clearInterval(waitTick);
  const upd = () => {
    if (!showing('scrWait')) { clearInterval(waitTick); return; }
    const s = Math.floor((Date.now() - waitStart) / 1000);
    $('waitTime').textContent = code ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  upd(); waitTick = setInterval(upd, 500);
}

$('btnQuick').onclick = () => {
  $('lobbyErr').textContent = '';
  if (!me.practiceDone) { $('lobbyErr').textContent = 'Finish one practice match first'; return; }
  if (ONLINE_NEEDS_ACCOUNT && me.isGuest) { pendingQueue = true; return startAccount(); }
  call('joinQueue');
};
$('btnFriend').onclick = () => {
  $('lobbyErr').textContent = ''; $('friendErr').textContent = ''; $('friendModal').classList.remove('hide');
  setTimeout(() => $('joinCode').focus(), 50);
};
$('friendClose').onclick = () => $('friendModal').classList.add('hide');

// ---------- sharing ----------
async function share(text: string, button: any, url = siteUrl()) {
  try {
    if (navigator.share) { await navigator.share({ title: 'RPS 10', text, url }); return; }
    await navigator.clipboard.writeText(`${text} ${url}`);
    const old = button.textContent; button.textContent = 'Copied!'; setTimeout(() => { button.textContent = old; }, 1500);
  } catch (e: any) {
    // the player closed the share sheet, or the clipboard isn't available: show the text instead
    if (!e || e.name !== 'AbortError') toast(`${text} ${url}`);
  }
}
$('btnInvite').onclick = () => share('Play me at RPS 10: rock paper scissors with a 10-card hand.', $('btnInvite'));
$('btnShareCode').onclick = () => {
  const code = $('waitCode').dataset.code;
  share(`Play me at RPS 10 ✂️ Tap to join my room (code ${code}):`, $('btnShareCode'), roomLink(code));
};
$('btnCopyLink').onclick = async () => {
  const link = roomLink($('waitCode').dataset.code);
  try { await navigator.clipboard.writeText(link); $('btnCopyLink').textContent = 'Copied!'; setTimeout(() => { $('btnCopyLink').textContent = 'Copy'; }, 1500); }
  catch { toast(link); }
};
$('btnPractice').onclick = () => { $('lobbyErr').textContent = ''; dismissed = null; call('startPractice'); };
$('btnCreate').onclick = () => { $('friendModal').classList.add('hide'); call('createRoom'); };
$('joinCode').addEventListener('input', () => { const el = $('joinCode'); el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('joinForm').onsubmit = async (e: Event) => {
  e.preventDefault();
  $('friendErr').textContent = '';
  if (!$('joinCode').value.trim()) { $('friendErr').textContent = 'Enter the 5-letter room code'; return; }
  if (await call('joinRoom', { code: $('joinCode').value })) { $('friendModal').classList.add('hide'); $('joinCode').value = ''; }
};
$('btnHow').onclick = () => openTutorial(false);

// ---------- tutorial ----------
const tc = (t: string, cls = '') => `<div class="tc ${cls}">${face(t)}</div>`;
const TUT = [
  { title: '10 cards each',
    text: 'You get 3 of two kinds and 4 of the third. Your opponent can\'t see which one you have 4 of.',
    art: () => `<div class="tutRow">${tc('rock').repeat(3)}${tc('paper').repeat(3)}</div><div class="tutRow">${tc('scissors', 'hi').repeat(4)}</div>` },
  { title: 'One card per round',
    text: 'Tap a card, then press Lock In. You have 10 seconds. If you haven\'t locked in by then, you lose the round.',
    art: () => tc('paper', 'big hi') + '<span class="num">10<small>sec</small></span>' + `<div class="tc big back">${BACK}</div>` },
  { title: 'Win the round, score a point',
    text: 'A draw scores nothing. Played cards are gone for good, so keep track of what your opponent has left.',
    art: () => tc('rock', 'big win') + '<span class="txt">beats</span>' + tc('scissors', 'big lose') },
  { title: '10 rounds, most wins',
    text: 'Every match lasts 10 rounds, one for each card. Whoever wins more rounds takes the match. Level scores are a draw.',
    art: () => `<div class="tutTrophy">${TROPHY}</div><span class="num">10<small>rounds</small></span>` },
];
let tutStep = 0, tutFirst = false;
function openTutorial(firstTime: boolean) { tutFirst = firstTime; if (!firstTime) overlay = 'tut'; tutStep = 0; renderTut(); show('scrTut'); }
function renderTut() {
  const t = TUT[tutStep]!, last = tutStep === TUT.length - 1;
  $('tutStepLbl').textContent = `How to play · ${tutStep + 1} / ${TUT.length}`;
  $('tutArt').innerHTML = t.art();
  $('tutArt').classList.remove('in'); void $('tutArt').offsetWidth; $('tutArt').classList.add('in');
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

function onState(s: any) {
  const firstOfGame = !G || G.gameId !== s.gameId;
  const isRematch = firstOfGame && !!G && !!G.ended; // straight from one end screen into the next match
  G = s;
  if (firstOfGame) {
    unlockedBefore = !!(me && me.practiceDone); prevPhase = null; prevRound = null; localHand = null; localSel = null;
    selInFlight = 0; lockPending = ''; clashDone = ''; handSig = ''; oppBacks = -1; lastSec = -1;
    achNew = [];
    $('over').classList.add('hide');
    if (fromWait || isRematch) sfx.match();
    if (isRematch) toast('Rematch! Get ready');
  }
  fromWait = false;
  if (!showing('scrGame')) show('scrGame');

  // hand: keep local order unless the server's card set changed
  const serverIds = s.you.hand.map((c: any) => c.id).slice().sort().join();
  const localIds = localHand ? localHand.map((c: any) => c.id).slice().sort().join() : '';
  if (!localHand || localIds !== serverIds) localHand = s.you.hand.slice();
  if (s.phase === 'pick') { if (s.you.sel !== null && selInFlight === 0) localSel = s.you.sel; } else localSel = null;

  const entering = s.phase !== prevPhase || s.round !== prevRound;
  renderGame(entering, firstOfGame);
  syncChat(firstOfGame);
  prevPhase = s.phase; prevRound = s.round;
  if (!raf) raf = requestAnimationFrame(frame);
}

function renderGame(entering: boolean, firstOfGame: boolean) {
  const s = G;
  $('nameOpp').innerHTML = (s.opp.isBot ? '' : tierBadge(tierOf(s.opp.rating), 'xs')) + (s.opp.avatar ? s.opp.avatar + ' ' : '') + esc(s.opp.name);
  $('nameYou').innerHTML = tierBadge(tierOf(me ? me.rating : 1000), 'xs') + (me && me.avatar ? me.avatar + ' ' : '') + esc(s.you.name);
  const mySkin = (me && me.skin) || 'classic';
  $('hand').dataset.skin = mySkin; $('slotYou').dataset.skin = mySkin; $('slotOpp').dataset.skin = s.opp.skin || 'classic';
  $('watchers').textContent = s.watchers ? `👀 ${s.watchers} watching` : '';
  $('watchers').classList.toggle('hide', !s.watchers);
  $('totalR').textContent = s.totalRounds;
  $('round').textContent = s.round;
  $('oppTag').textContent = s.mode === 'daily' ? 'Daily' : s.opp.isBot ? 'Bot' : 'Opp';
  $('sYou').textContent = s.you.score;
  $('sOpp').textContent = s.opp.score;
  renderRounds();
  // whoever is ahead gets a highlight
  $('sideYou').classList.toggle('lead', s.you.score > s.opp.score);
  $('sideOpp').classList.toggle('lead', s.opp.score > s.you.score);
  $('lblOpp').textContent = s.opp.name;

  // opponent's hand: card backs, minus the one they've put down
  const backs = Math.max(0, s.opp.handCount - (s.opp.placed ? 1 : 0));
  if (backs !== oppBacks) {
    oppBacks = backs;
    $('oppHand').innerHTML = Array.from({ length: backs }, (_, i) => {
      const mid = (backs - 1) / 2, d = i - mid;
      return `<span class="ob" style="--r:${(d * 4).toFixed(1)}deg;--y:${(Math.abs(d) * 1.6).toFixed(1)}px">${BACK}</span>`;
    }).join('');
  }
  renderTracker();

  const phase = s.phase;
  const prep = phase === 'prep';
  $('prep').classList.toggle('on', prep);
  document.body.dataset.phase = phase;

  // the one action button: always in place so the layout never jumps
  const btn = $('readyBtn');
  btn.className = 'btn action';
  if (prep) {
    $('chipYou').textContent = s.you.ready ? 'You ✓' : 'You'; $('chipYou').className = 'chip' + (s.you.ready ? ' ok' : '');
    $('chipOpp').textContent = s.opp.name + (s.opp.ready ? ' ✓' : ''); $('chipOpp').className = 'chip' + (s.opp.ready ? ' ok' : '');
    btn.disabled = s.you.ready;
    btn.classList.add('go');
    btn.textContent = s.you.ready ? (s.opp.ready ? 'Starting…' : 'Waiting for opponent…') : 'Ready';
  } else if (phase === 'pick') {
    btn.disabled = !localSel || s.you.locked;
    btn.classList.add(s.you.locked ? 'done' : 'lockIn');
    btn.innerHTML = s.you.locked ? (s.opp.placed ? 'Revealing…' : `${LOCK} Locked in · waiting for ${esc(s.opp.name)}`)
      : localSel ? `${LOCK} Lock In` : 'Pick a card';
  } else {
    btn.disabled = true;
    btn.textContent = phase === 'banner' ? 'Get ready…' : phase === 'reveal' ? 'Revealing…' : phase === 'result' ? 'Next round…' : 'Match over';
  }
  btn.classList.toggle('hide', phase === 'over');

  // round banner
  if (phase === 'banner' && entering) {
    $('bn0').textContent = s.round === 1 ? 'Match start' : s.round === s.totalRounds ? `Final round · ${s.you.score} – ${s.opp.score}` : `${s.you.score} – ${s.opp.score}`;
    $('bn1').textContent = `Round ${s.round}`;
    const bn = $('banner'); bn.classList.remove('on'); void bn.offsetWidth; bn.classList.add('on');
    sfx.banner();
  } else if (phase !== 'banner') $('banner').classList.remove('on');

  // the table
  if (entering) { $('arena').classList.remove('urgent'); lastSec = -1; }
  if (phase !== 'pick') { $('timer').textContent = 'VS'; $('timer').classList.remove('num'); setRing(1); }
  if (prep || phase === 'banner') {
    setSlot('slotYou', 'empty', '<span class="q">?</span>');
    setSlot('slotOpp', 'empty', '<span class="q">?</span>');
    $('lblYou').textContent = 'You';
  }
  if (phase === 'pick') {
    const sc = localHand.find((c: any) => c.id === localSel);
    setSlot('slotYou', sc ? (s.you.locked ? 'mine lockedIn' : 'mine') : 'empty', sc ? face(sc.t) : '<span class="q">Pick</span>');
    $('lblYou').textContent = s.you.locked ? 'Locked in' : sc ? 'Selected' : 'You';
    setSlot('slotOpp', s.opp.placed ? 'down' : 'empty thinking', s.opp.placed ? BACK : '<span class="dots3"><i></i><i></i><i></i></span>');
    $('lblOpp').textContent = s.opp.placed ? `${s.opp.name} · locked` : s.opp.name;
  }
  if ((phase === 'reveal' || phase === 'result') && s.reveal) {
    const r = s.reveal, k = `${s.gameId}:${r.n}`;
    // draw the revealed cards when the reveal starts, or when we join the game partway through it
    if (entering && (phase === 'reveal' || prevPhase !== 'reveal')) {
      const anim = phase === 'reveal';
      setSlot('slotYou', r.you ? 'face' + (anim ? ' slam' : '') : 'miss', r.you ? face(r.you) : '<span class="slow">Too<br>slow</span>');
      setSlot('slotOpp', r.opp ? 'face' + (anim ? ' flip' : '') : 'miss',
        r.opp ? (anim ? `<span class="fl"><span class="fr">${face(r.opp)}</span><span class="bk">${BACK}</span></span>` : face(r.opp)) : '<span class="slow">Too<br>slow</span>');
      $('lblYou').textContent = 'You';
      if (anim) { sfx.flip(); clearTimeout(clashTimer); clashTimer = setTimeout(() => clash(r, k), 650); }
    }
    if (phase === 'result') {
      if (clashDone !== k) clash(r, k);
      if (entering) {
        const res = r.result;
        showRibbon(!r.you && r.opp ? 'Too slow' : res === 'win' ? 'Round won' : res === 'loss' ? 'Round lost' : 'Draw', res);
        if (res === 'win') bump('sYou'); if (res === 'loss') bump('sOpp');
      }
    }
  }
  if (phase !== 'result') $('ribbon').classList.remove('on');

  // messages
  $('msg').textContent = !s.opp.connected && !s.opp.isBot && phase !== 'over' ? 'Opponent disconnected — waiting for them to return…' : '';

  renderHand(firstOfGame && prep);
  renderLog();

  if (phase === 'over' && s.ended) showEnd();
}

/** The moment the two cards meet: winner glows, loser shakes, sparks fly. */
function clash(r: any, k: string) {
  if (clashDone === k || !G) return;
  clashDone = k;
  const res = r.you && r.opp ? (beats(r.you, r.opp) ? 'win' : beats(r.opp, r.you) ? 'loss' : 'draw')
    : r.you ? 'win' : r.opp ? 'loss' : 'draw';
  const you = $('slotYou'), opp = $('slotOpp');
  you.classList.add('clashY'); opp.classList.add('clashO');
  if (r.you) you.classList.add(res === 'win' ? 'win' : res === 'loss' ? 'lose' : 'tie');
  if (r.opp) opp.classList.add(res === 'loss' ? 'win' : res === 'win' ? 'lose' : 'tie');
  const arena = $('arena');
  arena.classList.remove('shake'); void arena.offsetWidth; arena.classList.add('shake');
  sfx.clash();
  setTimeout(() => {
    if (res === 'win') { sfx.roundWin(); burstAt(you, COLORS[r.you]!, 34); vibrate(30); }
    else if (res === 'loss') { sfx.roundLose(); if (r.opp) burstAt(opp, COLORS[r.opp]!, 34); vibrate([20, 40, 20]); }
    else { sfx.roundDraw(); burstAt(arena.querySelector('.center-ring'), ['#ffc83d', '#ffffff'], 18); }
  }, 120);
}

function showRibbon(text: string, cls: string) {
  const rb = $('ribbon');
  $('ribbonTx').textContent = text;
  rb.className = 'ribbon ' + (cls || 'draw');
  void rb.offsetWidth; rb.classList.add('on');
}

/** One slot per round: green you won it, red they did, gold a draw, outlined the one being played. */
function renderRounds() {
  const s = G, el = $('roundStrip');
  const byRound: Record<number, string> = {};
  for (const l of s.log) byRound[l.n] = l.result;
  const html = Array.from({ length: s.totalRounds }, (_, i) => {
    const n = i + 1, r = byRound[n];
    const cls = r === 'win' ? 'w' : r === 'loss' ? 'l' : r === 'draw' ? 'd' : n === s.round && s.phase !== 'over' ? 'now' : '';
    return `<i class="${cls}"><b>${n}</b></i>`;
  }).join('');
  if (el.dataset.h === html) return;
  const before = el.dataset.h ? el.querySelectorAll('i.w,i.l,i.d').length : -1;
  el.innerHTML = html; el.dataset.h = html;
  const done = el.querySelectorAll('i.w,i.l,i.d');
  if (before !== -1 && done.length > before) done[done.length - 1].classList.add('pop'); // the round that just finished
}
function bump(id: string) { const e = $(id); e.classList.remove('bump'); void e.offsetWidth; e.classList.add('bump'); }
function setSlot(id: string, cls: string, content: string) {
  const el = $(id);
  el.className = 'slot' + (cls ? ' ' + cls : '');
  if (el.dataset.c !== content) { el.innerHTML = content; el.dataset.c = content; }
}
function setRing(frac: number) {
  const C = 2 * Math.PI * 44;
  const p = $('ringProg');
  p.style.strokeDasharray = String(C);
  p.style.strokeDashoffset = String(C * (1 - Math.max(0, Math.min(1, frac))));
}

/** What the opponent can still be holding, worked out from the cards they've played. */
function renderTracker() {
  const played = [0, 0, 0];
  for (const l of G.log) if (l.opp) played[KINDS.indexOf(l.opp)]! += 1;
  const fours = [0, 1, 2].filter(f => played.every((p, x) => p <= (x === f ? 4 : 3)));
  const html = KINDS.map((kind, k) => {
    const left = fours.map(f => (k === f ? 4 : 3) - played[k]!);
    const lo = Math.max(0, Math.min(...left)), hi = Math.max(0, Math.max(...left));
    const txt = !fours.length ? '?' : lo === hi ? String(lo) : `${lo}–${hi}`;
    return `<span class="tk${hi === 0 ? ' out' : ''}">${mini(kind)}<b>${txt}</b></span>`;
  }).join('');
  if ($('tracker').dataset.h !== html) { $('tracker').innerHTML = `<span class="tkl">Opp has</span>${html}`; $('tracker').dataset.h = html; }
}

function frame() {
  raf = requestAnimationFrame(frame);
  if (!G) return;
  const ms = remaining();
  if (G.phase === 'pick') {
    const sec = Math.ceil(ms / 1000);
    const tm = $('timer');
    if (sec !== lastSec) {
      tm.textContent = sec; tm.classList.add('num');
      if (lastSec !== -1 && sec > 0 && !G.you.locked) { if (sec <= 3) { sfx.tickUrgent(); vibrate(15); } else if (sec <= 5) sfx.tick(); }
      lastSec = sec;
      $('arena').classList.toggle('urgent', sec <= 3 && !G.you.locked);
    }
    setRing(ms / G.pickMs);
  } else if (G.phase === 'prep') {
    const t = String(Math.ceil(ms / 1000));
    if ($('prepT').textContent !== t) $('prepT').textContent = t;
  }
}

function showEnd() {
  const e = G.ended;
  const res = e.result;
  const modal = $('endModal');
  modal.className = 'modal endModal ' + res;
  $('endBadge').innerHTML = res === 'win' ? TROPHY : res === 'loss' ? SKULL : SHAKE;
  $('endTitle').textContent = res === 'win' ? 'Victory!' : res === 'loss' ? 'Defeat' : 'Draw';
  $('endYou').textContent = G.you.score; $('endOpp').textContent = G.opp.score;
  $('endNameYou').textContent = G.you.name; $('endNameOpp').textContent = G.opp.name;
  const chips: string[] = [];
  if (e.reason === 'disconnect') chips.push(e.result === 'win' ? 'Opponent left' : 'You disconnected');
  if (e.reason === 'forfeit') chips.push(e.result === 'win' ? 'Opponent left' : 'You left');
  if (G.rated) chips.push(`<span class="${G.ratingChange >= 0 ? 'up' : 'down'}">Rating ${G.ratingChange >= 0 ? '+' : ''}${G.ratingChange}</span>`);
  if (me && !unlockedBefore && me.practiceDone && G.opp.isBot && e.reason === 'points') chips.push('<span class="up">Online play unlocked</span>');
  if (G.mode === 'daily') { const st = dailyState(); if (st.streak) chips.push(`🔥 ${st.streak}-day streak`); }
  for (const k of achNew) { const a = achievementOf(k); if (a) chips.push(`<span class="up">${a.icon} ${esc(a.name)}</span>`); }
  $('endChips').innerHTML = chips.map(c => `<span class="ec">${c}</span>`).join('');
  renderRematch();
  $('banner').classList.remove('on');
  $('confirmLeave').classList.add('hide');
  $('over').classList.remove('hide');
  if (endShown !== G.gameId) {
    endShown = G.gameId;
    showLog(false);
    if (res === 'win') { sfx.victory(); confetti(); vibrate([30, 60, 30, 60, 80]); }
    else if (res === 'loss') { sfx.defeat(); vibrate(120); }
    else sfx.roundDraw();
  }
}
// ---------- share the result as an image ----------
let shareFile: File | null = null, shareUrl = '';
$('btnShareResult').onclick = async () => {
  if (!G || !G.ended) return;
  shareFile = null;
  if (shareUrl) { URL.revokeObjectURL(shareUrl); shareUrl = ''; }
  $('shareImg').removeAttribute('src');
  $('shareLoading').classList.remove('hide');
  $('shareGo').disabled = true; $('shareSave').disabled = true;
  $('shareModal').classList.remove('hide');
  try {
    const blob = await drawResultCard({
      result: G.ended.result, you: G.you.name, opp: G.opp.name, youScore: G.you.score, oppScore: G.opp.score,
      rounds: G.log.map((l: any) => ({ you: l.you, result: l.result })),
      rated: G.rated, ratingChange: G.ratingChange, link: siteUrl().replace(/^https?:\/\//, '').replace(/\/$/, ''),
    });
    shareFile = new File([blob], 'rps10-result.png', { type: 'image/png' });
    shareUrl = URL.createObjectURL(blob);
    $('shareImg').src = shareUrl;
    $('shareLoading').classList.add('hide');
    $('shareGo').disabled = false; $('shareSave').disabled = false;
    // sharing an image needs a phone-style share sheet; elsewhere "Save image" does the job
    const canFiles = !!(navigator.canShare && navigator.canShare({ files: [shareFile] }));
    $('shareGo').classList.toggle('hide', !canFiles);
  } catch {
    $('shareLoading').textContent = "Couldn't make the image. Try again.";
  }
};
$('shareGo').onclick = async () => {
  if (!shareFile || !G) return;
  const text = G.ended && G.ended.result === 'win' ? `I just won ${G.you.score}–${G.opp.score} at RPS 10 🪨📄✂️ Think you can beat me?` : `${G.you.score}–${G.opp.score} at RPS 10 🪨📄✂️ Can you do better?`;
  try { await navigator.share({ files: [shareFile], text: `${text} ${siteUrl()}` }); }
  catch (e: any) { if (!e || e.name !== 'AbortError') toast("Couldn't open sharing. Use Save image instead."); }
};
$('shareSave').onclick = () => {
  if (!shareUrl) return;
  const a = document.createElement('a');
  a.href = shareUrl; a.download = 'rps10-result.png';
  document.body.appendChild(a); a.click(); a.remove();
};
$('shareClose').onclick = () => $('shareModal').classList.add('hide');

$('btnBack').onclick = () => { if (G) dismissed = G.gameId; call('leaveGame'); toLobby(); };

/** The rematch button: against a person it needs both players to ask; against a bot it starts at once. */
let rmAskedSeen = '';
function renderRematch() {
  const rm = G.rematch, opp = esc(G.opp.name);
  const btn = $('btnRematch'), note = $('rmNote');
  let label = 'Rematch', disabled = false, msg = '', hot = false;
  if (G.opp.isBot) label = `Rematch ${opp}`;
  else if (rm.oppLeft) { disabled = true; msg = `${opp} has left the match`; }
  else if (rm.you) { disabled = true; label = `Waiting for ${opp}…`; msg = `Rematch requested — ${opp} needs to accept`; }
  else if (rm.opp) {
    label = 'Accept rematch'; hot = true; msg = `${opp} wants a rematch!`;
    if (rmAskedSeen !== G.gameId) { rmAskedSeen = G.gameId; sfx.ready(); vibrate([20, 40, 20]); }
  }
  btn.innerHTML = label; btn.disabled = disabled;
  btn.classList.toggle('hot', hot);
  note.textContent = msg; note.className = 'rmNote' + (hot ? ' hot' : rm.oppLeft ? ' gone' : '');
  // a new opponent only makes sense for online play; practice and friend rooms just rematch or go back
  $('btnAgain').classList.toggle('hide', !(G.mode === 'ranked' || G.mode === 'bot'));
  btn.classList.toggle('hide', G.mode === 'daily'); // one try a day
  renderFriendBtn();
  if (G.mode === 'daily') { note.textContent = `Next challenge in ${shortTime(msToNextDay())}`; note.className = 'rmNote'; }
}
$('btnRematch').onclick = () => {
  if (!G || !G.ended) return;
  if (!G.opp.isBot) { G.rematch.you = true; renderRematch(); } // show it at once; the server confirms
  call('rematch').then(ok => { if (!ok && G && G.ended) { G.rematch.you = false; renderRematch(); } });
};
$('btnAgain').onclick = () => {
  if (!G) return;
  dismissed = G.gameId;
  $('over').classList.add('hide');
  call('leaveGame').then(() => call('joinQueue'));
};

function pressAction() {
  if (!G) return;
  if (G.phase === 'prep' && !G.you.ready) { sfx.ready(); return call('ready'); }
  if (G.phase === 'pick' && localSel && !G.you.locked) {
    lockPending = `${G.gameId}:${G.round}`;
    G.you.locked = true; renderGame(false, false); // show it at once; the server confirms
    sfx.lock(); vibrate(25);
    burstAt($('slotYou'), ['#ffc83d', '#fff3c4'], 14);
    call('lockIn').then(ok => { if (!ok) { lockPending = ''; if (G) { G.you.locked = false; renderGame(false, false); } } });
  }
}
$('readyBtn').onclick = pressAction;

function askExit() {
  if (!G || G.phase === 'over') return;
  $('leaveNote').textContent = G.rated ? 'This is a ranked match. Exiting counts as a loss and costs you rating.'
    : !G.opp.isBot ? 'Your friend wins this match.'
    : me && !me.practiceDone ? 'It counts as a loss, and you still need one finished practice match to unlock online play.'
    : 'It will count as a loss.';
  $('confirmLeave').classList.remove('hide');
}
$('btnLeave').onclick = askExit;

// previous turns: a pull-up panel on phones (a side column on wide screens)
function showLog(open: boolean) { document.body.classList.toggle('logOpen', open); }
$('btnLog').onclick = () => showLog(!document.body.classList.contains('logOpen'));
$('logClose').onclick = () => showLog(false);
$('logDim').onclick = () => showLog(false);
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
  const html = log.length ? (() => {
    const lbl: Record<string, string> = { win: 'WIN', loss: 'LOSS', draw: 'DRAW' };
    let h = `<table><tr><th>#</th><th>You</th><th>${esc(G.opp.name)}</th><th></th></tr>`;
    log.slice().reverse().forEach((r: any, i: number) => {
      h += `<tr class="${i === 0 ? 'new' : ''}"><td class="n">${r.n}</td><td>${r.you ? mini(r.you) : '<span class="none">—</span>'}</td><td>${r.opp ? mini(r.opp) : '<span class="none">—</span>'}</td><td><span class="res ${r.result}">${r.you ? lbl[r.result] : 'MISSED'}</span></td></tr>`;
    });
    return h + '</table>';
  })() : '<div class="empty">No turns yet</div>';
  $('logCount').textContent = log.length ? `${log.length} played` : '';
  $('logBadge').textContent = log.length || '';
  if ($('logBody').dataset.h !== html) { $('logBody').innerHTML = html; $('logBody').dataset.h = html; }
}
function esc(s: any) { return String(s).replace(/[&<>"']/g, c => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as any)[c]); }

// ---------- hand: tap to select, drag to reorder ----------
let handSig = '', oppBacks = -1;
function renderHand(deal = false) {
  // Never rebuild while a finger is down on a card: the drag would carry a stale element
  // back into the hand and duplicate a card.
  if (D) return;
  const hand = $('hand');
  const phase = G.phase;
  const order = localHand.map((c: any) => c.id).join();
  hand.classList.toggle('wait', phase !== 'pick' && phase !== 'prep');
  hand.classList.toggle('picking', phase === 'pick' && !G.you.locked);
  $('handCount').textContent = `· ${localHand.length}`;
  if (order !== handSig || deal) {
    handSig = order;
    hand.innerHTML = '';
    localHand.forEach((c: any, i: number) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'card' + (deal ? ' deal' : '');
      if (deal) { b.style.animationDelay = (i * 55) + 'ms'; sfx.deal(i); }
      b.innerHTML = face(c.t) + `<span class="kbd">${(i + 1) % 10}</span>`;
      b.dataset.id = c.id;
      b.setAttribute('aria-label', c.t);
      b.addEventListener('pointerdown', e => startDrag(e, b));
      hand.appendChild(b);
    });
  }
  // selection and lock-in only change classes, so the lift animates smoothly
  [...hand.children].forEach((b: any, i: number) => {
    b.classList.toggle('sel', localSel === b.dataset.id);
    b.classList.toggle('faded', phase === 'pick' && G.you.locked && localSel !== b.dataset.id);
    b.querySelector('.kbd').textContent = String((i + 1) % 10);
  });
}
function selectCard(id: string) {
  if (!G || G.phase !== 'pick' || G.you.locked || localSel === id) return;
  localSel = id;
  selInFlight++;
  sfx.select();
  call('selectCard', { cardId: BigInt(id) }).finally(() => { selInFlight = Math.max(0, selInFlight - 1); });
  renderGame(false, false);
}
function startDrag(e: PointerEvent, el: HTMLElement) {
  if (!G || G.phase === 'over' || e.button > 0) return;
  e.preventDefault();
  D = { el, x: e.clientX, y: e.clientY, moving: false, ghost: null, id: e.pointerId };
  window.addEventListener('pointermove', onDrag);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
}
function onDrag(e: PointerEvent) {
  if (!D || e.pointerId !== D.id) return;
  if (!D.moving) {
    if (Math.hypot(e.clientX - D.x, e.clientY - D.y) < 8) return;
    D.moving = true;
    const r = D.el.getBoundingClientRect();
    D.ghost = document.createElement('div'); D.ghost.className = 'dragGhost';
    D.ghost.style.width = r.width + 'px'; D.ghost.style.height = r.height + 'px';
    D.ghost.innerHTML = D.el.querySelector('.cf').outerHTML;
    document.body.appendChild(D.ghost);
    D.el.classList.add('ph');
  }
  D.ghost.style.left = e.clientX + 'px'; D.ghost.style.top = e.clientY + 'px';
  const hand = $('hand');
  for (const c of hand.children) {
    if (c === D.el) continue;
    const r = c.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 6 && e.clientY <= r.bottom + 6) {
      const before = e.clientX > r.left + r.width / 2 ? c.nextSibling : c;
      if (before !== D.el && before !== D.el.nextSibling) { hand.insertBefore(D.el, before); sfx.deal(0); }
      break;
    }
  }
}
function endDrag(e: PointerEvent) {
  if (!D || e.pointerId !== D.id) return;
  window.removeEventListener('pointermove', onDrag);
  window.removeEventListener('pointerup', endDrag);
  window.removeEventListener('pointercancel', endDrag);
  const d = D; D = null;
  if (!G) { if (d.ghost) d.ghost.remove(); return; }
  if (d.moving) {
    d.ghost.remove();
    d.el.classList.remove('ph');
    const byId = Object.fromEntries(localHand.map((c: any) => [c.id, c]));
    const next = [...$('hand').children].map((c: any) => byId[c.dataset.id]).filter(Boolean);
    // only keep the new order if it still holds exactly the cards we have
    if (next.length === localHand.length && new Set(next.map((c: any) => c.id)).size === next.length) {
      localHand = next;
      call('reorderHand', { ids: localHand.map((c: any) => BigInt(c.id)) });
    }
    handSig = '';
    renderGame(false, false);
  } else if (G.phase === 'pick' && !G.you.locked) {
    selectCard(d.el.dataset.id);
  } else renderGame(false, false); // catch up on anything skipped while the finger was down
}

// ---------- chat and emoji ----------
// Only fixed emoji and phrases, one tap each: there is no typing. Incoming ones pop up as bubbles
// under the sender's name, even with the panel closed. Muting hides the opponent's on this device.
// Both lists must match EMOJIS and PHRASES in spacetimedb/src/index.ts (the server refuses anything else).
const EMOJIS = ['👍', '😂', '😎', '😮', '😤', '😭', '🔥', '👏', '🤝', '🤔', '😈', '🙈', '🪨', '📄', '✂️', '🤞', '🎁', '😇'];
const PHRASES = [
  'Good luck!', 'Nice one!', 'Well played', 'gg', 'Thanks!', 'Oops 😅', 'Rematch?',
  'Rock is coming 🪨', 'Paper next 📄', 'Scissors time ✂️', 'I promise 🤞', 'Trust me 😇', 'Gift for you 🎁', 'Too easy 😎',
];
const MUTE_CHAT_KEY = 'rps10_chatmute';
let chatGame = '', chatSeen = 0n, unread = 0, chatSig = '';
let chatMuted = store.get(MUTE_CHAT_KEY) === '1';
$('chatIc').innerHTML = CHAT;
$('chatEmoji').innerHTML = EMOJIS.map(e => `<button type="button" class="emo" data-e="${e}" aria-label="Send ${e}">${e}</button>`).join('');
$('chatPhrases').innerHTML = PHRASES.map(p => `<button type="button" class="phr" data-p="${esc(p)}">${esc(p)}</button>`).join('');
$('chatMute').checked = chatMuted;

const chatOpen = () => document.body.classList.contains('chatOpen');
function showChat(open: boolean) {
  document.body.classList.toggle('chatOpen', open);
  if (open) { showLog(false); unread = 0; renderChat(true); }
  renderBadge();
}
function renderBadge() { $('chatBadge').textContent = unread ? String(Math.min(unread, 9)) : ''; }

function sendChat(kind: 'emoji' | 'phrase', body: string) {
  if (!G) return;
  if (kind === 'emoji') sfx.emote();
  call('sendChat', { kind, body });
}
$('chatEmoji').addEventListener('click', (e: any) => { const b = e.target.closest('.emo'); if (b) { sendChat('emoji', b.dataset.e); showChat(false); } });
$('chatPhrases').addEventListener('click', (e: any) => { const b = e.target.closest('.phr'); if (b) { sendChat('phrase', b.dataset.p); showChat(false); } });
$('btnChat').onclick = () => showChat(!chatOpen());
$('endChat').onclick = () => showChat(true);
$('chatClose').onclick = () => showChat(false);
$('chatDim').onclick = () => showChat(false);
$('chatMute').onchange = () => {
  chatMuted = $('chatMute').checked;
  store.set(MUTE_CHAT_KEY, chatMuted ? '1' : null);
  if (chatMuted) { hideBubble('bubOpp'); unread = 0; renderBadge(); }
  renderChat(true);
};

function chatRows() {
  return Array.from(conn.db.myChat.iter()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** New messages since we last looked: bubble them, count unread, and sound. */
function syncChat(firstOfGame: boolean) {
  const rows = chatRows();
  const last = rows.length ? rows[rows.length - 1]!.id : 0n;
  if (firstOfGame || chatGame !== G.gameId) {
    // a game we just arrived in: don't replay what was said before
    chatGame = G.gameId; chatSeen = last; unread = 0; chatSig = '';
    hideBubble('bubYou'); hideBubble('bubOpp');
  } else {
    for (const m of rows) {
      if (m.id <= chatSeen) continue;
      if (!m.mine && chatMuted) continue;
      bubble(m.mine ? 'bubYou' : 'bubOpp', m.kind, m.body);
      if (!m.mine) {
        sfx.msg();
        if (!chatOpen()) unread++;
        if (G.phase === 'over' && !chatOpen()) toast(`${G.opp.name}: ${m.body}`);
      }
    }
    chatSeen = last;
  }
  $('chatMute').parentElement.classList.toggle('hide', !!G.opp.isBot);
  renderBadge();
  renderChat(false);
}
function renderChat(scroll: boolean) {
  const rows = chatRows().filter(m => m.mine || !chatMuted);
  const sig = rows.map(m => String(m.id)).join() + (chatMuted ? 'm' : '');
  const list = $('chatList');
  if (sig === chatSig && !scroll) return;
  const grew = sig !== chatSig;
  chatSig = sig;
  list.innerHTML = rows.length ? rows.map(m =>
    `<div class="cm ${m.mine ? 'me' : 'them'}${m.kind === 'emoji' ? ' emoji' : ''}"><span>${esc(m.body)}</span></div>`).join('')
    : `<div class="empty">${chatMuted ? 'Opponent muted' : 'Send an emoji or a quick message 👇'}</div>`;
  if (grew || scroll) list.scrollTop = list.scrollHeight;
}
const bubTimers: Record<string, any> = {};
function bubble(id: string, kind: string, body: string) {
  const el = $(id);
  el.className = 'bub ' + (id === 'bubYou' ? 'you' : 'opp') + (kind === 'emoji' ? ' emoji' : ' text');
  el.textContent = body;
  void el.offsetWidth; el.classList.add('on');
  clearTimeout(bubTimers[id]);
  bubTimers[id] = setTimeout(() => hideBubble(id), kind === 'emoji' ? 2200 : 4000);
}
function hideBubble(id: string) { $(id).classList.remove('on'); }


// ---------- friends, invites, looks, reports ----------
/** The end screen's friend button follows the friendship state with this opponent. */
function renderFriendBtn() {
  const b = $('btnAddFriend');
  const person = G && !G.opp.isBot;
  const st = person ? G.opp.friend : 'friends';
  b.classList.toggle('hide', !person || st === 'friends');
  b.disabled = st === 'out';
  b.textContent = st === 'in' ? `✅ Accept ${G ? G.opp.name : ''}'s friend request` : st === 'out' ? 'Friend request sent' : '➕ Add friend';
  $('btnReport').classList.toggle('hide', !person || reportedGame === (G && G.gameId));
}
$('btnAddFriend').onclick = () => {
  if (!G) return;
  const was = G.opp.friend;
  call('addOpponent').then(ok => { if (ok) toast(was === 'in' ? `You and ${G ? G.opp.name : 'they'} are now friends 🤝` : 'Friend request sent'); });
};

let reportedGame: string | null = null;
function openReport() {
  if (!G || G.opp.isBot) return;
  $('reportWho').textContent = `What's wrong with ${G.opp.name}?`;
  $('reportReasons').innerHTML = REPORT_REASONS.map(r => `<button class="btn ghost" data-r="${esc(r)}">${esc(r)}</button>`).join('');
  $('reportModal').classList.remove('hide');
}
$('reportReasons').addEventListener('click', (e: Event) => {
  const b = (e.target as HTMLElement).closest('button[data-r]') as HTMLElement | null;
  if (!b || !G) return;
  const gameId = G.gameId;
  $('reportModal').classList.add('hide');
  call('reportPlayer', { reason: b.dataset.r }).then(ok => {
    if (!ok) return;
    reportedGame = gameId;
    if (G) renderFriendBtn();
    toast('Thanks. Your report was sent.');
  });
});
$('btnReport').onclick = openReport;
$('chatReport').onclick = () => { showChat(false); openReport(); };
$('reportClose').onclick = () => $('reportModal').classList.add('hide');

// your look: avatar, frame and card style
function lookUnlocks() {
  const achs = new Set(Array.from(conn.db.myAchievements.iter(), a => a.key));
  return { achs, p: { played: me.wins + me.losses + me.draws, wins: me.wins, ach: achs.size } };
}
function renderLook() {
  const { achs, p } = lookUnlocks();
  $('lookPreview').innerHTML = avatarHtml(me.name, me.avatar, me.frame, 'lg')
    + `<div class="lpCards" data-skin="${me.skin || 'classic'}">${['rock', 'paper', 'scissors'].map(k => `<div class="tc">${face(k)}</div>`).join('')}</div>`;
  $('avGrid').innerHTML = [`<button class="avPick${!me.avatar ? ' on' : ''}" data-av="">${esc(initialOf(me.name))}</button>`]
    .concat(AVATARS.map(a => `<button class="avPick${me.avatar === a ? ' on' : ''}" data-av="${a}">${a}</button>`)).join('');
  $('frGrid').innerHTML = FRAMES.map(f => {
    const open = !f.ach || achs.has(f.ach);
    return `<button class="frPick${me.frame === f.key ? ' on' : ''}${open ? '' : ' locked'}" data-fr="${f.key}" ${open ? '' : 'disabled'}>`
      + `${avatarHtml(me.name, me.avatar, f.key, 'sm')}<b>${f.name}</b><small>${open ? (me.frame === f.key ? 'On' : '') : '🔒 ' + f.how}</small></button>`;
  }).join('');
  $('skGrid').innerHTML = SKINS.map(k => {
    const open = k.open(p);
    return `<button class="skPick${(me.skin || 'classic') === k.key ? ' on' : ''}${open ? '' : ' locked'}" data-sk="${k.key}" ${open ? '' : 'disabled'}>`
      + `<div class="tc" data-skin="${k.key}">${face('rock')}</div><b>${k.name}</b><small>${open ? '' : '🔒 ' + k.how}</small></button>`;
  }).join('');
}
function saveLook(change: Partial<{ avatar: string; frame: string; skin: string }>) {
  $('lookErr').textContent = '';
  const next = { avatar: me.avatar, frame: me.frame, skin: me.skin || 'classic', ...change };
  call('setLook', next);
}
$('avGrid').addEventListener('click', (e: Event) => { const b = (e.target as HTMLElement).closest('[data-av]') as HTMLElement | null; if (b) saveLook({ avatar: b.dataset.av! }); });
$('frGrid').addEventListener('click', (e: Event) => { const b = (e.target as HTMLElement).closest('[data-fr]') as HTMLElement | null; if (b && !b.hasAttribute('disabled')) saveLook({ frame: b.dataset.fr! }); });
$('skGrid').addEventListener('click', (e: Event) => { const b = (e.target as HTMLElement).closest('[data-sk]') as HTMLElement | null; if (b && !b.hasAttribute('disabled')) saveLook({ skin: b.dataset.sk! }); });
$('btnLook').onclick = () => { $('lookErr').textContent = ''; renderLook(); $('lookModal').classList.remove('hide'); };
$('lookClose').onclick = () => $('lookModal').classList.add('hide');

// friends list
const STATUS = (f: any) => f.state === 'in' ? 'Wants to be friends' : f.state === 'out' ? 'Request sent' : f.playing ? '🟢 In a match' : f.online ? '🟢 Online' : 'Offline';
function renderFriends() {
  const all = Array.from(conn.db.myFriends.iter());
  const order = (f: any) => (f.state === 'in' ? 0 : f.state === 'friends' ? (f.playing ? 1 : f.online ? 2 : 3) : 4);
  all.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  const busy = !!G && !G.ended;
  $('friendsList').innerHTML = all.length ? all.map(f => {
    const id = f.identity.toHexString();
    let acts = '';
    if (f.state === 'in') acts = `<button class="mini go" data-act="accept" data-id="${id}">Accept</button><button class="mini" data-act="remove" data-id="${id}">✕</button>`;
    else if (f.state === 'out') acts = `<button class="mini" data-act="remove" data-id="${id}">Cancel</button>`;
    else {
      if (f.playing) acts += `<button class="mini go" data-act="watch" data-id="${id}" ${busy ? 'disabled' : ''}>👀 Watch</button>`;
      else if (f.online) acts += `<button class="mini go" data-act="invite" data-id="${id}" ${busy ? 'disabled' : ''}>Invite</button>`;
      acts += `<button class="mini dim" data-act="unfriend" data-id="${id}" data-name="${esc(f.name)}" aria-label="Remove friend">⋯</button>`;
    }
    return `<div class="fr ${f.state}${f.online ? ' on' : ''}">${avatarHtml(f.name, f.avatar, f.frame, 'sm')}`
      + `<div class="frMid"><b>${f.state === 'friends' ? tierBadge(tierOf(f.rating), 'xs') : ''}${esc(f.name)}</b><small>${STATUS(f)}</small></div>${acts}</div>`;
  }).join('') : '<div class="empty">No friends yet. Add someone by their username.</div>';
}
function friendsBadge() {
  const n = Array.from(conn.db.myFriends.iter()).filter(f => f.state === 'in').length + Number(conn.db.myInvites.count());
  $('friendsBadge').textContent = n ? String(Math.min(Number(n), 9)) : '';
}
$('btnFriends').onclick = () => { $('friendsErr').textContent = ''; renderFriends(); $('friendsModal').classList.remove('hide'); };
$('friendsClose').onclick = () => $('friendsModal').classList.add('hide');
$('addFriendForm').onsubmit = (e: Event) => {
  e.preventDefault();
  const name = $('addFriendName').value.trim();
  if (!name) return;
  $('friendsErr').textContent = '';
  call('addFriend', { name }).then(ok => { if (ok) { $('addFriendName').value = ''; toast(`Friend request sent to ${name}`); } });
};
$('friendsList').addEventListener('click', (e: Event) => {
  const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
  if (!b || b.disabled) return;
  const f = Array.from(conn.db.myFriends.iter()).find(x => x.identity.toHexString() === b.dataset.id);
  if (!f) return;
  const other = f.identity;
  $('friendsErr').textContent = '';
  switch (b.dataset.act) {
    case 'accept': call('acceptFriend', { other }).then(ok => ok && toast(`You and ${f.name} are now friends 🤝`)); break;
    case 'remove': call('removeFriend', { other }); break;
    case 'unfriend': if (confirm(`Remove ${f.name} from your friends?`)) call('removeFriend', { other }); break;
    case 'invite':
      call('inviteFriend', { other }).then(ok => { if (ok) { $('friendsModal').classList.add('hide'); toast(`Invite sent to ${f.name}`); } });
      break;
    case 'watch':
      call('watchFriend', { other }).then(ok => { if (ok) $('friendsModal').classList.add('hide'); });
      break;
  }
});

// invites from friends: a bar in the lobby, and a toast wherever you are
let invitesSeen: Set<string> | null = null;
function renderInvites() {
  const inv = Array.from(conn.db.myInvites.iter());
  const ids = inv.map(i => String(i.id));
  if (invitesSeen) for (const i of inv) if (!invitesSeen.has(String(i.id))) { sfx.msg(); vibrate([20, 40, 20]); toast(`${i.avatar || '🎮'} ${i.fromName} invited you to play!`); }
  invitesSeen = new Set(ids);
  const bar = $('inviteBar');
  bar.classList.toggle('hide', !inv.length);
  bar.innerHTML = inv.slice(0, 3).map(i => `<div class="inv"><span class="invAv">${i.avatar || '🎮'}</span><span class="invTx"><b>${esc(i.fromName)}</b> invited you to a match</span>`
    + `<button class="mini go" data-join="${esc(i.code)}">Join</button><button class="mini" data-dismiss="${i.id}" aria-label="Dismiss">✕</button></div>`).join('');
  friendsBadge();
  if (!$('friendsModal').classList.contains('hide')) renderFriends();
}
$('inviteBar').addEventListener('click', async (e: Event) => {
  const t = e.target as HTMLElement;
  const join = t.closest('[data-join]') as HTMLElement | null, dis = t.closest('[data-dismiss]') as HTMLElement | null;
  if (join) { dismissed = null; homeMsg(''); const err = await joinFromLink(join.dataset.join!); if (err) homeMsg(err); }
  else if (dis) call('dismissInvite', { id: BigInt(dis.dataset.dismiss!) });
});

// ---------- watching a friend ----------
let watchKey = '', watchDeadline = 0, watchTick: any = 0, watchSig = '';
function renderWatch() {
  if (!showing('scrWatch')) { show('scrWatch'); watchSig = ''; }
  closeModals();
  $('wFriend').textContent = me.watching;
  const w: any = first(conn.db.watchGame.iter());
  const log = Array.from(conn.db.watchLog.iter()).sort((a, b) => a.n - b.n);
  if (!w) {
    $('scrWatch').classList.add('idle');
    $('wMsg').textContent = `${me.watching} isn't in a match right now. You'll see their next one here.`;
    return;
  }
  $('scrWatch').classList.remove('idle');
  const key = `${w.gameId}:${w.seq}`;
  if (key !== watchKey) {
    watchKey = key;
    const now = Date.now();
    watchDeadline = Math.min(now + w.phaseMs, Math.max(now, w.deadline.toDate().getTime()));
  }
  $('wAvA').innerHTML = avatarHtml(w.aName, w.aAvatar, '', 'sm');
  $('wAvB').innerHTML = avatarHtml(w.bName, w.bAvatar, '', 'sm');
  $('wNameA').innerHTML = tierBadge(tierOf(w.aRating), 'xs') + esc(w.aName);
  $('wNameB').innerHTML = (w.bIsBot ? '' : tierBadge(tierOf(w.bRating), 'xs')) + esc(w.bName);
  $('wScoreA').textContent = w.aScore; $('wScoreB').textContent = w.bScore;
  $('wRound').textContent = w.round;
  const byRound: Record<number, string> = {};
  for (const l of log) byRound[l.n] = l.result;
  $('wStrip').innerHTML = Array.from({ length: w.totalRounds }, (_, i) => {
    const n = i + 1, r = byRound[n];
    return `<i class="${r === 'win' ? 'w' : r === 'loss' ? 'l' : r === 'draw' ? 'd' : n === w.round && !w.over ? 'now' : ''}"><b>${n}</b></i>`;
  }).join('');
  const backs = (n: number) => Array.from({ length: n }, () => `<span class="ob">${BACK}</span>`).join('');
  $('wBacksA').innerHTML = backs(w.aCards); $('wBacksB').innerHTML = backs(w.bCards);
  $('wSlotA').dataset.skin = w.aSkin || 'classic'; $('wSlotB').dataset.skin = w.bSkin || 'classic';
  const res = w.revealResult;
  const slot = (id: string, k: number, locked: boolean, win: boolean, lose: boolean) => {
    const el = $(id);
    const kind = k >= 0 ? KINDS[k] : null;
    el.className = 'slot' + (w.revealShown ? (kind ? ' face' : ' miss') : locked ? ' down' : ' empty thinking') + (win ? ' win' : lose ? ' lose' : '');
    const html = w.revealShown ? (kind ? face(kind) : '<span class="slow">Too<br>slow</span>') : locked ? BACK : '<span class="dots3"><i></i><i></i><i></i></span>';
    if (el.dataset.c !== html) { el.innerHTML = html; el.dataset.c = html; }
  };
  slot('wSlotA', w.revealA, w.aLocked, res === 'win', res === 'loss');
  slot('wSlotB', w.revealB, w.bLocked, res === 'loss', res === 'win');
  $('wStA').textContent = w.phase === 'pick' ? (w.aLocked ? 'Locked in ✓' : 'Choosing…') : '';
  $('wStB').textContent = w.phase === 'pick' ? (w.bLocked ? 'Locked in ✓' : 'Choosing…') : '';
  const sig = `${w.gameId}:${w.phase}:${w.round}:${res}`;
  if (sig !== watchSig) {
    watchSig = sig;
    if (w.phase === 'result' && res) sfx[res === 'win' ? 'roundWin' : res === 'loss' ? 'roundLose' : 'roundDraw']();
    if (w.phase === 'reveal') sfx.flip();
  }
  $('wMsg').textContent = w.over
    ? `${w.endResult === 'win' ? `${w.aName} won` : w.endResult === 'loss' ? `${w.bName} won` : "It's a draw"} ${w.aScore}–${w.bScore}${w.endReason === 'points' ? '' : ` (${w.endReason === 'forfeit' ? 'someone left' : 'disconnect'})`}. Waiting for their next match…`
    : w.phase === 'prep' ? 'Players are arranging their hands…'
    : w.phase === 'result' ? (res === 'win' ? `${w.aName} takes round ${w.round}!` : res === 'loss' ? `${w.bName} takes round ${w.round}!` : `Round ${w.round} is a draw`)
    : '';
  clearInterval(watchTick);
  const upd = () => {
    if (!showing('scrWatch')) { clearInterval(watchTick); return; }
    const ms = Math.max(0, watchDeadline - Date.now());
    $('wTimer').textContent = w.phase === 'pick' ? String(Math.ceil(ms / 1000)) : w.over ? '🏁' : 'VS';
  };
  upd(); watchTick = setInterval(upd, 250);
}
$('btnStopWatch').onclick = () => { call('stopWatching'); toLobby(); };

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('chatOpen')) { showChat(false); return; }
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  const open = document.querySelector('.overlay:not(.hide)');
  if (e.key === 'Escape') {
    if (document.body.classList.contains('logOpen')) { showLog(false); return; }
    if (open && open.id !== 'over') { open.classList.add('hide'); return; }
    if (G && showing('scrGame')) askExit();
    return;
  }
  if (!G || !showing('scrGame') || open) return;
  if (/^[0-9]$/.test(e.key) && G.phase === 'pick') {
    const i = (Number(e.key) + 9) % 10;
    const c = localHand[i];
    if (c) selectCard(c.id);
    e.preventDefault();
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && G.phase === 'pick' && localHand.length) {
    const i = localHand.findIndex((c: any) => c.id === localSel);
    const n = localHand.length;
    const next = i === -1 ? 0 : (i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
    selectCard(localHand[next].id);
    e.preventDefault();
  } else if (e.key === 'Enter' || e.key === ' ') {
    if (document.activeElement && (document.activeElement as HTMLElement).closest('.card')) (document.activeElement as HTMLElement).blur();
    pressAction();
    e.preventDefault();
  }
});

// ---------- install as an app ----------
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installEvt: any = null;
function showInstall(on: boolean) { $('btnInstall').classList.toggle('hide', !on); $('installSep').classList.toggle('hide', !on); }
addEventListener('beforeinstallprompt', (e: any) => { e.preventDefault(); installEvt = e; showInstall(true); });
addEventListener('appinstalled', () => { installEvt = null; showInstall(false); toast('Installed! Find RPS 10 on your home screen.'); });
if (isIOS && !standalone()) showInstall(true); // Safari has no install prompt: show the steps instead
$('btnInstall').onclick = async () => {
  if (installEvt) {
    installEvt.prompt();
    try { await installEvt.userChoice; } catch {}
    installEvt = null; showInstall(false);
  } else if (isIOS) $('iosInstall').classList.remove('hide');
};
$('iosInstallOk').onclick = () => $('iosInstall').classList.add('hide');
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
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
