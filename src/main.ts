// RPS 10 — browser client for the Spacetime version.
// It only ever sees what the server's views send it: its own hand, the opponent's card count,
// and each round's cards once both are revealed.
import './style.css';
import { DbConnection, tables } from './module_bindings';
import { KINDS, ICON, face, mini, TROPHY, SKULL, SHAKE, LOCK, CHAT, GEAR, EXIT, LIST, LOCKER, BAG, PLAY, FLAG, STATS, CALENDAR } from './art';
import { sfx, unlock, isMuted, setMuted, isMusicOn, setMusicOn, setTrack } from './sfx';
import { burstAt, vibrate, winEffect, setReducedMotion, setVibration } from './fx';
import { drawResultCard } from './card';
import { tierOf, nextTier, tierBadge, TIERS, ACHIEVEMENTS, achievementOf, today, msToNextDay, msToSeasonEnd, seasonName, shortTime } from './ranks';
import { addSprite } from './sprite';
import {
  ITEM, ITEMS, COINS, XP, XP_MULT, COIN_MULT, K_STEPS, REACTION_SLOTS, PHRASE_SLOTS, levelOf, nameOf, descOf, itemsOf, KIND_LABEL, avatarHtml, reactionSvg, reactionName,
  ticketHtml, titleHtml, backHtml, skinTrio, itemArt, ROAD, nextUnlock, reactionsInPack, phrasesInPack, xpForLevel, type ItemKind,
} from './catalog';

const VERSION = '2.4.1';
const REPORT_REASONS = ['Offensive name', 'Spam in chat', 'Stalling or quitting', 'Other'];
// Contact us / privacy policy address. Put your support email here before launch.
const SUPPORT_EMAIL = '';
addSprite();

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
// match types: one icon each (stroke drawings that take the button's colour)
const svg24 = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const MODE_ICONS = {
  mRanked: svg24('<path d="M7 4h10v4a5 5 0 0 1-10 0Z M5 5H3v2a3 3 0 0 0 3 3 M19 5h2v2a3 3 0 0 1-3 3 M12 13v4 M8 20h8"/>'),
  mCasual: svg24('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17 M12 3.5c2.5 2.4 3.6 5.2 3.6 8.5s-1.1 6.1-3.6 8.5 M12 3.5C9.5 5.9 8.4 8.7 8.4 12s1.1 6.1 3.6 8.5" stroke-width="2"/>'),
  mFriend: svg24('<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><circle cx="17" cy="9" r="2.4" stroke-width="2"/><path d="M16.5 13.6c2.6.2 4.5 2 4.5 4.6" stroke-width="2"/>'),
  mBot: svg24('<rect x="4.5" y="8" width="15" height="11" rx="3.5"/><path d="M12 4v4 M9 13h.01 M15 13h.01 M2.5 13v2.5 M21.5 13v2.5" stroke-width="2.4"/>'),
  lock: svg24('<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
};
const STATIC_ICONS: Record<string, string> = {
  ...ICON, ...MODE_ICONS, trophy: TROPHY, gear: GEAR, exit: EXIT, list: LIST, locker: LOCKER, bag: BAG, play: PLAY, flag: FLAG, stats: STATS, calendar: CALENDAR,
};
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
let flipTimer: any = 0, faceDown = '', prevIntro = false, introSec = -1;
const FACE_DOWN_MS = 1000; // cards sit face down this long before they flip (the server's reveal is 1s longer to match)
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

// ---------- settings saved on this device ----------
const PREF = {
  vibe: () => store.get('rps10_vibe') !== '0',
  motion: () => store.get('rps10_motion') === '1',
};
setVibration(PREF.vibe());
setReducedMotion(PREF.motion());
document.body.classList.toggle('calm', PREF.motion());
addEventListener('pointerdown', unlock, { capture: true });
addEventListener('keydown', unlock, { capture: true });
// a soft click on every button
document.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button'); if (b && !b.disabled && !b.matches('.card, #readyBtn, .emo')) sfx.tap(); });

// ---------- talking to the server ----------
/** Calls a server reducer. Refusals ("Room not found", ...) are shown to the player. */
function call(name: string, args: any = {}): Promise<boolean> {
  const fn = (conn.reducers as any)[name];
  return Promise.resolve()
    .then(() => fn(args))
    .then(() => true, (err: any) => { showError(String((err && err.message) || err || 'Something went wrong. Try again.')); return false; });
}
const isOpen = (id: string) => !$(id).classList.contains('hide');
function showError(msg: string) {
  msg = msg.replace(/^.*?Error:\s*/, '');
  if (/fatal|internal|panic|unreachable/i.test(msg)) msg = 'Something went wrong on our side. Nothing was lost. Try again.';
  if (showing('scrAuth')) $('authErr').textContent = msg;
  else if (isOpen('storeSheet') && $('storeErr')) $('storeErr').textContent = msg;
  else if (isOpen('settingsSheet') && !$('setDelete').classList.contains('hide')) $('delErr').textContent = msg;
  else if (isOpen('settingsSheet') && !$('setBugPage').classList.contains('hide')) $('bugErr').textContent = msg;
  else if (isOpen('friendModal')) $('friendErr').textContent = msg;
  else if (isOpen('profileSheet') || isOpen('profileCard')) toast(msg, 'bad');
  else if (isOpen('friendsSheet')) $('friendsErr').textContent = msg;
  else if (showing('scrLobby') && !document.querySelector('.sheetOv:not(.hide)')) { $('lobbyErr').textContent = msg; $('lobbyErr').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
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
  achSeen = null; lvlSeen = 0;
  ready = false; me = null; G = null; localHand = null; prevPhase = null; phaseKey = ''; dismissed = null; overlay = null;
  skippingTutorial = false;
  closeModals();
  $('loadMsg').textContent = 'Connecting…';
  show('scrLoad');
  loadTips(my);

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
          tables.myFriends, tables.myInvites, tables.watchGame, tables.watchLog,
          tables.myItems, tables.serverInfo, tables.weeklyBoard, tables.myRank, tables.friendsBoard, tables.myRecent, tables.playerProfile]);
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
        // offline, or the server is down: say so, and keep trying
        $('loadMsg').innerHTML = `<b>Can't reach the game</b><br>${navigator.onLine === false ? 'Check your internet connection.' : 'The server may be down for a moment.'} Your progress is saved on the server, so nothing is lost.<br><small>Trying again in 5s…</small>`;
        setTimeout(() => { if (my === gen) connect(); }, 5000);
      }
    })
    .build();

  // any change to what the server shows us: rebuild the screen once the whole update has landed
  let queued = false;
  const changed = () => { if (my === gen && !queued) { queued = true; queueMicrotask(() => { queued = false; if (my === gen) sync(); }); } };
  for (const t of [conn.db.myPlayer, conn.db.myGame, conn.db.myHand, conn.db.myLog, conn.db.myTransfer, conn.db.leaderboard, conn.db.myChat,
    conn.db.myStats, conn.db.myHistory, conn.db.myAchievements, conn.db.seasonInfo, conn.db.dailyStats,
    conn.db.myFriends, conn.db.myInvites, conn.db.watchGame, conn.db.watchLog,
    conn.db.myItems, conn.db.serverInfo, conn.db.weeklyBoard, conn.db.myRank, conn.db.friendsBoard, conn.db.myRecent, conn.db.playerProfile] as any[]) {
    t.onInsert(changed); t.onDelete(changed);
    if (typeof t.onUpdate === 'function') t.onUpdate(changed);
  }
}

// while loading: a rotating tip, and a Retry button if it takes a while
const TIPS = [
  'Tip: you hold 4 of one card and 3 of the others. Count what your opponent has played.',
  'Tip: the last round is often decided by counting. What have they not played yet?',
  'Tip: Unranked matches give normal XP and coins without risking your rating.',
  'Tip: every level on the Level road pays coins, even the ones without an unlock.',
  'Tip: the daily challenge deals everyone the same hands. One try a day.',
];
function loadTips(my: number) {
  let i = Math.floor(Math.random() * TIPS.length);
  $('loadTip').textContent = TIPS[i]!;
  $('loadRetry').classList.add('hide');
  const t = setInterval(() => {
    if (my !== gen || ready) { clearInterval(t); return; }
    i = (i + 1) % TIPS.length; $('loadTip').textContent = TIPS[i]!;
  }, 4000);
  setTimeout(() => {
    if (my !== gen || ready) return;
    $('loadMsg').textContent = 'Still connecting…';
    $('loadRetry').classList.remove('hide');
  }, 8000);
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
    .map(l => ({ n: l.n, you: kindName(l.you), opp: kindName(l.opp), result: l.result,
      youGone: kindName(l.youGone), oppGone: kindName(l.oppGone), youAuto: l.youAuto, oppAuto: l.oppAuto }));
  const lockKey = `${gv.gameId}:${gv.round}`;
  if (gv.phase !== 'pick' || gv.youLocked) lockPending = ''; // the server has caught up
  return {
    gameId: String(gv.gameId), mode: gv.mode, phase: gv.phase, deadline: localDeadline, round: gv.round,
    totalRounds: gv.totalRounds, pickMs: gv.pickMs, phaseMs: gv.phaseMs, rated: gv.rated, ratingChange: gv.ratingChange,
    you: { name: gv.youName, score: gv.youScore, hand, sel: gv.youSel === 0n ? null : String(gv.youSel), ready: gv.youReady,
      locked: gv.youLocked || (gv.phase === 'pick' && lockPending === lockKey) },
    watchers: gv.watchers, xpGain: gv.xpGain, coinGain: gv.coinGain,
    opp: { name: gv.oppName, isBot: gv.oppIsBot, rating: gv.oppRating, avatar: gv.oppAvatar, frame: gv.oppFrame, skin: gv.oppSkin,
      back: gv.oppBack, color: gv.oppColor, fx: gv.oppFx, title: gv.oppTitle,
      friend: gv.oppFriend, score: gv.oppScore, handCount: gv.oppHandCount, ready: gv.oppReady, placed: gv.oppPlaced, connected: gv.oppConnected },
    reveal: gv.revealShown ? { n: gv.round, you: kindName(gv.revealYou), opp: kindName(gv.revealOpp), result: gv.revealResult || null,
      youGone: kindName(gv.revealYouGone), oppGone: kindName(gv.revealOppGone), youAuto: gv.revealYouAuto, oppAuto: gv.revealOppAuto } : null,
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
  checkLevel();
  renderMe();
  renderBoard();
  renderInvites();
  renderSheets();
  if (isOpen('profileCard')) renderProfileCard();

  const gv = first(conn.db.myGame.iter());
  if (gv && String(gv.gameId) !== dismissed) {
    overlay = null;
    onState(buildState(gv));
    return;
  }
  if (G) leaveGameScreen();
  setTrack('lobby');
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
function closeModals() {
  for (const id of ['friendModal', 'confirmLeave', 'reportModal', 'profileCard', 'rankUp']) $(id).classList.add('hide');
  document.querySelectorAll('.sheetOv').forEach(el => el.classList.add('hide'));
}

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

/** Your own avatar with your aura. */
function avatar(el: any, size = 48) { if (me) el.innerHTML = avatarHtml(me.avatar, me.frame, size, me.name); }
/** The Account rows in Settings. */
function renderAccount() {
  if (!me) return;
  const rows: string[] = [];
  rows.push(`<div class="ri acct">${avatarHtml(me.avatar, me.frame, 40)}<span><b>${esc(me.name)}</b><small>${google ? 'Signed in with Google' : me.isGuest ? 'Guest: progress is saved on this device only' : 'Account'}</small></span></div>`);
  if (me.isGuest) rows.push(`<button class="ri" type="button" data-acct="signin"><span>${google ? 'Choose a username' : googleOn ? 'Continue with Google' : 'Create account'}<small>Keep your progress on every device</small></span><span class="chev">›</span></button>`);
  if (google) rows.push('<button class="ri" type="button" data-acct="signout"><span>Sign out</span><span class="chev">›</span></button>');
  rows.push('<button class="ri red" type="button" data-acct="delete"><span>Delete account</span><span class="chev">›</span></button>');
  $('setAccount').innerHTML = rows.join('');
}
$('setAccount').addEventListener('click', (e: Event) => {
  const b = (e.target as HTMLElement).closest('[data-acct]') as HTMLElement | null;
  if (!b) return;
  const act = b.dataset.acct;
  if (act === 'signin') { closeSheet('settingsSheet'); pendingQueue = false; startAccount(); }
  else if (act === 'signout') { closeSheet('settingsSheet'); googleSignOut(); }
  else if (act === 'delete') settingsPage('setDelete');
});

// ---------- lobby ----------
function toLobby() {
  $('banner').classList.remove('on'); $('over').classList.add('hide'); $('confirmLeave').classList.add('hide');
  $('lobbyErr').textContent = '';
  renderMe(); renderBoard();
  show('scrLobby');
  setTrack('lobby');
}
let googleOn = false; // Firebase values are present
authReady.then(a => { googleOn = !!(a && a.configured); renderMe(); });
function homeMsg(m: string) { $('lobbyErr').textContent = m; }

const myStats = (): any => first(conn.db.myStats.iter());
const myLevel = () => levelOf(myStats()?.xp || 0);
const owned = () => new Set(Array.from(conn.db.myItems.iter(), r => r.item));
const info = (): any => first(conn.db.serverInfo.iter());
const coins = () => (me ? me.coins : 0);
const fmt = (n: number) => n.toLocaleString('en');

function renderMe() {
  if (!me) return;
  document.querySelectorAll('.coinN').forEach(el => { el.textContent = fmt(coins()); });
  $('meAv').innerHTML = avatarHtml(me.avatar, me.frame, 116, me.name);
  $('meName').textContent = me.name;
  const t = tierOf(me.rating);
  $('tierBadge').innerHTML = tierBadge(t, 'xs');
  $('meRank').textContent = ONLINE_NEEDS_ACCOUNT && me.isGuest ? 'Unranked' : `${t.name} · ${fmt(me.rating)}`;
  $('meRank').style.color = t.c1;
  $('meTitle').innerHTML = titleHtml(me.title);
  // sign-in bar: shown to guests
  $('guestCard').classList.toggle('hide', !ACCOUNTS || !me.isGuest);
  $('guestText').textContent = google ? 'Pick a username to finish your account.'
    : googleOn ? 'Sign in to keep your progress on every device.' : 'Create an account to pick your own name.';
  $('btnGoogle').textContent = google ? 'Choose a username' : googleOn ? 'Continue with Google' : 'Create account';
  renderLevel();
  renderDaily();
  renderModes();
  renderNotice();
  // the Store tab gets a dot until today's deal has been looked at
  const day = info()?.day;
  $('storeDot').classList.toggle('hide', !day || store.get('rps10_deal_seen') === String(day));
  if (notice) { homeMsg(notice); notice = ''; }
}
function renderLevel() {
  const { level, into, need } = myLevel();
  $('lvlNum').textContent = level; $('lvlN').textContent = level;
  $('lvlXp').textContent = `${into} / ${need} XP`;
  $('lvlFill').style.width = `${Math.max(2, Math.round((into / need) * 100))}%`;
  const n = nextUnlock(level);
  $('lvlNext').textContent = n ? `Next: ${n.items.map(i => nameOf(i.id) + (i.kind === 'skin' ? ' cards' : '')).join(' + ')} at level ${n.level}` : 'You have finished the Level road!';
}
/** Server notices (maintenance) shown at the top of the lobby, plus any bonus event. */
const nowMs = () => Date.now();
const toMs = (micros: any) => Number(BigInt(micros ?? 0) / 1000n);
/** A notice with a hide time stops showing (and stops blocking play) once that time has passed. */
function noticeOn(s: any) { return !!s && (s.maintenance || !!s.message) && (!toMs(s.noticeEndsAt) || toMs(s.noticeEndsAt) > nowMs()); }
const maintOn = () => { const s = info(); return noticeOn(s) && !!s.maintenance; };
function leftText(ms: number) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.round(h / 24)} days`;
}
function renderNotice() {
  const s = info();
  const on = noticeOn(s);
  $('noticeBar').classList.toggle('hide', !on);
  if (on) {
    const back = toMs(s.backAt) - nowMs();
    const backTx = s.maintenance && toMs(s.backAt) ? (back > 0 ? ` <span class="nbBack">Back in about ${leftText(back)}</span>` : ' <span class="nbBack">Back any moment now</span>') : '';
    $('noticeBar').innerHTML = `<b>${s.maintenance ? 'Maintenance' : 'News'}</b> ${esc(s.message || 'The game is being updated. Online matches are paused for a few minutes.')}${backTx}`;
  }
  // your own suspension or chat mute, so it's clear why Play or chat says no
  const banLeft = me ? toMs(me.banUntil) - nowMs() : 0, muteLeft = me ? toMs(me.mutedUntil) - nowMs() : 0;
  const banned = !!me && (me.banned || banLeft > 0);
  $('banBar').classList.toggle('hide', !banned && muteLeft <= 0);
  if (banned) $('banBar').innerHTML = `<b>Suspended</b> You can't play online ${me.banned ? 'for now' : `for about ${leftText(banLeft)}`}${me.banReason ? ` (${esc(me.banReason)})` : ''}. Practice still works. If you think this is a mistake, contact us from Settings.`;
  else if (muteLeft > 0) $('banBar').innerHTML = `<b>Chat muted</b> Your chat is off for about ${leftText(muteLeft)}. You can still play.`;
  const ends = toMs(s?.eventEndsAt), starts = toMs(s?.eventStartsAt);
  const ev = !!s && !!s.eventName && ends > nowMs();
  $('eventBar').classList.toggle('hide', !ev);
  if (ev) {
    const boosts = [s.eventCoinPct > 100 ? `${s.eventCoinPct / 100}× coins` : '', s.eventXpPct > 100 ? `${s.eventXpPct / 100}× XP` : ''].filter(Boolean).join(' and ');
    $('eventBar').innerHTML = starts > nowMs()
      ? `<b>Coming up</b> ${esc(s.eventName)}: ${boosts} from every match. Starts in ${leftText(starts - nowMs())}.`
      : `<b>${esc(s.eventName)}</b> ${boosts} from every match! Ends in ${leftText(ends - nowMs())}.`;
  }
}

// match type: Ranked, Unranked, Friend or Practice, then one big Play
type Mode = 'ranked' | 'casual' | 'friend' | 'practice';
let mode: Mode = (['ranked', 'casual', 'friend', 'practice'].includes(store.get('rps10_mode') || '') ? store.get('rps10_mode') : 'ranked') as Mode;
const MODE_HINT: Record<Mode, string> = {
  ranked: 'rated, counts on the leaderboards',
  casual: 'a real opponent, no rating change',
  friend: 'a private room, send your friend a code',
  practice: 'against a bot, half XP and coins',
};
const MODE_NAME_SHORT: Record<Mode, string> = { ranked: 'Ranked', casual: 'Unranked', friend: 'Friend', practice: 'Practice' };
function renderModes() {
  const locked = !me.practiceDone;
  const shown: Mode = locked && (mode === 'ranked' || mode === 'casual') ? 'practice' : mode;
  document.querySelectorAll<HTMLButtonElement>('#modes [data-mode]').forEach(b => {
    const m = b.dataset.mode as Mode;
    b.classList.toggle('on', m === shown);
    b.setAttribute('aria-selected', String(m === shown));
    b.disabled = locked && (m === 'ranked' || m === 'casual');
  });
  mode = shown;
  $('modeHint').innerHTML = locked ? 'Finish one practice match to unlock <b>Ranked</b> and <b>Unranked</b>' : `<b>${MODE_NAME_SHORT[mode]}:</b> ${MODE_HINT[mode]}`;
  $('quickIc').innerHTML = PLAY;
  $('quickTx').textContent = mode === 'friend' ? 'PLAY A FRIEND' : mode === 'practice' ? 'PRACTICE' : mode === 'casual' ? 'PLAY UNRANKED' : 'PLAY RANKED';
  const maint = maintOn() && (mode === 'ranked' || mode === 'casual' || mode === 'friend');
  $('btnQuick').classList.toggle('locked', maint);
}
$('modes').addEventListener('click', (e: Event) => {
  const b = (e.target as HTMLElement).closest('[data-mode]') as HTMLButtonElement | null;
  if (!b || b.disabled) return;
  mode = b.dataset.mode as Mode;
  store.set('rps10_mode', mode);
  renderModes();
});
$('btnQuick').onclick = () => {
  $('lobbyErr').textContent = '';
  dismissed = null;
  if (mode === 'practice') return void call('startPractice');
  if (mode === 'friend') {
    $('friendErr').textContent = ''; $('friendModal').classList.remove('hide');
    setTimeout(() => $('joinCode').focus(), 50);
    return;
  }
  if (!me.practiceDone) { homeMsg('Finish one practice match first'); return; }
  if (ONLINE_NEEDS_ACCOUNT && me.isGuest) { pendingQueue = true; return void startAccount(); }
  call(mode === 'casual' ? 'joinCasual' : 'joinQueue');
};

/** The lobby's leaderboard card: your place this week and the top three. */
function renderBoard() {
  if (!me) return;
  const r: any = first(conn.db.myRank.iter());
  const top = Array.from(conn.db.weeklyBoard.iter()).sort((a, b) => b.points - a.points).slice(0, 3);
  $('boardSub').innerHTML = r && r.weekRank ? `This week you're <b>#${r.weekRank}</b> · ${r.weekPoints} pts`
    : r && r.monthRank ? `This month you're <b>#${r.monthRank}</b>` : 'Win ranked matches to get on the board';
  $('boardStack').innerHTML = top.map(u => avatarHtml(u.avatar, '', 26)).join('');
  if (isOpen('boardSheet')) renderBoardSheet();
}

// ---------- sheets: Locker, Store, Level road, Stats, Leaderboard, Settings ----------
const sheetTab: Record<string, string> = { lockerSheet: 'cards', storeSheet: 'skin', statsSheet: 'overview', boardSheet: 'week', friendsSheet: 'friends', ranksSheet: 'ranks' };
function openSheet(id: string, tab?: string) {
  closeModals();
  if (tab) sheetTab[id] = tab;
  $(id).classList.remove('hide');
  renderSheet(id);
  const body = $(id + 'Body'); if (body) body.scrollTop = 0;
  if (id === 'roadSheet') setTimeout(() => { const n = $('roadSheet').querySelector('.rs.next'); if (n) n.scrollIntoView({ block: 'center' }); }, 30);
  if (id === 'storeSheet' && info()) store.set('rps10_deal_seen', String(info().day));
  renderMe();
}
function closeSheet(id: string) { $(id).classList.add('hide'); }
function renderSheet(id: string) {
  document.querySelectorAll<HTMLElement>(`#${id} .shTabs [data-tab]`).forEach(b => {
    b.classList.toggle('on', b.dataset.tab === sheetTab[id]);
    b.setAttribute('aria-selected', String(b.dataset.tab === sheetTab[id]));
  });
  if (id === 'lockerSheet') renderLocker();
  else if (id === 'storeSheet') renderStore();
  else if (id === 'roadSheet') renderRoad();
  else if (id === 'statsSheet') renderStats();
  else if (id === 'boardSheet') {
    // "How it works" opens the Ranks screen
    if (sheetTab.boardSheet === 'how') { sheetTab.boardSheet = 'week'; openSheet('ranksSheet', 'ranks'); return; }
    renderBoardSheet();
  }
  else if (id === 'ranksSheet') renderRanks();
  else if (id === 'settingsSheet') renderSettings();
  else if (id === 'friendsSheet') renderFriends();
  else if (id === 'profileSheet') renderProfile();
}
/** Keeps any open sheet up to date when the server sends something new. */
function renderSheets() {
  document.querySelectorAll<HTMLElement>('.sheetOv:not(.hide)').forEach(el => renderSheet(el.id));
}
document.querySelectorAll<HTMLElement>('.sheetOv').forEach(ov => {
  ov.addEventListener('click', (e: Event) => {
    const t = e.target as HTMLElement;
    if (t === ov || t.closest('[data-close]')) { ov.classList.add('hide'); return; }
    const tab = t.closest('.shTabs [data-tab]') as HTMLElement | null;
    if (tab) { sheetTab[ov.id] = tab.dataset.tab!; renderSheet(ov.id); const body = $(ov.id + 'Body'); if (body) body.scrollTop = 0; }
  });
});
$('navLocker').onclick = () => openSheet('lockerSheet');
$('navStore').onclick = () => openSheet('storeSheet');
$('btnCoins').onclick = () => openSheet('storeSheet');
$('navRoad').onclick = () => openSheet('roadSheet');
$('lvlRow').onclick = () => openSheet('roadSheet');
$('navStats').onclick = () => openSheet('statsSheet');
$('btnBoard').onclick = () => openSheet('boardSheet');
$('btnLook').onclick = () => openSheet('lockerSheet', 'profile');
$('navPlay').onclick = () => closeModals();
$('btnSettings').onclick = () => openSheet('settingsSheet');

// ---------- unlock popups: achievements, level-ups and card styles, shown one at a time at the top ----------
type Pop = { icon: string; label: string; title: string; sub: string; kind?: string };
const popQueue: Pop[] = [];
let popBusy = false, popTimer: any = 0;
function popup(p: Pop) {
  popQueue.push(p);
  // wait for the result screen and its fanfare before the first one
  if (!popBusy) { popBusy = true; popTimer = setTimeout(nextPop, 1300); }
}
function nextPop() {
  const el = $('achPop');
  const p = popQueue.shift();
  if (!p) { popBusy = false; return; }
  el.className = 'achPop ' + (p.kind || '');
  el.innerHTML = `<div class="apIc">${p.icon}</div><div class="apTx"><small>${esc(p.label)}</small><b>${esc(p.title)}</b><span>${esc(p.sub)}</span></div>`;
  void el.offsetWidth;
  el.classList.add('on');
  sfx.unlock();
  vibrate([15, 30, 15]);
  setTimeout(() => burstAt(el.querySelector('.apIc'), p.kind === 'skin' ? ['#6fe0ff', '#ff7ac0', '#fff'] : ['#ffc83d', '#fff3c4', '#ffb21f'], 16), 300);
  popTimer = setTimeout(hidePop, 3000);
}
function hidePop() {
  clearTimeout(popTimer);
  $('achPop').classList.remove('on');
  popTimer = setTimeout(nextPop, 380);
}
if (import.meta.env.DEV) (window as any).__popup = popup; // for trying the popup from the browser console while developing
$('achPop').addEventListener('click', () => { if ($('achPop').classList.contains('on')) hidePop(); });

/** Level-ups and Level-road unlocks since this connection loaded. */
let lvlSeen = 0;
function checkLevel() {
  const level = myLevel().level;
  if (lvlSeen && level > lvlSeen) {
    const got = ROAD.filter(st => st.level > lvlSeen && st.level <= level);
    const paid = got.reduce((n, st) => n + st.coins, 0);
    popup({ icon: `<span class="apLvl">${level}</span>`, label: 'Level up', title: `Level ${level}`, sub: `+${paid} coins`, kind: 'lvl' });
    if (!me.allSkins) for (const st of got) for (const it of st.items) {
      popup({ icon: itemArt(it.id, 44), label: `New ${KIND_LABEL[it.kind].toLowerCase()}`, title: nameOf(it.id), sub: 'Yours now. Equip it in the Locker', kind: 'skin' });
    }
  }
  lvlSeen = level;
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
    : `+${COINS.dailyPlay} coins, +${COINS.dailyWin} more for a win`;
}
setInterval(() => { if (me && showing('scrLobby')) { renderDaily(); renderBoard(); renderNotice(); renderModes(); } }, 30000);
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
    if (RANK_ORDER.includes(k as any)) { rankUpQueue.push(k); setTimeout(showRankUp, 1700); continue; }
    const a = achievementOf(k);
    if (a) popup({ icon: `<span class="apEmo">${a.icon}</span>`, label: 'Achievement unlocked', title: a.name, sub: a.how });
  }
}

// ---------- Ranks & rewards: how ranks work, and what every match pays (numbers come from the server's catalog) ----------
const KIND_SHORT: Partial<Record<ItemKind, string>> = { aura: 'aura', back: 'card back', title: 'title', fx: 'win effect' };
/** "Diamond aura", "Golden title", "Prism card back". */
function rewardLabel(i: { id: string; kind: ItemKind }) {
  const n = nameOf(i.id);
  const nice = i.kind === 'title' ? n.charAt(0) + n.slice(1).toLowerCase() : n;
  return `${nice} ${KIND_SHORT[i.kind] ?? KIND_LABEL[i.kind].toLowerCase()}`;
}
function renderRanks() {
  const tab = sheetTab.ranksSheet;
  const mine = owned();
  let html = '';
  if (tab === 'ranks') {
    const t = tierOf(me.rating), n = nextTier(me.rating);
    html += '<div class="rkLadder">' + [...TIERS].reverse().map(x => {
      const isMe = x.key === t.key;
      const rw = rankRewards(x.key);
      const got = rw.filter(i => mine.has(i.id)).length;
      const line = x.min === -Infinity ? 'Everyone starts here' : `${fmt(x.min)}+ rating`;
      const rewards = rw.length ? `<small class="rkRw">${rw.map(i => esc(rewardLabel(i))).join(' · ')}${got ? ` <span class="up">${got === rw.length ? '✓ yours' : `${got}/${rw.length} yours`}</span>` : ''}</small>` : '';
      return `<div class="rkRung${isMe ? ' me' : ''}">${tierBadge(x)}<span class="rkMid"><b>${x.name}</b><small>${line}</small>${rewards}</span>${isMe ? `<span class="rkYou">YOU · ${fmt(me.rating)}</span>` : ''}</div>`;
    }).join('') + '</div>';
    const lo = t.min === -Infinity ? 1000 : t.min, hi = n ? n.min : lo;
    const pctNext = n ? Math.max(4, Math.min(100, Math.round(((me.rating - Math.min(lo, me.rating)) / Math.max(1, hi - Math.min(lo, me.rating))) * 100))) : 100;
    html += `<div class="rkProg"><div><span>${t.name} · ${fmt(me.rating)}</span><span>${n ? `<b>${n.min - me.rating}</b> rating to ${n.name}` : 'Top rank. Stay there!'}</span></div><i><b style="width:${pctNext}%"></b></i></div>`;
    const k0 = K_STEPS[0]! / 2;
    const steps = [...K_STEPS.map(k => k / 2), 0].join(' → ');
    html += `<h4>How rating moves <span class="sub">Ranked only</span></h4><div class="rkRules">`
      + `<div><b class="up">+${k0}</b><span>Beat a player at your level</span></div>`
      + `<div><b class="down">−${k0}</b><span>Lose to a player at your level</span></div>`
      + `<div><b class="gold">±</b><span>Beat someone stronger and you get more. Lose to someone weaker and you lose more.</span></div>`
      + `<div><b>${k0}→0</b><span>Playing the same person again within 24 hours counts less each time (${steps}).</span></div></div>`
      + `<div class="rkChips"><div><b>Monthly seasons</b>On the 1st, ratings move halfway back to 1,000.</div><div><b>Weekly board</b>3 points a Ranked win, 1 a draw. Resets on Mondays.</div></div>`
      + `<p class="muted small ctr">Everyone starts at 1,000. Reaching a rank for the first time unlocks its rewards for good.</p>`;
  } else {
    const s = info();
    const evOn = !!s && !!s.eventName && Number(BigInt(s.eventEndsAt ?? 0) / 1000n) > Date.now() && Number(BigInt(s.eventStartsAt ?? 0) / 1000n) <= Date.now();
    if (evOn) html += `<div class="noticeBar evBar" style="margin:0"><b>${esc(s.eventName)}</b> is on: ${[s.eventCoinPct > 100 ? `${s.eventCoinPct / 100}× coins` : '', s.eventXpPct > 100 ? `${s.eventXpPct / 100}× XP` : ''].filter(Boolean).join(' and ')} from every match.</div>`;
    const MODES: [string, string, string][] = [['ranked', 'Ranked', '#ffc83d'], ['casual', 'Unranked', '#6fe0ff'], ['room', 'Friend', '#ff7ac0'], ['practice', 'Practice', '#3ee6a0'], ['daily', 'Daily', '#ffb25b']];
    const cell = (mode: string, res: 'win' | 'draw' | 'loss') => {
      const xp = Math.round((XP[res] + (mode === 'daily' ? XP.dailyBonus : 0)) * (XP_MULT[mode] ?? 1));
      const coins = Math.round(COINS[res] * (COIN_MULT[mode] ?? 1));
      return `<td><b>${xp} XP</b><small>${coins}${mode === 'daily' && res === 'win' ? ` +${COINS.dailyWin}` : ''}</small></td>`;
    };
    html += `<h4>Every match <span class="sub">XP, then coins</span></h4><div class="rkTable"><table><tr><th>Match type</th><th>Win</th><th>Draw</th><th>Loss</th></tr>`
      + MODES.map(([m, label, col]) => `<tr><td><span class="rkMode"><i style="background:${col}"></i>${label}</span></td>${cell(m, 'win')}${cell(m, 'draw')}${cell(m, 'loss')}</tr>`).join('')
      + '</table></div>';
    const coin = '<i class="coin"></i>';
    html += `<h4>Bonuses</h4><div class="rkBonus">`
      + `<div><span>First win of the day</span><b>${coin}+${COINS.firstWin}</b></div>`
      + `<div><span>Play the daily challenge</span><b>${coin}+${COINS.dailyPlay}</b></div>`
      + `<div><span>Level up (every 5th level)</span><b>${coin}+${COINS.level} (+${COINS.level5})</b></div>`
      + `<div><span>An award (big ones)</span><b>${coin}+${COINS.ach} (+${COINS.achBig})</b></div>`
      + `<div><span>Your opponent quits (×${XP_MULT.ranked} in Ranked)</span><b>${XP.walkover} XP · ${coin}${COINS.walkover}</b></div></div>`
      + `<p class="muted small">Each level needs 25 more XP than the last (100, 125, 150…). Ranked pays ${XP_MULT.ranked}×; Practice and bots pay half. Coins are only ever earned by playing.</p>`;
  }
  $('ranksSheetBody').innerHTML = html;
}
$('btnRank').onclick = () => openSheet('ranksSheet', 'ranks');
$('statsSheet').addEventListener('click', (e: Event) => { if ((e.target as HTMLElement).closest('[data-ranks]')) openSheet('ranksSheet', 'ranks'); });
$('statsSheet').addEventListener('keydown', (e: KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).closest('[data-ranks]')) { e.preventDefault(); openSheet('ranksSheet', 'ranks'); } });

// ---------- rank up: the first time you reach Silver, Gold or Diamond ----------
const rankUpQueue: string[] = [];
let rankUpShown = '';
function showRankUp() {
  if (!$('rankUp').classList.contains('hide')) return;
  const k = rankUpQueue.shift();
  if (!k) return;
  const t = TIERS.find(x => x.key === k)!;
  rankUpShown = k;
  $('ruEm').innerHTML = tierBadge(t);
  $('rankUp').querySelector('.rankUpModal')!.className = `modal rankUpModal ru-${k}`;
  $('ruTitle').textContent = `${t.name.toUpperCase()}!`;
  $('ruSub').textContent = `You reached ${t.name} · ${fmt(me.rating)} rating`;
  $('ruGot').innerHTML = rankRewards(k).map(i => `<div>${itemArt(i.id, 40, me.avatar)}<span><b>${esc(nameOf(i.id))}</b><small>${esc(KIND_LABEL[i.kind])}</small></span></div>`).join('');
  $('rankUp').classList.remove('hide');
  sfx.unlock(); vibrate([20, 40, 20, 40, 60]);
  setTimeout(() => burstAt($('ruEm'), t.key === 'diamond' ? ['#e6fdff', '#7fe3ff', '#d79cff'] : t.key === 'gold' ? ['#ffc83d', '#fff3c4', '#ffb21f'] : ['#ffffff', '#c3c9e6'], 28), 250);
}
function closeRankUp() { $('rankUp').classList.add('hide'); if (rankUpQueue.length) setTimeout(showRankUp, 400); }
if (import.meta.env.DEV) (window as any).__rankUp = (k: string) => { rankUpQueue.push(k); showRankUp(); }; // try the rank-up moment from the console while developing
$('ruLater').onclick = closeRankUp;
$('ruWear').onclick = async () => {
  for (const i of rankRewards(rankUpShown)) if (i.kind !== 'pack') await call('equip', { kind: i.kind, key: i.key });
  toast('Wearing your new rank rewards');
  closeRankUp();
};

const pct = (w: number, n: number) => (n ? Math.round((w / n) * 100) + '%' : '—');
/** My stats: Overview, Cards, Awards and History, each fitting one screen. */
function renderStats() {
  const s = myStats() || {};
  const played = me.wins + me.losses + me.draws;
  const { level } = myLevel();
  $('statsSheetTop').innerHTML = `<div class="stHead">${avatarHtml(me.avatar, me.frame, 48)}<span><b>${esc(me.name)}</b><small>Level ${level} · ${tierOf(me.rating).name} ${fmt(me.rating)}</small></span></div>`;
  const tab = sheetTab.statsSheet;
  const cell = (v: any, l: string) => `<div><b>${v}</b><small>${l}</small></div>`;
  let html = '';
  if (tab === 'overview') {
    const hist = Array.from(conn.db.myHistory.iter()).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 10);
    html = `<div class="stGrid">${[cell(played, 'Matches'), cell(pct(me.wins, played), 'Win rate'), cell(s.streak || 0, 'Win streak'),
      cell(s.bestStreak || 0, 'Best streak'), cell(s.perfects || 0, 'Perfect 10s'), cell(s.dailyStreak || 0, 'Daily streak')].join('')}</div>`
      + `<h4>Last 10 matches <span class="sub">Newest first</span></h4><div class="last10">${hist.length ? hist.map(h => `<i class="o${h.result[0]}">${h.result === 'win' ? 'W' : h.result === 'loss' ? 'L' : 'D'}</i>`).join('') : '<span class="muted">No matches yet. Play one to see your stats.</span>'}</div>`;
    const last = s.lastSeason;
    html += `<h4>Rank <span class="sub">tap for how ranks work</span></h4><div class="rankRow" role="button" tabindex="0" data-ranks>${tierBadge(tierOf(me.rating))}<span><b>${tierOf(me.rating).name} · ${fmt(me.rating)}</b><small>${(() => { const n = nextTier(me.rating); return n ? `${n.min - me.rating} rating to ${n.name}` : 'Top rank. Stay there!'; })()}${last ? ` · last season ${tierOf(last).name} (${last})` : ''}</small></span></div>`;
  } else if (tab === 'cards') {
    const plays = [s.plays0 || 0, s.plays1 || 0, s.plays2 || 0], wins = [s.wins0 || 0, s.wins1 || 0, s.wins2 || 0];
    const opens = [s.opens0 || 0, s.opens1 || 0, s.opens2 || 0];
    const fav = Math.max(...opens) > 0 ? KINDS[opens.indexOf(Math.max(...opens))] : null;
    html = '<h4>Win rate by card</h4><div class="cardRates">' + KINDS.map((k, i) => {
      const r = plays[i] ? wins[i]! / plays[i]! : 0;
      return `<div class="cr k-${k}"><span class="crIc">${ICON[k]}</span><div class="crBar"><i style="width:${Math.round(r * 100)}%"></i></div>`
        + `<b>${pct(wins[i]!, plays[i]!)}</b><small>${plays[i]} played</small></div>`;
    }).join('') + (fav ? `<div class="crFav">Favourite opening card: ${mini(fav)} <b>${fav}</b></div>` : '') + '</div>';
  } else if (tab === 'awards') {
    const got = new Map(Array.from(conn.db.myAchievements.iter(), a => [a.key, a.at] as const));
    html = `<h4>Awards <span class="sub">${got.size} of ${ACHIEVEMENTS.length}</span></h4><div class="achGrid">` + ACHIEVEMENTS.map(a => {
      const on = got.has(a.key);
      const aura = ITEMS.find(i => i.ach === a.key);
      return `<div class="ach${on ? ' on' : ''}" title="${esc(a.how)}"><span class="achIc">${on ? a.icon : '🔒'}</span><b>${esc(a.name)}</b><small>${esc(a.how)}${aura ? ` · unlocks the ${nameOf(aura.id)} aura` : ''}</small></div>`;
    }).join('') + '</div>';
  } else {
    const hist = Array.from(conn.db.myHistory.iter()).sort((a, b) => (a.id < b.id ? 1 : -1));
    const MODE: Record<string, string> = { ranked: 'Ranked', casual: 'Unranked', room: 'Friend', bot: 'Online · bot', practice: 'Practice', daily: 'Daily' };
    html = '<div class="hist">' + (hist.length ? hist.map(h => {
      const dots = [...h.outcomes].map((o, i) => `<i class="o${o}" title="Round ${i + 1}: ${h.cards[i] === '-' ? 'too slow' : KINDS['rps'.indexOf(h.cards[i]!)]}"></i>`).join('');
      const rc = h.ratingChange ? `<span class="${h.ratingChange > 0 ? 'up' : 'down'}">${h.ratingChange > 0 ? '+' : ''}${h.ratingChange}</span>` : '';
      return `<div class="hr ${h.result}"><span class="hrRes">${h.result === 'win' ? 'W' : h.result === 'loss' ? 'L' : 'D'}</span>`
        + `<div class="hrMid"><div class="hrTop"><b>${esc(h.opp)}</b><span class="hrMode">${MODE[h.mode] || h.mode}</span></div><div class="hrDots">${dots}</div></div>`
        + `<div class="hrScore"><b>${h.you}–${h.them}</b>${rc}<small>${ago(h.at.toDate().getTime())}</small></div></div>`;
    }).join('') : '<div class="empty">No matches yet. Play one to see your history.</div>') + '</div>';
  }
  $('statsSheetBody').innerHTML = html;
}
function ago(t: number) {
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
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
    art: () => tc('paper', 'big hi') + '<span class="num">10<small>sec</small></span>' + `<div class="tc big back">${backHtml('classic')}</div>` },
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
  setTrack(s.phase === 'over' ? null : s.round >= s.totalRounds ? 'final' : 'match');
  if (entering && (s.phase === 'pick' || s.phase === 'prep')) flashTitle();
  renderGame(entering, firstOfGame);
  syncChat(firstOfGame);
  prevPhase = s.phase; prevRound = s.round;
  if (!raf) raf = requestAnimationFrame(frame);
}

function renderGame(entering: boolean, firstOfGame: boolean) {
  const s = G;
  const heads = `${s.gameId}:${s.opp.avatar}:${s.opp.frame}:${s.opp.title}:${me && me.avatar}:${me && me.frame}:${me && me.title}`;
  if ($('hud').dataset.h !== heads) {
    $('hud').dataset.h = heads;
    $('avYou').innerHTML = me ? avatarHtml(me.avatar, me.frame, 42) : '';
    $('avOpp').innerHTML = avatarHtml(s.opp.avatar, s.opp.frame, 42);
    $('ttlYou').innerHTML = me ? titleHtml(me.title) : '';
    $('ttlOpp').innerHTML = s.opp.isBot ? `<span class="ttl bot">${s.mode === 'daily' ? 'DAILY' : 'BOT'}</span>` : titleHtml(s.opp.title);
  }
  $('nameYou').textContent = s.you.name;
  $('nameOpp').textContent = s.opp.name;
  const mySkin = (me && me.skin) || 'classic';
  $('hand').dataset.skin = mySkin; $('slotYou').dataset.skin = mySkin; $('slotOpp').dataset.skin = s.opp.skin || 'classic';
  $('watchers').textContent = s.watchers ? `${s.watchers} watching` : '';
  $('watchers').classList.toggle('hide', !s.watchers);
  $('totalR').textContent = s.totalRounds;
  $('round').textContent = s.round;
  const final = s.round >= s.totalRounds && s.phase !== 'prep';
  $('roundLbl').textContent = s.phase === 'prep' || s.phase === 'intro' ? 'GET READY' : final ? 'FINAL ROUND' : 'ROUND';
  document.body.classList.toggle('finalRound', final && s.phase !== 'over');
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
      return `<span class="ob" style="--r:${(d * 4).toFixed(1)}deg;--y:${(Math.abs(d) * 1.6).toFixed(1)}px">${backHtml(s.opp.back)}</span>`;
    }).join('');
  }
  renderTracker();

  const phase = s.phase;
  const prep = phase === 'prep';
  $('prep').classList.toggle('on', prep);
  // "Opponent found": who you're up against, and a 3-2-1 countdown while both players connect
  $('introOv').classList.toggle('hide', phase !== 'intro');
  if (phase === 'intro') renderIntro(s, entering);
  if (entering && prevIntro && phase === 'prep') sfx.go();
  prevIntro = phase === 'intro';
  document.body.dataset.phase = phase;

  // the one action button: always in place so the layout never jumps
  const btn = $('readyBtn');
  btn.className = 'btn action';
  if (phase === 'intro') {
    btn.disabled = true;
    btn.textContent = 'Get ready…';
  } else if (prep) {
    $('chipYou').textContent = s.you.ready ? 'You ✓' : 'You'; $('chipYou').className = 'chip' + (s.you.ready ? ' ok' : '');
    $('chipOpp').textContent = s.opp.name + (s.opp.ready ? ' ✓' : ''); $('chipOpp').className = 'chip' + (s.opp.ready ? ' ok' : '');
    btn.disabled = s.you.ready;
    btn.classList.add('go');
    btn.textContent = s.you.ready ? (s.opp.ready ? 'Starting…' : 'Waiting for opponent…') : 'Ready';
  } else if (phase === 'pick') {
    btn.disabled = !localSel || s.you.locked;
    btn.classList.add(s.you.locked ? 'done' : 'lockIn');
    btn.innerHTML = s.you.locked ? (s.opp.placed ? 'Revealing…' : `${LOCK} Locked`)
      : localSel ? `${LOCK} Lock in<kbd class="dk">Enter</kbd>` : 'Pick a card';
  } else {
    btn.disabled = true;
    btn.textContent = phase === 'banner' ? 'Get ready…' : phase === 'reveal' ? 'Revealing…' : phase === 'result' ? 'Next round…' : 'Match over';
  }
  btn.classList.toggle('hide', phase === 'over');
  renderHint();

  // round banner
  if (phase === 'banner' && entering) {
    $('bn0').textContent = s.round === 1 ? 'Match start' : `${s.you.score} – ${s.opp.score}`;
    $('bn1').textContent = s.round === s.totalRounds ? 'FINAL ROUND' : `ROUND ${s.round}`;
    $('banner').classList.toggle('final', s.round === s.totalRounds);
    $('bn2').textContent = s.round === s.totalRounds ? (s.you.score === s.opp.score ? 'Winner takes the match' : 'Last card each') : 'Choose your card · 10 seconds';
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
    setSlot('slotOpp', s.opp.placed ? 'down' : 'empty thinking', s.opp.placed ? backHtml(s.opp.back) : '<span class="dots3"><i></i><i></i><i></i></span>');
    $('lblOpp').textContent = s.opp.placed ? `${s.opp.name} · locked` : s.opp.name;
  }
  if ((phase === 'reveal' || phase === 'result') && s.reveal) {
    const r = s.reveal, k = `${s.gameId}:${r.n}`;
    // draw the revealed cards when the reveal starts, or when we join the game partway through it
    if (entering && (phase === 'reveal' || prevPhase !== 'reveal')) {
      const anim = phase === 'reveal';
      const slow = '<span class="slow">Too<br>slow</span>';
      $('lblYou').textContent = r.youAuto ? 'You · auto-played' : 'You';
      $('lblOpp').textContent = r.oppAuto ? `${s.opp.name} · auto-played` : s.opp.name;
      if (anim) {
        // hold for a second: your card stays face up (you know it); the opponent's sits face down,
        // so each player sees the other's card back, then it flips
        faceDown = k;
        setSlot('slotYou', r.you ? 'face slam' : 'miss', r.you ? face(r.you) : slow);
        setSlot('slotOpp', r.opp ? 'down slam' : 'miss', r.opp ? backHtml(s.opp.back) : slow);
        sfx.thud(); vibrate(20);
        renderHint(); // no spoilers while the cards are face down
        clearTimeout(flipTimer); clearTimeout(clashTimer);
        flipTimer = setTimeout(() => {
          if (!G || faceDown !== k) return;
          faceDown = '';
          const fl = (kind: string, back: string) => `<span class="fl"><span class="flF">${face(kind)}</span><span class="flB">${backHtml(back)}</span></span>`;
          if (r.opp) setSlot('slotOpp', 'face flip', fl(r.opp, s.opp.back));
          sfx.flip();
          renderHint();
          clashTimer = setTimeout(() => clash(r, k), 650);
        }, FACE_DOWN_MS);
      } else {
        setSlot('slotYou', r.you ? 'face' : 'miss', r.you ? face(r.you) : slow);
        setSlot('slotOpp', r.opp ? 'face' : 'miss', r.opp ? face(r.opp) : slow);
      }
    }
    if (phase === 'result') {
      if (clashDone !== k) clash(r, k);
      if (entering) {
        const res = r.result;
        showRibbon(!r.you && r.opp ? 'Too slow · round lost' : !r.opp && r.you ? 'They were too slow!' : res === 'win' ? `You win round ${r.n}!` : res === 'loss' ? `Round ${r.n} lost` : 'Draw', res);
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

const VERB: Record<string, string> = { rock: 'crushes', paper: 'wraps', scissors: 'cut' };
const cap = (k: string) => k[0]!.toUpperCase() + k.slice(1);
const finePointer = matchMedia('(hover:hover) and (pointer:fine)').matches;
/** The line between the table and your hand: what to do now, or what just happened. */
function renderHint() {
  const s = G; let t = '';
  if (s.phase === 'prep') {
    const n = [0, 0, 0]; for (const c of localHand) n[KINDS.indexOf(c.t)]! += 1;
    t = `You have ${n[0]} Rock, ${n[1]} Paper, ${n[2]} Scissors`;
  } else if (s.phase === 'pick') {
    t = s.you.locked ? (s.opp.placed ? 'Both locked in · revealing…' : `Locked in · waiting for ${esc(s.opp.name)}`)
      : localSel ? (finePointer ? 'Press <kbd>Enter</kbd> to lock in, or pick another card' : 'Tap Lock in, or tap another card to change')
      : finePointer ? 'Press <kbd>1</kbd>–<kbd>0</kbd> or click a card' : 'Tap a card to pick it';
    if (s.round >= s.totalRounds && !s.you.locked) t = 'One card each. What have they played so far?';
  } else if ((s.phase === 'reveal' || s.phase === 'result') && s.reveal && faceDown === `${s.gameId}:${s.reveal.n}`) {
    t = s.reveal.youAuto ? 'Too slow · a random card was played for you…' : s.reveal.youGone ? 'Too slow · you lost this round…' : 'Both cards are in…';
  } else if ((s.phase === 'reveal' || s.phase === 'result') && s.reveal) {
    const r = s.reveal;
    if (r.youGone) t = `Too slow · a random card left your hand: <b>${cap(r.youGone)}</b>`;
    else if (r.oppGone && !r.opp) t = `${esc(s.opp.name)} was too slow and lost a card: <b>${cap(r.oppGone)}</b>`;
    else if (r.you && r.opp) t = r.you === r.opp ? `Both played ${cap(r.you)}` : beats(r.you, r.opp) ? `${cap(r.you)} ${VERB[r.you]} ${cap(r.opp)}` : `${cap(r.opp)} ${VERB[r.opp]} ${cap(r.you)}`;
    else t = !r.you && !r.opp ? 'Nobody locked in' : !r.you ? 'Lock in before the timer ends' : '';
    if (r.youAuto && !r.youGone) t = `Too slow · ${cap(r.you)} was played for you · ` + t;
    if (s.phase === 'result' && s.round < s.totalRounds) t += ` · round ${s.round + 1} next`;
  }
  if ($('hint').dataset.h !== t) { $('hint').innerHTML = t; $('hint').dataset.h = t; }
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
const MATCH_LABEL: Record<string, string> = { ranked: 'Ranked match', casual: 'Unranked match', room: 'Friend match', bot: 'Online match', practice: 'Practice', daily: 'Daily challenge' };
/** "Opponent found": both players, their rank and whether they're connected, and the countdown. */
function renderIntro(s: any, entering: boolean) {
  if (entering) {
    introSec = -1;
    $('inTitle').textContent = s.mode === 'daily' ? 'DAILY CHALLENGE' : s.mode === 'practice' ? 'PRACTICE MATCH' : 'OPPONENT FOUND';
    $('inMode').textContent = MATCH_LABEL[s.mode] || 'Match';
    $('inMode').className = `inMode m-${s.mode}`;
    const t = tierOf(me.rating);
    $('inYou').innerHTML = `${avatarHtml(me.avatar, me.frame, 72)}<b>${esc(s.you.name)}</b><small>${tierBadge(t, 'xs')}${t.name} ${fmt(me.rating)}</small>${titleHtml(me.title)}<span class="inSt ok">✓ Connected</span>`;
  }
  const ot = tierOf(s.opp.rating || 1000);
  const oppSt = s.opp.isBot ? '<span class="inSt ok">✓ Ready</span>' : s.opp.connected ? '<span class="inSt ok">✓ Connected</span>' : '<span class="inSt wait">Connecting…</span>';
  const html = `${avatarHtml(s.opp.avatar, s.opp.frame, 72)}<b>${esc(s.opp.name)}</b><small>${s.opp.isBot ? '<span class="ttl bot">BOT</span>' : `${tierBadge(ot, 'xs')}${ot.name} ${fmt(s.opp.rating)}`}</small>${s.opp.isBot ? '' : titleHtml(s.opp.title)}${oppSt}`;
  if ($('inOpp').dataset.h !== html) { $('inOpp').innerHTML = html; $('inOpp').dataset.h = html; }
}

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
  for (const l of G.log) {
    if (l.opp) played[KINDS.indexOf(l.opp)]! += 1;
    if (l.oppGone) played[KINDS.indexOf(l.oppGone)]! += 1; // a card they lost to a missed turn
  }
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
  if (G.phase === 'intro') {
    const sec = Math.max(1, Math.ceil(ms / 1000));
    if (sec !== introSec) {
      introSec = sec;
      const el = $('inCount');
      el.textContent = String(sec);
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
      sfx.count(); vibrate(12);
    }
  }
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
  if (G.xpGain) chips.push(`<span class="xp">+${G.xpGain} XP</span>`);
  if (G.coinGain) chips.push(`<span class="coins"><i class="coin"></i>+${G.coinGain}</span>`);
  if (G.rated) chips.push(`<span class="${G.ratingChange >= 0 ? 'up' : 'down'}">Rating ${G.ratingChange >= 0 ? '+' : ''}${G.ratingChange}</span>`);
  if (me && !unlockedBefore && me.practiceDone && G.opp.isBot && e.reason === 'points') chips.push('<span class="up">Online play unlocked</span>');
  if (G.mode === 'daily') { const st = dailyState(); if (st.streak) chips.push(`${st.streak}-day streak`); }
  for (const k of achNew) { const a = achievementOf(k); if (a) chips.push(`<span class="up">${a.icon} ${esc(a.name)}</span>`); }
  $('endChips').innerHTML = chips.map(c => `<span class="ec">${c}</span>`).join('');
  // the winner's win effect: yours at full strength, or theirs dimmed with their name on it
  const fxLbl = $('fxLabel');
  const theirFx = res === 'loss' && G.opp.fx && G.opp.fx !== 'confetti';
  fxLbl.classList.toggle('hide', !theirFx);
  if (theirFx) fxLbl.textContent = `${G.opp.name}'s win effect: ${nameOf('fx:' + G.opp.fx)}`;
  renderRematch();
  $('banner').classList.remove('on');
  $('confirmLeave').classList.add('hide');
  $('over').classList.remove('hide');
  if (endShown !== G.gameId) {
    endShown = G.gameId;
    showLog(false);
    if (res === 'win') { sfx.victory(); winEffect((me && me.fx) || 'confetti'); vibrate([30, 60, 30, 60, 80]); }
    else if (res === 'loss') { sfx.defeat(); if (G.opp.fx && G.opp.fx !== 'confetti') winEffect(G.opp.fx, true); vibrate(120); }
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
  $('btnAgain').classList.toggle('hide', !(G.mode === 'ranked' || G.mode === 'casual' || G.mode === 'bot'));
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
  call('leaveGame').then(() => call(G && G.mode === 'casual' ? 'joinCasual' : mode === 'casual' ? 'joinCasual' : 'joinQueue'));
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
  const lead = G.you.score > G.opp.score ? 'winning' : G.you.score < G.opp.score ? 'losing' : 'level';
  const kind = G.mode === 'ranked' ? 'a ranked match' : G.mode === 'casual' ? 'an unranked match' : G.mode === 'room' ? 'a friend match' : G.mode === 'daily' ? "today's daily challenge" : 'a practice match';
  $('leaveScore').textContent = `You're ${lead} ${G.you.score}–${G.opp.score} in ${kind}.`;
  $('leaveNote').textContent = G.mode === 'ranked' ? `Leaving counts as a loss: you lose rating, get no XP and no coins, and ${G.opp.name} wins.`
    : G.mode === 'casual' ? "Leaving counts as a loss, with no XP or coins. Your rating doesn't change."
    : G.mode === 'room' ? `Your friend wins this match.`
    : G.mode === 'daily' ? "It counts as a loss and uses up today's try."
    : me && !me.practiceDone ? 'It counts as a loss, and you still need one finished practice match to unlock online play.'
    : 'It counts as a loss.';
  closeModals();
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
      h += `<tr class="${i === 0 ? 'new' : ''}"><td class="n">${r.n}</td><td>${r.you ? mini(r.you) + (r.youAuto ? '<small class="auto">auto</small>' : '') : r.youGone ? `<span class="gone">${mini(r.youGone)}</span>` : '<span class="none">—</span>'}</td><td>${r.opp ? mini(r.opp) + (r.oppAuto ? '<small class="auto">auto</small>' : '') : r.oppGone ? `<span class="gone">${mini(r.oppGone)}</span>` : '<span class="none">—</span>'}</td><td><span class="res ${r.result}">${r.you ? lbl[r.result] : 'MISSED'}</span></td></tr>`;
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

// ---------- quick chat ----------
// Only your loadout (set in Locker › Chat), one tap each: there is no typing. Reactions slam in as stickers,
// phrases pop out as tickets in the sender's message colour. Muting hides the opponent's on this device.
const MUTE_CHAT_KEY = 'rps10_chatmute';
let chatGame = '', chatSeen = 0n, unread = 0, chatSig = '', trayKey = '';
let chatMuted = store.get(MUTE_CHAT_KEY) === '1';
$('chatIc').innerHTML = CHAT;
$('chatMute').checked = chatMuted;
function setChatMuted(m: boolean) {
  chatMuted = m;
  store.set(MUTE_CHAT_KEY, m ? '1' : null);
  $('chatMute').checked = m;
  if (m) { hideBubble('bubOpp'); unread = 0; renderBadge(); }
  if (G) renderChat(true);
}
/** The tray: your 6 reactions and 4 phrases. */
function renderTray() {
  if (!me) return;
  const lo = loadout();
  const key = me.reactions + '|' + me.phrases + '|' + me.color;
  if (key === trayKey) return;
  trayKey = key;
  $('chatEmoji').innerHTML = lo.r.map(r => `<button type="button" class="emo" data-e="${r}" aria-label="Send ${esc(reactionName(r))}">${reactionSvg(r)}</button>`).join('');
  $('chatPhrases').innerHTML = lo.p.map(p => `<button type="button" class="phr" data-p="${esc(p)}">${ticketHtml(p, me.color, 's')}</button>`).join('');
}

const chatOpen = () => document.body.classList.contains('chatOpen');
function showChat(open: boolean) {
  document.body.classList.toggle('chatOpen', open);
  if (open) { showLog(false); unread = 0; renderTray(); renderChat(true); }
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
$('chatMute').onchange = () => setChatMuted($('chatMute').checked);
$('chatEdit').onclick = () => {
  showChat(false);
  if (G && !G.ended) { toast('Edit your quick chat in the Locker after this match.'); return; }
  openSheet('lockerSheet', 'chat');
};

function chatRows() {
  return Array.from(conn.db.myChat.iter()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
const chatItem = (m: any, color: string) => (m.kind === 'emoji' ? `<span class="stk">${reactionSvg(m.body)}</span>` : ticketHtml(m.body, color));
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
      bubble(m.mine ? 'bubYou' : 'bubOpp', m.kind, m.body, m.mine ? (me ? me.color : 'green') : G.opp.color);
      if (!m.mine) {
        sfx.msg();
        if (!chatOpen()) unread++;
        if (G.phase === 'over' && !chatOpen()) toast(`${G.opp.name}: ${m.kind === 'emoji' ? reactionName(m.body) : m.body}`);
      }
    }
    chatSeen = last;
  }
  $('chatMute').parentElement.classList.toggle('hide', !!G.opp.isBot);
  renderTray();
  renderBadge();
  renderChat(false);
}
function renderChat(scroll: boolean) {
  const rows = chatRows().filter(m => m.mine || !chatMuted);
  const sig = rows.map(m => String(m.id)).join() + (chatMuted ? 'm' : '');
  if (sig === chatSig && !scroll) return;
  const grew = sig !== chatSig;
  chatSig = sig;
  const html = rows.length ? rows.map(m =>
    `<div class="cm ${m.mine ? 'me' : 'them'}${m.kind === 'emoji' ? ' emoji' : ''}">${chatItem(m, m.mine ? (me ? me.color : 'green') : G ? G.opp.color : 'green')}</div>`).join('')
    : `<div class="empty">${chatMuted ? 'Opponent muted' : 'Send a reaction or a quick message'}</div>`;
  for (const id of ['chatList', 'sideChat']) {
    const list = $(id);
    list.innerHTML = id === 'sideChat' ? `<h4>Chat <button class="link sm" type="button" data-open-chat>Send</button></h4>${html}` : html;
    if (grew || scroll) list.scrollTop = list.scrollHeight;
  }
}
$('sideChat').addEventListener('click', (e: Event) => { if ((e.target as HTMLElement).closest('[data-open-chat]')) showChat(true); });
const bubTimers: Record<string, any> = {};
function bubble(id: string, kind: string, body: string, color: string) {
  const el = $(id);
  el.className = 'bub ' + (id === 'bubYou' ? 'you' : 'opp') + (kind === 'emoji' ? ' emoji' : ' text');
  el.innerHTML = kind === 'emoji' ? `<span class="burst"></span><span class="stk">${reactionSvg(body)}</span>` : ticketHtml(body, color, 'say');
  void el.offsetWidth; el.classList.add('on');
  clearTimeout(bubTimers[id]);
  bubTimers[id] = setTimeout(() => hideBubble(id), kind === 'emoji' ? 2200 : 3800);
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
  b.textContent = st === 'in' ? `Accept ${G ? G.opp.name : ''}'s friend request` : st === 'out' ? 'Friend request sent' : 'Add friend';
  $('btnReport').classList.toggle('hide', !person || reportedGame === (G && G.gameId));
}
$('btnAddFriend').onclick = () => {
  if (!G) return;
  const was = G.opp.friend;
  call('addOpponent').then(ok => { if (ok) toast(was === 'in' ? `You and ${G ? G.opp.name : 'they'} are now friends` : 'Friend request sent'); });
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

// ---------- Locker: only what you own ----------
const LOOK_FIELD: Partial<Record<ItemKind, string>> = { avatar: 'avatar', aura: 'frame', skin: 'skin', back: 'back', color: 'color', fx: 'fx', title: 'title' };
const wearing = (kind: ItemKind, key: string) => (me as any)[LOOK_FIELD[kind]!] === key;
let chatSlot: { kind: 'r' | 'p'; i: number } | null = null;
const loadout = () => ({
  r: me.reactions ? String(me.reactions).split(',').filter(Boolean) : [],
  p: me.phrases ? String(me.phrases).split('|').filter(Boolean) : [],
});
function ownedTiles(kind: ItemKind, mine: Set<string>, size = 56) {
  return itemsOf(kind).filter(i => mine.has(i.id)).map(i => {
    const on = wearing(kind, i.key);
    return `<button class="own${on ? ' eq' : ''}" type="button" data-eq="${kind}" data-key="${esc(i.key)}" aria-pressed="${on}">${on ? '<span class="badgeOn">On</span>' : ''}${itemArt(i.id, size, me.avatar)}<b>${esc(nameOf(i.id))}</b><small>${on ? 'Equipped' : 'Tap to use'}</small></button>`;
  }).join('');
}
/** Rank rewards: every item a rank unlocks, owned ones ready to wear, the rest locked with how to get them. */
const RANK_ORDER = ['silver', 'gold', 'diamond'] as const;
const rankRewards = (rank: string) => ITEMS.filter(i => i.ach === rank);
function rankRewardTiles(mine: Set<string>) {
  return RANK_ORDER.map(r => {
    const t = TIERS.find(x => x.key === r)!;
    const tiles = rankRewards(r).map(i => {
      if (!mine.has(i.id)) return `<div class="own locked" title="${esc(descOf(i.id))}">${itemArt(i.id, 48, me.avatar)}<b>${esc(nameOf(i.id))}</b><small>🔒 Reach ${t.name}</small></div>`;
      const on = wearing(i.kind, i.key);
      return `<button class="own${on ? ' eq' : ''}" type="button" data-eq="${i.kind}" data-key="${esc(i.key)}" aria-pressed="${on}">${on ? '<span class="badgeOn">On</span>' : ''}${itemArt(i.id, 48, me.avatar)}<b>${esc(nameOf(i.id))}</b><small>${on ? 'Equipped' : 'Tap to use'}</small></button>`;
    }).join('');
    return `<div class="rrHead">${tierBadge(t, 'sm')}<b>${t.name}</b><small>${fmt(t.min)} rating</small></div><div class="ownGrid">${tiles}</div>`;
  }).join('');
}
const countOwned = (kind: ItemKind, mine: Set<string>) => itemsOf(kind).filter(i => mine.has(i.id) && i.key !== '').length;
const moreLink = (tab: string, text: string, sub: string) => `<button class="moreLink" type="button" data-store="${tab}"><b>${text} ›</b><small>${sub}</small></button>`;
function nextFree(kind: ItemKind) {
  const lvl = myLevel().level;
  const n = itemsOf(kind).filter(i => i.level && i.level > lvl).sort((a, b) => a.level! - b.level!)[0];
  return n ? `Next free: ${nameOf(n.id)} at level ${n.level}` : 'All unlocked on the Level road';
}
function renderLocker() {
  const mine = owned();
  $('lockerSheetTop').innerHTML = `<div class="lkTop">${avatarHtml(me.avatar, me.frame, 64)}<span class="lkWho"><b>${esc(me.name)}</b>${titleHtml(me.title)}</span>${skinTrio(me.skin, 'sm')}</div>`;
  const tab = sheetTab.lockerSheet;
  let html = '';
  if (tab === 'cards') {
    html = `<div class="h4"><span>Your card styles</span><span class="gold">${countOwned('skin', mine)} owned</span></div><div class="ownGrid">${ownedTiles('skin', mine)}</div>`
      + `<div class="h4"><span>Card back</span><span class="gold">what your opponent sees</span></div><div class="ownGrid">${ownedTiles('back', mine)}</div>`
      + `<div class="moreRow">${moreLink('skin', 'Store', `${itemsOf('skin').filter(i => !mine.has(i.id)).length} more card styles`)}${moreLink('road', 'Level road', nextFree('skin'))}</div>`;
  } else if (tab === 'chat') {
    const lo = loadout();
    const slot = (kind: 'r' | 'p', i: number, content: string) =>
      `<button class="slotBtn ${kind === 'r' ? 'rSlot' : 'pSlot'}${chatSlot && chatSlot.kind === kind && chatSlot.i === i ? ' sel' : ''}${content ? '' : ' empty'}" type="button" data-slot="${kind}${i}">${content || '+'}</button>`;
    html = `<div class="h4"><span>Your quick chat</span><span class="gold">what shows in a match</span></div>`
      + `<div class="loadout"><div class="rRow">${Array.from({ length: REACTION_SLOTS }, (_, i) => slot('r', i, lo.r[i] ? reactionSvg(lo.r[i]!) : '')).join('')}</div>`
      + `<div class="pRow">${Array.from({ length: PHRASE_SLOTS }, (_, i) => slot('p', i, lo.p[i] ? ticketHtml(lo.p[i]!, me.color, 's') : '')).join('')}</div></div>`
      + `<p class="muted small">${chatSlot ? 'Now tap a reaction or phrase below to put it in that slot. Tap the slot again to empty it.' : 'Tap a slot, then an item.'}</p>`
      + `<div class="h4"><span>Your chat packs</span><span class="gold">${itemsOf('pack').filter(i => mine.has(i.id)).length} owned</span></div>`
      + itemsOf('pack').filter(i => mine.has(i.id)).map(pk => {
        const rs = reactionsInPack(pk.key), ps = phrasesInPack(pk.key);
        return `<div class="pack"><b>${esc(nameOf(pk.id))}</b><div class="packItems">${rs.map(r => `<button class="rx${lo.r.includes(r) ? ' used' : ''}" type="button" data-pick="r" data-v="${r}" title="${esc(reactionName(r))}">${reactionSvg(r)}</button>`).join('')}${ps.map(ph => `<button class="px${lo.p.includes(ph) ? ' used' : ''}" type="button" data-pick="p" data-v="${esc(ph)}">${ticketHtml(ph, me.color, 's')}</button>`).join('')}</div></div>`;
      }).join('')
      + `<div class="h4"><span>Message colour</span><span class="gold">your phrase tickets</span></div><div class="ownGrid">${ownedTiles('color', mine)}</div>`
      + `<div class="moreRow">${moreLink('pack', 'More chat packs', `${itemsOf('pack').filter(i => !mine.has(i.id)).length} more in the Store and on the Level road`)}</div>`;
  } else {
    html = `<div class="h4"><span>Your avatars</span><span class="gold">${countOwned('avatar', mine)} owned</span></div><div class="ownGrid">${ownedTiles('avatar', mine, 60)}</div>`
      + `<div class="h4"><span>Your auras</span><span class="gold">${countOwned('aura', mine)} owned</span></div><div class="ownGrid">${ownedTiles('aura', mine, 48)}</div>`
      + `<div class="h4"><span>Title and win effect</span><span class="gold">Level road and ranks</span></div>`
      + (countOwned('title', mine) ? `<div class="ownGrid">${ownedTiles('title', mine)}</div>` : `<div class="infoRow"><span class="ttl">—</span><span><b>Title: none yet</b><small>${nextFree('title')}</small></span></div>`)
      + `<div class="ownGrid">${ownedTiles('fx', mine)}</div>`
      + `<div class="h4"><span>Rank rewards</span><span class="gold">reach a rank in Ranked</span></div>${rankRewardTiles(mine)}`
      + `<div class="moreRow">${moreLink('avatar', 'Store', 'More avatars and auras')}${moreLink('ranks', 'Ranks', 'How ranks work')}</div>`;
  }
  html += '<p class="muted small ctr">The Locker only shows what you own. New things appear here the moment you buy or unlock them.</p>';
  $('lockerSheetBody').innerHTML = html;
}
$('lockerSheet').addEventListener('click', (e: Event) => {
  const t = e.target as HTMLElement;
  const eq = t.closest('[data-eq]') as HTMLElement | null;
  if (eq) { if (!wearing(eq.dataset.eq as ItemKind, eq.dataset.key!)) call('equip', { kind: eq.dataset.eq, key: eq.dataset.key }).then(ok => ok && sfx.select()); return; }
  const more = t.closest('[data-store]') as HTMLElement | null;
  if (more) {
    const where = more.dataset.store!;
    if (where === 'road') openSheet('roadSheet'); else if (where === 'awards') openSheet('statsSheet', 'awards'); else if (where === 'ranks') openSheet('ranksSheet', 'ranks'); else openSheet('storeSheet', where);
    return;
  }
  const sl = t.closest('[data-slot]') as HTMLElement | null;
  if (sl) {
    const kind = sl.dataset.slot![0] as 'r' | 'p', i = Number(sl.dataset.slot!.slice(1));
    if (chatSlot && chatSlot.kind === kind && chatSlot.i === i) {
      // tapping the selected slot again empties it
      const lo = loadout(); (kind === 'r' ? lo.r : lo.p).splice(i, 1); chatSlot = null;
      call('setLoadout', { reactions: lo.r, phrases: lo.p });
    } else chatSlot = { kind, i };
    renderLocker(); return;
  }
  const pk = t.closest('[data-pick]') as HTMLElement | null;
  if (pk) {
    const kind = pk.dataset.pick as 'r' | 'p', v = pk.dataset.v!;
    const lo = loadout(), list = kind === 'r' ? lo.r : lo.p, max = kind === 'r' ? REACTION_SLOTS : PHRASE_SLOTS;
    const at = list.indexOf(v);
    if (at >= 0) list.splice(at, 1);
    const i = chatSlot && chatSlot.kind === kind ? Math.min(chatSlot.i, list.length) : list.length;
    if (at < 0 || chatSlot) { if (i < max) list.splice(i, list.length > i && list.length >= max ? 1 : 0, v); else list[max - 1] = v; }
    chatSlot = null;
    call('setLoadout', { reactions: list === lo.r ? lo.r.slice(0, max) : lo.r, phrases: list === lo.p ? lo.p.slice(0, max) : lo.p });
    renderLocker();
  }
});

// ---------- Store: a showroom, one item at a time ----------
// The selected item is shown big (your three cards in that style, your avatar, your avatar in that aura,
// or the pack's stickers and tickets); a strip underneath switches items; one button buys or equips it.
const priceOf = (it: { id: string; price?: number }) => (info()?.dealItem === it.id ? info().dealPrice : it.price ?? 0);
const matchesFor = (n: number) => Math.max(1, Math.ceil(n / 30));
const storeSel: Record<string, string> = {};
/** What one Store tab shows: everything for sale, plus anything of that kind you own, cheapest first. */
function storeItems(kind: ItemKind, mine: Set<string>) {
  return ITEMS.filter(i => i.kind === kind && (i.price !== undefined || mine.has(i.id)) && !(kind === 'aura' && i.key === ''))
    .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
}
function storePick(kind: ItemKind, mine: Set<string>) {
  const list = storeItems(kind, mine);
  const cur = storeSel[kind];
  if (cur && list.some(i => i.id === cur)) return ITEM.get(cur)!;
  const deal = info()?.dealItem;
  const d = list.find(i => i.id === deal && !mine.has(i.id));
  return d ?? list.find(i => !mine.has(i.id)) ?? list[0]!;
}
function storeStage(it: { id: string; kind: ItemKind; key: string }) {
  switch (it.kind) {
    case 'skin': return `<span class="ssCards">${skinTrio(it.key)}</span>`;
    case 'avatar': return avatarHtml(it.key, me.frame, 140);
    case 'aura': return avatarHtml(me.avatar, it.key, 140);
    case 'pack': {
      const rs = reactionsInPack(it.key), ps = phrasesInPack(it.key);
      return `<span class="ssPack">${rs.map(r => `<span class="ssRx">${reactionSvg(r)}</span>`).join('')}${ps.map(p => ticketHtml(p, me.color)).join('')}</span>`;
    }
    default: return itemArt(it.id, 120, me.avatar);
  }
}
function storeThumb(it: { id: string; kind: ItemKind; key: string }) {
  if (it.kind === 'skin') return `<span class="tc" data-skin="${it.key}">${face('rock')}</span>`;
  if (it.kind === 'avatar') return avatarHtml(it.key, '', 46);
  if (it.kind === 'aura') return avatarHtml(me.avatar, it.key, 46);
  const r = reactionsInPack(it.key)[0];
  return `<span class="ssPk">${r ? reactionSvg(r) : `<span class="tkt t-${me.color || 'green'} s ssAa">Aa</span>`}</span>`;
}
function renderStore() {
  const mine = owned();
  const kind = sheetTab.storeSheet as ItemKind;
  const it = storePick(kind, mine);
  storeSel[kind] = it.id;
  const has = mine.has(it.id), price = priceOf(it), lvl = myLevel().level, need = price - coins();
  const isDeal = info()?.dealItem === it.id && !has;
  const equipped = has && it.kind !== 'pack' && wearing(it.kind, it.key);
  const tag = has ? (it.ach ? 'Earned' : 'Owned') : isDeal ? 'Today −20%' : it.level ? `Free at level ${it.level}` : 'Store only';
  const strip = storeItems(kind, mine).map(x => {
    const own = mine.has(x.id), deal = info()?.dealItem === x.id && !own;
    return `<button class="ssTh${x.id === it.id ? ' sel' : ''}${own ? ' own' : ''}" type="button" data-pick="${x.id}" aria-label="${esc(nameOf(x.id))}${own ? ', owned' : ''}">${storeThumb(x)}${own ? '<i class="ok">✓</i>' : ''}${deal ? '<i class="dl">−20%</i>' : ''}</button>`;
  }).join('');
  let action = '', note = '';
  if (has) {
    action = it.kind === 'pack' ? '<button class="btn primary" type="button" data-act="chat">Set up in Locker › Chat</button>'
      : equipped ? '<button class="btn" type="button" disabled>Equipped</button>' : '<button class="btn primary" type="button" data-act="equip">Equip</button>';
    note = it.kind === 'pack' ? 'Yours. Put its reactions and phrases in your quick chat.' : '';
  } else if (need <= 0) {
    action = `<button class="btn buyBtn" type="button" data-act="buy">Buy for <i class="coin"></i>${fmt(price)}</button>`;
    note = `You have ${fmt(coins())} · ${fmt(coins() - price)} left after buying`;
  } else {
    action = `<button class="btn" type="button" disabled>Need ${fmt(need)} more coins</button>`;
    note = `About ${matchesFor(need)} matches of play` + (it.level && lvl < it.level ? ` · or free at level ${it.level} (you're level ${lvl})` : '');
  }
  const d = info(), deal = d ? ITEM.get(d.dealItem) : undefined;
  $('storeSheetBody').innerHTML =
    `<div class="ssStage k-${kind}">${storeStage(it)}</div>`
    + `<div class="ssStrip" role="listbox" aria-label="${esc(KIND_LABEL[kind])}s">${strip}</div>`
    + `<div class="ssInfo"><div><small class="kindLbl">${KIND_LABEL[kind].toUpperCase()}</small><b class="ssName">${esc(nameOf(it.id))}</b><span class="muted">${esc(descOf(it.id))}</span></div><span class="ssTag${has ? ' own' : isDeal ? ' deal' : it.level ? ' lvl' : ''}">${tag}</span></div>`
    + `<div class="ssBuy">${isDeal ? `<span class="ssWas">Usually <s>${fmt(it.price!)}</s></span>` : ''}${action}${note ? `<small class="muted">${note}</small>` : ''}<div class="err" id="storeErr"></div></div>`
    + (deal ? `<button class="ssDeal" type="button" data-deal="${deal.id}"><span>Today's deal: <b>${esc(nameOf(deal.id))}${deal.kind === 'skin' ? ' cards' : ''}</b> <s>${fmt(deal.price!)}</s> <i class="coin"></i>${fmt(d.dealPrice)}</span><span class="muted">ends in ${shortTime(msToNextDay())}</span></button>` : '')
    + (kind === 'aura' ? '<p class="muted small ctr">Rookie, Blaze, Sunrise, Gold and Diamond auras are earned in matches, never sold.</p>' : '');
  const sel = $('storeSheetBody').querySelector('.ssTh.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center' });
}
$('storeSheet').addEventListener('click', async (e: Event) => {
  const t = e.target as HTMLElement;
  const pick = t.closest('[data-pick]') as HTMLElement | null;
  if (pick) { storeSel[sheetTab.storeSheet!] = pick.dataset.pick!; sfx.select(); renderStore(); return; }
  const dl = t.closest('[data-deal]') as HTMLElement | null;
  if (dl) { const it = ITEM.get(dl.dataset.deal!)!; sheetTab.storeSheet = it.kind; storeSel[it.kind] = it.id; renderSheet('storeSheet'); return; }
  const act = (t.closest('[data-act]') as HTMLElement | null)?.dataset.act;
  const it = ITEM.get(storeSel[sheetTab.storeSheet!] || '');
  if (!act || !it) return;
  if (act === 'buy') {
    const btn = t.closest('button') as HTMLButtonElement; btn.disabled = true;
    if (await call('buyItem', { item: it.id })) {
      sfx.unlock(); vibrate([15, 30, 15]);
      burstAt($('storeSheetBody').querySelector('.ssStage'), ['#ffc83d', '#fff3c4', '#3ee6a0'], 28);
      toast(`${nameOf(it.id)} is yours!`);
    } else btn.disabled = false;
  } else if (act === 'equip') {
    if (await call('equip', { kind: it.kind, key: it.key })) toast(`${nameOf(it.id)} equipped`);
  } else if (act === 'chat') openSheet('lockerSheet', 'chat');
});

// ---------- Level road ----------
function renderRoad() {
  const { level, into, need } = myLevel();
  const mine = owned();
  $('roadSheetTop').innerHTML = `<div class="rdTop"><span class="lvlNum">${level}</span><span class="lvlInfo"><span class="lvlTop"><b>Level ${level}</b><small>${into} / ${need} XP</small></span><span class="lvlBar"><i style="width:${Math.max(2, Math.round(into / need * 100))}%"></i></span></span></div>`;
  const next = ROAD.find(st => st.level > level);
  $('roadSheetBody').innerHTML = '<div class="road">' + ROAD.map(st => {
    const got = st.level <= level, isNext = next && st.level === next.level, top = st.level === 50;
    const what = st.items.length ? st.items.map(i => `<span class="rsItem">${itemArt(i.id, 34)}<b>${esc(nameOf(i.id))}</b><small>${KIND_LABEL[i.kind]}${i.price && !got && !mine.has(i.id) ? ` · or ${fmt(i.price)} coins` : ''}</small></span>`).join('')
      : '<span class="rsItem coinsOnly"><i class="coin"></i><b>Coins</b></span>';
    const status = got ? '<span class="rsGot">Got it</span>' : isNext ? `<span class="rsNext">${xpForLevel(st.level) - (myStats()?.xp || 0)} XP to go</span>` : '';
    return `<div class="rs${got ? ' got' : ''}${isNext ? ' next' : ''}${top ? ' top' : ''}${st.items.length ? '' : ' plain'}"><span class="rsN">${st.level}</span><div class="rsBody">${what}<small class="rsCoins">+${st.coins} coins${st.level % 5 === 0 ? ' · milestone' : ''}</small></div>${status}</div>`;
  }).join('') + '</div><p class="muted small ctr">Rewards arrive by themselves the moment you level up. XP and levels never go down, and never reset.</p>';
}

// ---------- Leaderboard: this week and this month ----------
let boardFriends = false;
function renderBoardSheet() {
  const week = sheetTab.boardSheet === 'week';
  const r: any = first(conn.db.myRank.iter());
  const day = info()?.day;
  const resetIn = day ? (() => { const dow = (day + 3) % 7; const ms = (7 - dow) * 86400000 - (Date.now() % 86400000); return shortTime(ms); })() : '';
  const season = first(conn.db.seasonInfo.iter());
  $('boardSheetTop').innerHTML = `<div class="bdChips"><button type="button" class="chip${boardFriends ? '' : ' on'}" data-bf="0">Everyone</button><button type="button" class="chip${boardFriends ? ' on' : ''}" data-bf="1">Friends</button>`
    + `<span class="muted small">${week ? `Resets in ${resetIn}` : season ? `${seasonName(season.key)} season · ends in ${shortTime(msToSeasonEnd())}` : ''}</span></div>`;
  type Row = { identity: any; name: string; v: number; avatar: string; frame: string; title: string; me?: boolean };
  let rows: Row[];
  if (boardFriends) {
    rows = Array.from(conn.db.friendsBoard.iter()).filter(f => week || f.ranked)
      .map(f => ({ identity: f.identity, name: f.name, v: week ? f.points : f.rating, avatar: f.avatar, frame: f.frame, title: f.title, me: f.me }))
      .sort((a, b) => b.v - a.v);
  } else if (week) rows = Array.from(conn.db.weeklyBoard.iter()).map(w => ({ identity: w.identity, name: w.name, v: w.points, avatar: w.avatar, frame: w.frame, title: w.title })).sort((a, b) => b.v - a.v);
  else rows = Array.from(conn.db.leaderboard.iter()).map(l => ({ identity: l.identity, name: l.name, v: l.rating, avatar: l.avatar, frame: l.frame, title: l.title })).sort((a, b) => b.v - a.v);
  const val = (v: number) => (week ? `${v} pts` : `<span class="tier">${tierBadge(tierOf(v), 'xs')}${fmt(v)}</span>`);
  const isMe = (x: Row) => x.me || (me && x.identity.isEqual(me.identity));
  const podium = rows.slice(0, 3);
  const order = [1, 0, 2].filter(i => podium[i]);
  let html = '';
  if (!rows.length) html = `<div class="empty">${week ? 'Nobody has played ranked this week yet. Win a ranked match to top the board!' : 'No ranked games this season yet. Be the first on the board!'}</div>`;
  else {
    html += '<div class="podium">' + order.map(i => {
      const x = podium[i]!;
      return `<div class="pd p${i + 1}${isMe(x) ? ' mine' : ''}"${isMe(x) ? '' : ` data-prof="${esc(x.name)}"`}>${avatarHtml(x.avatar, x.frame, i === 0 ? 62 : 52)}<b>${esc(x.name)}</b><small>${val(x.v)}</small><span class="step">${i + 1}</span></div>`;
    }).join('') + '</div>';
    html += '<div class="rows">' + rows.slice(3, 10).map((x, i) =>
      `<div class="rw${isMe(x) ? ' mine' : ''}"${isMe(x) ? '' : ` data-prof="${esc(x.name)}"`}><span class="n">${i + 4}</span>${avatarHtml(x.avatar, x.frame, 32)}<span class="nm">${esc(x.name)}${titleHtml(x.title)}</span><span class="pt">${val(x.v)}</span></div>`).join('') + '</div>';
  }
  if (!boardFriends && me) {
    const rank = week ? r?.weekRank : r?.monthRank;
    const myV = week ? (r?.weekPoints || 0) : me.rating;
    const n = nextTier(me.rating);
    const note = week ? (rank ? (rank > 1 ? 'Win ranked matches to climb' : "You're top of the week!") : 'Win a ranked match to get on this week\'s board')
      : n ? `${n.min - me.rating} rating to ${n.name}` : 'Top rank';
    html += `<div class="meRow"><div class="rw"><span class="n">${rank || '–'}</span>${avatarHtml(me.avatar, me.frame, 32)}<span class="nm">${esc(me.name)} (you)<small>${note}</small></span><span class="pt">${val(myV)}</span></div></div>`;
  }
  if (!week && season && season.champ) html += `<p class="champ">Last season's champion: <b>${esc(season.champ)}</b> ${season.champRating}</p>`;
  html += `<p class="muted small ctr">${week ? 'This week: ranked matches only. 3 points for a win, 1 for a draw. Unranked, friend rooms, practice and bots don\'t count.' : 'This month: your ranked rating. A new season starts on the 1st.'}</p>`;
  $('boardSheetBody').innerHTML = html;
}
$('boardSheet').addEventListener('click', (e: Event) => {
  const b = (e.target as HTMLElement).closest('[data-bf]') as HTMLElement | null;
  if (b) { boardFriends = b.dataset.bf === '1'; renderBoardSheet(); return; }
  const pr = (e.target as HTMLElement).closest('[data-prof]') as HTMLElement | null;
  if (pr) openProfile(pr.dataset.prof!);
});

// ---------- Settings ----------
function settingsPage(id: string) {
  for (const p of ['setMain', 'setDelete', 'setBugPage']) $(p).classList.toggle('hide', p !== id);
  $('setTitle').textContent = id === 'setDelete' ? 'Delete account' : id === 'setBugPage' ? 'Report a bug' : 'Settings';
  $('settingsBody').scrollTop = 0;
  if (id === 'setDelete') {
    const lvl = myLevel().level;
    $('delList').innerHTML = [`Username ${esc(me.name)} and your sign-in`, `Level ${lvl}, your XP and ${fmt(coins())} coins`,
      'Everything you own: card styles, avatars, auras, chat packs', 'Stats, match history, achievements and friends', 'Your place on the leaderboards']
      .map(x => `<li>${x}</li>`).join('');
    $('delInput').value = ''; $('delErr').textContent = ''; $('delGo').disabled = true;
  }
  if (id === 'setBugPage') { $('bugErr').textContent = ''; }
}
function renderSettings() {
  $('setSound').checked = !isMuted();
  $('setMusic').checked = isMusicOn();
  $('setVibe').checked = PREF.vibe();
  $('setMotion').checked = PREF.motion();
  $('setChat').checked = !chatMuted;
  const inMatch = !!G && !G.ended && showing('scrGame');
  $('setMatch').classList.toggle('hide', !inMatch);
  $('setReport').classList.toggle('hide', !inMatch || !G || G.opp.isBot);
  renderAccount();
  $('setTeam').classList.toggle('hide', !(me && (me.isAdmin || me.isMod)));
  $('setVer').textContent = `RPS 10 · version ${VERSION}`;
  $('setContact').href = SUPPORT_EMAIL ? `mailto:${SUPPORT_EMAIL}` : './privacy.html#contact';
}
$('setSound').onchange = () => { setMuted(!$('setSound').checked); };
$('setMusic').onchange = () => { setMusicOn($('setMusic').checked); };
$('setVibe').onchange = () => { store.set('rps10_vibe', $('setVibe').checked ? '1' : '0'); setVibration($('setVibe').checked); };
$('setMotion').onchange = () => { const on = $('setMotion').checked; store.set('rps10_motion', on ? '1' : '0'); setReducedMotion(on); document.body.classList.toggle('calm', on); };
$('setChat').onchange = () => setChatMuted(!$('setChat').checked);
$('setHow').onclick = () => { closeSheet('settingsSheet'); if (!G || G.ended) openTutorial(false); else toast('How to play is in the lobby, after this match.'); };
$('setBug').onclick = () => settingsPage('setBugPage');
$('bugBack').onclick = () => settingsPage('setMain');
$('bugGo').onclick = async () => {
  $('bugErr').textContent = '';
  const device = `${navigator.userAgent.slice(0, 160)} · ${innerWidth}×${innerHeight}`;
  if (await call('reportBug', { text: $('bugText').value, version: VERSION, device })) {
    $('bugText').value = ''; settingsPage('setMain'); toast('Thanks! Your bug report was sent.');
  }
};
$('delBack').onclick = () => settingsPage('setMain');
$('delInput').addEventListener('input', () => { $('delGo').disabled = $('delInput').value.trim() !== 'DELETE'; });
$('delGo').onclick = async () => {
  $('delGo').disabled = true;
  if (!await call('deleteAccount', { confirm: $('delInput').value.trim() })) { $('delGo').disabled = false; return; }
  closeModals();
  // a fresh start: forget this device's guest login and any Google sign-in
  store.set(TOKEN_KEY, null);
  if (google) { google = null; store.set(GOOGLE_KEY, null); try { const auth = await authReady; if (auth) await auth.signOutUser(); } catch {} }
  notice = 'Your account was deleted. You are now a new guest.';
  connect();
};
$('setReport').onclick = () => { closeSheet('settingsSheet'); openReport(); };
$('setLeave').onclick = () => { closeSheet('settingsSheet'); askExit(); };
$('btnGameSet').onclick = () => { openSheet('settingsSheet'); settingsPage('setMain'); };
$('btnSettings').onclick = () => { openSheet('settingsSheet'); settingsPage('setMain'); };
$('loadRetry').onclick = () => connect();

// ---------- friends: a full screen with Friends, Requests and Played with ----------
const microsMs = (x: any) => Number(BigInt(x ?? 0) / 1000n);
const sinceText = (micros: any) => { const t = microsMs(micros); return t ? ago(t) : ''; };
const MODE_NAME: Record<string, string> = { ranked: 'Ranked', casual: 'Unranked', room: 'Friend room', bot: 'Online', practice: 'Practice', daily: 'Daily' };
const resultHtml = (r: string, you: number, them: number, reason = 'points') => `<span class="res-${r}">${reason !== 'points' && r !== 'draw' ? (r === 'win' ? 'won · they left' : 'you left') : `${r === 'win' ? 'won' : r === 'loss' ? 'lost' : 'draw'} ${you}–${them}`}</span>`;
function friendRow(f: any, mid: string, acts: string) {
  return `<div class="fr${f.online ? ' on' : ''}" data-prof="${esc(f.name)}">${avatarHtml(f.avatar, f.frame, 40)}`
    + `<div class="frMid"><b>${esc(f.name)} ${f.isGuest || /^guest_/i.test(f.name) ? '' : tierBadge(tierOf(f.rating), 'xs')}</b><small>${mid}</small></div>${acts}</div>`;
}
function renderFriends() {
  const tab = sheetTab.friendsSheet;
  const all = Array.from(conn.db.myFriends.iter());
  const incoming = all.filter(f => f.state === 'in');
  $('reqBadge').textContent = incoming.length ? String(incoming.length) : '';
  $('addFriendForm').classList.toggle('hide', tab !== 'friends');
  const busy = !!G && !G.ended;
  const id = (f: any) => f.identity.toHexString();
  let html = '';
  if (tab === 'friends') {
    const fr = all.filter(f => f.state === 'friends').sort((a, b) => a.name.localeCompare(b.name));
    const on = fr.filter(f => f.online).sort((a, b) => Number(b.playing) - Number(a.playing)), off = fr.filter(f => !f.online).sort((a, b) => Number(b.lastPlayed - a.lastPlayed));
    if (!fr.length) html = `<div class="empty">No friends yet. Add someone by their username, or find people you played in <b>Played with</b>.</div>`;
    if (on.length) html += `<h4>Online · ${on.length}</h4><div class="frList">` + on.map(f => friendRow(f,
      f.playing ? '<span class="onTx">In a match</span>' : '<span class="onTx">Online</span>',
      f.playing ? `<button class="mini" type="button" data-act="watch" data-id="${id(f)}" ${busy ? 'disabled' : ''}>Watch</button>`
        : `<button class="mini go" type="button" data-act="invite" data-id="${id(f)}" ${busy ? 'disabled' : ''}>Invite</button>`)).join('') + '</div>';
    if (off.length) html += `<h4>Offline · ${off.length}</h4><div class="frList">` + off.map(f => friendRow(f,
      f.lastPlayed ? `Last played ${sinceText(f.lastPlayed)}` : 'Offline', '<span class="chev" aria-hidden="true">›</span>')).join('') + '</div>';
    if (fr.length) html += '<p class="muted small ctr">Tap a friend to see their profile. Removing a friend is at the bottom of it.</p>';
  } else if (tab === 'requests') {
    const out = all.filter(f => f.state === 'out');
    if (!incoming.length && !out.length) html = '<div class="empty">No friend requests right now.</div>';
    if (incoming.length) html += `<h4>Wants to be your friend · ${incoming.length}</h4><div class="frList">` + incoming.map(f => friendRow(f, `Sent ${sinceText(f.since)}`,
      `<button class="mini go" type="button" data-act="accept" data-id="${id(f)}">Accept</button><button class="mini" type="button" data-act="remove" data-id="${id(f)}" aria-label="Decline ${esc(f.name)}'s request">✕</button>`)).join('') + '</div>';
    if (out.length) html += `<h4>You asked · ${out.length}</h4><div class="frList">` + out.map(f => friendRow(f, `Sent ${sinceText(f.since)} · waiting for them`,
      `<button class="mini" type="button" data-act="remove" data-id="${id(f)}">Cancel</button>`)).join('') + '</div>';
  } else {
    const rec = Array.from(conn.db.myRecent.iter()).sort((a, b) => Number(b.at - a.at));
    if (!rec.length) html = '<div class="empty">Nobody yet. The real people you play show up here, so you can add them as friends.</div>';
    else html = `<h4>Recent opponents <span class="sub">your last 20 matches</span></h4><div class="frList">` + rec.map(r => {
      const act = r.relation === 'friends' ? '<span class="frTag">Friends</span>'
        : r.relation === 'out' ? '<span class="frTag dim">Sent</span>'
        : r.relation === 'in' ? `<button class="mini go" type="button" data-act="acceptName" data-name="${esc(r.name)}">Accept</button>`
        : `<button class="mini" type="button" data-act="addName" data-name="${esc(r.name)}">Add</button>`;
      return friendRow(r, `${MODE_NAME[r.mode] || r.mode} · ${sinceText(r.at)} · ${resultHtml(r.result, r.you, r.them, r.reason)}`, act);
    }).join('') + '</div><p class="muted small ctr">Bots aren\'t listed.</p>';
  }
  $('friendsSheetBody').innerHTML = html;
}
function friendsBadge() {
  const n = Array.from(conn.db.myFriends.iter()).filter(f => f.state === 'in').length + Number(conn.db.myInvites.count());
  $('friendsBadge').textContent = n ? String(Math.min(Number(n), 9)) : '';
}
$('btnFriends').onclick = () => {
  $('friendsErr').textContent = '';
  const asked = Array.from(conn.db.myFriends.iter()).some(f => f.state === 'in');
  openSheet('friendsSheet', asked ? 'requests' : sheetTab.friendsSheet);
};
$('addFriendForm').onsubmit = (e: Event) => {
  e.preventDefault();
  const name = $('addFriendName').value.trim();
  if (!name) return;
  $('friendsErr').textContent = '';
  call('addFriend', { name }).then(ok => { if (ok) { $('addFriendName').value = ''; toast(`Friend request sent to ${name}`); } });
};
/** Friend actions, from the Friends screen, a profile or the in-match card. */
async function friendAct(act: string, el: HTMLElement) {
  $('friendsErr').textContent = '';
  const byName = (n: string) => Array.from(conn.db.myFriends.iter()).find(x => x.name.toLowerCase() === n.toLowerCase());
  const f = el.dataset.id ? Array.from(conn.db.myFriends.iter()).find(x => x.identity.toHexString() === el.dataset.id) : el.dataset.name ? byName(el.dataset.name) : undefined;
  switch (act) {
    case 'addName': if (await call('addFriend', { name: el.dataset.name })) toast(`Friend request sent to ${el.dataset.name}`); break;
    case 'acceptName': case 'accept':
      if (f && await call('acceptFriend', { other: f.identity })) toast(`You and ${f.name} are now friends`);
      break;
    case 'remove': if (f) call('removeFriend', { other: f.identity }); break;
    case 'unfriend':
      if (!f) break;
      // two taps instead of a browser pop-up: the first one asks
      if (el.dataset.sure !== '1') { el.dataset.sure = '1'; el.textContent = `Tap again to remove ${f.name}`; setTimeout(() => { el.dataset.sure = ''; el.textContent = 'Remove friend'; }, 3500); break; }
      el.dataset.sure = '';
      if (await call('removeFriend', { other: f.identity })) { toast(`${f.name} is no longer your friend`); renderSheets(); }
      break;
    case 'invite':
      if (f && await call('inviteFriend', { other: f.identity })) { closeModals(); toast(`Invite sent to ${f.name}`); }
      break;
    case 'watch':
      if (f && await call('watchFriend', { other: f.identity })) closeModals();
      break;
    case 'look': openSheet('lockerSheet', 'profile'); break;
    case 'full': if (profName) { $('profileCard').classList.add('hide'); profFrom = ''; openSheet('profileSheet'); } break;
    case 'report': $('profileCard').classList.add('hide'); closeSheet('profileSheet'); openReport(); break;
    case 'closeCard': $('profileCard').classList.add('hide'); break;
  }
}
for (const id of ['friendsSheetBody', 'profileSheetBody', 'profileCardBody']) {
  $(id).addEventListener('click', (e: Event) => {
    const t = e.target as HTMLElement;
    const b = t.closest('[data-act]') as HTMLButtonElement | null;
    if (b) { if (!b.disabled) friendAct(b.dataset.act!, b); return; }
    const row = t.closest('[data-prof]') as HTMLElement | null;
    if (row && id === 'friendsSheetBody') openProfile(row.dataset.prof!);
  });
}

// ---------- player profiles ----------
let profName = '', profFrom = '';
/** Opens a player's profile: a short card during your match, a full screen anywhere else. */
function openProfile(name: string) {
  if (!name || /_bot$/i.test(name)) return;
  profName = name;
  call('viewProfile', { name });
  const inMatch = !!G && !G.ended && showing('scrGame');
  if (inMatch) { renderProfileCard(); $('profileCard').classList.remove('hide'); return; }
  profFrom = Array.from(document.querySelectorAll<HTMLElement>('.sheetOv:not(.hide)')).map(el => el.id).find(id => id !== 'profileSheet') || '';
  openSheet('profileSheet');
}
$('profBack').onclick = () => { const from = profFrom; closeSheet('profileSheet'); if (from) openSheet(from); };
$('profileCard').addEventListener('click', (e: Event) => { if (e.target === $('profileCard')) $('profileCard').classList.add('hide'); });
/** True when this profile is the person you're playing right now. */
const playingNow = (p: any) => !!G && !G.ended && !!G.opp && !G.opp.isBot && G.opp.name.toLowerCase() === p.name.toLowerCase();
const shownProfile = () => { const p: any = first(conn.db.playerProfile.iter()); return p && p.name.toLowerCase() === profName.toLowerCase() ? p : null; };
function profileActs(p: any, card: boolean) {
  if (p.isMe) return `<button class="btn ghost" type="button" data-act="look">Change your look</button>`;
  const fr = Array.from(conn.db.myFriends.iter()).find(x => x.name.toLowerCase() === p.name.toLowerCase());
  const busy = !!G && !G.ended;
  const nm = `data-name="${esc(p.name)}"`;
  let main = '';
  if (p.relation === 'friends' && fr && playingNow(p)) main = '<span class="pfTag">✓ Friends</span>';
  else if (p.relation === 'friends' && fr) {
    main = p.playing ? `<button class="btn" type="button" data-act="watch" ${nm} ${busy ? 'disabled' : ''}>Watch their match</button>`
      : p.online ? `<button class="btn gold" type="button" data-act="invite" ${nm} ${busy ? 'disabled' : ''}>Invite to play</button>`
      : `<button class="btn ghost" type="button" disabled>Offline${p.lastPlayed ? ` · played ${sinceText(p.lastPlayed)}` : ''}</button>`;
    main += '<span class="pfTag">✓ Friends</span>';
  } else if (p.relation === 'in') main = `<button class="btn primary" type="button" data-act="acceptName" ${nm}>Accept friend request</button>`;
  else if (p.relation === 'out') main = '<button class="btn ghost" type="button" disabled>Friend request sent</button>';
  else main = `<button class="btn primary" type="button" data-act="addName" ${nm}>Add friend</button>`;
  if (card) main += `<button class="btn ghost" type="button" data-act="full">Full profile</button>`;
  return main;
}
function profileHead(p: any, size: number) {
  const t = tierOf(p.rating);
  const status = p.isMe ? '' : playingNow(p) ? ' · <span class="onTx">Playing you</span>' : p.playing ? ' · <span class="onTx">In a match</span>' : p.online ? ' · <span class="onTx">Online</span>' : '';
  return `${avatarHtml(p.avatar, p.frame, size, p.name)}<div class="pfWho"><b class="pfName">${esc(p.name)}</b>${titleHtml(p.title)}`
    + `<small>${p.isGuest ? '<span class="pill">Guest</span> ' : `${tierBadge(t, 'xs')} ${t.name} ${fmt(p.rating)} · `}Level ${p.level}${status}</small></div>`;
}
function renderProfile() {
  const p = shownProfile();
  if (!p) { $('profileSheetBody').innerHTML = '<div class="empty">Loading…</div>'; return; }
  $('profBack').style.visibility = profFrom ? '' : 'hidden';
  const played = p.wins + p.losses + p.draws;
  const cell = (v: any, l: string) => `<div><b>${v}</b><small>${l}</small></div>`;
  const vs = p.vsWins + p.vsLosses + p.vsDraws;
  const got = new Set(p.achievements ? p.achievements.split(',') : []);
  const form = [...p.form].map((r: string) => `<i class="o${r}">${r.toUpperCase()}</i>`).join('');
  const fr = Array.from(conn.db.myFriends.iter()).find(x => x.name.toLowerCase() === p.name.toLowerCase());
  const lastOpp = !!G && !!G.opp && !G.opp.isBot && G.opp.name.toLowerCase() === p.name.toLowerCase();
  let html = `<div class="pfHead">${profileHead(p, 92)}</div>`
    + `<div class="pfActs">${profileActs(p, false)}</div>`
    + `<div class="stGrid g4">${cell(played, 'Matches')}${cell(pct(p.wins, played), 'Win rate')}${cell(p.bestStreak, 'Best streak')}${cell(p.perfects, 'Perfect 10s')}</div>`;
  if (!p.isMe) html += vs
    ? `<div class="h2h"><div><small>You vs ${esc(p.name)}</small><b>${p.vsWins} – ${p.vsLosses}</b>${p.vsDraws ? `<small>${p.vsDraws} draw${p.vsDraws === 1 ? '' : 's'}</small>` : ''}</div>`
      + `<div class="h2hR"><small>${vs} match${vs === 1 ? '' : 'es'} · last ${sinceText(p.vsLast)}</small><small class="res-${p.vsLastResult}">${p.vsLastResult === 'win' ? 'You won the last one' : p.vsLastResult === 'loss' ? 'They won the last one' : 'The last one was a draw'}</small></div></div>`
    : `<div class="h2h none"><small>You haven't played ${esc(p.name)} yet.</small></div>`;
  html += `<h4>Last 10 matches <span class="sub">Newest first</span></h4><div class="last10">${form || '<span class="muted">No matches yet.</span>'}</div>`
    + `<div class="pfRow">${p.favourite ? `<div class="pfMini">${mini(p.favourite)}<span><b>${p.favourite[0].toUpperCase() + p.favourite.slice(1)}</b>plays it ${p.favouritePct}%</span></div>` : ''}`
    + `<div class="pfMini">${skinTrio(p.skin, 'xs')}<span><b>${esc(nameOf('skin:' + p.skin))}</b>card style</span></div></div>`
    + `<h4>Awards <span class="sub">${got.size} of ${ACHIEVEMENTS.length}</span></h4>${got.size ? `<div class="pfAwards">${ACHIEVEMENTS.filter(a => got.has(a.key)).map(a => `<span class="pfAw on" title="${esc(a.name)}: ${esc(a.how)}" aria-label="${esc(a.name)}">${a.icon}</span>`).join('')}</div>` : '<p class="muted small">No awards yet.</p>'}`
    + `<p class="muted small ctr">Playing since ${new Date(microsMs(p.since)).toLocaleDateString('en', { month: 'long', year: 'numeric' })}</p>`;
  const foot = (lastOpp ? '<button class="linkBtn" type="button" data-act="report">Report</button>' : '')
    + (p.relation === 'friends' && fr ? `<button class="linkBtn red" type="button" data-act="unfriend" data-id="${fr.identity.toHexString()}">Remove friend</button>` : '');
  if (foot) html += `<div class="pfFoot">${foot}</div>`;
  const body = $('profileSheetBody');
  // don't redraw over a "Tap again to remove" that's waiting for its second tap
  if (body.querySelector('[data-sure="1"]')) return;
  body.innerHTML = html;
}
function renderProfileCard() {
  const p = shownProfile();
  if (!p) { $('profileCardBody').innerHTML = '<div class="empty">Loading…</div>'; return; }
  const played = p.wins + p.losses + p.draws;
  const cell = (v: any, l: string) => `<div><b>${v}</b><small>${l}</small></div>`;
  const fav = p.favourite ? p.favourite[0].toUpperCase() + p.favourite.slice(1) : '—';
  $('profileCardBody').innerHTML = `<div class="pfHead row">${profileHead(p, 60)}</div>`
    + `<div class="stGrid g4">${cell(played, 'Matches')}${cell(pct(p.wins, played), 'Win rate')}${cell(`${p.vsWins}–${p.vsLosses}`, 'Vs you')}${cell(fav, 'Favourite')}</div>`
    + `<div class="pfActs">${profileActs(p, true)}</div>`
    + `<div class="pfFoot"><button class="linkBtn" type="button" data-act="report">Report</button><button class="linkBtn" type="button" data-act="closeCard">Close</button></div>`;
}
const oppProfile = () => { if (G && G.opp && !G.opp.isBot) openProfile(G.opp.name); };
$('sideOpp').addEventListener('click', oppProfile);
$('sideOpp').addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); oppProfile(); } });
$('endNameOpp').addEventListener('click', oppProfile);

// invites from friends: a bar in the lobby, and a toast wherever you are
let invitesSeen: Set<string> | null = null;
function renderInvites() {
  const inv = Array.from(conn.db.myInvites.iter());
  const ids = inv.map(i => String(i.id));
  if (invitesSeen) for (const i of inv) if (!invitesSeen.has(String(i.id))) { sfx.msg(); vibrate([20, 40, 20]); toast(`${i.fromName} invited you to play!`); }
  invitesSeen = new Set(ids);
  const bar = $('inviteBar');
  bar.classList.toggle('hide', !inv.length);
  bar.innerHTML = inv.slice(0, 3).map(i => `<div class="inv">${avatarHtml(i.avatar, '', 30)}<span class="invTx"><b>${esc(i.fromName)}</b> invited you to a match</span>`
    + `<button class="mini go" data-join="${esc(i.code)}">Join</button><button class="mini" data-dismiss="${i.id}" aria-label="Dismiss">✕</button></div>`).join('');
  friendsBadge();
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
  $('wAvA').innerHTML = avatarHtml(w.aAvatar, '', 36);
  $('wAvB').innerHTML = avatarHtml(w.bAvatar, '', 36);
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
  const backs = (n: number) => Array.from({ length: n }, () => `<span class="ob">${backHtml('classic')}</span>`).join('');
  $('wBacksA').innerHTML = backs(w.aCards); $('wBacksB').innerHTML = backs(w.bCards);
  $('wSlotA').dataset.skin = w.aSkin || 'classic'; $('wSlotB').dataset.skin = w.bSkin || 'classic';
  const res = w.revealResult;
  const slot = (id: string, k: number, locked: boolean, win: boolean, lose: boolean) => {
    const el = $(id);
    const kind = k >= 0 ? KINDS[k] : null;
    el.className = 'slot' + (w.revealShown ? (kind ? ' face' : ' miss') : locked ? ' down' : ' empty thinking') + (win ? ' win' : lose ? ' lose' : '');
    const html = w.revealShown ? (kind ? face(kind) : '<span class="slow">Too<br>slow</span>') : locked ? backHtml('classic') : '<span class="dots3"><i></i><i></i><i></i></span>';
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
    if (G && !G.ended && showing('scrGame')) { openSheet('settingsSheet'); settingsPage('setMain'); }
    return;
  }
  if ((e.key === 'f' || e.key === 'F') && !open) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
    return;
  }
  if (!G || !showing('scrGame') || open) return;
  if (e.key === 't' || e.key === 'T') { showChat(!chatOpen()); e.preventDefault(); return; }
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

// ---------- browser details ----------
// leaving the page mid-match asks first
addEventListener('beforeunload', e => { if (G && !G.ended && showing('scrGame')) { e.preventDefault(); e.returnValue = ''; } });
// the tab title flashes when it's your turn and you're in another tab
const TITLE = document.title;
let titleTimer: any = 0;
function flashTitle() {
  if (!document.hidden || titleTimer) return;
  let on = false;
  titleTimer = setInterval(() => { on = !on; document.title = on ? 'Your turn! · RPS 10' : TITLE; }, 900);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearInterval(titleTimer); titleTimer = 0; document.title = TITLE; } });
// a new version: offered in the lobby, never mid-match
let newVersion = false;
async function checkVersion() {
  try {
    const r = await fetch('./version.json', { cache: 'no-store' });
    const v = (await r.json()).v;
    if (v && v !== VERSION && !newVersion) { newVersion = true; renderUpdate(); }
  } catch {}
}
function renderUpdate() {
  const bar = $('updateBar');
  bar.classList.toggle('hide', !newVersion);
}
$('updateBar').addEventListener('click', () => location.reload());
if (import.meta.env.PROD) { setInterval(checkVersion, 5 * 60 * 1000); addEventListener('focus', checkVersion); }

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
