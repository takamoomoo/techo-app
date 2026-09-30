// お試し（デモ）バックエンド: Google と同じ形のイベントを localStorage に保存する
import { addDays, mondayOf, ymd, taskBody } from './logic.js';

const KEY = 'techo-demo-v1';

const HOLIDAYS_2026_27 = {
  '2026-09-21': '敬老の日', '2026-09-22': '国民の休日', '2026-09-23': '秋分の日', '2026-10-12': 'スポーツの日',
  '2026-11-03': '文化の日', '2026-11-23': '勤労感謝の日', '2027-01-01': '元日', '2027-01-11': '成人の日',
};

function uid() { return 'd' + Math.random().toString(36).slice(2, 10); }

function seed() {
  const mon = mondayOf(ymd(new Date()));
  const d = n => addDays(mon, n);
  const timed = (date, s, e, summary, location = '') => ({
    id: uid(), summary, location,
    start: { dateTime: `${date}T${s}:00+09:00` }, end: { dateTime: `${date}T${e}:00+09:00` },
  });
  const allday = (date, summary) => ({ id: uid(), summary, start: { date }, end: { date: addDays(date, 1) } });
  const deliver = allday(d(3), '雄武町現場に届ける');
  const kui = allday(d(0), '雄武現場杭設置');
  const main = [deliver, kui, timed(d(3), '13:00', '14:00', '現場集合', '雄武町'),
    timed(d(1), '10:00', '11:30', '調整課打合せ'), timed(d(5), '08:45', '15:00', 'ゴルフ'),
    allday(d(9), '完了検査')];
  const t = (o) => ({ id: uid(), ...taskBody(o) });
  const tasks = [
    t({ title: '杭10本（赤２寸）', date: d(2), parentId: deliver.id }),
    t({ title: '見出し', date: d(2), parentId: deliver.id, done: true }),
    t({ title: '資料作成（協議資料）', date: d(4), checklist: [
      { text: '網図', done: true }, { text: '対比表', done: false }, { text: '承諾書', done: false }] }),
    t({ title: '請求書の確認', date: addDays(d(0), -3) }),
  ];
  const holidays = Object.entries(HOLIDAYS_2026_27).map(([date, summary]) => ({ id: 'h' + date, ...allday(date, summary) }));
  const family = [allday(d(6), '家族：買い物')];
  return { main, tasks, holidays, family };
}

export class DemoBackend {
  constructor() {
    try { this.db = JSON.parse(localStorage.getItem(KEY)); } catch { this.db = null; }
    if (!this.db) { this.db = seed(); this.save(); }
  }
  get name() { return 'demo'; }
  get signedIn() { return true; }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.db)); } catch { /* 保存不可でも動作は続ける */ } }
  reset() { this.db = seed(); this.save(); }
  async setup() {}

  inRange(list, from, to) {
    return list.filter(e => {
      const s = e.start.date || e.start.dateTime.slice(0, 10);
      const en = e.end.date ? addDays(e.end.date, -1) : e.end.dateTime.slice(0, 10);
      return s <= to && en >= from;
    }).map(e => structuredClone(e));
  }
  async listRange(from, to) {
    const { main, tasks, holidays, family } = this.db;
    return { events: this.inRange(main, from, to), tasks: this.inRange(tasks, from, to),
      holidays: this.inRange(holidays, from, to), family: this.inRange(family, from, to) };
  }
  async listOverdue(today) {
    return this.db.tasks.filter(e => e.start.date < today && e.extendedProperties.private.done === '0')
      .map(e => structuredClone(e));
  }
  async getItem(id) {
    const m = this.db.main.find(x => x.id === id), t = this.db.tasks.find(x => x.id === id);
    return m ? { ev: structuredClone(m), kind: 'event' } : t ? { ev: structuredClone(t), kind: 'task' } : null;
  }

  list(kind) { return kind === 'task' ? this.db.tasks : this.db.main; }
  async create(kind, body) { const e = { id: uid(), ...structuredClone(body) }; this.list(kind).push(e); this.save(); return e; }
  async patch(kind, id, body) {
    const e = this.list(kind).find(x => x.id === id);
    if (!e) throw new Error('見つかりません');
    Object.assign(e, structuredClone(body));
    this.save();
    return e;
  }
  async remove(kind, id) {
    const l = this.list(kind);
    const i = l.findIndex(x => x.id === id);
    if (i >= 0) l.splice(i, 1);
    this.save();
  }
}
