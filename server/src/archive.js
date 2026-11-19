// Сохранность наработок: импорт архива симулятора в боевую базу и выгрузка архива компании.
// Числа симулятора (выручка, ROI, этапы) — модельные, поэтому проекты переносятся как идеи
// с пометкой; тексты документов, протоколы, поручения и решения переносятся как есть.
import fs from 'node:fs';
import path from 'node:path';

const SIM_STAGES = ['идея', 'анализ', 'ждёт решения', 'разработка', 'тестирование', 'запуск', 'доход'];
const str = (x, n) => String(typeof x === 'string' ? x : JSON.stringify(x ?? '')).slice(0, n);

export function importSimulator(db, payload, by = 'director') {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const S = data?.S;
  if (!S || !Array.isArray(S.projects)) throw Object.assign(new Error('Это не архив симулятора: нет S.projects'), { code: 400 });
  const stamp = data.savedAt || `day-${S.day}`;
  if (db.setting('sim_import_' + stamp)) return { ok: true, skipped: true, note: 'Этот архив уже импортирован' };
  const res = { projects: 0, documents: 0, skipped_projects: 0 };
  // В симуляторе одна идея запускается много раз («… 2.0»): переносим каждую идею один раз со сводкой
  const base = (n) => String(n).replace(/\s+\d+(\.\d+)*$/, '').trim();
  const groups = new Map();
  for (const p of S.projects) { if (!p?.name) continue; const k = base(p.name); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  const names = new Set(db.all('SELECT name FROM projects').map((p) => p.name.toLowerCase()));
  for (const [name, ps] of groups) {
    if (names.has(name.toLowerCase())) { res.skipped_projects += ps.length; continue; }
    const active = ps.filter((p) => p.status === 'active'), live = ps.filter((p) => p.stage === 6), best = Math.max(...ps.map((p) => Number(p.roi) || 0));
    db.run(`INSERT INTO projects(name,stage,owner,summary,roi,stage_since) VALUES(?,?,?,?,?,datetime('now'))`, name.slice(0, 200), active.length ? 'idea' : 'closed', ps[0].owner || null,
      `Перенесено из симулятора: запусков ${ps.length}, дошли до «дохода» ${live.length}, отклонено ${ps.filter((p) => p.status !== 'active').length}, лучший ROI ${best}%. Цифры симулятора модельные — перед работой проверить спрос по-настоящему (тест спроса).`, null);
    names.add(name.toLowerCase()); res.projects++;
  }
  const doc = (title, kind, content) => { db.run('INSERT INTO documents(title,kind,content,agent_id) VALUES(?,?,?,?)', String(title).slice(0, 200), kind, String(content).slice(0, 200000), 'sim_import'); res.documents++; };
  for (const d of S.plans || []) doc(`[симулятор] ${d.title || 'Документ'}`, 'plan', str(d.text || d.body || d.content || d, 200000));
  for (const m of S.meetings || []) doc(`[симулятор] Совещание: ${str(m.title || m.topic || 'без темы', 150)}`, 'protocol', str(m.protocol || m.summary || m, 50000));
  if ((S.directives || []).length) doc('[симулятор] Поручения директора', 'notes', S.directives.map((x) => '- ' + str(x, 1000)).join('\n'));
  if ((S.statements || []).length) doc('[симулятор] Выписки и отчёты', 'notes', S.statements.map((x) => str(x, 5000)).join('\n\n'));
  if (S.dev?.reports?.length) doc('[симулятор] Отчёты директора по развитию', 'report', S.dev.reports.map((x) => str(x, 8000)).join('\n\n---\n\n'));
  if ((S.closed || []).length) doc('[симулятор] Закрытые направления', 'notes', S.closed.map((x) => '- ' + str(x, 500)).join('\n'));
  db.setSetting('sim_import_' + stamp, new Date().toISOString());
  db.audit(by, 'archive.import_simulator', { stamp, ...res });
  db.feed('📦', `Перенесены наработки симулятора: ${res.projects} идей проектов, ${res.documents} документов`, null, 'good');
  return { ok: true, ...res };
}

// Автоимпорт при старте: файлы из каталога /data/import (или DATA_DIR/import) переносятся один раз
export function autoImport(db, dir, log) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try { const r = importSimulator(db, fs.readFileSync(path.join(dir, f), 'utf8'), 'system:autoimport'); log?.info?.('import', f, JSON.stringify(r)); }
      catch (e) { log?.error?.('import', f, e.message); }
    }
  } catch (e) { log?.error?.('import', e.message); }
}

// Архив компании для скачивания директором: всё, что сделали сотрудники, без ключей и служебных настроек
const EXPORT_TABLES = ['playbooks', 'model_stats', 'agents', 'projects', 'tasks', 'documents', 'memory', 'ledger', 'actions', 'payment_links', 'questions', 'meetings', 'radar_items', 'adoptions',
  'mk_tests', 'mk_campaigns', 'mk_metrics', 'tickets', 'bugs', 'backlog', 'releases', 'surveys', 'project_metrics', 'fate', 'kb_articles', 'hr_reviews'];
export function exportCompany(db) {
  const out = { exported_at: new Date().toISOString(), format: 'neurosfera-archive-1', tables: {} };
  for (const t of EXPORT_TABLES) {
    try { out.tables[t] = db.all(`SELECT * FROM ${t}`); } catch { /* таблицы может не быть в старой базе */ }
  }
  return out;
}
