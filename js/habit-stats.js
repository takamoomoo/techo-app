// 習慣のふり返り（集計・バッジ・称号）。純粋関数のみ
import * as L from './logic.js';
import * as H from './habit-md.js';

const started = (h, d) => !h.start || d >= h.start;
const targetsOn = (data, d) => data.habits.filter(h => started(h, d) && H.isTarget(h, d));
const lastOfMonth = d => L.addDays(d, 1).slice(8) === '01';

// 記録の始まり（最初の開始日か最初の✅）
export function firstDate(data) {
  const ds = [...data.habits.map(h => h.start).filter(Boolean), ...Object.keys(data.done).filter(d => data.done[d].size)];
  return ds.length ? ds.sort()[0] : null;
}

// 1日分: done=その日の✅数（対象外の曜日・リストから外した習慣も含む）、target/targetDone=対象習慣の数と達成数
export function dayStats(data, d) {
  const t = targetsOn(data, d), set = data.done[d] || new Set();
  return { date: d, done: set.size, names: [...set], target: t.length, targetDone: t.filter(h => set.has(h.name)).length };
}

// 期間の集計（今日より後は数えない）
export function periodStats(data, from, to, today) {
  const days = [];
  for (let d = from; d <= to; d = L.addDays(d, 1)) days.push(d > today ? { date: d, future: true, done: 0, names: [], target: 0, targetDone: 0 } : dayStats(data, d));
  const past = days.filter(x => !x.future);
  const sum = k => past.reduce((a, x) => a + x[k], 0);
  const target = sum('target'), targetDone = sum('targetDone');
  const perHabit = data.habits.map(h => {
    let t = 0, dn = 0;
    for (const x of past) {
      const on = started(h, x.date) && H.isTarget(h, x.date);
      if (on) t++;
      if (on && x.names.includes(h.name)) dn++;
    }
    return { name: h.name, target: t, done: dn, rate: t ? Math.round((dn / t) * 100) : null };
  });
  return {
    days, done: sum('done'), target, targetDone, rate: target ? Math.round((targetDone / target) * 100) : null,
    perfectDays: past.filter(x => x.target && x.targetDone === x.target).length, perHabit,
  };
}

// 週は月曜始まり。offset で前後に移動
export function periodRange(kind, anchor, offset = 0) {
  if (kind === 'week') { const m = L.addDays(L.mondayOf(anchor), offset * 7); return { from: m, to: L.addDays(m, 6) }; }
  const b = new Date(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)) - 1 + offset, 1);
  const from = L.ymd(b), to = L.ymd(new Date(b.getFullYear(), b.getMonth() + 1, 0));
  return { from, to };
}

// ---- バッジ（記録から毎回計算するので保存不要。獲得日も分かる） ----
export const BADGES = [
  ...[[1, 'はじめの一歩'], [10, '10回達成'], [50, '50回達成'], [100, '100回達成'], [300, '300回達成'], [500, '500回達成'], [1000, '1000回達成']]
    .map(([n, t]) => ({ id: `total-${n}`, kind: 'total', goal: n, icon: '✅', title: t, desc: `✅を累計${n}回` })),
  ...[[3, '三日坊主卒業'], [7, '1週間継続'], [14, '2週間継続'], [30, '1か月継続'], [50, '50日継続'], [100, '百日修行'], [200, '200日継続'], [365, '1年継続']]
    .map(([n, t]) => ({ id: `streak-${n}`, kind: 'streak', goal: n, icon: '🔥', title: t, desc: `どれか1つを${n}日連続` })),
  ...[[1, 'パーフェクトデイ'], [10, 'パーフェクト10日'], [30, 'パーフェクト30日'], [100, 'パーフェクト100日']]
    .map(([n, t]) => ({ id: `perfect-${n}`, kind: 'perfect', goal: n, icon: '⭐', title: t, desc: n === 1 ? 'その日の習慣を全部達成' : `全部達成の日が累計${n}日` })),
  ...[[1, 'パーフェクトウィーク'], [4, 'パーフェクト4週'], [12, 'パーフェクト12週']]
    .map(([n, t]) => ({ id: `pweek-${n}`, kind: 'pweek', goal: n, icon: '👑', title: t, desc: n === 1 ? '月〜日の習慣を全部達成' : `全部達成の週が累計${n}週` })),
  ...[[1, '優良月'], [3, '優良月×3'], [6, '優良月×6'], [12, '優良月×12']]
    .map(([n, t]) => ({ id: `month-${n}`, kind: 'month', goal: n, icon: '🏆', title: t, desc: n === 1 ? '1か月の達成率80%以上' : `達成率80%以上の月が${n}回` })),
];

export const RANKS = [[0, '見習い'], [3, '習慣の芽'], [7, '継続の人'], [12, '習慣の達人'], [18, '習慣マスター'], [24, '習慣の伝説']];

// 最初の日から今日まで1日ずつたどって、各バッジの獲得日と現在値を出す
export function badges(data, today) {
  const v = { total: 0, streak: 0, perfect: 0, pweek: 0, month: 0 };
  const earned = new Map(), cur = new Map();
  const first = firstDate(data);
  let weekOk = true, weekAny = false, mT = 0, mD = 0;
  if (first) {
    for (let d = first; d <= today; d = L.addDays(d, 1)) {
      const s = dayStats(data, d), set = data.done[d] || new Set();
      v.total += s.done;
      for (const h of targetsOn(data, d)) {
        if (set.has(h.name)) { const n = (cur.get(h.name) || 0) + 1; cur.set(h.name, n); v.streak = Math.max(v.streak, n); }
        else if (d !== today) cur.set(h.name, 0);
      }
      if (s.target) {
        weekAny = true; mT += s.target; mD += s.targetDone;
        if (s.targetDone === s.target) v.perfect++; else weekOk = false;
      }
      if (L.weekday(d) === 0) { // 日曜で週を締める
        if (weekOk && weekAny) v.pweek++;
        weekOk = true; weekAny = false;
      }
      if (lastOfMonth(d)) {
        if (mT && mD / mT >= 0.8) v.month++;
        mT = 0; mD = 0;
      }
      for (const b of BADGES) if (!earned.has(b.id) && v[b.kind] >= b.goal) earned.set(b.id, d);
    }
  }
  const list = BADGES.map(b => ({ ...b, earnedOn: earned.get(b.id) || null, value: v[b.kind] }));
  const count = earned.size;
  const ri = RANKS.reduce((a, r, i) => (count >= r[0] ? i : a), 0);
  return {
    list, values: v, count,
    rank: RANKS[ri][1], nextRank: RANKS[ri + 1] ? { title: RANKS[ri + 1][1], need: RANKS[ri + 1][0] - count } : null,
    next: [...new Set(BADGES.map(b => b.kind))].map(k => list.find(b => b.kind === k && !b.earnedOn)).filter(Boolean),
  };
}

// 積み上げの草（直近 weeks 週・月曜始まり）。level 0〜4
export function heatmap(data, today, weeks = 20) {
  const start = L.addDays(L.mondayOf(today), -7 * (weeks - 1));
  return Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, i) => {
    const d = L.addDays(start, w * 7 + i);
    if (d > today) return { date: d, future: true, level: 0 };
    const s = dayStats(data, d);
    const r = s.target ? s.targetDone / s.target : s.done ? 1 : 0;
    const level = !s.done ? 0 : r >= 1 ? 4 : r >= 0.67 ? 3 : r >= 0.34 ? 2 : 1;
    return { ...s, level };
  }));
}
