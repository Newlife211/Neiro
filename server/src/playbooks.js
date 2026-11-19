// Опыт компании — «плейбуки» (идея цикла обучения Ruflo: найти → применить → оценить → записать → сжать).
// После удачной задачи агент записывает рабочий приём (save_playbook). Перед новой задачей сервер ищет
// похожие приёмы: сходство ≥ 0.7 — следовать, 0.5–0.7 — адаптировать, ниже — не показывать.
// Приёмы, которые помогают, набирают доверие; которые подводят или не используются — теряют и уходят в архив.
// Поиск — взвешенное совпадение слов (без векторной базы: на сотнях записей перебор быстрее и проще).

export const USE_AT = 0.7, ADAPT_AT = 0.5;
const STOP = new Set('и в во на с со по за к ко от до из у о об для что как это все всё его её их мы вы ты он она они не ни но а или же ли бы то так уже еще ещё при про над под без через также чтобы если the a an of to in on for and or with by is are be this that it from as at'.split(' '));

// Грубая основа слова: 6 первых букв — для русского этого хватает, чтобы «клиентам» и «клиенты» совпали
export function tokens(s) {
  return [...new Set(String(s || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.slice(0, 6)))];
}

export function createPlaybooks(ctx) {
  const { db } = ctx;
  const DAY = 86400000;
  const ts = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') : 0);

  // Доверие: доля успехов с поправкой на малую выборку и «забывание» без использования (полураспад 60 дней)
  function confidence(p, now = Date.now()) {
    const base = (p.wins + 1) / (p.wins + p.losses + 2);
    const idle = (now - ts(p.last_used || p.created_at)) / DAY;
    return Math.round(base * Math.pow(0.5, Math.max(0, idle - 14) / 60) * 100) / 100;
  }

  function idf(all) {
    const df = new Map();
    for (const p of all) for (const t of p._tok) df.set(t, (df.get(t) || 0) + 1);
    return (t) => Math.log(1 + (all.length + 1) / ((df.get(t) || 0) + 0.5));
  }
  const keyText = (p) => `${p.title} ${p.situation || ''} ${(JSON.parse(p.tags || '[]') || []).join(' ')}`;

  // Сходство: какая доля «ключевых слов» приёма (по весу) встречается в задаче
  function search(text, { dept = null, limit = 3, all: inclAll = false } = {}) {
    const all = db.all(`SELECT * FROM playbooks WHERE status='active'`).map((p) => ({ ...p, _tok: tokens(keyText(p)) }));
    if (!all.length) return [];
    const w = idf(all), q = new Set(tokens(text));
    return all.map((p) => {
      const tot = p._tok.reduce((s, t) => s + w(t), 0) || 1;
      const hit = p._tok.reduce((s, t) => s + (q.has(t) ? w(t) : 0), 0);
      let sim = hit / tot;
      if (dept && p.dept && p.dept !== dept) sim *= 0.85;
      const conf = confidence(p);
      return { id: p.id, title: p.title, situation: p.situation, steps: JSON.parse(p.steps || '[]'), dept: p.dept, sim: Math.round(sim * 100) / 100, confidence: conf, uses: p.uses };
    }).filter((x) => inclAll || x.sim >= ADAPT_AT).sort((a, b) => b.sim * (0.5 + b.confidence) - a.sim * (0.5 + a.confidence)).slice(0, limit);
  }

  // Блок для системного промпта агента + список id, чтобы потом засчитать результат
  function forTask(task, agent) {
    const found = search(`${task.title} ${String(task.body || '').slice(0, 400)}`, { dept: agent.dept, limit: 2 }).filter((p) => p.confidence >= 0.35);
    if (!found.length) return { text: '', ids: [] };
    const text = '\nОПЫТ КОМПАНИИ (проверенные приёмы для похожих задач):\n' + found.map((p) => `• [${p.sim >= USE_AT ? 'СЛЕДУЙ' : 'АДАПТИРУЙ'}] «${p.title}» (сходство ${p.sim}, доверие ${p.confidence})${p.situation ? ' — когда: ' + p.situation : ''}\n${p.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`).join('\n')
      + '\nЕсли приём не подходит к этой задаче — не применяй его и коротко скажи почему в отчёте.';
    for (const p of found) db.run(`UPDATE playbooks SET uses=uses+1, last_used=datetime('now') WHERE id=?`, p.id);
    return { text, ids: found.map((p) => p.id) };
  }

  // Результат задачи → доверие к приёмам, которые ей подсказали
  function judge(ids, success) {
    for (const id of ids || []) db.run(`UPDATE playbooks SET ${success ? 'wins=wins+1' : 'losses=losses+1'}, updated_at=datetime('now') WHERE id=?`, id);
  }

  // Записать приём. Почти такой же уже есть в отделе — обновляем его (версия +1), а не плодим дубли.
  function save(agent, input, taskId = null) {
    const title = String(input.title || '').trim().slice(0, 160);
    const steps = (Array.isArray(input.steps) ? input.steps : String(input.steps || '').split('\n')).map((s) => String(s).replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean).slice(0, 12).map((s) => s.slice(0, 300));
    if (title.length < 5 || steps.length < 2) return { error: 'Нужны название (от 5 знаков) и минимум 2 шага' };
    const tags = (input.tags || []).map((t) => String(t).slice(0, 40)).slice(0, 8);
    const situation = String(input.situation || '').slice(0, 400);
    // дубль — приём того же отдела с почти тем же названием (совпадение слов ≥ 80%)
    const tt = new Set(tokens(title));
    const twin = db.all(`SELECT id, title FROM playbooks WHERE status='active' AND dept=?`, agent.dept).find((p) => {
      const pt = tokens(p.title); const inter = pt.filter((t) => tt.has(t)).length;
      return inter / Math.max(1, new Set([...pt, ...tt]).size) >= 0.8;
    });
    if (twin) {
      db.run(`UPDATE playbooks SET steps=?, situation=COALESCE(NULLIF(?,''),situation), version=version+1, updated_at=datetime('now') WHERE id=?`, JSON.stringify(steps), situation, twin.id);
      db.audit(agent.id, 'playbook.updated', { id: twin.id, title });
      return { ok: true, playbook_id: twin.id, note: 'Обновил(а) похожий приём вместо создания дубля' };
    }
    const r = db.run('INSERT INTO playbooks(dept,title,situation,steps,tags,created_by,source_task) VALUES(?,?,?,?,?,?,?)', agent.dept, title, situation, JSON.stringify(steps), JSON.stringify(tags), agent.id, taskId);
    db.feed('🧠', `${agent.name} записал(а) приём в опыт компании: «${title}»`, agent.id, 'good');
    db.audit(agent.id, 'playbook.created', { id: Number(r.lastInsertRowid), title });
    return { ok: true, playbook_id: Number(r.lastInsertRowid) };
  }

  // Раз в сутки: приёмы с низким доверием после 4+ применений и давно забытые — в архив
  function consolidate() {
    let archived = 0;
    for (const p of db.all(`SELECT * FROM playbooks WHERE status='active'`)) {
      const c = confidence(p);
      if ((p.wins + p.losses >= 4 && c < 0.3) || c < 0.15) { db.run(`UPDATE playbooks SET status='archived', updated_at=datetime('now') WHERE id=?`, p.id); archived++; }
    }
    if (archived) db.feed('🧠', `Опыт компании: в архив ушло приёмов — ${archived} (не помогали или давно не нужны)`);
    return { archived };
  }

  function list({ status = 'active' } = {}) {
    return db.all('SELECT * FROM playbooks WHERE (?=\'all\' OR status=?) ORDER BY id DESC LIMIT 300', status, status)
      .map((p) => ({ ...p, steps: JSON.parse(p.steps || '[]'), tags: JSON.parse(p.tags || '[]'), confidence: confidence(p), author: db.get('SELECT name FROM agents WHERE id=?', p.created_by)?.name || p.created_by, dept_name: db.get('SELECT name FROM departments WHERE key=?', p.dept)?.name || p.dept }));
  }
  function setStatus(id, status, by = 'director') {
    if (!['active', 'archived'].includes(status)) throw new Error('Статус: active или archived');
    db.run(`UPDATE playbooks SET status=?, updated_at=datetime('now') WHERE id=?`, status, id);
    db.audit(by, 'playbook.' + status, { id });
    return db.get('SELECT * FROM playbooks WHERE id=?', id);
  }

  return { search, forTask, judge, save, consolidate, list, setStatus, confidence };
}
