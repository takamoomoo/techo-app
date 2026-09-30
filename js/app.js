// 手帳アプリ 本体（画面・操作）
import * as L from './logic.js';
import { GoogleBackend, consumeRedirectToken, readLoginLog, isStandalone } from './backend-google.js';
import { DemoBackend } from './backend-demo.js';
import { buildPrint } from './print.js';
import { Notes, GitHubNotes, DemoNotes } from './obsidian.js';
import * as O from './obsidian-md.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const HOUR_PX = 40, DAY_FROM = 6, DAY_TO = 22; // 画面の時間帯 6:00〜22:00

// ---------- 設定・キャッシュ（localStorage は失敗しても動くように） ----------
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 無視 */ } }

// Google OAuth クライアントID は秘密情報ではないので既定値として持つ（端末ごとの入力を不要にする）
const DEFAULT_CLIENT_ID = '652451864608-8v8n62vs721gom1qc3ugu0pdjptlmcuq.apps.googleusercontent.com';
const PUBLIC_URL = 'https://takamoomoo.github.io/techo-app/';
const isClientId = s => /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(s || '');

// 「スマホへ設定を送る」のリンク（…#import=…）から設定を取り出す
function parseImport(text) {
  const m = String(text || '').match(/#import=([^\s#]+)/);
  if (!m) return null;
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(decodeURIComponent(m[1])), c => c.charCodeAt(0)))); }
  catch { return null; }
}
// QR で開かれたとき: URL から設定を取り込み、すぐ URL から消す
let importLink = '';
function readImport() {
  if (!location.hash.startsWith('#import=')) return null;
  const s = parseImport(location.hash);
  importLink = PUBLIC_URL + location.hash; // ブラウザで開いた時にホーム画面アプリへ渡せるよう控える
  history.replaceState(null, '', location.pathname + location.search);
  return s;
}
const redirected = consumeRedirectToken(); // Google ログイン（ページ移動方式）から戻ってきた場合
const imported = readImport();
const settings = {
  mode: location.hostname.endsWith('github.io') ? 'google' : 'demo', clientId: DEFAULT_CLIENT_ID,
  ghToken: '', ghRepo: 'takamoomoo/takayuki-brain', ghBranch: 'main',
  ...(lsGet('techo-settings') || {}), ...(imported || {}),
};
if (!isClientId(settings.clientId)) settings.clientId = DEFAULT_CLIENT_ID; // 貼り間違い・途中切れを救済
if (imported) lsSet('techo-settings', settings);
const state = {
  view: matchMedia('(max-width: 760px)').matches ? 'day' : 'week',
  anchor: L.ymd(new Date()), today: L.ymd(new Date()),
  items: null, overdue: [], parents: new Map(), children: new Map(),
  holidaySet: new Set(), holidayNames: new Map(),
  offline: false, cachedAt: null, needLogin: false, loading: false, error: '', selected: null,
  notes: new Map(), notesWeek: null, notesAt: 0, notesError: '', notesOffline: false,
  drafts: lsGet('techo-drafts') || {}, // 入力途中のメモ（保存前）は端末に残す
  page: location.hash === '#home' || lsGet('techo-page') === 'home' ? 'home' : 'schedule', // #home か最後に開いていた画面
  home: lsGet('techo-home-cache'), homeSha: null, homeError: '', cover: lsGet('techo-cover'),
};
let backend = makeBackend();
let notes = makeNotes();

function makeNotes() {
  if (settings.ghToken) return new Notes(new GitHubNotes({ token: settings.ghToken, repo: settings.ghRepo, branch: settings.ghBranch }));
  return backend.name === 'demo' ? new Notes(new DemoNotes()) : null;
}

function makeBackend() {
  return settings.mode === 'google' && settings.clientId ? new GoogleBackend(settings.clientId, location.href.startsWith(PUBLIC_URL) ? PUBLIC_URL : null) : new DemoBackend();
}

function range() {
  if (state.view === 'week') { const m = L.mondayOf(state.anchor); return { from: m, to: L.addDays(m, 6) }; }
  return { from: state.anchor, to: state.anchor };
}

// ---------- 読み込み ----------
async function load() {
  state.today = L.ymd(new Date());
  const { from, to } = range();
  const f = L.addDays(from, -21), t = L.addDays(to, 21); // 準備タスクは親より前にあるので広めに取る
  state.loading = true; render();
  try {
    if (!backend.signedIn) { const e = new Error('Googleにログインしてください'); e.code = 'AUTH'; throw e; }
    if (!backend.ready) { await backend.setup(); backend.ready = true; }
    const [raw, overdue] = await Promise.all([backend.listRange(f, t), backend.listOverdue(state.today)]);
    const known = new Set([...raw.events, ...raw.tasks, ...overdue].map(e => e.id));
    const missing = [...new Set([...raw.tasks, ...overdue]
      .map(e => e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.parentId)
      .filter(id => id && !known.has(id)))];
    const parentsRaw = (await Promise.all(missing.map(id => backend.getItem(id)))).filter(Boolean);
    const snap = { f, t, raw, overdue, parentsRaw, at: Date.now() };
    apply(snap);
    lsSet(`techo-cache-${backend.name}`, snap);
    state.offline = false; state.cachedAt = null; state.error = ''; state.needLogin = false;
  } catch (e) {
    if (e.code === 'AUTH') state.needLogin = true;
    else state.error = e.message;
    const c = lsGet(`techo-cache-${backend.name}`);
    if (c && c.f <= from && c.t >= to) {
      apply(c);
      state.offline = e.code !== 'AUTH';
      state.cachedAt = c.at;
    } else if (!state.items || e.code !== 'AUTH') {
      state.items = null;
    }
  } finally {
    state.loading = false;
    render();
  }
  await loadNotes();
}

// ---------- Obsidian デイリーノート（表示中の週の7日分） ----------
async function loadNotes(force = false) {
  if (!notes) { state.notes = new Map(); render(); return; }
  const monday = L.mondayOf(state.anchor);
  if (!force && state.notesWeek === monday && Date.now() - state.notesAt < 60000) return;
  const key = `techo-notes-cache-${notes.name}`;
  try {
    state.notes = await notes.loadDays(L.weekDates(monday));
    state.notesWeek = monday; state.notesAt = Date.now(); state.notesError = ''; state.notesOffline = false;
    lsSet(key, { monday, days: [...state.notes] });
  } catch (e) {
    const c = lsGet(key);
    if (c && c.monday === monday) { state.notes = new Map(c.days); state.notesOffline = true; }
    else state.notes = new Map();
    state.notesError = e.message;
  }
  render();
}

// 📓 行（アプリで書いた行）だけ削除できる。Obsidian側で書いた行は Obsidian で直す
function deleteNote(date, kind, i) {
  const n = state.notes.get(date);
  const item = n && n[kind][i];
  if (!item || !item.mine) return;
  if (state.notesOffline || !navigator.onLine) return toast('オフライン中は削除できません');
  openModal('メモの削除', `<p>「${esc(item.text)}」をObsidianのノートから削除します。</p>`, async () => {
    try {
      const ok = await notes.remove(date, kind, item.text);
      toast(ok ? '削除しました' : '既に削除されていました');
      await loadNotes(true);
    } catch (e) { toast(e.message); return false; }
  }, '削除する');
}

async function saveNote(date, kind) {
  const k = `${date}:${kind}`;
  const text = (state.drafts[k] || '').trim();
  if (!text) return toast('書く内容を入力してください');
  if (!notes) return toast('⚙設定でGitHubトークンを入れてください');
  if (state.notesOffline || !navigator.onLine) return toast('オフライン中は保存できません（入力内容はこの端末に残ります）');
  try {
    const n = await notes.append(date, kind, text);
    delete state.drafts[k]; lsSet('techo-drafts', state.drafts);
    toast(`Obsidianに${n}行追記しました`);
    await loadNotes(true);
  } catch (e) { toast(e.message); }
}

function apply({ raw, overdue, parentsRaw }) {
  const events = raw.events.map(e => L.normalize(e, 'event'));
  const tasks = raw.tasks.map(e => L.normalize(e, 'task'));
  const holidays = raw.holidays.map(e => L.normalize(e, 'holiday'));
  const family = raw.family.map(e => L.normalize(e, 'family'));
  state.items = { events, tasks, holidays, family };
  state.holidaySet = new Set(holidays.map(h => h.date));
  state.holidayNames = new Map(holidays.map(h => [h.date, h.title]));
  state.overdue = L.carryOver(overdue.map(e => L.normalize(e, 'task')), state.today);
  const allTasks = new Map([...tasks, ...state.overdue].map(x => [x.id, x]));
  const extra = parentsRaw.map(p => L.normalize(p.ev, p.kind));
  state.parents = new Map([...events, ...allTasks.values(), ...extra].map(e => [e.id, e]));
  state.children = L.groupChildren([...allTasks.values()]);
}

// ---------- 書き込み ----------
const canWrite = () => !state.offline && !state.needLogin && !!state.items;

async function write(fn, msg) {
  if (!canWrite()) { toast(state.needLogin ? '先にGoogleにログインしてください' : 'オフライン中は変更できません（閲覧のみ）'); return false; }
  try {
    await fn();
    if (msg) toast(msg);
    await load();
    return true;
  } catch (e) {
    if (e.code === 'AUTH') state.needLogin = true;
    toast(e.message);
    render();
    return false;
  }
}

const privOf = i => ({ ...((i.raw.extendedProperties && i.raw.extendedProperties.private) || {}) });

function findItem(id) {
  if (!state.items) return null;
  const { events, tasks, family } = state.items;
  return [...tasks, ...state.overdue, ...events, ...family].find(i => i.id === id) || state.parents.get(id) || null;
}

function setDone(t, done) {
  return write(() => backend.patch('task', t.id, {
    summary: (done ? L.DONE_MARK : '') + t.title,
    extendedProperties: { private: { ...privOf(t), done: done ? '1' : '0' } },
  }), done ? '完了にしました' : '未完了に戻しました');
}

function moveTask(t, date) {
  return write(() => backend.patch('task', t.id, { start: { date }, end: { date: L.addDays(date, 1) } }),
    `${L.mdLabel(date)} に移動しました`);
}

// ---------- HOME（表紙＋メニュー） ----------
// メニューは配列で管理（大きな時計・習慣化管理などを後から足す）
const MENU = [
  { act: 'open-schedule', icon: '📅', title: 'スケジュール帳', desc: '週・日表示／Googleカレンダー・Obsidian連携' },
  { icon: '⏰', title: '大きな時計', desc: '準備中', soon: true },
  { icon: '✅', title: '習慣化管理', desc: '準備中', soon: true },
];

function homeHtml() {
  const h = state.home || O.DEFAULT_HOME;
  const items = h.items.map((t, i) => {
    const hl = t.startsWith(O.HIGHLIGHT);
    return `<li class="${hl ? 'hl' : ''}"><span class="n">${String(i + 1).padStart(2, '0')}</span><span class="t">${esc(hl ? t.slice(1) : t)}</span></li>`;
  }).join('');
  const photo = state.cover ? `style="background-image:url('${state.cover}')"` : '';
  return `<div class="homepage">
    <section class="cover">
      <div class="cv-photo${state.cover ? '' : ' none'}" ${photo}></div>
      <div class="cv-brand">PERSONAL NOTEBOOK</div>
      <div class="cv-title"><span class="hut">🛖</span><h1>HOME</h1><div class="line"></div></div>
      <div class="cv-slogan" data-act="edit-home" role="button" tabindex="0" title="押して編集">
        <div class="label">☀ MONTHLY SLOGAN <span class="jp">今月のスローガン</span><span class="pen">✎ 編集</span></div>
        <h2>${esc(h.title)}</h2><ol>${items}</ol>
      </div>
      <div class="cv-mission" data-act="edit-home" role="button" tabindex="0" title="押して編集">
        <p>${esc(h.mission).replace(/\n/g, '<br>')}</p>${h.sub ? `<div class="sub">${esc(h.sub)}</div>` : ''}
      </div>
    </section>
    <aside class="menu">
      <h3>MENU <span>メニュー</span></h3>
      ${MENU.map(m => m.soon
        ? `<div class="mi soon"><span class="ic">${m.icon}</span><span><b>${esc(m.title)}</b><small>${esc(m.desc)}</small></span></div>`
        : `<button class="mi" data-act="${m.act}"><span class="ic">${m.icon}</span><span><b>${esc(m.title)}</b><small>${esc(m.desc)}</small></span><span class="go">›</span></button>`).join('')}
      ${state.homeError ? `<p class="note">${esc(state.homeError)}</p>` : ''}
      ${!notes ? '<p class="note">⚙でGitHubトークンを入れると、スローガンがObsidianに保存されPCとスマホで共有されます。</p>' : ''}
    </aside>
  </div>`;
}

async function loadHome() {
  state.homeError = '';
  if (!notes) { state.home = lsGet('techo-home-local') || { ...O.DEFAULT_HOME }; state.homeSha = null; render(); return; }
  try {
    const r = await notes.loadHome();
    state.home = r.home; state.homeSha = r.sha;
    lsSet('techo-home-cache', r.home);
  } catch (e) {
    state.home = lsGet('techo-home-cache') || { ...O.DEFAULT_HOME };
    state.homeError = `Obsidianから読めませんでした（${e.message}）。保存済みの内容を表示しています`;
  }
  render();
  if (!state.cover) {
    try {
      const c = await notes.loadCover();
      if (c) { state.cover = c; lsSet('techo-cover', c); render(); }
    } catch { /* 写真が無くても表紙は出す */ }
  }
}

function editHome() {
  const h = state.home || O.DEFAULT_HOME;
  openModal('今月のスローガンを編集', `
    <label>スローガン（大きな見出し）<input name="title" required value="${esc(h.title)}"></label>
    <label>項目（1行1件。先頭に ★ を付けると強調）<textarea name="items" rows="8">${esc(h.items.join('\n'))}</textarea></label>
    <label>ミッション<textarea name="mission" rows="3">${esc(h.mission)}</textarea></label>
    <label>肩書き<input name="sub" value="${esc(h.sub)}"></label>
    <p class="note">${notes ? 'Obsidian の「手帳アプリ/HOME.md」に保存され、PCとスマホで共有されます。' : 'この端末だけに保存されます（⚙でGitHubトークンを入れるとObsidianに保存）。'}</p>`,
  async fd => {
    const next = {
      title: String(fd.get('title')).trim(),
      items: String(fd.get('items')).split(/\r?\n/).map(s => s.trim()).filter(Boolean),
      mission: String(fd.get('mission')).trim(), sub: String(fd.get('sub')).trim(),
    };
    if (!notes) { lsSet('techo-home-local', next); state.home = next; render(); toast('保存しました'); return; }
    try {
      const r = await notes.saveHome(next, state.homeSha);
      state.home = r.home; state.homeSha = r.sha; lsSet('techo-home-cache', r.home);
      render(); toast('Obsidianに保存しました');
    } catch (e) {
      toast(e.message);
      if (e.code === 'STALE') await loadHome();
      return false;
    }
  }, '保存');
}

function goPage(page) {
  state.page = page;
  lsSet('techo-page', page);
  state.selected = null;
  if (page === 'home') { render(); loadHome(); } else load();
}

// ---------- 描画 ----------
function render() {
  document.body.classList.toggle('on-home', state.page === 'home');
  if (state.page === 'home') {
    $('#banner').innerHTML = '';
    $('#main').innerHTML = homeHtml();
    $('#selbar').hidden = true;
    return;
  }
  $('#period').textContent = periodLabel();
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === state.view));
  $('#banner').innerHTML = bannerHtml();
  const main = $('#main');
  if (!state.items) {
    main.innerHTML = state.loading ? '<p class="empty">読み込み中…</p>'
      : state.needLogin ? loginHtml() : `<p class="empty">表示できるデータがありません。${esc(state.error)}</p>`;
  } else {
    main.innerHTML = state.view === 'week' ? weekHtml() : dayHtml();
  }
  $('#selbar').innerHTML = selbarHtml();
  $('#selbar').hidden = !state.selected || !findItem(state.selected);
  requestAnimationFrame(drawLinks);
}

function periodLabel() {
  const { from, to } = range();
  const y = L.parseYmd(from).getFullYear();
  if (from === to) return `${y}年 ${L.mdLabel(from)}（${L.WEEKDAYS[L.weekday(from)]}）`;
  return `${y}年 ${L.mdLabel(from)} 〜 ${L.mdLabel(to)}`;
}

function bannerHtml() {
  const b = [];
  if (backend.name === 'demo') b.push('<div class="bn demo">お試しモード：データはこの端末だけに保存されます。⚙設定でGoogleカレンダーに切替</div>');
  if (state.needLogin && state.items) b.push(`<div class="bn warn">ログインが必要です（表示は保存済みの内容・閲覧のみ） <button data-act="login">Googleでログイン</button></div>`);
  if (state.offline) {
    const at = state.cachedAt ? new Date(state.cachedAt) : null;
    b.push(`<div class="bn warn">オフライン表示${at ? `（${at.getMonth() + 1}/${at.getDate()} ${L.hhmm(at.getHours() * 60 + at.getMinutes())} 時点）` : ''}・閲覧のみ <button data-act="reload">再読込</button></div>`);
  } else if (state.error) b.push(`<div class="bn err">${esc(state.error)}</div>`);
  return b.join('');
}

function loginHtml() {
  return `<div class="login"><p>Googleカレンダーの予定を表示するにはログインしてください。</p>
    <button class="primary" data-act="login">Googleでログイン</button></div>`;
}

function dayClass(d) {
  const wd = L.weekday(d);
  return [state.holidaySet.has(d) || wd === 0 ? 'sun' : wd === 6 ? 'sat' : '', d === state.today ? 'today' : ''].join(' ');
}

function allDayOn(d) {
  const { events, family, tasks } = state.items;
  return L.sortItems([...L.itemsOn([...events, ...family], d).filter(i => i.allDay), ...tasks.filter(t => t.date === d)]);
}
function timedOn(d) {
  const { events, family } = state.items;
  return [...events, ...family].filter(i => !i.allDay && i.date === d).sort((a, b) => a.startMin - b.startMin);
}

function itemHtml(i) {
  const sel = state.selected === i.id ? ' sel' : '';
  if (i.kind === 'task') {
    const color = i.parentId ? `--c:${L.linkColor(i.parentId)}` : '';
    const p = i.parentId && state.parents.get(i.parentId);
    const kids = state.children.get(i.id);
    const style = color || (kids ? `--c:${L.linkColor(i.id)}` : '');
    const cl = i.checklist.length ? `<span class="cl">☑${i.checklist.filter(c => c.done).length}/${i.checklist.length}</span>` : '';
    const to = p ? `<span class="to">▶ ${L.mdLabel(p.date)} ${esc(p.title)}</span>` : i.parentId ? '<span class="to">▶ （親が見つかりません）</span>' : '';
    const pg = kids ? `<span class="pg" style="--c:${L.linkColor(i.id)}">${L.progressLabel(kids)}</span>` : '';
    return `<div class="it task${i.done ? ' done' : ''}${i.parentId || kids ? ' linked' : ''}${sel}" data-id="${i.id}" data-kind="task" data-parent="${i.parentId || ''}" style="${style}">
      <button class="chk" data-act="toggle" data-id="${i.id}" aria-label="完了切替">${i.done ? '✓' : ''}</button>
      <div class="tx"><span class="ti">${esc(i.title)}</span>${cl}${pg}${to}</div></div>`;
  }
  const kids = state.children.get(i.id);
  const color = kids ? `--c:${L.linkColor(i.id)}` : '';
  const tm = i.allDay ? '' : `<span class="tm">${L.hhmm(i.startMin)}</span>`;
  return `<div class="it ev ${i.kind}${kids ? ' linked' : ''}${sel}" data-id="${i.id}" data-kind="${i.kind}" style="${color}">
    <div class="tx">${tm}<span class="ti">${esc(i.title)}</span>${kids ? `<span class="pg">${L.progressLabel(kids)}</span>` : ''}</div></div>`;
}

function overdueHtml() {
  if (!state.overdue.length) return '';
  const { from, to } = range();
  if (!(from <= state.today && state.today <= to)) return '';
  return `<section class="carry"><h3>⚠ 持ち越し（${state.overdue.length}）</h3>
    ${state.overdue.map(t => `<div class="carry-row"><span class="cd">${L.mdLabel(t.date)}</span>${itemHtml(t)}
      <span class="acts"><button data-act="to-today" data-id="${t.id}">今日へ</button><button data-act="toggle" data-id="${t.id}">完了</button><button data-act="delete" data-id="${t.id}">削除</button></span></div>`).join('')}
  </section>`;
}

function timelineHtml(d) {
  const list = timedOn(d);
  const lanes = [];
  const placed = list.map(i => {
    const s = Math.max(i.startMin, DAY_FROM * 60), e = Math.min(Math.max(i.endMin, s + 20), DAY_TO * 60);
    let lane = lanes.findIndex(end => end <= s);
    if (lane < 0) { lane = lanes.length; lanes.push(e); } else lanes[lane] = e;
    return { i, s, e, lane };
  });
  const n = Math.max(1, lanes.length);
  const blocks = placed.filter(p => p.e > p.s).map(({ i, s, e, lane }) => {
    const style = `top:${(s / 60 - DAY_FROM) * HOUR_PX}px;height:${((e - s) / 60) * HOUR_PX - 2}px;left:${(lane / n) * 100}%;width:${100 / n}%`;
    const kids = state.children.get(i.id);
    return `<div class="it tb ${i.kind}${kids ? ' linked' : ''}${state.selected === i.id ? ' sel' : ''}" data-id="${i.id}" data-kind="${i.kind}" style="${style};${kids ? `--c:${L.linkColor(i.id)}` : ''}">
      <span class="tm">${L.hhmm(i.startMin)}${i.endMin ? `-${L.hhmm(i.endMin)}` : ''}</span> <span class="ti">${esc(i.title)}</span>${kids ? `<span class="pg">${L.progressLabel(kids)}</span>` : ''}</div>`;
  }).join('');
  return `<div class="tl" data-date="${d}" style="height:${(DAY_TO - DAY_FROM) * HOUR_PX}px">${blocks}</div>`;
}

function axisHtml() {
  let s = '';
  for (let h = DAY_FROM; h < DAY_TO; h++) s += `<span style="top:${(h - DAY_FROM) * HOUR_PX}px">${h}:00</span>`;
  return `<div class="axis" style="height:${(DAY_TO - DAY_FROM) * HOUR_PX}px">${s}</div>`;
}

function weekHtml() {
  const days = L.weekDates(L.mondayOf(state.anchor));
  const heads = days.map(d => `<div class="wh ${dayClass(d)}" data-act="goto-day" data-date="${d}">
      <b>${L.mdLabel(d)}</b> ${L.WEEKDAYS[L.weekday(d)]}${state.holidayNames.has(d) ? `<small>${esc(state.holidayNames.get(d))}</small>` : ''}</div>`).join('');
  const tasks = days.map(d => `<div class="wc tasks ${dayClass(d)}">${allDayOn(d).map(itemHtml).join('')}
      <button class="add" data-act="new-task" data-date="${d}">＋</button></div>`).join('');
  const tls = days.map(d => `<div class="wc ${dayClass(d)}">${timelineHtml(d)}</div>`).join('');
  return `<div class="board week">${overdueHtml()}
    <div class="wgrid">
      <div class="wl"></div>${heads}
      <div class="wl lab">メモ</div>${days.map(d => noteCell(d, 'memo')).join('')}
      <div class="wl lab">タスク</div>${tasks}
      <div class="wl lab sec">予定</div>${days.map(d => `<div class="wsec ${dayClass(d)}"></div>`).join('')}
      <div class="wl">${axisHtml()}</div>${tls}
      <div class="wl lab">結果<br>記録</div>${days.map(d => noteCell(d, 'log')).join('')}
    </div><svg class="links"></svg></div>`;
}

function noteCell(d, kind) {
  const n = state.notes.get(d);
  const list = n ? n[kind] : [];
  return `<div class="wc note ${kind} ${dayClass(d)}" data-act="goto-day" data-date="${d}">${list.map(x =>
    `<div class="nl${x.mine ? ' mine' : ''}">${esc(x.text)}</div>`).join('')}</div>`;
}

function dayHtml() {
  const d = state.anchor;
  return `<div class="board day">${missionHtml(d)}${overdueHtml()}
    <section class="dsec"><h3 class="${dayClass(d)}">タスク${state.holidayNames.has(d) ? `（${esc(state.holidayNames.get(d))}）` : ''}</h3>
      <div class="dlist">${allDayOn(d).map(itemHtml).join('') || '<p class="none">なし</p>'}</div>
      <div class="dadd"><button data-act="new-event" data-date="${d}">＋予定</button><button data-act="new-task" data-date="${d}">＋タスク</button></div>
    </section>
    <section class="dsec"><h3>予定</h3><div class="dtl">${axisHtml()}${timelineHtml(d)}</div></section>
    ${noteSection(d, 'memo')}${noteSection(d, 'log')}
    <svg class="links"></svg></div>`;
}

function missionHtml(d) {
  const n = state.notes.get(d);
  if (!n || !n.exists) return '';
  const { work, goal } = n.mission, w = n.weather;
  if (!work && !goal && !w.weather) return '';
  return `<section class="mission">
    ${work || goal ? `<div><b>🚀 今日の1ミッション</b>${work ? `<span>業務：${esc(work)}</span>` : ''}${goal ? `<span>目標：${esc(goal)}</span>` : ''}</div>` : ''}
    ${w.weather ? `<div class="wx">🌤 ${esc(w.weather)}${w.temp ? ` ${esc(w.temp)}℃` : ''}${w.condition ? ` ・体調 ${esc(w.condition)}` : ''}</div>` : ''}
  </section>`;
}

function noteSection(d, kind) {
  const title = kind === 'memo' ? '📝 手帳メモ' : '⚔️ 結果記録（行動ログ）';
  if (!notes) return `<section class="dsec"><h3>${title}</h3><p class="none">Obsidianに保存するには <button data-act="settings">⚙設定</button> でGitHubトークンを入れてください。</p></section>`;
  const n = state.notes.get(d);
  const list = n ? n[kind] : [];
  const k = `${d}:${kind}`;
  return `<section class="dsec notes">
    <h3>${title}${state.notesOffline ? '<small>（オフライン表示）</small>' : ''}</h3>
    ${list.length ? `<ul class="nlist">${list.map((x, i) => `<li class="${x.mine ? 'mine' : ''}"><span>${esc(x.text)}</span>${x.mine
      ? `<button class="ndel" data-act="del-note" data-date="${d}" data-kind="${kind}" data-i="${i}" aria-label="この行を削除">✕</button>` : ''}</li>`).join('')}</ul>` : '<p class="none">まだありません</p>'}
    <textarea data-draft="${k}" rows="2" placeholder="${kind === 'memo' ? '例：2-21網走川美和 完了検査' : '例：杭10本と見出しを準備した'}（1行1件）">${esc(state.drafts[k] || '')}</textarea>
    <div class="dadd"><button class="primary" data-act="save-note" data-date="${d}" data-kind="${kind}">Obsidianに保存</button></div>
  </section>`;
}

function selbarHtml() {
  const i = state.selected && findItem(state.selected);
  if (!i) return '';
  const btns = [`<button data-act="edit" data-id="${i.id}">詳細・編集</button>`];
  if (i.kind === 'event' || i.kind === 'task') btns.push(`<button class="primary" data-act="prep" data-id="${i.id}">＋準備</button>`);
  if (i.kind === 'task') btns.push(`<button data-act="toggle" data-id="${i.id}">${i.done ? '未完了に戻す' : '完了'}</button>`);
  if (i.kind === 'task' && i.parentId && state.parents.get(i.parentId)) btns.push(`<button data-act="goto-parent" data-id="${i.id}">親へ</button>`);
  btns.push('<button data-act="deselect">✕</button>');
  return `<span class="st">${esc(i.title)}</span><span class="sb">${btns.join('')}</span>`;
}

// 親子を線で結ぶ（画面のみ・印刷しない）
function drawLinks() {
  const board = document.querySelector('.board');
  if (!board) return;
  const svg = board.querySelector('svg.links');
  board.querySelectorAll('.it.hl').forEach(e => e.classList.remove('hl'));
  svg.innerHTML = '';
  const sel = state.selected && findItem(state.selected);
  if (!sel) return;
  const pid = sel.kind === 'task' && !state.children.get(sel.id) ? sel.parentId : sel.id;
  if (!pid) return;
  const pEl = board.querySelector(`.it[data-id="${pid}"]`);
  const cEls = [...board.querySelectorAll(`.it[data-parent="${pid}"]`)];
  [pEl, ...cEls].forEach(e => e && e.classList.add('hl'));
  if (!pEl || !cEls.length) return;
  svg.setAttribute('width', board.scrollWidth);
  svg.setAttribute('height', board.scrollHeight);
  const br = board.getBoundingClientRect();
  const pt = (r, side) => ({
    x: (side === 'l' ? r.left : r.right) - br.left + board.scrollLeft,
    y: r.top + r.height / 2 - br.top + board.scrollTop,
  });
  const color = L.linkColor(pid);
  const pr = pEl.getBoundingClientRect();
  svg.innerHTML = cEls.map(c => {
    const cr = c.getBoundingClientRect();
    const leftToRight = cr.left + cr.width / 2 <= pr.left + pr.width / 2;
    const a = pt(cr, leftToRight ? 'r' : 'l'), b = pt(pr, leftToRight ? 'l' : 'r');
    const dx = Math.max(30, Math.abs(b.x - a.x) / 2) * (leftToRight ? 1 : -1);
    return `<path d="M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}" stroke="${color}" stroke-width="2.5" fill="none" stroke-dasharray="6 4"/>
      <circle cx="${b.x}" cy="${b.y}" r="4" fill="${color}"/>`;
  }).join('');
}

// ---------- モーダル ----------
function openModal(title, bodyHtml, onSubmit, submitLabel = '保存', extraBtn = '') {
  const m = $('#modal');
  m.innerHTML = `<form class="mbox"><h2>${esc(title)}</h2>${bodyHtml}
    <div class="mbtns">${extraBtn}<span class="sp"></span><button type="button" data-close>キャンセル</button><button class="primary" type="submit">${esc(submitLabel)}</button></div></form>`;
  m.hidden = false;
  const form = m.querySelector('form');
  form.onsubmit = async ev => {
    ev.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    const ok = await onSubmit(new FormData(form), form);
    btn.disabled = false;
    if (ok !== false) closeModal();
  };
  m.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  const first = form.querySelector('input,textarea');
  if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
  return form;
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }

function eventForm(ev, date) {
  const e = ev || { title: '', date, allDay: false, startMin: 9 * 60, endMin: 10 * 60, location: '' };
  const t = m => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const form = openModal(ev ? '予定の編集' : '予定の追加', `
    <label>件名<input name="title" required value="${esc(e.title)}"></label>
    <label>日付<input name="date" type="date" required value="${e.date}"></label>
    <label class="row"><input name="allDay" type="checkbox" ${e.allDay ? 'checked' : ''}> 終日</label>
    <div class="row times"><label>開始<input name="start" type="time" value="${t(e.startMin ?? 540)}"></label>
      <label>終了<input name="end" type="time" value="${t(e.endMin ?? 600)}"></label></div>
    <label>場所<input name="location" value="${esc(e.location)}"></label>
    ${ev && state.children.get(ev.id) ? `<p class="note">準備タスク：${state.children.get(ev.id).map(c => `${c.done ? '✅' : '□'} ${L.mdLabel(c.date)} ${esc(c.title)}`).join('、')}</p>` : ''}`,
  async fd => {
    const body = L.eventBody({ title: fd.get('title'), date: fd.get('date'), allDay: !!fd.get('allDay'),
      start: fd.get('start'), end: fd.get('end'), location: fd.get('location') });
    if (!body.start.date && fd.get('end') <= fd.get('start')) { toast('終了は開始より後にしてください'); return false; }
    return write(() => ev ? backend.patch('event', ev.id, body) : backend.create('event', body), ev ? '予定を更新しました' : '予定を追加しました');
  }, '保存', ev ? `<button type="button" class="danger" data-del>削除</button>` : '');
  const sync = () => form.querySelector('.times').classList.toggle('off', form.allDay.checked);
  form.allDay.onchange = sync; sync();
  const del = form.querySelector('[data-del]');
  if (del) del.onclick = () => confirmDelete(ev);
}

function parentOptions(current, selfId) {
  const kids = new Set((state.children.get(selfId) || []).map(c => c.id));
  const evs = [...state.items.events, ...state.items.tasks]
    .filter(e => e.date >= L.addDays(state.today, -7) && e.id !== selfId && !kids.has(e.id))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'event' ? -1 : 1));
  const opts = evs.map(e => `<option value="${e.id}" ${e.id === current ? 'selected' : ''}>${L.mdLabel(e.date)} ${e.kind === 'task' ? '［タスク］' : '［予定］'}${esc(e.title)}</option>`);
  if (current && !evs.find(e => e.id === current)) {
    const p = state.parents.get(current);
    opts.unshift(`<option value="${current}" selected>${p ? `${L.mdLabel(p.date)} ${esc(p.title)}` : '（現在の親予定）'}</option>`);
  }
  return `<option value="">紐付けなし（普通のタスク）</option>${opts.join('')}`;
}

function taskForm(task, date) {
  const t = task || { title: '', date, parentId: null, checklist: [] };
  const form = openModal(task ? 'タスクの編集' : 'タスクの追加', `
    <label>件名<input name="title" required value="${esc(t.title)}"></label>
    <label>日付<input name="date" type="date" required value="${t.date}"></label>
    <label>親（予定またはタスク）<select name="parent">${parentOptions(t.parentId, task && task.id)}</select></label>
    <fieldset><legend>チェックリスト（1行1項目）</legend>
      ${t.checklist.map((c, k) => `<label class="row"><input type="checkbox" name="c${k}" ${c.done ? 'checked' : ''}> ${esc(c.text)}</label>`).join('')}
      <textarea name="more" rows="3" placeholder="小項目を追加（例：網図）"></textarea></fieldset>`,
  async fd => {
    const checklist = t.checklist.map((c, k) => ({ text: c.text, done: !!fd.get(`c${k}`) }))
      .concat(String(fd.get('more')).split(/\r?\n/).map(s => s.replace(/^[・\-－]\s*/, '').trim()).filter(Boolean).map(text => ({ text, done: false })));
    const body = L.taskBody({ title: fd.get('title'), date: fd.get('date'), parentId: fd.get('parent') || null, checklist, done: t.done || false });
    if (!task) return write(() => backend.create('task', body), 'タスクを追加しました');
    // 既存タスク: Google の PATCH は private をマージするので、親を外すときは空文字で上書きする
    const priv = { ...privOf(task), ...body.extendedProperties.private };
    if (!body.extendedProperties.private.parentId) priv.parentId = '';
    return write(() => backend.patch('task', task.id, { ...body, extendedProperties: { private: priv } }), 'タスクを更新しました');
  }, '保存', task ? `<button type="button" class="danger" data-del>削除</button>` : '');
  const del = form.querySelector('[data-del]');
  if (del) del.onclick = () => confirmDelete(task);
}

function prepForm(parent) {
  const def = L.prevBusinessDay(parent.date, state.holidaySet);
  openModal('準備タスクの追加', `
    <p class="note" style="--c:${L.linkColor(parent.id)}">▶ 親${parent.kind === 'task' ? 'タスク' : '予定'}：<b>${L.mdLabel(parent.date)}（${L.WEEKDAYS[L.weekday(parent.date)]}） ${esc(parent.title)}</b></p>
    <label>準備する日（初期値＝前の営業日）<input name="date" type="date" required value="${def}"></label>
    <label>準備タスク（1行1件。「・」で始まる行は直前タスクの小項目）
      <textarea name="lines" rows="6" required placeholder="杭10本（赤２寸）&#10;見出し"></textarea></label>`,
  async fd => {
    const tasks = L.parseTaskLines(fd.get('lines'));
    if (!tasks.length) { toast('準備タスクを入力してください'); return false; }
    return write(async () => {
      for (const t of tasks) await backend.create('task', L.taskBody({ ...t, date: fd.get('date'), parentId: parent.id }));
    }, `準備タスクを${tasks.length}件追加しました`);
  }, '追加');
}

function confirmDelete(i) {
  openModal('削除の確認', `<p>「${esc(i.title)}」を削除します。元に戻せません。</p>
    ${state.children.get(i.id) ? '<p class="note">※子タスクは残ります（親なしの表示になります）。</p>' : ''}`,
  async () => {
    state.selected = null;
    return write(() => backend.remove(i.kind === 'task' ? 'task' : 'event', i.id), '削除しました');
  }, '削除する');
}

function settingsForm() {
  const form = openModal('設定', `
    <fieldset><legend>予定・タスクの保存先</legend>
      <label class="row"><input type="radio" name="mode" value="demo" ${settings.mode !== 'google' ? 'checked' : ''}> お試しモード（この端末のみ）</label>
      <label class="row"><input type="radio" name="mode" value="google" ${settings.mode === 'google' ? 'checked' : ''}> Googleカレンダー</label>
      <label>Google OAuth クライアントID<input name="clientId" value="${esc(settings.clientId)}" placeholder="xxxxxxxx.apps.googleusercontent.com"></label>
    </fieldset>
    <fieldset><legend>メモ・結果記録の保存先（Obsidian / GitHub）</legend>
      <label>GitHub アクセストークン<input name="ghToken" type="password" autocomplete="off" value="${esc(settings.ghToken)}" placeholder="github_pat_…"></label>
      <label>リポジトリ<input name="ghRepo" value="${esc(settings.ghRepo)}"></label>
      <label>ブランチ<input name="ghBranch" value="${esc(settings.ghBranch)}"></label>
      <label>設定コードを貼り付け（PCの「📱 スマホへ設定を送る」のリンク）<textarea name="importCode" rows="2" placeholder="https://takamoomoo.github.io/techo-app/#import=…"></textarea></label>
      <details class="diag"><summary>ログイン診断</summary><div>${readLoginLog().map(l =>
        `${esc(l.at)} ${esc(l.ev)}：${esc(l.detail)}${l.standalone ? '［ホーム画面］' : '［ブラウザ］'}`).join('<br>') || '記録なし'}</div></details>
      <p class="note">トークンはこの端末の中だけに保存されます。空欄ならObsidianには保存しません${settings.mode !== 'google' ? '（お試しモードでは端末内の仮ノートに保存）' : ''}。</p>
    </fieldset>`,
  async fd => {
    const next = {
      mode: fd.get('mode'), clientId: String(fd.get('clientId')).trim(),
      ghToken: String(fd.get('ghToken')).trim(), ghRepo: String(fd.get('ghRepo')).trim() || 'takamoomoo/takayuki-brain',
      ghBranch: String(fd.get('ghBranch')).trim() || 'main',
    };
    const code = String(fd.get('importCode') || '').trim();
    if (code) {
      const imp = parseImport(code);
      if (!imp) { toast('設定コードを読み取れません（リンク全体を貼ってください）'); return false; }
      Object.assign(next, imp);
    }
    if (next.mode === 'google' && !next.clientId) { toast('クライアントIDを入力してください'); return false; }
    const calChanged = next.mode !== settings.mode || next.clientId !== settings.clientId;
    Object.assign(settings, next);
    lsSet('techo-settings', settings);
    if (calChanged) { // カレンダー側を変えたときだけ作り直す（ログインし直しになるため）
      backend = makeBackend();
      state.items = null; state.selected = null; state.needLogin = false;
    }
    notes = makeNotes();
    state.notesWeek = null;
    closeModal();
    if (state.page === 'home') loadHome();
    await load();
  }, '保存', settings.mode !== 'google' ? '<button type="button" data-reset>お試しデータを初期化</button>'
    : '<button type="button" data-qr>📱 スマホへ設定を送る</button>');
  const q = form.querySelector('[data-qr]');
  if (q) q.onclick = () => showSettingsQr();
  const r = form.querySelector('[data-reset]');
  if (r) r.onclick = async () => {
    new DemoBackend().reset(); new DemoNotes().reset();
    backend = makeBackend(); notes = makeNotes(); state.notesWeek = null;
    closeModal(); await load(); toast('お試しデータを初期化しました');
  };
}

// この端末の設定を QR にしてスマホで読み取らせる（URL の # 以降はサーバーに送られない）
async function showSettingsQr() {
  const payload = { mode: settings.mode, clientId: settings.clientId, ghToken: settings.ghToken, ghRepo: settings.ghRepo, ghBranch: settings.ghBranch };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const url = `${PUBLIC_URL}#import=${encodeURIComponent(btoa(String.fromCharCode(...bytes)))}`;
  try {
    if (!window.qrcode) await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
      s.onload = resolve; s.onerror = () => reject(new Error('QRの部品を読み込めません（ネット接続を確認）'));
      document.head.appendChild(s);
    });
    const qr = window.qrcode(0, 'L');
    qr.addData(url); qr.make();
    openModal('スマホへ設定を送る', `
      <div class="qrbox">${qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true })}</div>
      <p class="note">Safari で使う場合：iPhone のカメラで読み取り、表示された「takamoomoo.github.io」を開くと設定が入ります。<br>
      ホーム画面のアプリで使う場合：カメラの表示を長押しして「リンクをコピー」→ ホーム画面のアプリの ⚙設定「設定コードを貼り付け」に貼って保存。<br>
      ⚠ このQRには GitHub トークンが入っています。人に見せず、読み取ったらすぐ閉じてください。</p>`,
    async () => {}, '閉じる');
  } catch (e) { toast(e.message); }
}

// QR をブラウザ（Safari/Chrome）で開いた場合: ホーム画面アプリは保存場所が別なので、リンクをコピーして渡してもらう
function offerImportCopy() {
  const form = openModal('設定を取り込みました', `
    <p>このブラウザに設定が入りました。<b>「閉じる」を押せば、このまま使えます。</b></p>
    <p class="note">ホーム画面のアイコンが同じブラウザで開く場合は、それ以上の操作は不要です。<br>
    別のブラウザで開く場合だけ、「リンクをコピー」を押して、そちらの ⚙設定 →「設定コードを貼り付け」に貼ってください。</p>`,
  async () => {}, '閉じる', '<button type="button" data-copy>リンクをコピー</button>');
  form.querySelector('[data-copy]').onclick = async () => {
    try { await navigator.clipboard.writeText(importLink); toast('コピーしました。ホーム画面の手帳アプリに貼ってください'); }
    catch { toast('コピーできませんでした'); }
  };
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------- 操作 ----------
function go(delta) {
  state.anchor = L.addDays(state.anchor, delta * (state.view === 'week' ? 7 : 1));
  state.selected = null;
  load();
}

async function doLogin() {
  try {
    await backend.signIn();
    await load();
  } catch (e) { toast(e.message); }
}

document.addEventListener('click', async ev => {
  const a = ev.target.closest('[data-act]');
  if (a && !a.closest('#modal')) {
    const id = a.dataset.id, it = id && findItem(id);
    switch (a.dataset.act) {
      case 'home': return goPage('home');
      case 'open-schedule': return goPage('schedule');
      case 'edit-home': return editHome();
      case 'prev': return go(-1);
      case 'next': return go(1);
      case 'today': state.anchor = L.ymd(new Date()); state.selected = null; return load();
      case 'view': state.view = a.dataset.view; state.selected = null; return load();
      case 'goto-day': state.view = 'day'; state.anchor = a.dataset.date; return load();
      case 'login': return doLogin();
      case 'reload': return load();
      case 'settings': return settingsForm();
      case 'print': return doPrint();
      case 'save-note': return saveNote(a.dataset.date, a.dataset.kind);
      case 'del-note': return deleteNote(a.dataset.date, a.dataset.kind, Number(a.dataset.i));
      case 'new-event': return canWrite() ? eventForm(null, a.dataset.date || state.anchor) : write(async () => {});
      case 'new-task': return canWrite() ? taskForm(null, a.dataset.date || state.anchor) : write(async () => {});
      case 'toggle': return it && setDone(it, !it.done);
      case 'to-today': return it && moveTask(it, state.today);
      case 'delete': return it && confirmDelete(it);
      case 'edit': if (!it) return; return it.kind === 'task' ? taskForm(it) : it.kind === 'event' ? eventForm(it) : toast('家族・祝日の予定はここでは編集できません');
      case 'prep': return it && (canWrite() ? prepForm(it) : write(async () => {}));
      case 'goto-parent': {
        const p = state.parents.get(it.parentId);
        state.anchor = p.date; state.selected = p.id; return load();
      }
      case 'deselect': state.selected = null; return render();
    }
    return;
  }
  const item = ev.target.closest('.board .it');
  if (item) { state.selected = state.selected === item.dataset.id ? null : item.dataset.id; render(); return; }
  if (ev.target.closest('textarea, .notes')) return; // 入力中に再描画しない
  if (ev.target.closest('.board') && state.selected) { state.selected = null; render(); }
});

// スワイプで日/週送り
let touch = null;
document.addEventListener('touchstart', e => { if (e.touches.length === 1 && !e.target.closest('#modal')) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
document.addEventListener('touchend', e => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y;
  const scroller = e.target.closest('.board.week');
  touch = null;
  if (scroller && scroller.scrollWidth > scroller.clientWidth + 4) return; // 週表示の横スクロール中は送らない
  if (Math.abs(dx) > 70 && Math.abs(dy) < 50) go(dx < 0 ? 1 : -1);
}, { passive: true });

document.addEventListener('input', e => {
  const k = e.target.dataset && e.target.dataset.draft;
  if (!k) return;
  if (e.target.value) state.drafts[k] = e.target.value; else delete state.drafts[k];
  lsSet('techo-drafts', state.drafts);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
});
window.addEventListener('resize', () => requestAnimationFrame(drawLinks));

// ---------- 印刷 ----------
function doPrint() {
  if (!state.items) return toast('データがありません');
  const monday = L.mondayOf(state.anchor);
  const data = { ...state.items, parents: state.parents, children: state.children, holidayNames: state.holidayNames, notes: state.notes };
  // 日表示でも前後21日を取得済みなので、その週をそのまま印刷できる
  $('#print').innerHTML = buildPrint(monday, data);
  window.print();
}

// ---------- 起動 ----------
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && L.ymd(new Date()) !== state.today) load();
});
if (state.page === 'home') loadHome();
load().then(() => {
  if (imported && !isStandalone()) offerImportCopy();
  else if (imported) toast('設定を取り込みました');
  else if (redirected && redirected.error) { state.error = `Googleログインに失敗しました（${redirected.error}）`; render(); }
});
