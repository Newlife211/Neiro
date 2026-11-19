import crypto from 'node:crypto';
// Хранилище: встроенный SQLite в Node 22 (node:sqlite), режим WAL.
// Для одного сервера на старте этого достаточно; бэкап — один файл (см. deploy/backup.sh).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS departments (key TEXT PRIMARY KEY, name TEXT NOT NULL, rules TEXT NOT NULL DEFAULT '[]', budget_monthly REAL);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, dept TEXT NOT NULL, boss TEXT, head INTEGER DEFAULT 0,
  skills TEXT DEFAULT '[]', duties TEXT DEFAULT '[]', character TEXT, goal TEXT,
  enabled INTEGER DEFAULT 0, tier TEXT DEFAULT 'worker', email TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'idea', owner TEXT, summary TEXT,
  roi REAL, price REAL, currency TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT, dept TEXT, agent_id TEXT, parent_id INTEGER, project_id INTEGER,
  status TEXT NOT NULL DEFAULT 'queued', priority INTEGER DEFAULT 5, created_by TEXT, result TEXT, error TEXT, attempts INTEGER DEFAULT 0,
  due_at TEXT, created_at TEXT DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, priority, id);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, agent_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL,
  amount REAL DEFAULT 0, currency TEXT, amount_base REAL DEFAULT 0, status TEXT NOT NULL, policy_reason TEXT,
  decided_by TEXT, decided_at TEXT, result TEXT, error TEXT, idem_key TEXT UNIQUE,
  created_at TEXT DEFAULT (datetime('now')), executed_at TEXT);
CREATE INDEX IF NOT EXISTS actions_status ON actions(status);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')), direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  category TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL, amount_base REAL NOT NULL,
  source TEXT NOT NULL, ref TEXT, project_id INTEGER, note TEXT, UNIQUE(source, ref));
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')), task_id INTEGER, agent_id TEXT, model TEXT,
  in_tokens INTEGER, out_tokens INTEGER, cost_base REAL);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, kind TEXT, content TEXT, agent_id TEXT, project_id INTEGER, task_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, ts TEXT DEFAULT (datetime('now')), text TEXT);
CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')), icon TEXT, agent_id TEXT, text TEXT, level TEXT DEFAULT 'info');
CREATE TABLE IF NOT EXISTS payment_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, ext_id TEXT NOT NULL, url TEXT, project_id INTEGER, title TEXT,
  amount REAL, currency TEXT, recurring TEXT, customer_email TEXT, status TEXT DEFAULT 'open', created_at TEXT DEFAULT (datetime('now')), UNIQUE(provider, ext_id));
CREATE TABLE IF NOT EXISTS inbound (provider TEXT, ext_id TEXT, ts TEXT DEFAULT (datetime('now')), task_id INTEGER, PRIMARY KEY(provider, ext_id));
CREATE TABLE IF NOT EXISTS bank_tx (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, ext_id TEXT NOT NULL, account TEXT, ts TEXT, amount REAL NOT NULL, currency TEXT NOT NULL,
  amount_base REAL, description TEXT, counterparty TEXT, card_id TEXT, kind TEXT, status TEXT NOT NULL DEFAULT 'new',
  action_id INTEGER, ledger_id INTEGER, note TEXT, raw TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(provider, ext_id));
CREATE INDEX IF NOT EXISTS bank_tx_status ON bank_tx(status);
CREATE TABLE IF NOT EXISTS radar_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, ext_id TEXT NOT NULL, title TEXT, url TEXT, summary TEXT, signal REAL DEFAULT 0,
  published_at TEXT, fetched_at TEXT DEFAULT (datetime('now')), verdict TEXT, relevance REAL, assessment TEXT, assessed_by TEXT, assessed_at TEXT, UNIQUE(source, ext_id));
CREATE INDEX IF NOT EXISTS radar_verdict ON radar_items(verdict);
CREATE TABLE IF NOT EXISTS adoptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, summary TEXT, benefit TEXT, cost TEXT, risk TEXT, plan TEXT, owner_dept TEXT,
  items TEXT, status TEXT NOT NULL, proposed_by TEXT, security_note TEXT, pilot_task_id INTEGER, result TEXT, director_note TEXT,
  created_at TEXT DEFAULT (datetime('now')), decided_at TEXT);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, task_id INTEGER, question TEXT NOT NULL, context TEXT, options TEXT, urgency TEXT DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open', answer TEXT, tg_message_id INTEGER, created_at TEXT DEFAULT (datetime('now')), answered_at TEXT);
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agenda TEXT NOT NULL, participants TEXT, status TEXT NOT NULL, summary_task_id INTEGER, protocol TEXT, protocol_doc_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')), finished_at TEXT);
CREATE TABLE IF NOT EXISTS meeting_tasks (meeting_id INTEGER, task_id INTEGER, agent_id TEXT, PRIMARY KEY(meeting_id, task_id));
CREATE TABLE IF NOT EXISTS mk_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, project_id INTEGER, title TEXT NOT NULL, hypothesis TEXT, segment TEXT, offer TEXT,
  channels TEXT NOT NULL DEFAULT '[]', budget REAL NOT NULL, currency TEXT NOT NULL, budget_base REAL NOT NULL, days INTEGER NOT NULL,
  stop_rules TEXT DEFAULT '{}', success TEXT DEFAULT '{}', landing_url TEXT, status TEXT NOT NULL, proposed_by TEXT, director_note TEXT,
  finish_reason TEXT, report TEXT, verdict TEXT, decision TEXT, report_doc_id INTEGER, started_at TEXT, ends_at TEXT,
  created_at TEXT DEFAULT (datetime('now')), decided_at TEXT, finished_at TEXT);
CREATE TABLE IF NOT EXISTS mk_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, test_id INTEGER NOT NULL, channel TEXT NOT NULL, ext_id TEXT, extra TEXT, name TEXT, url TEXT,
  daily_budget_base REAL DEFAULT 0, status TEXT NOT NULL DEFAULT 'paused', spec TEXT, stop_reason TEXT, created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS mk_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, test_id INTEGER NOT NULL, campaign_id INTEGER NOT NULL DEFAULT 0, channel TEXT NOT NULL, day TEXT NOT NULL,
  impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, spend REAL DEFAULT 0, currency TEXT, spend_base REAL DEFAULT 0, leads INTEGER DEFAULT 0, sales INTEGER DEFAULT 0,
  source TEXT NOT NULL, note TEXT, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(test_id, campaign_id, channel, day, source));
CREATE TABLE IF NOT EXISTS mk_links (code TEXT PRIMARY KEY, test_id INTEGER NOT NULL, channel TEXT NOT NULL, medium TEXT, campaign TEXT, content TEXT, url TEXT NOT NULL,
  clicks INTEGER DEFAULT 0, created_by TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS mk_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')), test_id INTEGER NOT NULL, event TEXT NOT NULL, channel TEXT, medium TEXT, campaign TEXT, content TEXT,
  visitor TEXT, value REAL, currency TEXT, value_base REAL, dk TEXT, UNIQUE(test_id, dk));
CREATE INDEX IF NOT EXISTS mk_events_t ON mk_events(test_id, event);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, channel TEXT NOT NULL, customer TEXT, subject TEXT, body TEXT, message_id TEXT, inbox_agent TEXT,
  kind TEXT NOT NULL DEFAULT 'new', topic TEXT, status TEXT NOT NULL DEFAULT 'new', assignee TEXT, bug_id INTEGER, backlog_id INTEGER, rating INTEGER,
  first_due TEXT, first_response_at TEXT, overdue_alerted INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), solved_at TEXT);
CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status);
CREATE TABLE IF NOT EXISTS bugs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, title TEXT NOT NULL, description TEXT, level TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  affected INTEGER DEFAULT 1, reported_by TEXT, fix_due TEXT, overdue_alerted INTEGER DEFAULT 0, release_id INTEGER, postmortem_task INTEGER, note TEXT,
  created_at TEXT DEFAULT (datetime('now')), fixed_at TEXT);
CREATE TABLE IF NOT EXISTS backlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, source TEXT, reach REAL DEFAULT 0, impact REAL DEFAULT 1,
  confidence REAL DEFAULT 0.8, effort REAL DEFAULT 1, rice REAL DEFAULT 0, requests INTEGER DEFAULT 0, metric TEXT, status TEXT NOT NULL DEFAULT 'new',
  release_id INTEGER, created_by TEXT, created_at TEXT DEFAULT (datetime('now')), done_at TEXT);
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, week TEXT NOT NULL, notes TEXT, status TEXT NOT NULL DEFAULT 'planned',
  planned_by TEXT, effect TEXT, created_at TEXT DEFAULT (datetime('now')), released_at TEXT, effect_at TEXT, UNIQUE(project_id, week));
CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, customer TEXT NOT NULL, kind TEXT NOT NULL, score INTEGER, answer TEXT, reason TEXT,
  sent_at TEXT, answered_at TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(project_id, customer, kind));
CREATE TABLE IF NOT EXISTS project_metrics (
  project_id INTEGER NOT NULL, week TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(project_id, week));
CREATE TABLE IF NOT EXISTS fate (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, checkpoint INTEGER NOT NULL, proposal TEXT, reasoning TEXT, proposed_by TEXT,
  decision TEXT, decided_at TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(project_id, checkpoint));
CREATE TABLE IF NOT EXISTS kb_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, title TEXT NOT NULL, body TEXT NOT NULL, topic TEXT, uses INTEGER DEFAULT 0, created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS hr_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, week TEXT, score INTEGER, verdict TEXT, reason TEXT, coaching TEXT, reviewer TEXT,
  status TEXT NOT NULL DEFAULT 'applied', replacement_id TEXT, created_at TEXT DEFAULT (datetime('now')), decided_at TEXT);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')), actor TEXT, event TEXT, data TEXT, prev TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, route TEXT, sender TEXT, subject TEXT, body TEXT, risk TEXT, flags TEXT, meta TEXT,
  status TEXT NOT NULL DEFAULT 'held', decided_by TEXT, decided_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS playbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dept TEXT, title TEXT NOT NULL, situation TEXT, steps TEXT NOT NULL, tags TEXT, created_by TEXT, source_task INTEGER,
  uses INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, version INTEGER DEFAULT 1, status TEXT NOT NULL DEFAULT 'active',
  last_used TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS model_stats (category TEXT NOT NULL, tier TEXT NOT NULL, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, cost REAL DEFAULT 0, runs INTEGER DEFAULT 0, PRIMARY KEY(category, tier));
`;

// Ключ подписи журнала: AUDIT_KEY из окружения или файл audit.key рядом с базой (создаётся один раз, права 600).
// Без ключа подделать запись так, чтобы проверка не заметила, нельзя. Ключ хранится в резервной копии вместе с базой.
function auditKey(file, given) {
  if (given) return given;
  if (process.env.AUDIT_KEY) return process.env.AUDIT_KEY;
  if (file === ':memory:') return crypto.randomBytes(32).toString('hex');
  const kf = path.join(path.dirname(file), 'audit.key');
  try { return fs.readFileSync(kf, 'utf8').trim(); } catch {}
  const k = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(kf, k + '\n', { mode: 0o600 });
  return k;
}
export const auditHash = (key, prev, row) => crypto.createHmac('sha256', key).update([prev || '', row.ts, row.actor, row.event, row.data].join('\u241E')).digest('hex');

export function openDb(file, opts = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  raw.exec(SCHEMA);
  for (const m of ['ALTER TABLE audit ADD COLUMN prev TEXT', 'ALTER TABLE audit ADD COLUMN hash TEXT', 'ALTER TABLE tasks ADD COLUMN tier TEXT', 'ALTER TABLE tasks ADD COLUMN route_cat TEXT', 'ALTER TABLE tasks ADD COLUMN playbooks TEXT', 'ALTER TABLE projects ADD COLUMN stage_since TEXT', 'ALTER TABLE agents ADD COLUMN on_leave INTEGER DEFAULT 0', 'ALTER TABLE agents ADD COLUMN leave_since TEXT']) { try { raw.exec(m); } catch {} } // миграции для старых баз
  const AK = auditKey(file, opts.auditKey);
  const cache = new Map();
  const st = (sql) => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
  const db = {
    raw,
    run: (sql, ...p) => st(sql).run(...p),
    get: (sql, ...p) => st(sql).get(...p),
    all: (sql, ...p) => st(sql).all(...p),
    tx(fn) { raw.exec('BEGIN IMMEDIATE'); try { const r = fn(); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
    setting(key, def = null) { const r = st('SELECT value FROM settings WHERE key=?').get(key); return r ? JSON.parse(r.value) : def; },
    setSetting(key, value) { st('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); },
    // Журнал — цепочка: каждая запись подписана HMAC вместе с подписью предыдущей. Изменение, удаление
    // или вставка задним числом ломает цепочку, и verifyAudit() показывает, где именно.
    audit(actor, event, data) {
      const row = { ts: new Date().toISOString().slice(0, 19).replace('T', ' '), actor: String(actor ?? ''), event: String(event ?? ''), data: JSON.stringify(data ?? null) };
      const prev = st('SELECT hash FROM audit WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1').get()?.hash || '';
      st('INSERT INTO audit(ts,actor,event,data,prev,hash) VALUES(?,?,?,?,?,?)').run(row.ts, row.actor, row.event, row.data, prev, auditHash(AK, prev, row));
    },
    verifyAudit() {
      let prev = '', n = 0, started = false;
      for (const r of raw.prepare('SELECT id,ts,actor,event,data,prev,hash FROM audit ORDER BY id').iterate()) {
        if (!r.hash) { if (started) return { ok: false, checked: n, broken_at: r.id, reason: 'запись без подписи внутри цепочки' }; continue; } // старые записи до включения подписи
        started = true;
        if ((r.prev || '') !== prev) return { ok: false, checked: n, broken_at: r.id, reason: 'разрыв цепочки: перед этой записью что-то удалено или вставлено' };
        if (auditHash(AK, prev, r) !== r.hash) return { ok: false, checked: n, broken_at: r.id, reason: 'запись изменена после создания' };
        prev = r.hash; n++;
      }
      // «якоря» — отпечатки, которые раз в день уходят директору в Telegram: так видно и удаление хвоста журнала
      for (const a of this.setting('audit_anchors', [])) {
        const r = st('SELECT hash FROM audit WHERE id=?').get(a.id);
        if (!r || r.hash !== a.hash) return { ok: false, checked: n, broken_at: a.id, reason: `запись с отпечатком от ${a.date} удалена или изменена` };
      }
      const last = st('SELECT id FROM audit WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1').get();
      return { ok: true, checked: n, head: prev ? prev.slice(0, 16) : null, last_id: last?.id ?? null };
    },
    feed(icon, text, agentId = null, level = 'info') { st('INSERT INTO feed(icon,agent_id,text,level) VALUES(?,?,?,?)').run(icon, agentId, String(text).slice(0, 2000), level); },
    close: () => raw.close(),
  };
  return db;
}

export const J = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
