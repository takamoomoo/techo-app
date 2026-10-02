// 習慣化管理: Obsidian の 手帳アプリ/習慣.md に保存。Obsidian でも読み書きできる Markdown（純粋関数のみ）
import * as L from './logic.js';

export const HABIT_PATH = '手帳アプリ/習慣.md';
export const DONE = '✅';
const LIST_HEADING = '## 習慣リスト';

// 曜日指定: 毎日／平日／土日／「月水金」のような曜日の並び → 対象曜日（0=日〜6=土）
export function parseDays(spec) {
  const s = String(spec || '').trim();
  if (!s || s === '毎日') return [0, 1, 2, 3, 4, 5, 6];
  if (s === '平日') return [1, 2, 3, 4, 5];
  if (s === '土日') return [0, 6];
  const d = [...new Set([...s].map(c => L.WEEKDAYS.indexOf(c)).filter(i => i >= 0))].sort();
  return d.length ? d : [0, 1, 2, 3, 4, 5, 6];
}
export function normalizeDays(spec) {
  const d = parseDays(spec);
  if (d.length === 7) return '毎日';
  if (d.join() === '1,2,3,4,5') return '平日';
  if (d.join() === '0,6') return '土日';
  return [1, 2, 3, 4, 5, 6, 0].filter(i => d.includes(i)).map(i => L.WEEKDAYS[i]).join('');
}
export const isTarget = (h, date) => parseDays(h.days).includes(L.weekday(date));

const cleanName = s => String(s || '').replace(/[|｜]/g, ' ').trim();

// { habits: [{ name, days, start }], done: { 'YYYY-MM-DD': Set(名前) } }
export function parseHabits(text) {
  const data = { habits: [], done: {} };
  let sec = '', month = null, cols = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('## ')) {
      sec = l; const m = l.match(/^## (\d{4})-(\d{2})\b/);
      month = m ? `${m[1]}-${m[2]}` : null; cols = null;
      continue;
    }
    if (sec === LIST_HEADING && /^[-*]\s+/.test(l)) {
      const [name, days, start] = l.replace(/^[-*]\s+/, '').split(/\s*[|｜]\s*/);
      const st = String(start || '').match(/\d{4}-\d{2}-\d{2}/);
      if (cleanName(name)) data.habits.push({ name: cleanName(name), days: normalizeDays(days), start: st ? st[0] : '' });
    } else if (month && l.startsWith('|')) {
      const cells = l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (!cols) { cols = cells.map(c => (/^\d{1,2}$/.test(c) ? Number(c) : null)); continue; }
      if (cells.every(c => /^:?-+:?$/.test(c) || !c)) continue; // 区切り行
      const name = cells[0];
      cells.forEach((c, i) => {
        if (i === 0 || !cols[i] || !c.includes(DONE)) return;
        const date = `${month}-${String(cols[i]).padStart(2, '0')}`;
        (data.done[date] ||= new Set()).add(name);
      });
    }
  }
  return data;
}

const daysInMonth = ym => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();

// months: 表を必ず書く月（今月など）。記録のある月はすべて残す。新しい月が上
export function formatHabits(data, months = []) {
  const all = new Set([...months, ...Object.keys(data.done).filter(d => data.done[d].size).map(d => d.slice(0, 7))]);
  const out = [
    '# ✅ 習慣（手帳アプリの習慣化管理）', '',
    'アプリの「習慣化管理」で付けたチェックがここに記録されます。Obsidian で ✅ を書き足し・消しても反映されます。',
    '習慣リストの書き方: `- 名前 ｜ 曜日 ｜ 開始日`（曜日は 毎日／平日／土日／月水金 など）', '',
    LIST_HEADING,
    ...data.habits.map(h => `- ${h.name} ｜ ${normalizeDays(h.days)}${h.start ? ` ｜ ${h.start}` : ''}`), '',
  ];
  for (const ym of [...all].sort().reverse()) {
    const n = daysInMonth(ym), days = Array.from({ length: n }, (_, i) => i + 1);
    const names = [...data.habits.map(h => h.name)];
    for (const [d, set] of Object.entries(data.done)) if (d.startsWith(ym)) set.forEach(nm => { if (!names.includes(nm)) names.push(nm); });
    out.push(`## ${ym}`, `| 習慣 | ${days.join(' | ')} |`, `|---|${days.map(() => ':-:').join('|')}|`);
    for (const nm of names) {
      out.push(`| ${nm} | ${days.map(i => (data.done[`${ym}-${String(i).padStart(2, '0')}`]?.has(nm) ? DONE : ' ')).join(' | ')} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

export function isDone(data, name, date) { return !!data.done[date]?.has(name); }

export function setDone(data, name, date, on) {
  const set = (data.done[date] ||= new Set());
  if (on) set.add(name); else set.delete(name);
  return data;
}

// 習慣リストの編集（1行1件「名前 ｜ 曜日」）。同じ名前の開始日は引き継ぎ、新しい習慣は today 開始
export function parseHabitLines(text, prev = [], today = '') {
  const seen = new Set();
  return String(text || '').split(/\r?\n/).map(l => l.replace(/^[-*・]\s*/, '').trim()).filter(Boolean).map(l => {
    const [name, days] = l.split(/\s*[|｜]\s*/);
    return { name: cleanName(name), days: normalizeDays(days) };
  }).filter(h => h.name && !seen.has(h.name) && seen.add(h.name)).map(h => {
    const old = prev.find(p => p.name === h.name);
    return { ...h, start: old ? old.start : today };
  });
}

const started = (h, date) => !h.start || date >= h.start;

// 連続日数: 対象曜日だけを数える。今日がまだ未チェックなら昨日から数える
export function streak(data, h, today) {
  let n = 0;
  for (let i = 0, d = today; i < 800; i++, d = L.addDays(d, -1)) {
    if (!started(h, d)) break;
    if (!isTarget(h, d)) continue;
    if (isDone(data, h.name, d)) n++;
    else if (d !== today) break;
  }
  return n;
}

// その月の達成率（今日までの対象日のうち✅の割合）
export function monthRate(data, h, ym, today) {
  let target = 0, done = 0;
  for (let i = 1; i <= daysInMonth(ym); i++) {
    const d = `${ym}-${String(i).padStart(2, '0')}`;
    if (d > today) break;
    if (!started(h, d) || !isTarget(h, d)) continue;
    target++;
    if (isDone(data, h.name, d)) done++;
  }
  return { target, done, rate: target ? Math.round((done / target) * 100) : null };
}

// 今日の対象習慣の達成数
export function todayCount(data, today) {
  const list = data.habits.filter(h => started(h, today) && isTarget(h, today));
  return { done: list.filter(h => isDone(data, h.name, today)).length, total: list.length };
}

export const monthDates = ym => Array.from({ length: daysInMonth(ym) }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
export const cellState = (data, h, date, today) =>
  date > today ? 'future' : isDone(data, h.name, date) ? 'done' : !started(h, date) ? 'before' : !isTarget(h, date) ? 'off' : 'miss';
