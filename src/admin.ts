// The admin dashboard: overview charts, players, moderation, economy, live matches, the team and the admin log.
// The server only sends this data to admins and moderators (see `admins` in spacetimedb/src/config.ts and the
// Team section), so the page is empty for everyone else even though it is public.
import { DbConnection, tables } from './module_bindings';
import { ITEMS, ITEM } from '../spacetimedb/src/catalog';
import { nameOf, KIND_LABEL } from './catalog';

const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? 'https://maincloud.spacetimedb.com';
const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'rps-10-b7hi9';
const TOKEN_KEY = `rps10_token:${HOST}/${DB_NAME}`;
const $ = (id: string) => document.getElementById(id) as any;
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as any)[c]);
const fmt = (n: number | bigint) => Number(n).toLocaleString('en');
const DAY = 86_400_000;
const dayLabel = (d: number) => new Date(d * DAY).toLocaleDateString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const ms = (t: any) => (typeof t === 'bigint' ? Number(t / 1000n) : t.toDate().getTime());
function ago(t: number) {
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
const until = (micros: bigint) => {
  const left = Number(micros / 1000n) - Date.now();
  if (left <= 0) return '';
  const h = Math.ceil(left / 3600000);
  return h < 48 ? `${h}h left` : `${Math.round(h / 24)}d left`;
};
const MODE: Record<string, string> = { ranked: 'Ranked', casual: 'Unranked', room: 'Friend', bot: 'Online vs bot', practice: 'Practice', daily: 'Daily' };
let conn: DbConnection;
let me: any = null;
let section = 'overview';

// ---------- small helpers ----------
let toastT: any = 0;
function toast(m: string, bad = false) {
  const t = $('toast'); t.textContent = m; t.className = 'toast on' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600);
}
async function call(name: string, args: any, done?: string) {
  $('actErr').textContent = '';
  try { await (conn.reducers as any)[name](args); if (done) toast(done); return true; }
  catch (e: any) { const m = String((e && e.message) || e).replace(/^.*?Error:\s*/, ''); toast(m, true); if (section === 'players') $('actErr').textContent = m; return false; }
}
const rows = (t: any) => Array.from(t.iter()) as any[];
const isAdminMe = () => !!me && me.isAdmin;

// ---------- charts (plain SVG, no library) ----------
type Series = { color: string; values: number[] };
function barChart(labels: string[], series: Series[], opts: { stacked?: boolean; height?: number; every?: number } = {}) {
  const W = 640, H = opts.height ?? 200, pad = { l: 34, r: 8, t: 10, b: 22 };
  const n = labels.length;
  if (!n) return '<div class="empty">No data yet</div>';
  const totals = labels.map((_, i) => (opts.stacked ? series.reduce((s, x) => s + (x.values[i] || 0), 0) : Math.max(...series.map(x => x.values[i] || 0))));
  const max = Math.max(1, ...totals);
  const cw = (W - pad.l - pad.r) / n, bw = opts.stacked ? cw * 0.7 : (cw * 0.8) / series.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  let out = '';
  for (let g = 0; g <= 4; g++) {
    const v = (max / 4) * g, yy = y(v);
    out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}" stroke="rgba(255,255,255,.07)"/><text x="${pad.l - 6}" y="${yy + 4}" fill="#6f68a3" font-size="10" text-anchor="end">${v >= 1000 ? Math.round(v / 100) / 10 + 'k' : Math.round(v)}</text>`;
  }
  labels.forEach((lb, i) => {
    const x0 = pad.l + cw * i + (cw - (opts.stacked ? bw : bw * series.length)) / 2;
    let acc = 0;
    series.forEach((s, k) => {
      const v = s.values[i] || 0;
      if (opts.stacked) { const top = y(acc + v), h = y(acc) - top; if (h > 0) out += `<rect x="${x0}" y="${top}" width="${bw}" height="${h}" fill="${s.color}" rx="2"><title>${esc(lb)}: ${v}</title></rect>`; acc += v; }
      else { const top = y(v); out += `<rect x="${x0 + bw * k}" y="${top}" width="${Math.max(1, bw - 1)}" height="${Math.max(0, H - pad.b - top)}" fill="${s.color}" rx="2"><title>${esc(lb)}: ${v}</title></rect>`; }
    });
    if (i % (opts.every ?? Math.ceil(n / 8)) === 0) out += `<text x="${pad.l + cw * i + cw / 2}" y="${H - 6}" fill="#6f68a3" font-size="10" text-anchor="middle">${esc(lb)}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${out}</svg>`;
}
function lineChart(labels: string[], series: Series[], height = 200, every?: number) {
  const W = 640, H = height, pad = { l: 34, r: 8, t: 10, b: 22 };
  const n = labels.length;
  if (!n) return '<div class="empty">No data yet</div>';
  const max = Math.max(1, ...series.flatMap(s => s.values));
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) * i) / Math.max(1, n - 1);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  let out = '';
  for (let g = 0; g <= 4; g++) { const v = (max / 4) * g; out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,.07)"/><text x="${pad.l - 6}" y="${y(v) + 4}" fill="#6f68a3" font-size="10" text-anchor="end">${Math.round(v)}</text>`; }
  for (const s of series) {
    const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    out += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round"/>`;
    out += `<polygon points="${x(0)},${H - pad.b} ${pts} ${x(n - 1)},${H - pad.b}" fill="${s.color}" opacity=".12"/>`;
  }
  labels.forEach((lb, i) => { if (i % (every ?? Math.ceil(n / 8)) === 0) out += `<text x="${x(i)}" y="${H - 6}" fill="#6f68a3" font-size="10" text-anchor="middle">${esc(lb)}</text>`; });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${out}</svg>`;
}

// ---------- sortable tables ----------
type Col = { k: string; label: string; html: (r: any) => string; sort?: (r: any) => any };
const sortState: Record<string, { k: string; dir: number }> = {};
function table(id: string, cols: Col[], data: any[], opts: { rowAttr?: (r: any) => string; empty?: string } = {}) {
  const st = sortState[id];
  const col = st && cols.find(c => c.k === st.k);
  if (col && col.sort) data = data.slice().sort((a, b) => { const x = col.sort!(a), y = col.sort!(b); return (x < y ? -1 : x > y ? 1 : 0) * st!.dir; });
  $(id).innerHTML = `<tr>${cols.map(c => `<th data-k="${c.k}" class="${c.sort ? '' : 'nosort'}">${esc(c.label)}${st && st.k === c.k ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>`
    + (data.length ? data.map(r => `<tr ${opts.rowAttr ? opts.rowAttr(r) : ''}>${cols.map(c => `<td>${c.html(r)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="empty">${opts.empty ?? 'Nothing here yet'}</td></tr>`);
}
document.addEventListener('click', (e: Event) => {
  const th = (e.target as HTMLElement).closest('th[data-k]:not(.nosort)') as HTMLElement | null;
  if (!th) return;
  const id = th.closest('table')!.id, k = th.dataset.k!;
  const st = sortState[id];
  sortState[id] = { k, dir: st && st.k === k ? -st.dir : -1 };
  draw();
});

// ---------- connect ----------
async function start() {
  let token: string | undefined, provider: (() => Promise<string>) | undefined;
  try {
    const auth = await import('./auth');
    if (auth.configured && await auth.restore()) { token = await auth.token(); provider = () => auth.token(); }
    $('signIn').onclick = async () => { try { await auth.signIn(); location.reload(); } catch (e: any) { $('gateMsg').textContent = `Sign-in failed (${String(e && e.code || e)})`; } };
    $('signIn').hidden = !auth.configured || !!token;
  } catch { $('signIn').hidden = true; }
  if (!token) token = localStorage.getItem(TOKEN_KEY) || undefined;
  let b = DbConnection.builder().withUri(HOST).withDatabaseName(DB_NAME).withToken(token).withAutomaticReconnect();
  if (provider) b = b.withTokenProvider(provider);
  const T = [tables.myPlayer, tables.serverInfo, tables.adminReports, tables.adminBugs, tables.adminDays, tables.adminHours, tables.adminRetention,
    tables.adminSummary, tables.adminPlayers, tables.adminProfile, tables.adminSales, tables.adminDeals, tables.adminLive, tables.adminLogView, tables.adminStaff];
  conn = b.onConnect(c => { c.subscriptionBuilder().onApplied(draw).subscribe(T); })
    .onConnectError(() => { $('gateMsg').textContent = "Can't reach the game server."; }).build();
  for (const t of [conn.db.myPlayer, conn.db.serverInfo, conn.db.adminReports, conn.db.adminBugs, conn.db.adminDays, conn.db.adminHours, conn.db.adminRetention,
    conn.db.adminSummary, conn.db.adminPlayers, conn.db.adminProfile, conn.db.adminSales, conn.db.adminDeals, conn.db.adminLive, conn.db.adminLogView, conn.db.adminStaff] as any[]) {
    t.onInsert(draw); t.onDelete(draw); if (t.onUpdate) t.onUpdate(draw);
  }
}

let queued = false;
function draw() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; render(); });
}
const NAMES: Record<string, string> = { overview: 'Overview', players: 'Players', moderation: 'Moderation', economy: 'Economy', live: 'Live', team: 'Team', log: 'Admin log' };
function show(sec: string) {
  section = sec;
  document.querySelectorAll('section').forEach(s => s.classList.toggle('on', s.id === sec));
  document.querySelectorAll('.nav').forEach(n => n.classList.toggle('on', (n as HTMLElement).dataset.sec === sec));
  $('title').textContent = NAMES[sec];
  render();
}
document.querySelectorAll('.nav').forEach(n => n.addEventListener('click', () => show((n as HTMLElement).dataset.sec!)));

function render() {
  me = rows(conn.db.myPlayer)[0];
  if (!me) return;
  if (!me.isMod) {
    $('gate').hidden = false; $('app').hidden = true;
    $('gateMsg').textContent = `Signed in as ${me.name}. This account isn't on the team. Sign in with an admin account.`;
    return;
  }
  $('gate').hidden = true; $('app').hidden = false;
  $('who').innerHTML = `Signed in as <b>${esc(me.name)}</b><span class="role${me.isAdmin ? '' : ' mod'}">${me.isAdmin ? 'Admin' : 'Moderator'}</span>`;
  // moderators don't see the admin-only controls
  document.querySelectorAll('.adm').forEach(el => ((el as HTMLElement).hidden = !isAdminMe()));
  document.querySelectorAll('#aBanHours [data-admin]').forEach(o => ((o as HTMLOptionElement).hidden = !isAdminMe()));
  $('nReports').textContent = String(new Set(rows(conn.db.adminReports).map(r => r.reported)).size || '');
  $('nLive').textContent = String(rows(conn.db.adminLive).length || '');
  if (section === 'overview') renderOverview();
  else if (section === 'players') renderPlayers();
  else if (section === 'moderation') renderModeration();
  else if (section === 'economy') renderEconomy();
  else if (section === 'live') renderLive();
  else if (section === 'team') renderTeam();
  else renderLog();
}

// ---------- overview ----------
const days = () => rows(conn.db.adminDays).sort((a, b) => a.day - b.day);
const today = () => { const s = rows(conn.db.serverInfo)[0]; return s ? s.day : Math.floor(Date.now() / DAY); };
function lastDays(n: number) {
  const byDay = new Map(days().map(d => [d.day, d]));
  const t = today();
  return Array.from({ length: n }, (_, i) => { const d = t - n + 1 + i; return byDay.get(d) ?? { day: d, matches: 0, newPlayers: 0, active: 0, ranked: 0, casual: 0, room: 0, bot: 0, practice: 0, daily: 0, botFallback: 0, waitMs: 0n, waits: 0, coinsEarned: 0n, coinsSpent: 0n, sales: 0 }; });
}
function renderOverview() {
  const s = rows(conn.db.adminSummary)[0] || {};
  const [y, t] = lastDays(2);
  const delta = (a: number, b: number) => (b === a ? '' : `<span class="d ${a > b ? 'up' : 'down'}">${a > b ? '▲' : '▼'} ${Math.abs(a - b)}</span>`);
  const tile = (v: any, l: string, d = '') => `<div class="tile"><b>${fmt(v ?? 0)}${d}</b><small>${l}</small></div>`;
  $('kpis').innerHTML = tile(s.online, 'Online now') + tile(s.inMatch, 'In a match') + tile(s.queued, 'Waiting for a match')
    + tile(t.active, 'Played today', delta(t.active, y.active)) + tile(t.newPlayers, 'New today', delta(t.newPlayers, y.newPlayers))
    + tile(t.matches, 'Matches today', delta(t.matches, y.matches)) + tile(s.players, 'Players') + tile(s.accounts, 'With an account')
    + tile(s.banned, 'Suspended');
  // last 48 hours
  const hours = new Map(rows(conn.db.adminHours).map(h => [h.hour, h]));
  const nowH = Math.floor(Date.now() / 3600000);
  const hs = Array.from({ length: 48 }, (_, i) => nowH - 47 + i);
  const hl = hs.map(h => new Date(h * 3600000).toLocaleTimeString('en', { hour: 'numeric' }));
  $('chHours').innerHTML = lineChart(hl, [
    { color: '#6fe0ff', values: hs.map(h => hours.get(h)?.peakOnline ?? 0) },
    { color: '#ffc83d', values: hs.map(h => hours.get(h)?.matches ?? 0) },
  ], 200, 6);
  const d30 = lastDays(30);
  $('chDays').innerHTML = barChart(d30.map(d => dayLabel(d.day)), [{ color: '#3ee6a0', values: d30.map(d => d.active) }, { color: '#ff7ac0', values: d30.map(d => d.newPlayers) }]);
  const d14 = lastDays(14);
  const MODES: [string, string][] = [['ranked', '#ffc83d'], ['casual', '#6fe0ff'], ['room', '#ff7ac0'], ['bot', '#a78bfa'], ['practice', '#3ee6a0'], ['daily', '#ffb25b']];
  $('lgModes').innerHTML = MODES.map(([m, c]) => `<span><i style="background:${c}"></i>${MODE[m]}</span>`).join('');
  $('chModes').innerHTML = barChart(d14.map(d => dayLabel(d.day)), MODES.map(([m, c]) => ({ color: c, values: d14.map(d => d[m]) })), { stacked: true });
  $('chWait').innerHTML = barChart(d14.map(d => dayLabel(d.day)), [
    { color: '#a78bfa', values: d14.map(d => (d.waits ? Math.round(Number(d.waitMs) / d.waits / 1000) : 0)) },
    { color: '#ffb25b', values: d14.map(d => d.botFallback) },
  ]);
  // busiest hours of the day (your time zone)
  const byHour = Array(24).fill(0);
  for (const h of rows(conn.db.adminHours)) byHour[new Date(h.hour * 3600000).getHours()] += h.matches;
  $('chPeak').innerHTML = barChart(byHour.map((_, i) => `${i}h`), [{ color: '#ffc83d', values: byHour }], { every: 3, height: 170 });
  const ret = rows(conn.db.adminRetention).sort((a, b) => b.day - a.day).slice(0, 14);
  const pc = (a: number, b: number, ready: boolean) => (!ready ? '<span class="mono">not yet</span>' : b ? `${Math.round((a / b) * 100)}% <span class="mono">(${a})</span>` : '—');
  table('tRetention', [
    { k: 'day', label: 'Joined', html: r => dayLabel(r.day) },
    { k: 'joined', label: 'Players', html: r => fmt(r.joined) },
    { k: 'd1', label: 'Next day', html: r => pc(r.d1, r.joined, r.day + 1 < today()) },
    { k: 'd7', label: 'A week later', html: r => pc(r.d7, r.joined, r.day + 7 < today()) },
  ], ret);
}

// ---------- players ----------
let pFilter = 'all', focusName = '';
const flagged = (p: any) => p.reports >= 3 || p.quits >= 5;
const suspended = (p: any) => p.banned || Number(p.banUntil / 1000n) > Date.now();
const muted = (p: any) => Number(p.mutedUntil / 1000n) > Date.now();
function playerPills(p: any) {
  return (p.online ? '<span class="pill p-on">online</span>' : '') + (p.isGuest ? '<span class="pill p-guest">guest</span>' : '')
    + (suspended(p) ? '<span class="pill p-ban">suspended</span>' : '') + (muted(p) ? '<span class="pill p-mute">muted</span>' : '')
    + (flagged(p) ? '<span class="pill p-flag">flagged</span>' : '') + (p.role ? `<span class="pill p-${p.role}">${p.role}</span>` : '');
}
function renderPlayers() {
  const q = $('pSearch').value.trim().toLowerCase();
  let list = rows(conn.db.adminPlayers);
  const all = list.length;
  list = list.filter(p => (!q || p.name.toLowerCase().includes(q)) && (pFilter === 'all' || (pFilter === 'online' && p.online)
    || (pFilter === 'flagged' && flagged(p)) || (pFilter === 'suspended' && suspended(p)) || (pFilter === 'accounts' && !p.isGuest) || (pFilter === 'guests' && p.isGuest)));
  $('pCount').textContent = `${fmt(list.length)} of ${fmt(all)}`;
  table('tPlayers', [
    { k: 'name', label: 'Player', html: p => `<b>${esc(p.name)}</b><br>${playerPills(p)}`, sort: p => p.name.toLowerCase() },
    { k: 'level', label: 'Level', html: p => p.level, sort: p => p.level },
    { k: 'rating', label: 'Rating', html: p => p.rating, sort: p => p.rating },
    { k: 'coins', label: 'Coins', html: p => fmt(p.coins), sort: p => p.coins },
    { k: 'wl', label: 'W–L–D', html: p => `${p.wins}–${p.losses}–${p.draws}`, sort: p => p.wins + p.losses + p.draws },
    { k: 'rep', label: 'Reports', html: p => (p.reports ? `<b style="color:var(--red)">${p.reports}</b>` : '0'), sort: p => p.reports },
    { k: 'seen', label: 'Last seen', html: p => (p.online ? '<span class="up">now</span>' : ago(ms(p.lastSeen))), sort: p => ms(p.lastSeen) },
  ], list.slice(0, 300), { rowAttr: p => `class="click${p.name === focusName ? ' sel' : ''}" data-open="${esc(p.name)}"` });
  renderProfile();
}
$('pSearch').addEventListener('input', () => renderPlayers());
$('pFilters').addEventListener('click', (e: Event) => {
  const b = (e.target as HTMLElement).closest('[data-f]') as HTMLElement | null;
  if (!b) return;
  pFilter = b.dataset.f!;
  document.querySelectorAll('#pFilters .chip').forEach(c => c.classList.toggle('on', c === b));
  renderPlayers();
});
document.addEventListener('click', (e: Event) => {
  const r = (e.target as HTMLElement).closest('[data-open]') as HTMLElement | null;
  if (!r) return;
  openPlayer(r.dataset.open!);
});
function openPlayer(name: string) {
  focusName = name;
  if (section !== 'players') show('players');
  call('adminOpenPlayer', { name });
  $('aNewName').value = ''; $('aDelName').value = ''; $('actErr').textContent = '';
  renderPlayers();
  $('profile').scrollIntoView({ block: 'nearest' });
}
function renderProfile() {
  const p = rows(conn.db.adminProfile)[0];
  if (!p || p.name !== focusName) {
    $('profile').innerHTML = `<div class="empty">${focusName ? 'Loading…' : 'Pick a player to see everything about them.'}</div>`;
    $('pActs').hidden = true;
    return;
  }
  const hist = JSON.parse(p.history || '[]'), reps = JSON.parse(p.reportsJson || '[]');
  const bought = p.bought ? p.bought.split(',') : [];
  const banLeft = p.banned ? 'for good' : until(p.banUntil), muteLeft = until(p.mutedUntil);
  const kv = (v: any, l: string) => `<div><b>${v}</b><small>${l}</small></div>`;
  $('profile').innerHTML = `<div class="ph"><b>${esc(p.name)}</b>${playerPills({ ...p, reports: reps.length, quits: 0 })}<span class="mono">${p.inMatch ? 'in a match now' : ''}</span></div>`
    + `<div class="who">${p.isGuest ? 'Guest' : 'Google account'} · joined ${new Date(ms(p.createdAt)).toLocaleDateString()} · last seen ${p.online ? 'now' : ago(ms(p.lastSeen))}</div>`
    + (banLeft ? `<p class="err">Suspended ${banLeft}${p.banReason ? ` · "${esc(p.banReason)}"` : ''}</p>` : '')
    + (muteLeft ? `<p style="color:var(--orange);font-weight:700;margin:4px 0">Chat muted · ${muteLeft}</p>` : '')
    + `<div class="kv">${kv(p.level, `Level · ${fmt(p.xp)} XP`)}${kv(p.rating, 'Rating')}${kv(fmt(p.coins), 'Coins now')}`
    + `${kv(`${p.wins}–${p.losses}–${p.draws}`, 'Won–lost–drawn')}${kv(fmt(p.earned), 'Coins earned ever')}${kv(fmt(p.spent), 'Coins spent')}`
    + `${kv(p.weekPoints, 'Points this week')}${kv(p.bestStreak, 'Best win streak')}${kv(p.friends, 'Friends')}</div>`
    + `<div class="who">Look: ${esc(p.look)} · owns ${p.owns} items${bought.length ? ` · bought: ${bought.map((i: string) => esc(nameOf(i))).join(', ')}` : ''}</div>`
    + `<div class="who">Awards: ${p.achievements ? esc(p.achievements.split(',').join(', ')) : 'none yet'}</div>`
    + `<h2 style="margin-top:12px;font-size:14px">Recent matches</h2><div class="tableWrap" style="max-height:220px"><table>`
    + `<tr><th class="nosort">When</th><th class="nosort">Type</th><th class="nosort">Against</th><th class="nosort">Result</th><th class="nosort">Rating</th></tr>`
    + (hist.length ? hist.map((h: any) => `<tr><td>${ago(h.at)}</td><td>${MODE[h.mode] || h.mode}</td><td>${esc(h.opp)}</td><td class="${h.result === 'win' ? 'up' : h.result === 'loss' ? 'down' : ''}">${h.result} ${h.you}–${h.them}${h.reason !== 'points' ? ` (${h.reason})` : ''}</td><td>${h.rating ? (h.rating > 0 ? '+' : '') + h.rating : ''}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">No matches yet</td></tr>') + '</table></div>'
    + `<h2 style="margin-top:12px;font-size:14px">Reports against them (${reps.length})</h2>`
    + (reps.length ? reps.map((r: any) => `<div class="who">${ago(r.at)} · <b>${esc(r.reason)}</b> · by ${esc(r.by)}${r.chat ? `<details><summary>Chat from that match</summary><pre class="chat">${esc(r.chat)}</pre></details>` : ''}</div>`).join('') : '<div class="who">None</div>');
  $('pActs').hidden = false;
  $('pActsWho').textContent = p.name;
  $('aRole').value = p.role;
  const takeSel = $('aTakeItem');
  const want = bought.map((i: string) => `<option value="${i}">${esc(KIND_LABEL[ITEM.get(i)?.kind as keyof typeof KIND_LABEL] || '')}: ${esc(nameOf(i))}</option>`).join('');
  if (takeSel.dataset.h !== want) { takeSel.innerHTML = want || '<option value="">Nothing bought</option>'; takeSel.dataset.h = want; }
}
$('pActs').addEventListener('click', async (e: Event) => {
  const b = (e.target as HTMLElement).closest('[data-a]') as HTMLButtonElement | null;
  const name = focusName;
  if (!b || !name) return;
  b.disabled = true;
  switch (b.dataset.a) {
    case 'rename': {
      const nn = $('aNewName').value.trim();
      if (await call('adminRename', { name, newName: nn }, `Renamed to ${nn}`)) { focusName = nn; call('adminOpenPlayer', { name: nn }); }
      break;
    }
    case 'suspend': {
      const h = $('aBanHours').value, reason = $('aBanReason').value.trim();
      if (h === 'perm') { if (confirm(`Suspend ${name} for good?`)) await call('adminBan', { name, banned: true }, `${name} is suspended for good`); }
      else await call('adminSuspend', { name, hours: Number(h), reason }, `${name} is suspended`);
      break;
    }
    case 'unsuspend': await call('adminSuspend', { name, hours: 0, reason: '' }, 'Suspension lifted'); if (isAdminMe()) await call('adminBan', { name, banned: false }); break;
    case 'mute': await call('adminMute', { name, hours: Number($('aMuteHours').value) }, `${name}'s chat is muted`); break;
    case 'unmute': await call('adminMute', { name, hours: 0 }, 'Chat unmuted'); break;
    case 'give': {
      const coins = Math.max(0, Math.min(100000, Number($('aCoins').value) || 0)), item = $('aItem').value;
      if (!coins && !item) { toast('Enter coins or pick an item', true); break; }
      if (await call('adminGrant', { name, coins, item }, `Gave ${name} ${[coins ? coins + ' coins' : '', item ? nameOf(item) : ''].filter(Boolean).join(' + ')}`)) $('aCoins').value = '';
      break;
    }
    case 'takeCoins': { const coins = Math.max(0, Number($('aTakeCoins').value) || 0); if (coins) await call('adminTakeCoins', { name, coins }, `Took ${coins} coins`); break; }
    case 'takeItem': { const item = $('aTakeItem').value; if (item && confirm(`Take ${nameOf(item)} from ${name}?`)) await call('adminTakeItem', { name, item }, 'Item taken'); break; }
    case 'watch': if (await call('adminWatch', { name })) { toast(`Opening ${name}'s matches…`); setTimeout(() => window.open('./', '_blank'), 400); } break;
    case 'resetRating': if (confirm(`Take ${name} off the leaderboards and set their rating back to 1000?`)) await call('adminResetRating', { name }, 'Rating reset'); break;
    case 'role': await call('adminSetRole', { name, role: $('aRole').value }, 'Role saved'); break;
    case 'delete':
      if ($('aDelName').value.trim() !== name) { toast(`Type ${name} to confirm`, true); break; }
      if (confirm(`Delete ${name}'s account and everything on it? This can't be undone.`) && await call('adminDeleteAccount', { name, confirm: name }, `${name} was deleted`)) { focusName = ''; }
      break;
  }
  b.disabled = false;
  render();
});

// ---------- moderation ----------
function renderModeration() {
  const reps = rows(conn.db.adminReports).sort((a, b) => (a.id < b.id ? 1 : -1));
  const groups = new Map<string, any[]>();
  for (const r of reps) groups.set(r.reported, [...(groups.get(r.reported) ?? []), r]);
  const sorted = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);
  $('repGroups').innerHTML = sorted.length ? sorted.map(([who, rs]) => {
    const reasons = Array.from(new Set(rs.map(r => r.reason))).join(' · ');
    return `<div class="act" style="margin-top:10px;align-items:flex-start;flex-direction:column">
      <div class="row" style="width:100%"><b style="font-size:16px">${esc(who)}</b><span class="pill p-flag">${rs.length} report${rs.length === 1 ? '' : 's'}</span>${rs[0].banned ? '<span class="pill p-ban">suspended</span>' : ''}<span class="who" style="margin-left:auto">${ago(ms(rs[0].at))}</span></div>
      <div class="who">${esc(reasons)} · by ${esc(Array.from(new Set(rs.map(r => r.reporter))).join(', '))}</div>
      ${rs.filter(r => r.chat).slice(0, 3).map(r => `<details><summary>Chat when ${esc(r.reporter)} reported (${esc(r.reason)})</summary><pre class="chat">${esc(r.chat)}</pre></details>`).join('')}
      <div class="row"><button class="btn sm" data-open="${esc(who)}" type="button">Open profile</button>
        <button class="btn sm bad" data-q="suspend" data-who="${esc(who)}" type="button">Suspend 24h</button>
        <button class="btn sm" data-q="mute" data-who="${esc(who)}" type="button">Mute chat 24h</button>
        <button class="btn sm go" data-q="close" data-ids="${rs.map(r => r.id).join(',')}" type="button">Done: close ${rs.length === 1 ? 'report' : 'all ' + rs.length}</button></div>
    </div>`;
  }).join('') : '<div class="empty">No open reports. Nice and quiet.</div>';
  const flags = rows(conn.db.adminPlayers).filter(flagged).sort((a, b) => b.reports + b.quits - (a.reports + a.quits));
  table('tFlags', [
    { k: 'name', label: 'Player', html: p => `<b>${esc(p.name)}</b> ${playerPills(p)}` },
    { k: 'rep', label: 'Reports', html: p => p.reports, sort: p => p.reports },
    { k: 'q', label: 'Quit', html: p => `${p.quits} of ${p.recent}`, sort: p => p.quits },
  ], flags, { rowAttr: p => `class="click" data-open="${esc(p.name)}"`, empty: 'Nobody flagged' });
  const bugs = rows(conn.db.adminBugs).sort((a, b) => (a.id < b.id ? 1 : -1));
  table('tBugs', [
    { k: 'at', label: 'When', html: b => ago(ms(b.at)) },
    { k: 'n', label: 'From', html: b => `${esc(b.name)}<br><span class="mono">v${esc(b.version)}</span>` },
    { k: 't', label: 'What happened', html: b => `<div style="white-space:normal;min-width:200px">${esc(b.text)}</div><span class="mono" title="${esc(b.device)}">${esc(b.device.slice(0, 60))}…</span>` },
    { k: 'x', label: '', html: b => `<button class="btn sm" data-q="bug" data-id="${b.id}" type="button">Done</button>` },
  ], bugs, { empty: 'No bug reports' });
}
document.addEventListener('click', async (e: Event) => {
  const b = (e.target as HTMLElement).closest('[data-q]') as HTMLElement | null;
  if (!b) return;
  const q = b.dataset.q;
  if (q === 'suspend') await call('adminSuspend', { name: b.dataset.who, hours: 24, reason: 'Reported by other players' }, `${b.dataset.who} suspended for 24 hours`);
  else if (q === 'mute') await call('adminMute', { name: b.dataset.who, hours: 24 }, `${b.dataset.who}'s chat is muted for 24 hours`);
  else if (q === 'close') { for (const id of b.dataset.ids!.split(',')) await call('adminDismiss', { kind: 'report', id: BigInt(id) }); toast('Closed'); }
  else if (q === 'bug') await call('adminDismiss', { kind: 'bug', id: BigInt(b.dataset.id!) }, 'Closed');
});

// ---------- economy ----------
const saleItems = ITEMS.filter(i => i.price !== undefined);
/** Options grouped by kind, so two items with the same name (a Neon card style and a Neon aura) can't be confused. */
function groupedOpts(list: typeof ITEMS, sel = '') {
  const kinds = Array.from(new Set(list.map(i => i.kind)));
  return kinds.map(k => `<optgroup label="${esc(KIND_LABEL[k])}">${list.filter(i => i.kind === k)
    .map(i => `<option value="${i.id}"${i.id === sel ? ' selected' : ''}>${esc(nameOf(i.id))}</option>`).join('')}</optgroup>`).join('');
}
const itemOpts = (blank: string) => `<option value="">${blank}</option>` + groupedOpts(ITEMS.filter(i => i.key !== ''));
$('aItem').innerHTML = itemOpts('No item');
$('giftItem').innerHTML = itemOpts('No item');
function renderEconomy() {
  const d30 = lastDays(30), t = d30[d30.length - 1]!;
  const s = rows(conn.db.adminSummary)[0] || {};
  const tile = (v: any, l: string) => `<div class="tile"><b>${fmt(v ?? 0)}</b><small>${l}</small></div>`;
  const week = d30.slice(-7);
  $('ecoKpis').innerHTML = tile(t.coinsEarned, 'Coins earned today') + tile(t.coinsSpent, 'Coins spent today') + tile(t.sales, 'Items sold today')
    + tile(week.reduce((n, d) => n + d.sales, 0), 'Items sold this week') + tile(s.coinsInWallets, 'Coins in all wallets');
  $('chCoins').innerHTML = barChart(d30.map(d => dayLabel(d.day)), [{ color: '#ffc83d', values: d30.map(d => Number(d.coinsEarned)) }, { color: '#ff7ac0', values: d30.map(d => Number(d.coinsSpent)) }]);
  table('tSales', [
    { k: 'item', label: 'Item', html: r => `${esc(nameOf(r.item))} <span class="mono">${esc(KIND_LABEL[ITEM.get(r.item)?.kind as keyof typeof KIND_LABEL] || '')}</span>`, sort: r => nameOf(r.item) },
    { k: 'sold', label: 'Sold', html: r => fmt(r.sold), sort: r => r.sold },
    { k: 'w', label: 'Last 7 days', html: r => fmt(r.last7), sort: r => r.last7 },
    { k: 'd', label: 'On deal day', html: r => fmt(r.onDeal), sort: r => r.onDeal },
    { k: 'p', label: 'Price', html: r => fmt(ITEM.get(r.item)?.price ?? 0), sort: r => ITEM.get(r.item)?.price ?? 0 },
  ], sortState.tSales ? rows(conn.db.adminSales) : rows(conn.db.adminSales).sort((a, b) => b.sold - a.sold), { empty: 'Nothing sold yet' });
  // deals for the week
  const deals = rows(conn.db.adminDeals).sort((a, b) => a.daysFromToday - b.daysFromToday);
  const html = deals.map(d => `<div class="dd"><b>${d.daysFromToday === 0 ? 'Today' : d.daysFromToday === 1 ? 'Tomorrow' : dayLabel(today() + d.daysFromToday)}</b>`
    + `<select data-deal="${d.daysFromToday}">${groupedOpts(saleItems, d.item)}</select>`
    + `<span class="pk">${d.picked ? 'Picked by you · <a href="#" data-auto="' + d.daysFromToday + '">undo</a>' : 'Automatic'}</span></div>`).join('');
  if ($('dealDays').dataset.h !== html && !$('dealDays').contains(document.activeElement)) { $('dealDays').innerHTML = html; $('dealDays').dataset.h = html; }
  // event
  const info = rows(conn.db.serverInfo)[0];
  const evOn = info && info.eventName && Number(info.eventEndsAt / 1000n) > Date.now();
  const starts = info ? Number(info.eventStartsAt / 1000n) : 0;
  $('evNow').innerHTML = evOn ? `<b class="up">${esc(info.eventName)}</b>: coins ×${info.eventCoinPct / 100}, XP ×${info.eventXpPct / 100} · ${starts > Date.now() ? `starts ${new Date(starts).toLocaleString()}` : 'running now'} · ends ${new Date(Number(info.eventEndsAt / 1000n)).toLocaleString()}` : 'No event running.';
}
$('dealDays').addEventListener('change', (e: Event) => {
  const s = e.target as HTMLSelectElement;
  if (s.dataset.deal) call('adminSetDeal', { daysFromToday: Number(s.dataset.deal), item: s.value }, 'Deal saved');
});
$('dealDays').addEventListener('click', (e: Event) => {
  const a = (e.target as HTMLElement).closest('[data-auto]') as HTMLElement | null;
  if (a) { e.preventDefault(); call('adminSetDeal', { daysFromToday: Number(a.dataset.auto), item: '' }, 'Back to the automatic deal'); }
});
$('evGo').onclick = () => {
  const name = $('evName').value.trim() || 'Bonus event';
  call('adminEvent', { name, coinPct: Number($('evCoins').value), xpPct: Number($('evXp').value), hours: Number($('evHours').value), startInHours: Number($('evStart').value) }, `${name} is set`);
};
$('evStop').onclick = () => call('adminEvent', { name: '', coinPct: 100, xpPct: 100, hours: 0, startInHours: 0 }, 'Event stopped');
$('giftGo').onclick = async () => {
  const coins = Math.max(0, Math.min(10000, Number($('giftCoins').value) || 0)), item = $('giftItem').value;
  if (!coins && !item) { toast('Enter coins or pick an item', true); return; }
  const what = [coins ? `${coins} coins` : '', item ? nameOf(item) : ''].filter(Boolean).join(' and ');
  if (!confirm(`Give every player ${what}?`)) return;
  if (await call('adminGiftAll', { coins, item }, `Everyone got ${what}`)) { $('giftCoins').value = ''; $('giftItem').value = ''; }
};

// ---------- live ----------
function renderLive() {
  const live = rows(conn.db.adminLive);
  $('liveSub').textContent = `${live.length} playing`;
  table('tLive', [
    { k: 'm', label: 'Type', html: g => MODE[g.mode] || g.mode, sort: g => g.mode },
    { k: 'p', label: 'Players', html: g => `<b>${esc(g.name0)}</b> vs <b>${esc(g.name1)}</b>` },
    { k: 's', label: 'Score', html: g => `${g.score0}–${g.score1}` },
    { k: 'r', label: 'Round', html: g => `${g.round} / 10 <span class="mono">${g.phase}</span>`, sort: g => g.round },
    { k: 'w', label: '', html: g => `<button class="btn sm" data-watch="${esc(g.name0)}" type="button">Watch</button>` },
  ], live, { empty: 'No matches being played right now' });
  const info = rows(conn.db.serverInfo)[0];
  const ends = info ? Number(info.noticeEndsAt / 1000n) : 0;
  const on = info && (info.message || info.maintenance) && (!ends || ends > Date.now());
  $('noticeNow').innerHTML = on ? `Showing now: ${info.maintenance ? '<b class="down">[maintenance]</b> ' : ''}${esc(info.message)}${info.backAt ? ` · back ${new Date(Number(info.backAt / 1000n)).toLocaleTimeString()}` : ''}${ends ? ` · hides ${new Date(ends).toLocaleString()}` : ''}` : 'No notice showing.';
}
document.addEventListener('click', async (e: Event) => {
  const b = (e.target as HTMLElement).closest('[data-watch]') as HTMLElement | null;
  if (b && await call('adminWatch', { name: b.dataset.watch })) { toast('Opening the match…'); setTimeout(() => window.open('./', '_blank'), 400); }
});
$('nGo').onclick = () => call('adminNotice', { maintenance: $('nMaint').checked, message: $('nMsg').value, backInMinutes: Number($('nBack').value), hideAfterHours: Number($('nHide').value) }, 'Notice is showing');
$('nClear').onclick = () => { $('nMaint').checked = false; call('adminNotice', { maintenance: false, message: '', backInMinutes: 0, hideAfterHours: 0 }, 'Notice removed'); };

// ---------- team and log ----------
function renderTeam() {
  table('tStaff', [
    { k: 'n', label: 'Name', html: s => `<b>${esc(s.name)}</b>`, sort: s => s.name },
    { k: 'r', label: 'Role', html: s => `<span class="pill p-${s.role}">${s.role === 'admin' ? 'Admin' : 'Moderator'}</span>${s.fixed ? '<span class="mono">set in config.ts</span>' : ''}` },
    { k: 'o', label: '', html: s => (s.online ? '<span class="pill p-on">online</span>' : '') },
    { k: 'x', label: '', html: s => (!s.fixed && isAdminMe() ? `<button class="btn sm" data-open="${esc(s.name)}" type="button">Change</button>` : '') },
  ], rows(conn.db.adminStaff));
}
function renderLog() {
  table('tLog', [
    { k: 'at', label: 'When', html: l => `${new Date(ms(l.at)).toLocaleString()}`, sort: l => ms(l.at) },
    { k: 'by', label: 'Who', html: l => esc(l.by), sort: l => l.by },
    { k: 'a', label: 'Did', html: l => `<b>${esc(l.action)}</b>`, sort: l => l.action },
    { k: 't', label: 'To', html: l => esc(l.target) },
    { k: 'd', label: 'Details', html: l => `<span style="white-space:normal">${esc(l.detail)}</span>` },
  ], rows(conn.db.adminLogView).sort((a, b) => ms(b.at) - ms(a.at)), { empty: 'Nothing yet' });
}

setInterval(() => { if (me && me.isMod && (section === 'overview' || section === 'live')) render(); }, 30000);
start();
