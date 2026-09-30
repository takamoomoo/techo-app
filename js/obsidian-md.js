// Obsidian デイリーノート（Markdown）の読み書き用 純粋ロジック（node --test で検証する）
import { parseYmd } from './logic.js';

export const MEMO_HEADING = '### 📝 手帳メモ';
export const LOG_HEADING = '### ⚔️ 行動ログ';
export const MISSION_HEADING = '### 🚀 今日の1ミッション';
export const MARK = '📓';

const WEEKDAY_FULL = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
const pad = n => String(n).padStart(2, '0');

export const notePath = date => `01_inbox/${date}.md`;
export const TEMPLATE_PATH = 'templates/デイリーノート 🔥 改造版.md';

// テンプレートの {{DATE:...}} を埋める（テンプレートで使っている3形式）
export function fillTemplate(tpl, date, now = new Date()) {
  const d = parseYmd(date);
  return tpl
    .replace(/\{\{DATE:YYYY年MM月DD日\}\}/g, `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`)
    .replace(/\{\{DATE:dddd\}\}/g, WEEKDAY_FULL[d.getDay()])
    .replace(/\{\{DATE:YYYY-MM-DD HH:mm\}\}/g,
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`);
}

const isHeading = l => /^#{1,6}\s/.test(l);
const isRule = l => /^---\s*$/.test(l);

// 見出し行の位置と、その節の終わり（次の見出し or 区切り線）を返す
export function sectionRange(lines, heading) {
  const start = lines.findIndex(l => l.trim() === heading);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !isHeading(lines[end]) && !isRule(lines[end])) end++;
  return { start, end };
}

const eolOf = text => (text.includes('\r\n') ? '\r\n' : '\n'); // 元の改行コードを保つ

// 📝 手帳メモ 節が無ければ「🚀 今日の1ミッション」の直前に作る
export function ensureMemoSection(text) {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  if (sectionRange(lines, MEMO_HEADING)) return text;
  let at = lines.findIndex(l => l.trim() === MISSION_HEADING);
  if (at < 0) { // テンプレートが変わっていた場合は「## 📅 予定と結果」節の終わり、それも無ければ末尾
    const r = sectionRange(lines, '## 📅 予定と結果');
    at = r ? r.end : lines.length;
  }
  lines.splice(at, 0, MEMO_HEADING, '', '');
  return lines.join(eol);
}

// 節の最後の中身のある行の直後に追記する（既存行は変更しない）
export function appendToSection(text, heading, newLines) {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const r = sectionRange(lines, heading);
  if (!r) throw new Error(`ノートに「${heading}」が見つかりません`);
  let last = -1;
  for (let i = r.start + 1; i < r.end; i++) if (lines[i].trim()) last = i;
  // 中身があれば最後の行の直後、空の節なら「見出し・空行」の後
  const block = last >= 0 ? newLines : ['', ...newLines];
  const at = last >= 0 ? last + 1 : r.start + 1;
  const tail = at < lines.length && lines[at].trim() !== '' ? [''] : []; // 次の見出し・区切り線との間に空行を残す
  lines.splice(at, 0, ...block, ...tail);
  return lines.join(eol);
}

// アプリが書く行の形（手帳メモは箇条書き、行動ログは既存の「・」形式に合わせる）
export function formatEntries(kind, input) {
  const bullet = kind === 'memo' ? '- ' : '・';
  return String(input || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => `${bullet}${MARK} ${s}`);
}

// 空の雛形行（「・やったこと②  ：」など）は表示しない
const isPlaceholder = l => /^・やったこと[①-⑳0-9]*\s*[：:]\s*$/.test(l.trim()) || /^（.*）$/.test(l.trim());

export function readSection(text, heading) {
  const lines = String(text || '').split(/\r?\n/);
  const r = sectionRange(lines, heading);
  if (!r) return [];
  return lines.slice(r.start + 1, r.end).map(l => l.trimEnd()).filter(l => l.trim() && !isPlaceholder(l));
}

// 表示用: 行頭の記号を取り、アプリが書いた行かどうかを付ける
export function toDisplay(lines) {
  return lines.map(l => {
    const mine = l.includes(MARK);
    const t = l.replace(/^\s*(?:[-*・]\s*)?/, '').replace(MARK, '').trim();
    return { text: t, mine };
  }).filter(x => x.text);
}

export function readMission(text) {
  const lines = readSection(text, MISSION_HEADING);
  const pick = key => {
    const l = lines.find(x => x.trim().startsWith(key));
    return l ? l.trim().slice(key.length).replace(/^[：:]\s*/, '').trim() : '';
  };
  return { work: pick('今日の業務'), goal: pick('今日の目標') };
}

export function readWeather(text) {
  const lines = String(text || '').split(/\r?\n/);
  const pick = key => {
    const l = lines.find(x => x.trim().startsWith(`- ${key}`));
    return l ? l.trim().slice(key.length + 2).replace(/^[：:]\s*/, '').trim() : '';
  };
  return { weather: pick('天気'), temp: pick('気温'), condition: pick('体調') };
}

// ノート1日分の要約
export function summarizeNote(text) {
  if (text == null) return { exists: false, memo: [], log: [], mission: { work: '', goal: '' }, weather: { weather: '', temp: '', condition: '' } };
  return {
    exists: true,
    memo: toDisplay(readSection(text, MEMO_HEADING)),
    log: toDisplay(readSection(text, LOG_HEADING)),
    mission: readMission(text),
    weather: readWeather(text),
  };
}

// UTF-8 ⇔ base64（GitHub Contents API 用）
export function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
