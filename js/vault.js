// Obsidian ノート閲覧（フォルダ一覧・並べ替え・Obsidian 記法の下ごしらえ）。純粋関数のみ

const HIDDEN = /(^|\/)(\.|node_modules\/)/; // .obsidian・.git・.trash など
export const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

// Git Trees API の一覧から、見せるファイル（.md と画像）だけ残す
export function filterTree(entries) {
  return entries.filter(e => e.type === 'blob' && !HIDDEN.test(e.path) && (/\.md$/i.test(e.path) || IMAGE.test(e.path)))
    .map(e => ({ path: e.path, size: e.size || 0 }));
}

const isMd = p => /\.md$/i.test(p);
export const baseName = p => p.split('/').pop().replace(/\.md$/i, '');
export const parentOf = p => p.split('/').slice(0, -1).join('/');

// 日付で始まる名前（2026-10-02 など）は新しい順、それ以外は名前順（数字は自然順）
const DATE = /^\d{4}-\d{2}-\d{2}/;
export function compareNames(a, b) {
  const da = DATE.test(a), db = DATE.test(b);
  if (da && db) return b.localeCompare(a);
  if (da !== db) return da ? -1 : 1;
  return a.localeCompare(b, 'ja', { numeric: true });
}

// フォルダの中身: 直下のサブフォルダ（中の .md 件数つき）と .md ファイル
export function listFolder(files, folder) {
  const pre = folder ? `${folder}/` : '';
  const sub = new Map(), notes = [];
  for (const f of files) {
    if (!isMd(f.path) || !f.path.startsWith(pre)) continue;
    const rest = f.path.slice(pre.length), i = rest.indexOf('/');
    if (i < 0) notes.push(f.path);
    else { const name = rest.slice(0, i); sub.set(name, (sub.get(name) || 0) + 1); }
  }
  return {
    folders: [...sub].sort((a, b) => compareNames(a[0], b[0])).map(([name, count]) => ({ name, path: pre + name, count })),
    notes: notes.sort((a, b) => compareNames(baseName(a), baseName(b))),
  };
}

// 名前で検索（スペース区切りは全部含むもの）
export function searchNotes(files, q, limit = 60) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return files.filter(f => isMd(f.path) && words.every(w => f.path.toLowerCase().includes(w)))
    .map(f => f.path).sort((a, b) => compareNames(baseName(a), baseName(b))).slice(0, limit);
}

// [[リンク]] の解決: パス指定 → 同じフォルダ → 一番浅い場所（Obsidian と同じ考え方）
export function resolveLink(files, target, from = '') {
  const t = String(target || '').split('#')[0].trim();
  if (!t) return null;
  const paths = files.map(f => f.path);
  const want = IMAGE.test(t) || /\.\w+$/.test(t) && !/\.md$/i.test(t) ? t : t.replace(/\.md$/i, '') + '.md';
  if (paths.includes(want)) return want;
  const name = want.split('/').pop().toLowerCase();
  const hits = paths.filter(p => p.toLowerCase().endsWith(`/${name}`) || p.toLowerCase() === name || p.toLowerCase().endsWith(want.toLowerCase()));
  if (!hits.length) return null;
  const dir = parentOf(from);
  return hits.find(p => parentOf(p) === dir) || hits.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
}

// frontmatter（先頭の --- 〜 ---）を切り出す
export function splitFrontmatter(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: [], body: String(text || '') };
  const meta = m[1].split(/\r?\n/).map(l => l.match(/^([\w぀-ヿ一-鿿-]+):\s*(.*)$/)).filter(Boolean).map(x => [x[1], x[2]]);
  return { meta, body: String(text).slice(m[0].length) };
}

const encLink = p => encodeURIComponent(p);
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Obsidian 記法 → 普通の Markdown/HTML（コードブロックの中は触らない）
//  ![[画像]] → <img data-vault="path">、[[ノート|表示名]] → <a data-note="path">、==強調== → <mark>、%%コメント%% → 消す
export function obsidianToMarkdown(body, files, from) {
  const parts = String(body).split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return parts.map((s, i) => (i % 2 ? s : s
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, t, alt) => {
      const p = resolveLink(files, t, from);
      if (!p) return `<span class="vl-missing">🖼 ${escAttr(t)}</span>`;
      if (IMAGE.test(p)) return `<img data-vault="${escAttr(p)}" alt="${escAttr(alt || t)}">`;
      return `<a class="vl-link vl-embed" href="#notes=${encLink(p)}" data-note="${escAttr(p)}">📄 ${escAttr(baseName(p))}</a>`;
    })
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, t, label) => {
      const p = resolveLink(files, t, from);
      const text = escAttr(label || t.split('#')[0].split('/').pop());
      return p ? `<a class="vl-link" href="#notes=${encLink(p)}" data-note="${escAttr(p)}">${text}</a>` : `<span class="vl-missing">${text}</span>`;
    })
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>'))).join('');
}
