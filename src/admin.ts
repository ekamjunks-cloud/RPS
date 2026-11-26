// The admin page: reports, bug reports, rename or suspend a player, give coins or items, and notices.
// The server only sends this data to the accounts listed in `admins` in spacetimedb/src/config.ts,
// so the page shows nothing to anyone else even though it is public.
import { DbConnection, tables } from './module_bindings';
import { ITEMS } from '../spacetimedb/src/catalog';
import { nameOf, KIND_LABEL } from './catalog';

const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? 'https://maincloud.spacetimedb.com';
const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'rps-10-b7hi9';
const TOKEN_KEY = `rps10_token:${HOST}/${DB_NAME}`;
const $ = (id: string) => document.getElementById(id) as any;
const esc = (s: any) => String(s).replace(/[&<>"']/g, c => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as any)[c]);
const when = (t: any) => t.toDate().toLocaleString();
let conn: DbConnection;

$('grantItem').innerHTML += ITEMS.filter(i => i.key !== '')
  .map(i => `<option value="${i.id}">${esc(KIND_LABEL[i.kind])}: ${esc(nameOf(i.id))}</option>`).join('');

async function call(name: string, args: any = {}) {
  $('err').textContent = ''; $('toolOk').textContent = '';
  try { await (conn.reducers as any)[name](args); return true; }
  catch (e: any) { $('err').textContent = String((e && e.message) || e).replace(/^.*?Error:\s*/, ''); return false; }
}

async function start() {
  // the admin account is a Google account: use its sign-in, or this browser's game login
  let token: string | undefined, provider: (() => Promise<string>) | undefined;
  try {
    const auth = await import('./auth');
    if (auth.configured && await auth.restore()) { token = await auth.token(); provider = () => auth.token(); }
    $('signIn').onclick = async () => { try { await auth.signIn(); location.reload(); } catch (e: any) { $('err').textContent = String(e && e.code || e); } };
    $('signIn').hidden = !auth.configured || !!token;
  } catch { $('signIn').hidden = true; }
  if (!token) token = localStorage.getItem(TOKEN_KEY) || undefined;
  let b = DbConnection.builder().withUri(HOST).withDatabaseName(DB_NAME).withToken(token).withAutomaticReconnect();
  if (provider) b = b.withTokenProvider(provider);
  conn = b.onConnect(c => {
    c.subscriptionBuilder().onApplied(render)
      .subscribe([tables.myPlayer, tables.adminReports, tables.adminBugs, tables.adminDays, tables.adminSummary, tables.serverInfo]);
  }).onConnectError(() => { $('status').textContent = "Can't reach the game server"; }).build();
  for (const t of [conn.db.myPlayer, conn.db.adminReports, conn.db.adminBugs, conn.db.adminDays, conn.db.adminSummary, conn.db.serverInfo] as any[]) {
    t.onInsert(render); t.onDelete(render); if (t.onUpdate) t.onUpdate(render);
  }
}

let queued = false;
function render() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; draw(); });
}
function draw() {
  const me: any = Array.from(conn.db.myPlayer.iter())[0];
  if (!me) return;
  $('status').textContent = `Signed in as ${me.name}${me.isAdmin ? ' · admin' : ''}`;
  $('app').hidden = !me.isAdmin;
  if (!me.isAdmin) { $('err').textContent = 'This account is not an admin. Sign in with the account listed in spacetimedb/src/config.ts.'; return; }
  $('err').textContent = '';
  const s: any = Array.from(conn.db.adminSummary.iter())[0];
  if (s) {
    const tile = (v: any, l: string) => `<div class="tile"><b>${Number(v).toLocaleString()}</b><small>${l}</small></div>`;
    $('summary').innerHTML = tile(s.online, 'Online now') + tile(s.inMatch, 'In a match') + tile(s.activeToday, 'Played today')
      + tile(s.players, 'Players') + tile(s.accounts, 'Accounts') + tile(s.banned, 'Suspended') + tile(s.coinsInWallets, 'Coins in wallets');
  }
  const days = Array.from(conn.db.adminDays.iter()).sort((a, b) => b.day - a.day).slice(0, 14);
  $('days').innerHTML = '<tr><th>Day (UTC)</th><th>Matches</th><th>New players</th></tr>' + (days.length ? days.map(d =>
    `<tr><td>${new Date(d.day * 86400000).toISOString().slice(0, 10)}</td><td>${d.matches}</td><td>${d.newPlayers}</td></tr>`).join('') : '<tr><td colspan="3" class="empty">No data yet</td></tr>');
  const info: any = Array.from(conn.db.serverInfo.iter())[0];
  $('noticeNow').textContent = info && (info.message || info.maintenance) ? `Now showing: ${info.maintenance ? '[maintenance] ' : ''}${info.message}` : 'No notice showing.';
  const reps = Array.from(conn.db.adminReports.iter()).sort((a, b) => (a.id < b.id ? 1 : -1));
  $('reports').innerHTML = '<tr><th>When</th><th>Reported</th><th>Reason</th><th>By</th><th></th></tr>' + (reps.length ? reps.map(r =>
    `<tr><td>${when(r.at)}</td><td><b>${esc(r.reported)}</b>${r.banned ? ' <span class="muted">(suspended)</span>' : ''}<br><small class="muted">${r.reportsAgainst} report${r.reportsAgainst === 1 ? '' : 's'} in total</small></td>`
    + `<td>${esc(r.reason)}</td><td>${esc(r.reporter)}</td><td><div class="acts"><button type="button" data-pick="${esc(r.reported)}">Use name</button>`
    + `<button type="button" data-dismiss="report" data-id="${r.id}">Done</button></div></td></tr>`).join('') : '<tr><td colspan="5" class="empty">No reports</td></tr>');
  const bugs = Array.from(conn.db.adminBugs.iter()).sort((a, b) => (a.id < b.id ? 1 : -1));
  $('bugs').innerHTML = '<tr><th>When</th><th>From</th><th>What happened</th><th>Device</th><th></th></tr>' + (bugs.length ? bugs.map(b =>
    `<tr><td>${when(b.at)}</td><td>${esc(b.name)}<br><small class="muted">v${esc(b.version)}</small></td><td><pre>${esc(b.text)}</pre></td><td><small class="muted">${esc(b.device)}</small></td>`
    + `<td><button type="button" data-dismiss="bug" data-id="${b.id}">Done</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty">No bug reports</td></tr>');
}

document.addEventListener('click', (e: Event) => {
  const t = e.target as HTMLElement;
  const d = t.closest('[data-dismiss]') as HTMLElement | null;
  if (d) call('adminDismiss', { kind: d.dataset.dismiss, id: BigInt(d.dataset.id!) });
  const p = t.closest('[data-pick]') as HTMLElement | null;
  if (p) { $('who').value = p.dataset.pick; $('who').focus(); }
});
const who = () => $('who').value.trim();
const done = (m: string) => { $('toolOk').textContent = m; };
$('renameGo').onclick = async () => { if (await call('adminRename', { name: who(), newName: $('newName').value.trim() })) done(`Renamed ${who()} to ${$('newName').value.trim()}`); };
$('banGo').onclick = async () => { if (confirm(`Suspend ${who()}? They can't play online or chat until you lift it.`) && await call('adminBan', { name: who(), banned: true })) done(`${who()} is suspended`); };
$('unbanGo').onclick = async () => { if (await call('adminBan', { name: who(), banned: false })) done(`Lifted the suspension on ${who()}`); };
$('grantGo').onclick = async () => {
  const coins = Math.max(0, Math.min(100000, Number($('grantCoins').value) || 0)), item = $('grantItem').value;
  if (!coins && !item) { $('err').textContent = 'Enter coins or pick an item'; return; }
  if (await call('adminGrant', { name: who(), coins, item })) done(`Gave ${who()} ${coins ? coins + ' coins' : ''}${coins && item ? ' and ' : ''}${item ? nameOf(item) : ''}`);
};
$('noticeGo').onclick = async () => {
  if (await call('adminNotice', { maintenance: $('noticeMaint').checked, message: $('noticeMsg').value })) done('Notice saved');
};

start();
