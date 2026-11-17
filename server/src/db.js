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
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')), actor TEXT, event TEXT, data TEXT);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  raw.exec(SCHEMA);
  try { raw.exec('ALTER TABLE projects ADD COLUMN stage_since TEXT'); } catch {} // миграция для старых баз
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
    audit(actor, event, data) { st('INSERT INTO audit(actor,event,data) VALUES(?,?,?)').run(actor, event, JSON.stringify(data ?? null)); },
    feed(icon, text, agentId = null, level = 'info') { st('INSERT INTO feed(icon,agent_id,text,level) VALUES(?,?,?,?)').run(icon, agentId, String(text).slice(0, 2000), level); },
    close: () => raw.close(),
  };
  return db;
}

export const J = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
