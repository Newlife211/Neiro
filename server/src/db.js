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
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')), actor TEXT, event TEXT, data TEXT);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  raw.exec(SCHEMA);
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
