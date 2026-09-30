// Obsidian デイリーノートの読み書き（GitHub Contents API 経由。obsidian-git が PC 側へ同期する）
import * as O from './obsidian-md.js';

const enc = path => path.split('/').map(encodeURIComponent).join('/');

export class GitHubNotes {
  constructor({ token, repo, branch }) { Object.assign(this, { token, repo, branch }); }
  get name() { return 'github'; }

  async req(method, path, body) {
    const url = `https://api.github.com/repos/${this.repo}/contents/${enc(path)}` + (method === 'GET' ? `?ref=${encodeURIComponent(this.branch)}` : '');
    const res = await fetch(url, {
      method, cache: 'no-store', // 古い sha を掴まないように毎回取り直す
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (method === 'GET' && res.status === 404) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(res.status === 401 ? 'GitHubトークンが無効です（⚙設定で確認）'
        : res.status === 403 || res.status === 404 ? 'GitHubへの書き込み権限がありません（トークンの対象リポジトリ・権限を確認）'
        : `GitHub ${res.status}: ${json.message || ''}`);
      e.status = res.status;
      throw e;
    }
    return json;
  }
  async getFile(path) {
    const r = await this.req('GET', path);
    return r && { text: O.b64decode(r.content), sha: r.sha };
  }
  async putFile(path, text, sha, message) {
    return this.req('PUT', path, { message, content: O.b64encode(text), branch: this.branch, ...(sha ? { sha } : {}) });
  }
}

// お試し用（localStorage）。GitHub と同じ getFile/putFile を持つ
const DEMO_KEY = 'techo-demo-notes-v1';
const DEMO_TEMPLATE = `# 📅 {{DATE:YYYY年MM月DD日}}（{{DATE:dddd}}）

## 🌤️ 天気
- 天気：晴れ
- 気温：18
- 体調：良い

---

## 📅 予定と結果

### 📝 手帳メモ


### 🚀 今日の1ミッション
（これだけやればOKな最重要1つ）

今日の業務：（お試し）雄武町現場の準備

今日の目標：杭と見出しを揃える


---

### ⚔️ 行動ログ

・やったこと①  ：
・やったこと②  ：
・やったこと③：

---

**作成日時：** {{DATE:YYYY-MM-DD HH:mm}}`;

export class DemoNotes {
  get name() { return 'demo'; }
  load() { try { return JSON.parse(localStorage.getItem(DEMO_KEY)) || {}; } catch { return {}; } }
  async getFile(path) {
    if (path === O.TEMPLATE_PATH) return { text: DEMO_TEMPLATE, sha: 't' };
    const f = this.load()[path];
    return f ? { ...f } : null;
  }
  async putFile(path, text, sha) {
    const all = this.load();
    if ((all[path] && all[path].sha) !== sha && !(sha == null && !all[path])) { const e = new Error('conflict'); e.status = 409; throw e; }
    all[path] = { text, sha: Math.random().toString(36).slice(2) };
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(all)); } catch { /* 無視 */ }
  }
  reset() { try { localStorage.removeItem(DEMO_KEY); } catch { /* 無視 */ } }
}

export class Notes {
  constructor(store) { this.store = store; this.template = null; }
  get name() { return this.store.name; }

  async loadDays(dates) {
    const files = await Promise.all(dates.map(d => this.store.getFile(O.notePath(d))));
    return new Map(dates.map((d, i) => [d, O.summarizeNote(files[i] && files[i].text)]));
  }

  async getTemplate() {
    if (!this.template) {
      const f = await this.store.getFile(O.TEMPLATE_PATH);
      if (!f) throw new Error(`テンプレート ${O.TEMPLATE_PATH} が見つかりません`);
      this.template = f.text;
    }
    return this.template;
  }

  // 📓 行を1行削除。競合したら読み直して最大3回。戻り値 false = 既に無い
  async remove(date, kind, displayText) {
    const path = O.notePath(date);
    const heading = kind === 'memo' ? O.MEMO_HEADING : O.LOG_HEADING;
    for (let attempt = 0; ; attempt++) {
      const f = await this.store.getFile(path);
      const text = f && O.removeMarkedLine(f.text, heading, displayText);
      if (!text) return false;
      try {
        await this.store.putFile(path, text, f.sha, `techo: ${date} ${kind === 'memo' ? '手帳メモ' : '行動ログ'}削除`);
        return true;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 2) continue;
        throw e;
      }
    }
  }

  // kind: 'memo' → 📝 手帳メモ / 'log' → ⚔️ 行動ログ。競合したら読み直して最大3回
  async append(date, kind, input) {
    const entries = O.formatEntries(kind, input);
    if (!entries.length) return 0;
    const path = O.notePath(date);
    const heading = kind === 'memo' ? O.MEMO_HEADING : O.LOG_HEADING;
    for (let attempt = 0; ; attempt++) {
      const f = await this.store.getFile(path);
      let text = f ? f.text : O.fillTemplate(await this.getTemplate(), date);
      if (kind === 'memo') text = O.ensureMemoSection(text);
      text = O.appendToSection(text, heading, entries);
      try {
        await this.store.putFile(path, text, f && f.sha, `techo: ${date} ${kind === 'memo' ? '手帳メモ' : '行動ログ'}追記`);
        return entries.length;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 2) continue;
        throw e;
      }
    }
  }
}
