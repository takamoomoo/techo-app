// Google カレンダー API バックエンド（GIS トークン方式・サーバー不要）
import { addDays } from './logic.js';

const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const TASK_CAL_NAME = 'タスク';

export class GoogleBackend {
  constructor(clientId) {
    this.clientId = clientId;
    this.token = null;
    this.tokenClient = null;
    this.cal = { main: 'primary', tasks: null, holiday: null, family: [] };
    this.readonly = false;
  }

  get name() { return 'google'; }

  async loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Googleログイン部品を読み込めません（オフライン？）'));
      document.head.appendChild(s);
    });
  }

  // ボタン操作から呼ぶ（iPhone Safari のポップアップ制限対策）
  async signIn(prompt = '') {
    await this.loadGis();
    return new Promise((resolve, reject) => {
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPE,
        callback: r => {
          if (r.error) return reject(new Error(r.error_description || r.error));
          this.token = r.access_token;
          this.tokenExpiry = Date.now() + (r.expires_in - 60) * 1000;
          resolve();
        },
        error_callback: e => reject(new Error(e.message || 'ログインが中断されました')),
      });
      this.tokenClient.requestAccessToken({ prompt });
    });
  }

  get signedIn() { return !!this.token && Date.now() < this.tokenExpiry; }

  async req(method, path, body, query) {
    if (!this.signedIn) {
      const e = new Error('ログインが切れました。「Googleでログイン」を押してください');
      e.code = 'AUTH';
      throw e;
    }
    const url = new URL(API + path);
    if (query) for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
      else if (v !== undefined) url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { this.token = null; const e = new Error('ログインが切れました'); e.code = 'AUTH'; throw e; }
    if (res.status === 204) return null;
    const json = await res.json();
    if (!res.ok) throw new Error(`Google API ${res.status}: ${json.error && json.error.message}`);
    return json;
  }

  // カレンダー一覧から タスク／祝日／家族 を特定。タスクカレンダーが無ければ作る
  async setup() {
    const list = await this.req('GET', '/users/me/calendarList', null, { maxResults: 250 });
    for (const c of list.items) {
      if (c.summary === TASK_CAL_NAME && c.accessRole === 'owner') this.cal.tasks = c.id;
      else if (c.id.includes('#holiday@')) this.cal.holiday = c.id;
      else if (!c.primary && c.id !== this.cal.tasks) this.cal.family.push(c.id);
    }
    if (!this.cal.tasks) {
      const created = await this.req('POST', '/calendars', { summary: TASK_CAL_NAME, timeZone: 'Asia/Tokyo',
        description: '手帳アプリのタスク・準備タスク（親予定との紐付けは拡張プロパティ）' });
      this.cal.tasks = created.id;
    }
  }

  async listCal(calId, from, to, extra = {}) {
    if (!calId) return [];
    const out = [];
    let pageToken;
    do {
      const r = await this.req('GET', `/calendars/${encodeURIComponent(calId)}/events`, null, {
        timeMin: `${from}T00:00:00+09:00`, timeMax: `${addDays(to, 1)}T00:00:00+09:00`,
        singleEvents: 'true', orderBy: 'startTime', maxResults: 2500, pageToken, ...extra,
      });
      out.push(...r.items.filter(e => e.status !== 'cancelled'));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  // 戻り値は生の Google イベント（kind ごと）
  async listRange(from, to) {
    const [events, tasks, holidays, ...family] = await Promise.all([
      this.listCal(this.cal.main, from, to),
      this.listCal(this.cal.tasks, from, to),
      this.listCal(this.cal.holiday, from, to),
      ...this.cal.family.map(id => this.listCal(id, from, to)),
    ]);
    return { events, tasks, holidays, family: family.flat() };
  }

  async listOverdue(today) {
    return this.listCal(this.cal.tasks, addDays(today, -120), addDays(today, -1),
      { privateExtendedProperty: 'done=0' });
  }

  // 親（予定 or タスク）を ID で探す。戻り値 { ev, kind }
  async getItem(id) {
    for (const [kind, cal] of [['event', this.cal.main], ['task', this.cal.tasks]]) {
      try { return { ev: await this.req('GET', `/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`), kind }; }
      catch { /* 次のカレンダーを探す */ }
    }
    return null;
  }

  calOf(kind) { return kind === 'task' ? this.cal.tasks : this.cal.main; }
  create(kind, body) { return this.req('POST', `/calendars/${encodeURIComponent(this.calOf(kind))}/events`, body); }
  patch(kind, id, body) { return this.req('PATCH', `/calendars/${encodeURIComponent(this.calOf(kind))}/events/${encodeURIComponent(id)}`, body); }
  remove(kind, id) { return this.req('DELETE', `/calendars/${encodeURIComponent(this.calOf(kind))}/events/${encodeURIComponent(id)}`); }
}
