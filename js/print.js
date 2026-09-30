// A4横1枚=1週間。中央で折って A5 見開き（左: 月火水 / 右: 木金土日）
import * as L from './logic.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const T_FROM = 9 * 60, T_TO = 17 * 60;

// 罫線（グラデーションはPDFで消えるので実要素で引く）
const rules = (n, cls = '') => `<div class="pr-rules ${cls}">${'<i></i>'.repeat(n)}</div>`;

// data: { events, tasks, holidays, family, parents(Map), holidayNames(Map) }
export function buildPrint(monday, data) {
  const days = L.weekDates(monday);
  return `<div class="pr-sheet">
    ${half(days.slice(0, 3), 'left', data)}
    ${half(days.slice(3), 'right', data)}
    <i class="reg r-tl"></i><i class="reg r-tr"></i><i class="reg r-bl"></i><i class="reg r-br"></i>
    <div class="pr-code">TECHO-W ${monday}</div>
    <i class="pr-fold t"></i><i class="pr-fold b"></i>
  </div>`;
}

function half(days, side, data) {
  const cols = days.map(d => (L.weekday(d) === 0 || L.weekday(d) === 6) ? '0.48fr' : '1fr').join(' ');
  return `<div class="pr-half ${side}" style="grid-template-columns: 8mm ${cols}">
    <div class="pr-h pr-corner">${side === 'left' ? L.parseYmd(days[0]).getFullYear() : ''}</div>
    ${days.map(d => head(d, data)).join('')}
    <div class="pr-lab memo">メ<br>モ</div>${days.map(d => noteCell(d, data, 'memo', 6)).join('')}
    <div class="pr-lab task">タ<br>ス<br>ク</div>${days.map(d => taskCell(d, data)).join('')}
    <div class="pr-lab band">早</div>${days.map(d => bandCell(d, data, 'early')).join('')}
    <div class="pr-lab time">${timeAxis()}</div>${days.map(d => timeCell(d, data)).join('')}
    <div class="pr-lab band">夜</div>${days.map(d => bandCell(d, data, 'late')).join('')}
    <div class="pr-lab result">結<br>果<br>記<br>録</div>${days.map(d => noteCell(d, data, 'log', 11)).join('')}
  </div>`;
}

// Obsidian の手帳メモ／行動ログを罫線に合わせて印字（書き足す余白を残すため行数で打ち切り）
function noteCell(d, data, kind, n) {
  const note = data.notes && data.notes.get(d);
  const list = note ? note[kind] : [];
  const shown = list.slice(0, n), more = list.length - shown.length;
  const cls = kind === 'memo' ? 'memo' : 'result';
  return `<div class="pr-cell ${cls}">${rules(n)}<div class="pr-body">${shown.map(x =>
    `<div class="pr-nl">${esc(x.text)}</div>`).join('')}${more > 0 ? `<div class="pr-nl more">他${more}件</div>` : ''}</div></div>`;
}

function head(d, data) {
  const wd = L.weekday(d);
  const hol = data.holidayNames.get(d);
  const cls = hol || wd === 0 ? 'sun' : wd === 6 ? 'sat' : '';
  return `<div class="pr-h ${cls}"><b>${L.mdLabel(d)}</b> ${L.WEEKDAYS[wd]}${hol ? `<small>${esc(hol)}</small>` : ''}</div>`;
}

function taskCell(d, data) {
  const allDay = L.itemsOn([...data.events, ...data.family], d).filter(i => i.allDay);
  const tasks = data.tasks.filter(t => t.date === d);
  const rows = [
    ...allDay.map(e => {
      const kids = data.children.get(e.id);
      const c = kids ? `border-left-color:${L.linkColor(e.id)}` : '';
      return `<div class="pr-it ev" style="${c}">◆${esc(e.title)}${kids ? `<small> ${L.progressLabel(kids)}</small>` : ''}</div>`;
    }),
    ...tasks.map(t => {
      const p = t.parentId && data.parents.get(t.parentId);
      const kids = data.children.get(t.id);
      const c = t.parentId ? `border-left-color:${L.linkColor(t.parentId)}` : kids ? `border-left-color:${L.linkColor(t.id)}` : '';
      const sub = t.checklist.map(x => `<div class="pr-sub">${x.done ? '☑' : '□'} ${esc(x.text)}</div>`).join('');
      return `<div class="pr-it tk${t.done ? ' done' : ''}" style="${c}">${t.done ? '☑' : '□'} ${esc(t.title)}${kids ? `<small> ${L.progressLabel(kids)}</small>` : ''}${p ? `<small class="to"> ▶${L.mdLabel(p.date)} ${esc(p.title)}</small>` : ''}</div>${sub}`;
    }),
  ];
  return `<div class="pr-cell task">${rules(10)}<div class="pr-body">${rows.join('')}</div></div>`;
}

function timedOn(d, data) {
  return [...data.events, ...data.family].filter(i => !i.allDay && i.date === d);
}

function bandCell(d, data, band) {
  const list = timedOn(d, data).filter(i => L.timeBand(i, T_FROM, T_TO) === band);
  return `<div class="pr-cell band">${list.map(i => `${L.hhmm(i.startMin)} ${esc(i.title)}`).join(' / ')}</div>`;
}

function timeAxis() {
  let s = '';
  for (let m = T_FROM; m < T_TO; m += 60) s += `<span style="top:${((m - T_FROM) / (T_TO - T_FROM)) * 100}%">${m / 60}</span>`;
  return s;
}

function timeCell(d, data) {
  const list = timedOn(d, data).filter(i => L.timeBand(i, T_FROM, T_TO) === 'day');
  const span = T_TO - T_FROM;
  const blocks = list.map(i => {
    const s = Math.max(i.startMin, T_FROM), e = Math.min(Math.max(i.endMin, s + 30), T_TO);
    const pre = i.startMin < T_FROM ? `${L.hhmm(i.startMin)}〜` : L.hhmm(i.startMin);
    return `<div class="pr-tb" style="top:${((s - T_FROM) / span) * 100}%;height:${((e - s) / span) * 100}%">${pre} ${esc(i.title)}</div>`;
  });
  return `<div class="pr-cell time">${rules(16, 'half')}${blocks.join('')}</div>`;
}
