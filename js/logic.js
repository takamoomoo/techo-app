// 手帳アプリ: 画面やAPIに依存しない純粋ロジック（node --test で検証する）

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// ---- 日付（ローカル時刻の 'YYYY-MM-DD' 文字列で扱う） ----
export function ymd(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
export function diffDays(a, b) { // b - a（日数）
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}
export function weekday(s) { return parseYmd(s).getDay(); }
export function mondayOf(s) {
  const wd = weekday(s);
  return addDays(s, wd === 0 ? -6 : 1 - wd);
}
export function weekDates(monday) {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
export function mdLabel(s) {
  const d = parseYmd(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function isBusinessDay(s, holidays) {
  const wd = weekday(s);
  return wd !== 0 && wd !== 6 && !holidays.has(s);
}
// 前営業日（土日祝をスキップ）。月曜の予定なら前週金曜
export function prevBusinessDay(s, holidays) {
  let d = addDays(s, -1);
  for (let i = 0; i < 30 && !isBusinessDay(d, holidays); i++) d = addDays(d, -1);
  return d;
}

// ---- Google Calendar イベント → 表示用アイテム ----
export function minutesOf(dateTime) {
  const d = new Date(dateTime);
  return d.getHours() * 60 + d.getMinutes();
}
export function hhmm(min) {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

export const DONE_MARK = '✅ ';

export function stripDone(title) {
  return title.startsWith(DONE_MARK) ? title.slice(DONE_MARK.length) : title;
}

export function normalize(ev, kind) {
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  const allDay = !!(ev.start && ev.start.date);
  const date = allDay ? ev.start.date : ymd(new Date(ev.start.dateTime));
  const endDate = allDay ? addDays(ev.end.date, -1) : ymd(new Date(ev.end.dateTime));
  const title = ev.summary || '（無題）';
  const item = {
    id: ev.id, kind, allDay, date, endDate,
    title: stripDone(title),
    location: ev.location || '',
    description: ev.description || '',
    startMin: allDay ? null : minutesOf(ev.start.dateTime),
    endMin: allDay ? null : minutesOf(ev.end.dateTime),
    parentId: priv.parentId || null,
    done: priv.done === '1',
    raw: ev,
  };
  if (kind === 'task') item.checklist = parseChecklist(item.description);
  return item;
}

// タスク description 内のチェックリスト: "- [ ] 網図" / "- [x] 対比表"
export function parseChecklist(desc) {
  return (desc || '').split(/\r?\n/)
    .map(l => l.match(/^\s*-\s*\[( |x|X)\]\s*(.+)$/))
    .filter(Boolean)
    .map(m => ({ text: m[2].trim(), done: m[1] !== ' ' }));
}
export function formatChecklist(list) {
  return list.map(c => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n');
}

// 1行1タスクの入力を分解。「・」「-」で始まる行は直前タスクのチェックリスト
export function parseTaskLines(text) {
  const tasks = [];
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sub = line.match(/^[・\-－]\s*(.+)$/);
    if (sub && tasks.length) tasks[tasks.length - 1].checklist.push({ text: sub[1].trim(), done: false });
    else tasks.push({ title: sub ? sub[1].trim() : line, checklist: [] });
  }
  return tasks;
}

// ---- 紐付け ----
export const LINK_COLORS = ['#e8833a', '#3a8fd9', '#43a36b', '#c9579b', '#8a6ad6', '#c9a227', '#2aa5a5', '#d65a5a'];
export function linkColor(parentId) {
  let h = 0;
  for (const ch of parentId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LINK_COLORS[h % LINK_COLORS.length];
}

// 親予定ID → 子タスク配列
export function groupChildren(tasks) {
  const map = new Map();
  for (const t of tasks) {
    if (!t.parentId) continue;
    if (!map.has(t.parentId)) map.set(t.parentId, []);
    map.get(t.parentId).push(t);
  }
  return map;
}
export function progressLabel(children) {
  if (!children || !children.length) return '';
  const done = children.filter(c => c.done).length;
  return `準備 ${done}/${children.length}${done === children.length ? ' ✅' : ''}`;
}

// 持ち越し: 今日より前の未完了タスク
export function carryOver(tasks, today) {
  return tasks.filter(t => !t.done && t.date < today)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 指定日に表示するアイテム（複数日の終日予定は期間中の各日に出す）
export function itemsOn(items, s) {
  return items.filter(i => i.date <= s && s <= i.endDate);
}

// 時刻付き予定を 早朝(<9:00) / 日中 / 夜(>=17:00) に振り分け（印刷の時間帯 9:00-17:00 用）
export function timeBand(item, from = 9 * 60, to = 17 * 60) {
  if (item.endMin <= from && item.startMin < from) return 'early';
  if (item.startMin >= to) return 'late';
  return 'day';
}

// 並べ替え: 終日予定 → タスク（未完了優先）、時刻順
export function sortItems(list) {
  const rank = i => (i.kind === 'holiday' ? 0 : i.kind === 'event' || i.kind === 'family' ? 1 : 2);
  return [...list].sort((a, b) =>
    rank(a) - rank(b) || (a.done ? 1 : 0) - (b.done ? 1 : 0) || (a.startMin ?? -1) - (b.startMin ?? -1) || a.title.localeCompare(b.title, 'ja'));
}

// ---- Google Calendar へ書き込む本文 ----
export function taskBody({ title, date, parentId = null, checklist = [], done = false }) {
  const priv = { done: done ? '1' : '0', app: 'techo' };
  if (parentId) priv.parentId = parentId;
  return {
    summary: (done ? DONE_MARK : '') + title,
    description: formatChecklist(checklist),
    start: { date },
    end: { date: addDays(date, 1) },
    transparency: 'transparent',
    extendedProperties: { private: priv },
  };
}
export function eventBody({ title, date, allDay, start, end, location = '' }) {
  const body = { summary: title, location };
  if (allDay) {
    body.start = { date };
    body.end = { date: addDays(date, 1) };
  } else {
    body.start = { dateTime: `${date}T${start}:00+09:00`, timeZone: 'Asia/Tokyo' };
    body.end = { dateTime: `${date}T${end}:00+09:00`, timeZone: 'Asia/Tokyo' };
  }
  return body;
}
