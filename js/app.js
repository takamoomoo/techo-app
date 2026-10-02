// 手帳アプリ 本体（画面・操作）
import * as L from './logic.js';
import { GoogleBackend, consumeRedirectToken, readLoginLog, isStandalone } from './backend-google.js';
import { DemoBackend } from './backend-demo.js';
import { buildPrint } from './print.js';
import { Notes, GitHubNotes, DemoNotes, LocalFileStore } from './obsidian.js';
import * as O from './obsidian-md.js';
import * as H from './habit-md.js';
import * as HS from './habit-stats.js';
import * as V from './vault.js';

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
const SUB_PAGES = ['home', 'habit', 'review', 'notes']; // スケジュール帳以外の画面（紺の背景・HOMEボタンのみ）
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
  page: SUB_PAGES.find(p => location.hash === `#${p}`) || (SUB_PAGES.includes(lsGet('techo-page')) ? lsGet('techo-page') : 'schedule'), // #home など か最後に開いていた画面
  home: lsGet('techo-home-cache'), homeSha: null, homeError: '', cover: lsGet('techo-cover'),
  habits: null, habitMonth: L.ymd(new Date()).slice(0, 7), habitError: '',
  review: { kind: 'week', offset: 0 },
  vault: { files: (lsGet('techo-vault-tree') || {}).files || null, at: 0, truncated: false, folder: '', note: null, text: null, q: '', loading: false, error: '', noteError: '' },
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
// メニューは配列で管理（機能を足すときはここに追加）
const MENU = [
  { act: 'open-schedule', icon: '📅', title: 'スケジュール帳', desc: '週・日表示／Googleカレンダー・Obsidian連携' },
  { act: 'open-habit', icon: '✅', title: '習慣化管理', desc: '毎日のチェック・連続日数・達成率', badge: () => {
    if (!state.habits || !state.habits.habits.length) return '';
    const c = H.todayCount(state.habits, state.today);
    return c.total ? `今日 ${c.done}/${c.total}` : '';
  } },
  { act: 'open-notes', icon: '📚', title: 'ノート', desc: 'Obsidian のノートをフォルダごとに読む' },
  { act: 'open-review', icon: '🏆', title: 'ふり返り', desc: '積み上げグラフ・バッジ・称号', badge: () => {
    if (!state.habits || !state.habits.habits.length) return '';
    return HS.badges(state.habits, state.today).rank;
  } },
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
        : `<button class="mi" data-act="${m.act}"><span class="ic">${m.icon}</span><span><b>${esc(m.title)}</b><small>${esc(m.desc)}</small></span>${m.badge && m.badge() ? `<span class="badge">${esc(m.badge())}</span>` : ''}<span class="go">›</span></button>`).join('')}
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

// ---------- 習慣化管理（手帳アプリ/習慣.md） ----------
// GitHubトークンが無ければこの端末だけに保存
const habitStore = () => notes || new Notes(new LocalFileStore());
const shiftMonth = (ym, d) => { const t = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + d, 1); return L.ymd(t).slice(0, 7); };
let habitQueue = Promise.resolve(); // 連打しても書込みは1つずつ
const habitPending = []; // 画面には反映済みで、まだ保存していない変更

// トークンを入れる前にこの端末だけへ保存していた記録があれば、Obsidian へ移して端末側は消す
// （トークン無しの保存場所と、お試しモードの保存場所の両方を見る）
async function moveLocalHabits() {
  if (!notes || notes.name !== 'github') return;
  for (const local of [new LocalFileStore(), new LocalFileStore('techo-demo-notes-v1')]) {
    const f = await local.getFile(H.HABIT_PATH);
    if (!f) continue;
    const extra = H.parseHabits(f.text);
    if (extra.habits.length || Object.keys(extra.done).length) {
      await notes.updateHabits(d => H.mergeHabits(d, extra), [state.today.slice(0, 7)], 'この端末の記録を合流');
      toast('この端末だけに保存していた習慣を Obsidian に移しました');
    }
    local.removeFile(H.HABIT_PATH);
  }
}

async function loadHabits() {
  state.habitError = '';
  try {
    await moveLocalHabits();
    state.habits = await habitStore().loadHabits();
    lsSet('techo-habit-cache', serializeHabits(state.habits));
  } catch (e) {
    const c = lsGet('techo-habit-cache');
    state.habits = c ? { habits: c.habits, done: Object.fromEntries(Object.entries(c.done).map(([d, a]) => [d, new Set(a)])) } : null;
    state.habitError = `Obsidianから読めませんでした（${e.message}）${c ? '。保存済みの内容を表示しています' : ''}`;
  }
  render();
}
const serializeHabits = d => ({ habits: d.habits, done: Object.fromEntries(Object.entries(d.done).map(([k, v]) => [k, [...v]])) });

function habitWrite(change, message) {
  change(state.habits); render(); // 先に画面へ反映
  habitPending.push(change);
  const months = [state.today.slice(0, 7)];
  habitQueue = habitQueue.then(async () => {
    try {
      const saved = await habitStore().updateHabits(change, months, message);
      habitPending.shift();
      habitPending.forEach(f => f(saved)); // 後ろに控えている変更は画面に残す
      state.habits = saved;
      lsSet('techo-habit-cache', serializeHabits(saved));
    } catch (e) {
      habitPending.length = 0;
      toast(`保存できませんでした（${e.message}）`);
      await loadHabits();
    }
    render();
  });
  return habitQueue;
}

function toggleHabit(name, date) {
  if (!state.habits || date > state.today) return;
  const on = !H.isDone(state.habits, name, date);
  if (on && date === state.today && navigator.vibrate) navigator.vibrate(15);
  return habitWrite(d => H.setDone(d, name, date, on), `${date} ${name} ${on ? '✅' : '取消'}`);
}

function editHabits() {
  const list = (state.habits && state.habits.habits) || [];
  openModal('習慣を編集', `
    <label>習慣（1行1件）<textarea name="lines" rows="8" placeholder="早起き（5:30） ｜ 毎日&#10;読書15分 ｜ 平日&#10;ストレッチ ｜ 月水金">${esc(list.map(h => `${h.name} ｜ ${h.days}`).join('\n'))}</textarea></label>
    <p class="note">「名前 ｜ 曜日」で書きます。曜日は 毎日／平日／土日／月水金 など（省略すると毎日）。<br>
    名前を変えると別の習慣として数え直します（これまでの記録は Obsidian の表に残ります）。<br>
    ${notes ? 'Obsidian の「手帳アプリ/習慣.md」に保存され、PCとスマホで共有されます。' : 'この端末だけに保存されます（⚙でGitHubトークンを入れるとObsidianに保存）。'}</p>`,
  async fd => {
    const text = String(fd.get('lines'));
    if (!state.habits) state.habits = { habits: [], done: {} };
    habitWrite(d => { d.habits = H.parseHabitLines(text, d.habits, state.today); return d; }, '習慣リスト更新');
  }, '保存');
}

function habitHtml() {
  const d = state.habits, today = state.today, ym = state.habitMonth;
  const err = state.habitError ? `<p class="note">${esc(state.habitError)}</p>` : '';
  const where = notes && notes.name === 'github' ? '' : `<div class="hb-warn">⚠ <b>この端末だけに保存されています（スマホ・PCで共有されません）</b><br>
    共有するには <button data-act="settings">⚙設定</button> で GitHub アクセストークンを入れてください。入れると、ここまでの記録も Obsidian に自動で移ります。</div>`;
  if (!d) return `<div class="habitpage">${where}<p class="hb-empty">${state.habitError ? '' : '読み込み中…'}</p>${err}</div>`;
  if (!d.habits.length) {
    return `<div class="habitpage"><section class="hb-card hb-empty">
      <h2>✅ 習慣化管理</h2><p>続けたい習慣を登録しましょう。毎日チェックすると、連続日数と達成率が出ます。</p>
      <button class="primary" data-act="habit-edit">＋ 習慣を登録</button></section>${err}</div>`.replace('<div class="habitpage">', `<div class="habitpage">${where}`);
  }
  const c = H.todayCount(d, today);
  const wd = L.WEEKDAYS[L.weekday(today)];
  const todays = d.habits.map(h => {
    const target = H.isTarget(h, today) && (!h.start || today >= h.start);
    const done = H.isDone(d, h.name, today), s = H.streak(d, h, today);
    return `<button class="hb-today ${done ? 'done' : ''} ${target ? '' : 'off'}" data-act="habit-toggle" data-name="${esc(h.name)}" data-date="${today}">
      <span class="ck">${done ? '✓' : ''}</span>
      <span class="nm"><b>${esc(h.name)}</b><small>${target ? esc(h.days) : `今日はお休み（${esc(h.days)}）`}</small></span>
      <span class="st">${s ? `🔥<b>${s}</b>日` : ''}</span></button>`;
  }).join('');

  const dates = H.monthDates(ym);
  const head = dates.map(x => {
    const w = L.weekday(x);
    return `<th class="${w === 0 ? 'sun' : w === 6 ? 'sat' : ''} ${x === today ? 'tdy' : ''}">${Number(x.slice(8))}<i>${L.WEEKDAYS[w]}</i></th>`;
  }).join('');
  const rows = d.habits.map(h => {
    const r = H.monthRate(d, h, ym, today);
    return `<tr><th class="hn">${esc(h.name)}</th>${dates.map(x => {
      const st = H.cellState(d, h, x, today);
      return `<td class="c-${st} ${x === today ? 'tdy' : ''}">${st === 'future' || st === 'before'
        ? '' : `<button data-act="habit-toggle" data-name="${esc(h.name)}" data-date="${x}" aria-label="${esc(h.name)} ${x}">${st === 'done' ? '✓' : st === 'off' ? '･' : ''}</button>`}</td>`;
    }).join('')}<td class="rate">${r.rate == null ? '—' : `${r.rate}%`}</td></tr>`;
  }).join('');
  const [y, m] = ym.split('-').map(Number);

  return `<div class="habitpage">${where}
    <section class="hb-card">
      <div class="hb-head"><h2>✅ 今日の習慣 <small>${Number(today.slice(5, 7))}/${Number(today.slice(8))}（${wd}）</small></h2>
        <span class="hb-count">${c.total ? `${c.done} / ${c.total}` : ''}</span></div>
      ${c.total && c.done === c.total ? '<p class="hb-clear">🎉 今日の習慣はすべて達成！</p>' : ''}
      <div class="hb-list">${todays}</div>
    </section>
    <section class="hb-card">
      <div class="hb-head"><h2>${y}年${m}月</h2>
        <span class="hb-nav"><button data-act="habit-month" data-d="-1" aria-label="前の月">◀</button><button data-act="habit-month" data-d="1" aria-label="次の月" ${ym >= today.slice(0, 7) ? 'disabled' : ''}>▶</button></span></div>
      <div class="hb-grid-wrap"><table class="hb-grid"><thead><tr><th class="hn"></th>${head}<th class="rate">達成率</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hb-legend">マスを押すと過去の日も付け外しできます。･＝対象外の曜日。達成率は今日までの対象日で計算。</p>
      <div class="dadd"><button data-act="open-review">🏆 ふり返り</button><button data-act="habit-edit">✎ 習慣を編集</button></div>
    </section>${err}
  </div>`;
}

// ---------- ふり返り（習慣の積み上げグラフ・バッジ・称号） ----------
// 習慣の色は登録順で固定（暗い背景用に検証済みの8色。9件目以降とリストから外した習慣は「その他」）
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OTHER = '#6b778a';

function reviewHtml() {
  const d = state.habits, today = state.today;
  if (!d) return `<div class="habitpage"><p class="hb-empty">${state.habitError ? esc(state.habitError) : '読み込み中…'}</p></div>`;
  if (!d.habits.length && !HS.firstDate(d)) {
    return `<div class="habitpage"><section class="hb-card hb-empty"><h2>🏆 ふり返り</h2>
      <p>習慣を登録してチェックすると、ここに積み上げグラフとバッジが貯まっていきます。</p>
      <button class="primary" data-act="open-habit">✅ 習慣化管理へ</button></section></div>`;
  }
  const { kind, offset } = state.review;
  const color = new Map(d.habits.slice(0, SERIES.length).map((h, i) => [h.name, SERIES[i]]));
  const colorOf = n => color.get(n) || OTHER;
  const r = HS.periodRange(kind, today, offset), p = HS.periodRange(kind, today, offset - 1);
  // 途中の期間は、前の期間の「同じ日数まで」と比べる（月〜金と丸1週間を比べて減って見えないように）
  const partial = r.to > today, pTo = partial ? L.addDays(p.from, Math.min(L.diffDays(r.from, today), L.diffDays(p.from, p.to))) : p.to;
  const st = HS.periodStats(d, r.from, r.to, today), prev = HS.periodStats(d, p.from, pTo, today);
  const b = HS.badges(d, today);
  const unit = kind === 'week' ? '週' : '月';
  const label = kind === 'week'
    ? `${L.mdLabel(r.from)}〜${L.mdLabel(r.to)}${offset === 0 ? '（今週）' : ''}`
    : `${r.from.slice(0, 4)}年${Number(r.from.slice(5, 7))}月${offset === 0 ? '（今月）' : ''}`;
  const diff = st.done - prev.done;
  const diffTxt = prev.done || st.done ? `<small class="${diff > 0 ? 'up' : ''}">前${unit}${partial ? 'の同じ日まで' : ''}より ${diff > 0 ? '▲' : diff < 0 ? '▼' : '±'}${Math.abs(diff)}</small>` : '';

  // 積み上げ棒（日ごとの✅を習慣別に積む）
  const max = Math.max(d.habits.length, ...st.days.map(x => x.done), 1);
  const order = n => (color.has(n) ? d.habits.findIndex(h => h.name === n) : 99);
  const bars = st.days.map(x => {
    const w = L.weekday(x.date);
    const segs = [...x.names].sort((a, c) => order(a) - order(c))
      .map(n => `<i style="height:${(100 / max).toFixed(2)}%;background:${colorOf(n)}"></i>`).join('');
    const tip = x.future ? '' : `${L.mdLabel(x.date)}：✅${x.done}${x.target ? `（対象${x.target}件中${x.targetDone}件）` : ''}${x.names.length ? `\n${x.names.join('・')}` : ''}`;
    const perfect = x.target && x.targetDone === x.target;
    return `<div class="rv-col ${x.future ? 'future' : ''} ${x.date === today ? 'tdy' : ''}" ${tip ? `data-tip="${esc(tip)}"` : ''}>
      <div class="rv-bar">${segs}${perfect ? '<b class="star">⭐</b>' : ''}</div>
      <span class="rv-x ${w === 0 ? 'sun' : w === 6 ? 'sat' : ''}">${kind === 'week' ? `${Number(x.date.slice(8))}<i>${L.WEEKDAYS[w]}</i>` : (Number(x.date.slice(8)) % 5 === 1 || x.date === today ? Number(x.date.slice(8)) : '')}</span></div>`;
  }).join('');
  const others = st.days.some(x => x.names.some(n => !color.has(n)));
  const legend = [...color].map(([n, c]) => `<span><i style="background:${c}"></i>${esc(n)}</span>`).join('') + (others ? `<span><i style="background:${OTHER}"></i>その他</span>` : '');
  const rows = st.perHabit.map(h => `<tr><th><i style="background:${colorOf(h.name)}"></i>${esc(h.name)}</th><td>${h.done} / ${h.target}</td>
    <td class="rt">${h.rate == null ? '—' : `${h.rate}%`}${h.rate === 100 && h.target ? ' 💯' : ''}</td></tr>`).join('');

  // この期間に獲得したバッジ（ご褒美）
  const got = b.list.filter(x => x.earnedOn && x.earnedOn >= r.from && x.earnedOn <= r.to);
  const gotHtml = got.length ? `<div class="rv-got"><b>🎉 この${unit}に獲得したバッジ</b>
    <div>${got.map(x => `<span class="bdg on"><span class="ic">${x.icon}</span>${esc(x.title)}</span>`).join('')}</div></div>` : '';

  const heat = HS.heatmap(d, today, 20);
  const heatHtml = heat.map(w => `<div class="hm-w">${w.map(c => c.future ? '<i class="f"></i>'
    : `<i class="l${c.level}" data-tip="${esc(`${L.mdLabel(c.date)}：✅${c.done}${c.target ? `（${c.targetDone}/${c.target}）` : ''}`)}"></i>`).join('')}</div>`).join('');
  const months = heat.map((w, i) => { const m = w[0].date.slice(5, 7); return i === 0 || m !== heat[i - 1][0].date.slice(5, 7) ? `<span style="grid-column:${i + 1}">${Number(m)}月</span>` : ''; }).join('');

  const earned = b.list.filter(x => x.earnedOn);
  const badgeHtml = earned.map(x => `<div class="bdg on" data-tip="${esc(`${x.desc}\n${L.mdLabel(x.earnedOn)} 獲得`)}"><span class="ic">${x.icon}</span><b>${esc(x.title)}</b><small>${L.mdLabel(x.earnedOn)}</small></div>`).join('');
  const nextHtml = b.next.map(x => `<div class="bdg next" data-tip="${esc(x.desc)}"><span class="ic">${x.icon}</span><b>${esc(x.title)}</b>
    <small>あと ${x.goal - x.value}${x.kind === 'streak' ? '日' : x.kind === 'total' ? '回' : x.kind === 'pweek' ? '週' : x.kind === 'month' ? 'か月' : '日'}</small>
    <span class="pg"><span style="width:${Math.min(100, Math.round((x.value / x.goal) * 100))}%"></span></span></div>`).join('');

  return `<div class="habitpage reviewpage">
    <section class="hb-card rv-rank">
      <div class="rk-main"><span class="rk-label">称号</span><h2>${esc(b.rank)}</h2>
        <small>${b.nextRank ? `次の「${esc(b.nextRank.title)}」まで バッジあと${b.nextRank.need}個` : '最高の称号です'}</small></div>
      <div class="rk-stats">
        <div><b>${b.count}</b><span>バッジ</span></div>
        <div><b>${b.values.total}</b><span>累計✅</span></div>
        <div><b>${b.values.streak}</b><span>最長連続(日)</span></div>
        <div><b>${b.values.perfect}</b><span>⭐全部達成日</span></div>
      </div>
    </section>
    <section class="hb-card">
      <div class="hb-head"><span class="seg rv-seg"><button data-act="review-kind" data-kind="week" class="${kind === 'week' ? 'on' : ''}">週</button><button data-act="review-kind" data-kind="month" class="${kind === 'month' ? 'on' : ''}">月</button></span>
        <h2 class="rv-label">${label}</h2>
        <span class="hb-nav"><button data-act="review-move" data-d="-1" aria-label="前へ">◀</button><button data-act="review-move" data-d="1" aria-label="次へ" ${offset >= 0 ? 'disabled' : ''}>▶</button></span></div>
      ${gotHtml}
      <div class="rv-kpi">
        <div><span>✅ 達成</span><b>${st.done}<small>回</small></b>${diffTxt}</div>
        <div><span>達成率</span><b>${st.rate == null ? '—' : `${st.rate}<small>%</small>`}</b><small>${st.target ? `対象${st.target}件中${st.targetDone}件` : ''}</small></div>
        <div><span>⭐ 全部達成した日</span><b>${st.perfectDays}<small>日</small></b></div>
      </div>
      <div class="rv-chart ${kind}">${bars}</div>
      <div class="rv-legend">${legend}</div>
      <table class="rv-table"><tbody>${rows}</tbody></table>
    </section>
    <section class="hb-card">
      <div class="hb-head"><h2>🌱 積み上げ <small>直近20週・濃いほど達成</small></h2></div>
      <div class="hm"><div class="hm-m">${months}</div><div class="hm-g">${heatHtml}</div></div>
      <div class="hm-key">少 <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> 全部達成</div>
    </section>
    <section class="hb-card">
      <div class="hb-head"><h2>🏅 バッジ <small>${b.count} / ${b.list.length}</small></h2></div>
      ${earned.length ? `<div class="bdg-grid">${badgeHtml}</div>` : '<p class="hb-legend">最初のバッジは ✅ を1回付けると手に入ります。</p>'}
      <h3 class="rv-sub">次のバッジ</h3>
      <div class="bdg-grid">${nextHtml}</div>
    </section>
  </div>`;
}

// ふり返りのツールチップ（PCはマウスを乗せる・スマホはタップ）
function showTip(el) {
  let t = $('#tip');
  if (!t) { t = document.createElement('div'); t.id = 'tip'; document.body.appendChild(t); }
  if (!el) { t.hidden = true; return; }
  t.textContent = el.dataset.tip; t.hidden = false;
  const r = el.getBoundingClientRect(), w = t.offsetWidth;
  t.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  t.style.top = `${Math.max(8, r.top - t.offsetHeight - 8)}px`;
}
document.addEventListener('pointerover', e => { if (e.pointerType === 'mouse') showTip(e.target.closest('[data-tip]')); });
document.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') showTip(e.target.closest('[data-tip]')); });
addEventListener('scroll', () => showTip(null), { passive: true });

// ---------- ノート閲覧（Obsidian を読むだけ。書き換えはしない） ----------
const VAULT_TTL = 10 * 60 * 1000; // フォルダ一覧は10分ごとに取り直す
async function loadScript(src, globalName) {
  if (window[globalName]) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('表示用の部品を読み込めません（ネット接続を確認）'));
    document.head.appendChild(s);
  });
}

async function loadVault(force = false) {
  const v = state.vault;
  if (!notes) { v.error = ''; render(); return; }
  if (!force && v.files && Date.now() - v.at < VAULT_TTL) return;
  v.loading = true; v.error = ''; render();
  try {
    const t = await notes.listTree();
    v.files = V.filterTree(t.entries); v.truncated = t.truncated; v.at = Date.now();
    lsSet('techo-vault-tree', { files: v.files, at: v.at });
  } catch (e) {
    const c = lsGet('techo-vault-tree');
    if (c) { v.files = c.files; v.at = 0; }
    v.error = `Obsidianの一覧を読めませんでした（${e.message}）${c ? '。前回の一覧を表示しています' : ''}`;
  } finally { v.loading = false; render(); }
}

// folder / note を開く。ブラウザの「戻る」でも戻れるように履歴に積む
function vaultGo(next, push = true) {
  const v = state.vault;
  Object.assign(v, next);
  if (next.note !== undefined) v.text = null;
  if (push) history.pushState({ vault: { folder: v.folder, note: v.note } }, '', '#notes');
  render();
  if (v.note && next.note) openNote(v.note);
  if (next.note || next.folder !== undefined) window.scrollTo(0, 0);
}
addEventListener('popstate', e => {
  if (state.page === 'notes' && e.state && e.state.vault) vaultGo({ ...e.state.vault, q: '' }, false);
});

async function openNote(path) {
  const v = state.vault;
  v.noteError = '';
  try {
    const [f] = await Promise.all([notes.readNote(path),
      loadScript('https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js', 'marked'),
      loadScript('https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js', 'DOMPurify')]);
    if (v.note !== path) return; // 読み込み中に別のノートへ移った
    if (!f) throw new Error('ノートが見つかりません（移動・削除された可能性）');
    v.text = f.text;
  } catch (e) { v.noteError = e.message; }
  render();
}

function noteBodyHtml(path, text) {
  const { meta, body } = V.splitFrontmatter(text);
  const md = V.obsidianToMarkdown(body, state.vault.files || [], path);
  const html = window.DOMPurify.sanitize(window.marked.parse(md, { gfm: true, breaks: true }), { ADD_ATTR: ['target'] });
  const metaHtml = meta.length ? `<details class="vl-meta"><summary>プロパティ（${meta.length}）</summary><table>${meta.map(([k, val]) => `<tr><th>${esc(k)}</th><td>${esc(val)}</td></tr>`).join('')}</table></details>` : '';
  return metaHtml + html;
}

// 本文中の画像（![[...]]）を後から読み込む
async function loadVaultImages() {
  for (const img of document.querySelectorAll('.vl-body img[data-vault]:not([src])')) {
    const p = img.dataset.vault;
    img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; // 二重読み込み防止
    try {
      const b64 = await notes.readImage(p);
      if (b64) img.src = `data:image/${/\.svg$/i.test(p) ? 'svg+xml' : (p.split('.').pop().toLowerCase().replace('jpg', 'jpeg'))};base64,${b64}`;
      else img.replaceWith(Object.assign(document.createElement('span'), { className: 'vl-missing', textContent: `🖼 ${p.split('/').pop()}（大きすぎて表示できません）` }));
    } catch { img.alt = `🖼 ${p.split('/').pop()}`; }
  }
}

function crumbsHtml(folder, notePath) {
  const parts = folder ? folder.split('/') : [];
  const items = [`<button data-act="vault-folder" data-path="">📚 Obsidian</button>`,
    ...parts.map((p, i) => `<button data-act="vault-folder" data-path="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`)];
  if (notePath) items.push(`<span>${esc(V.baseName(notePath))}</span>`);
  return `<nav class="vl-crumbs">${items.join('<i>›</i>')}</nav>`;
}

function vaultHtml() {
  const v = state.vault;
  if (!notes) {
    return `<div class="habitpage"><div class="hb-warn">📚 ノートを見るには <button data-act="settings">⚙設定</button> で GitHub アクセストークンを入れてください。</div></div>`;
  }
  const files = v.files || [];
  const err = v.error ? `<p class="note">${esc(v.error)}</p>` : '';
  const todayPath = `01_inbox/${state.today}.md`;
  const hasToday = files.some(f => f.path === todayPath);
  const results = v.q ? V.searchNotes(files, v.q) : null;
  const { folders, notes: list } = V.listFolder(files, v.folder);
  const noteItem = p => `<button class="vl-item ${p === v.note ? 'on' : ''}" data-act="vault-note" data-path="${esc(p)}"><span class="ic">📄</span>
    <span class="nm">${esc(V.baseName(p))}${results ? `<small>${esc(V.parentOf(p) || '（トップ）')}</small>` : ''}</span></button>`;
  const listHtml = results
    ? `<p class="vl-count">「${esc(v.q)}」${results.length}件${results.length >= 60 ? '（先頭60件）' : ''}</p>${results.map(noteItem).join('') || '<p class="vl-count">見つかりません</p>'}`
    : `${crumbsHtml(v.folder)}
      ${folders.map(f => `<button class="vl-item folder" data-act="vault-folder" data-path="${esc(f.path)}"><span class="ic">📁</span><span class="nm">${esc(f.name)}</span><span class="ct">${f.count}</span></button>`).join('')}
      ${list.map(noteItem).join('')}
      ${!folders.length && !list.length ? `<p class="vl-count">${v.loading ? '読み込み中…' : 'ノートがありません'}</p>` : ''}`;
  const side = `<aside class="vl-side">
    <div class="vl-tools">
      <input type="search" class="vl-search" placeholder="🔍 ノート名で探す" value="${esc(v.q)}" data-vault-search>
      <button data-act="vault-reload" title="一覧を取り直す" aria-label="一覧を取り直す">↻</button>
    </div>
    ${hasToday ? `<button class="vl-today" data-act="vault-note" data-path="${esc(todayPath)}">📅 今日のデイリーノート</button>` : ''}
    <div class="vl-list">${listHtml}</div>${err}
  </aside>`;
  let reader = '<section class="vl-reader empty"><p>📖 左の一覧からノートを選んでください</p></section>';
  if (v.note) {
    const body = v.noteError ? `<p class="note">${esc(v.noteError)}</p>` : v.text == null ? '<p class="vl-count">読み込み中…</p>' : noteBodyHtml(v.note, v.text);
    const obs = `obsidian://open?vault=${encodeURIComponent(settings.ghRepo.split('/').pop())}&file=${encodeURIComponent(v.note.replace(/\.md$/i, ''))}`;
    reader = `<section class="vl-reader">
      <div class="vl-rhead"><button class="vl-back" data-act="vault-back">‹ 一覧</button>${crumbsHtml(V.parentOf(v.note), v.note)}</div>
      <h1 class="vl-title">${esc(V.baseName(v.note))}</h1>
      <div class="vl-body">${body}</div>
      <p class="vl-foot"><a href="${esc(obs)}">Obsidian アプリで開く</a>（読むだけの画面です。書き換えは Obsidian で）</p>
    </section>`;
  }
  return `<div class="vaultpage ${v.note ? 'reading' : ''}">${side}${reader}</div>`;
}

function goPage(page) {
  state.page = page; showTip(null);
  lsSet('techo-page', page);
  state.selected = null;
  if (page === 'home') { render(); loadHome(); loadHabits(); } else if (page === 'habit' || page === 'review') { render(); loadHabits(); } else if (page === 'notes') { render(); loadVault(); } else load();
}

// ---------- 描画 ----------
function render() {
  document.body.classList.toggle('on-home', state.page !== 'schedule');
  if (state.page !== 'schedule') {
    $('#banner').innerHTML = '';
    const prevSearch = document.activeElement && document.activeElement.matches('[data-vault-search]') ? document.activeElement.selectionStart : null;
    $('#main').innerHTML = state.page === 'home' ? homeHtml() : state.page === 'review' ? reviewHtml() : state.page === 'notes' ? vaultHtml() : habitHtml();
    if (state.page === 'notes') {
      loadVaultImages();
      const box = $('[data-vault-search]');
      if (box && prevSearch != null) { box.focus(); box.setSelectionRange(prevSearch, prevSearch); } // 入力中の検索欄を保つ
    }
    const wrap = $('.hb-grid-wrap'), td = wrap && wrap.querySelector('thead .tdy');
    if (td && wrap.scrollWidth > wrap.clientWidth) wrap.scrollLeft = Math.max(0, td.offsetLeft - wrap.clientWidth / 2); // 今日の列を見える位置に
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
    if (state.page !== 'schedule' && state.page !== 'notes') loadHabits();
    if (state.page === 'notes') loadVault(true);
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
      PC の別のブラウザへ移す場合：「リンクをコピー」→ そのブラウザのアドレス欄に貼って開くか、⚙設定「設定コードを貼り付け」に貼って保存。<br>
      ⚠ このQR・リンクには GitHub トークンが入っています。人に見せず、使ったらすぐ閉じてください。</p>`,
    async () => {}, '閉じる', '<button type="button" data-copy>リンクをコピー</button>');
    $('#modal [data-copy]').onclick = async () => {
      try { await navigator.clipboard.writeText(url); toast('コピーしました。移したいブラウザに貼ってください'); }
      catch { toast('コピーできませんでした'); }
    };
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
      case 'open-habit': return goPage('habit');
      case 'open-review': return goPage('review');
      case 'open-notes': return goPage('notes');
      case 'vault-folder': return vaultGo({ folder: a.dataset.path, note: null, q: '' });
      case 'vault-note': return vaultGo({ note: a.dataset.path, folder: V.parentOf(a.dataset.path) });
      case 'vault-back': return vaultGo({ note: null });
      case 'vault-reload': return loadVault(true);
      case 'review-kind': state.review = { kind: a.dataset.kind, offset: 0 }; return render();
      case 'review-move': state.review.offset = Math.min(0, state.review.offset + Number(a.dataset.d)); return render();
      case 'habit-toggle': return toggleHabit(a.dataset.name, a.dataset.date);
      case 'habit-edit': return editHabits();
      case 'habit-month': state.habitMonth = shiftMonth(state.habitMonth, Number(a.dataset.d)); return render();
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

// ノート本文の [[リンク]]（href="#notes=…"）はアプリ内で開く
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-note]');
  if (!a) return;
  e.preventDefault(); e.stopPropagation();
  vaultGo({ note: a.dataset.note, folder: V.parentOf(a.dataset.note) });
}, true);
document.addEventListener('input', e => {
  if (e.target.matches && e.target.matches('[data-vault-search]')) { state.vault.q = e.target.value; render(); return; }
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
  if (document.visibilityState === 'visible' && L.ymd(new Date()) !== state.today) {
    if (state.page !== 'schedule') { state.today = L.ymd(new Date()); state.habitMonth = state.today.slice(0, 7); loadHabits(); }
    load();
  }
});
if (state.page === 'home') loadHome();
if (state.page !== 'schedule' && state.page !== 'notes') loadHabits();
if (state.page === 'notes') { history.replaceState({ vault: { folder: '', note: null } }, '', '#notes'); loadVault(); }
load().then(() => {
  if (imported && !isStandalone()) offerImportCopy();
  else if (imported) toast('設定を取り込みました');
  else if (redirected && redirected.error) { state.error = `Googleログインに失敗しました（${redirected.error}）`; render(); }
});
