// Эффективность сотрудников. Отвечает HR-директор (Светлана Никитина): еженедельная оценка каждого
// агента по цифрам и выборке работ, наставления, отпуск при отсутствии задач (с автоматическим
// возвратом, когда задачи появятся) и предложения о замене — замену решает директор.
// Важно: агент без задач ничего не стоит — Claude оплачивается за выполненные задачи. Поэтому
// главное — цена полезного результата, качество и рутинные задачи, которые не дают результата.
import { addTask } from './worker.js';
import { round2 } from './policy.js';

export const VERDICTS = { ok: 'всё хорошо', coach: 'наставление', leave: 'в отпуск', replace: 'заменить' };
const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export function agentStats(db, days = 7, filter = {}) {
  const since = `-${days} days`;
  const rows = db.all(`SELECT a.id, a.name, a.role, a.dept, a.head, a.enabled, COALESCE(a.on_leave,0) on_leave, a.leave_since,
      (SELECT COUNT(*) FROM tasks t WHERE t.agent_id=a.id AND t.status='done' AND t.finished_at>=datetime('now',?)) done,
      (SELECT COUNT(*) FROM tasks t WHERE t.agent_id=a.id AND t.status='failed' AND t.finished_at>=datetime('now',?)) failed,
      (SELECT COUNT(*) FROM tasks t WHERE t.agent_id=a.id AND t.status IN ('queued','running')) open,
      (SELECT AVG((julianday(t.finished_at)-julianday(t.started_at))*1440) FROM tasks t WHERE t.agent_id=a.id AND t.status='done' AND t.finished_at>=datetime('now',?)) avg_min,
      (SELECT COALESCE(SUM(r.cost_base),0) FROM runs r WHERE r.agent_id=a.id AND r.ts>=datetime('now',?)) cost,
      (SELECT COUNT(*) FROM actions x WHERE x.agent_id=a.id AND x.status='rejected' AND x.created_at>=datetime('now',?)) rejected,
      (SELECT COUNT(*) FROM actions x WHERE x.agent_id=a.id AND x.status='denied' AND x.created_at>=datetime('now',?)) denied,
      (SELECT COUNT(*) FROM questions q WHERE q.agent_id=a.id AND q.created_at>=datetime('now',?)) questions,
      (SELECT MAX(COALESCE(t.finished_at,t.started_at)) FROM tasks t WHERE t.agent_id=a.id) last_active,
      (SELECT ROUND(AVG(h.score),1) FROM hr_reviews h WHERE h.agent_id=a.id AND h.created_at>=datetime('now','-28 days')) hr_score
    FROM agents a WHERE (a.enabled=1 OR COALESCE(a.on_leave,0)=1) AND (? IS NULL OR a.dept=?) AND (? IS NULL OR a.id=?) ORDER BY a.dept, a.head DESC, a.name`,
  since, since, since, since, since, since, since, null2(filter.dept), null2(filter.dept), null2(filter.agent_id), null2(filter.agent_id));
  return rows.map((r) => ({ ...r, cost: round2(r.cost), avg_min: r.avg_min == null ? null : Math.round(r.avg_min), cost_per_task: r.done ? round2(r.cost / r.done) : null,
    success_pct: r.done + r.failed ? Math.round((r.done / (r.done + r.failed)) * 100) : null }));
}
function null2(v) { return v ?? null; }

export function deptStats(db, days = 7) {
  const by = {};
  for (const a of agentStats(db, days)) {
    const d = (by[a.dept] ||= { dept: a.dept, people: 0, on_leave: 0, done: 0, failed: 0, cost: 0, idle: 0 });
    d.people += a.on_leave ? 0 : 1; d.on_leave += a.on_leave ? 1 : 0; d.done += a.done; d.failed += a.failed; d.cost = round2(d.cost + a.cost);
    if (!a.on_leave && a.done === 0 && a.open === 0) d.idle++;
  }
  for (const d of Object.values(by)) {
    d.queue = db.get(`SELECT COUNT(*) n FROM tasks WHERE dept=? AND status='queued'`, d.dept).n;
    d.cost_per_task = d.done ? round2(d.cost / d.done) : null;
    d.name = db.get('SELECT name FROM departments WHERE key=?', d.dept)?.name || d.dept;
  }
  return Object.values(by);
}

// Возврат из отпуска: задача пришла лично ему или в отделе не осталось работающих сотрудников
export function recall(db, agentId, reason, notify) {
  const a = db.get('SELECT * FROM agents WHERE id=? AND COALESCE(on_leave,0)=1', agentId);
  if (!a) return false;
  db.run('UPDATE agents SET enabled=1, on_leave=0, leave_since=NULL WHERE id=?', a.id);
  db.feed('🔙', `${a.name} вернулся(лась) из отпуска: ${reason}`, a.id, 'good');
  db.audit('system', 'hr.recall', { agent: a.id, reason });
  notify?.(`🔙 ${a.name} (${a.role}) вернулся(лась) из отпуска: ${reason}`);
  return true;
}
export function recallForDept(db, dept, notify) {
  if (!dept || db.get('SELECT 1 FROM agents WHERE enabled=1 AND dept=?', dept)) return null;
  const a = db.get(`SELECT id FROM agents WHERE dept=? AND COALESCE(on_leave,0)=1 ORDER BY head DESC, leave_since ASC LIMIT 1`, dept);
  return a && recall(db, a.id, 'в отделе появились задачи', notify) ? a.id : null;
}

export function createHR(ctx) {
  const { db } = ctx;
  const send = (text, kb) => ctx.telegram?.send?.(text, kb);
  const hrOn = () => !!db.get(`SELECT 1 FROM agents WHERE id='hr_head' AND enabled=1`);

  function sendOnLeave(agentId, by, reason) {
    const a = db.get('SELECT * FROM agents WHERE id=?', agentId);
    if (!a || !a.enabled) return { error: 'Сотрудник не работает сейчас' };
    if (['coo', 'cdo', 'hr_head'].includes(a.id)) return { error: 'Руководство компании в отпуск так не отправляется' };
    if (db.get(`SELECT 1 FROM tasks WHERE agent_id=? AND status IN ('queued','running')`, a.id)) return { error: 'У сотрудника есть незавершённые задачи — сначала их закрыть или передать' };
    db.run(`UPDATE agents SET enabled=0, on_leave=1, leave_since=datetime('now') WHERE id=?`, a.id);
    db.feed('🏖', `${a.name} отправлен(а) в отпуск: ${reason}. Вернётся автоматически, когда появятся задачи.`, a.id);
    db.audit(by, 'hr.leave', { agent: a.id, reason });
    return { ok: true, note: 'В отпуске до появления задач — возврат автоматический' };
  }

  // Оценка HR: ok и наставление применяются сразу, отпуск — сразу (обратим и возвращается сам), замена — решает директор
  function review(reviewer, input) {
    const a = db.get('SELECT * FROM agents WHERE id=?', input.agent_id);
    if (!a) return { error: 'Нет такого сотрудника' };
    const score = Math.max(1, Math.min(5, Math.round(Number(input.score))));
    if (!VERDICTS[input.verdict] || !input.reason || isNaN(score)) return { error: 'Нужны score 1–5, verdict (ok|coach|leave|replace) и reason с фактами' };
    if (input.agent_id === reviewer.id) return { error: 'Себя не оцениваем' };
    const week = new Date().toISOString().slice(0, 10);
    const r = db.run(`INSERT INTO hr_reviews(agent_id,week,score,verdict,reason,coaching,reviewer,status) VALUES(?,?,?,?,?,?,?,?)`,
      a.id, week, score, input.verdict, String(input.reason).slice(0, 2000), input.coaching ? String(input.coaching).slice(0, 1000) : null, reviewer.id, input.verdict === 'replace' ? 'proposed' : 'applied');
    const id = Number(r.lastInsertRowid);
    if (input.coaching || input.verdict === 'coach') db.run('INSERT INTO memory(agent_id,text) VALUES(?,?)', a.id, `Наставление HR (${week}): ${String(input.coaching || input.reason).slice(0, 450)}`);
    let extra = {};
    if (input.verdict === 'leave') extra = sendOnLeave(a.id, reviewer.id, input.reason);
    if (input.verdict === 'replace') {
      const bench = db.all(`SELECT id,name,role FROM agents WHERE dept=? AND enabled=0 AND COALESCE(on_leave,0)=0 AND id!=?`, a.dept, a.id);
      send(`👥 HR предлагает заменить сотрудника\n${a.name} — ${a.role}\nОценка ${score}/5: ${String(input.reason).slice(0, 800)}\n${bench.length ? 'Кем: ' + (bench.find((b) => b.id === input.replacement_id)?.name || bench[0].name) + ' (из резерва отдела)' : 'Резерва в отделе нет — сотрудник будет выключен, работу возьмут коллеги'}`,
        [[{ text: '✅ Заменить', callback_data: `h:${id}:y` }, { text: '✖ Оставить', callback_data: `h:${id}:n` }]]);
      db.run('UPDATE hr_reviews SET replacement_id=? WHERE id=?', input.replacement_id || bench[0]?.id || null, id);
    }
    if (score <= 2) db.feed('⚠️', `HR: низкая оценка ${a.name} (${score}/5) — ${VERDICTS[input.verdict]}`, a.id, 'warn');
    return { ok: true, review_id: id, ...extra };
  }

  function decideReplace(id, approve, by = 'director') {
    const r = db.get('SELECT * FROM hr_reviews WHERE id=?', id);
    if (!r) throw Object.assign(new Error('Нет такой оценки'), { code: 404 });
    if (r.status !== 'proposed') return r;
    db.run(`UPDATE hr_reviews SET status=?, decided_at=datetime('now') WHERE id=?`, approve ? 'approved' : 'rejected', id);
    const a = db.get('SELECT * FROM agents WHERE id=?', r.agent_id);
    if (approve) {
      db.run(`UPDATE tasks SET agent_id=NULL WHERE agent_id=? AND status='queued'`, a.id);
      db.run('UPDATE agents SET enabled=0, on_leave=0 WHERE id=?', a.id);
      if (r.replacement_id) db.run('UPDATE agents SET enabled=1 WHERE id=?', r.replacement_id);
      const repl = r.replacement_id ? db.get('SELECT name FROM agents WHERE id=?', r.replacement_id)?.name : null;
      db.feed('👥', `Директор: ${a.name} заменён(а)${repl ? ' на ' + repl : ''}`, null, 'warn');
    } else db.feed('👥', `Директор оставил ${a.name} — HR продолжит наставничество`, null);
    db.audit(by, 'hr.replace', { review: id, approve });
    return db.get('SELECT * FROM hr_reviews WHERE id=?', id);
  }

  // Еженедельный цикл и ежедневные сигналы
  function weekly() {
    if (!hrOn()) return;
    const stats = agentStats(db, 7);
    const idle = stats.filter((s) => !s.on_leave && !s.head && s.done === 0 && s.open === 0);
    const weak = stats.filter((s) => s.failed >= 2 || (s.success_pct != null && s.success_pct < 70) || (s.hr_score != null && s.hr_score <= 2.5));
    const top = [...stats].filter((s) => s.done).sort((x, y) => (x.cost_per_task ?? 1e9) - (y.cost_per_task ?? 1e9)).slice(0, 3);
    addTask(db, { title: 'Еженедельная оценка эффективности', agentId: 'hr_head', dept: 'hr', priority: 3, createdBy: 'system',
      body: `Цифры за 7 дней по каждому сотруднику (сделано, сбои, среднее время, стоимость, стоимость задачи, отклонённые директором действия, вопросы директору, оценка HR за 4 недели):
${JSON.stringify(stats.map(({ id, name, dept, done, failed, open, avg_min, cost, cost_per_task, rejected, denied, questions, hr_score, on_leave }) => ({ id, name, dept, done, failed, open, avg_min, cost, cost_per_task, rejected, denied, questions, hr_score, on_leave })))}
Отделы: ${JSON.stringify(deptStats(db, 7))}
Без задач всю неделю: ${idle.map((s) => s.name).join(', ') || 'нет'}. Сигналы слабой работы: ${weak.map((s) => s.name).join(', ') || 'нет'}. Самые экономные: ${top.map((s) => `${s.name} (${s.cost_per_task})`).join(', ') || '—'}.
Что сделать:
1) По каждому со сбоями или низкими цифрами — hr_sample(agent_id): посмотри 3 последние работы и оцени качество по сути, а не по объёму.
2) hr_review для каждого, о ком есть что сказать: ok, coach (наставление попадёт сотруднику в память), leave (нет задач — в отпуск, вернётся сам), replace (две недели подряд оценка ≤ 2 после наставления — решает директор).
3) Отдельно: рутинные задачи (ежедневные отчёты, контент), которые не дают результата, — предложи COO их сократить.
4) Итог — отчёт write_document(kind=report) и 5 строк директору по развитию (create_task cdo).` });
  }

  function daily() {
    const bad = db.all(`SELECT agent_id, COUNT(*) n FROM tasks WHERE status='failed' AND finished_at>=datetime('now','-1 day') AND agent_id IS NOT NULL GROUP BY agent_id HAVING n>=3`);
    for (const b of bad) {
      const a = db.get('SELECT * FROM agents WHERE id=?', b.agent_id);
      const head = db.get('SELECT id FROM agents WHERE dept=? AND head=1 AND enabled=1 AND id!=?', a.dept, a.id);
      db.feed('⚠️', `${a.name}: ${b.n} сбоя задач за сутки`, a.id, 'warn');
      addTask(db, { title: `Сбои у ${a.name}: ${b.n} за сутки`, agentId: head?.id || (hrOn() ? 'hr_head' : null), dept: a.dept, priority: 3, createdBy: 'system',
        body: `У сотрудника ${a.name} (${a.role}) за сутки ${b.n} проваленных задач. Посмотри ошибки (read_tasks), пойми причину: неясные поручения, нет инструмента, ошибка в работе. Исправь причину или передай HR.` });
    }
  }

  async function tick(hour, once) {
    const wd = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: ctx.cfg.workHours.tz }).format(new Date());
    if (hour >= 18) once('hr_daily', daily);
    if (wd === 'Fri' && hour >= 15) once('hr_weekly', weekly);
  }

  function sample(agentId) {
    return db.all(`SELECT id,title,status,substr(result,1,1500) result,error,finished_at FROM tasks WHERE agent_id=? AND status IN ('done','failed') ORDER BY id DESC LIMIT 3`, agentId);
  }

  function overview() {
    return { agents: agentStats(db, 7), depts: deptStats(db, 7), proposals: db.all(`SELECT h.*, a.name, a.role FROM hr_reviews h JOIN agents a ON a.id=h.agent_id WHERE h.status='proposed' ORDER BY h.id DESC`),
      reviews: db.all(`SELECT h.*, a.name FROM hr_reviews h JOIN agents a ON a.id=h.agent_id ORDER BY h.id DESC LIMIT 30`), hr_enabled: hrOn() };
  }

  return { review, decideReplace, sendOnLeave, recall: (id, reason) => recall(db, id, reason, ctx.notify), weekly, daily, tick, sample, overview };
}
