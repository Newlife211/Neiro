// Очередь задач: воркеры берут задачи по приоритету, выполняют через агентов, обрабатывают ошибки.
export function inWorkHours(cfg, now = new Date()) {
  const { start, end, tz } = cfg.workHours;
  if (start === '00:00' && end === '24:00') return true;
  const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(now);
  return hm >= start && hm < end;
}

export function createWorker(ctx) {
  const { db, cfg, runtime } = ctx;
  let running = 0, timer = null, stopped = false;

  function claim() {
    return db.tx(() => {
      const t = db.get(`SELECT * FROM tasks WHERE status='queued' AND (due_at IS NULL OR due_at<=datetime('now')) ORDER BY priority ASC, id ASC LIMIT 1`);
      if (!t) return null;
      db.run(`UPDATE tasks SET status='running', started_at=datetime('now'), attempts=attempts+1 WHERE id=? AND status='queued'`, t.id);
      return { ...t, attempts: t.attempts + 1 };
    });
  }

  async function processTask(t) {
    try {
      const { agent, result } = await runtime.runTask(t);
      db.run(`UPDATE tasks SET status='done', result=?, finished_at=datetime('now') WHERE id=?`, result.slice(0, 20000), t.id);
      db.feed('✅', `${agent.name} выполнил(а) «${t.title}»`, agent.id, 'good');
      if (t.created_by === 'director' || t.created_by === 'system:notify') ctx.notify?.(t.created_by === 'director' ? `✅ ${agent.name} выполнил(а) ваше поручение «${t.title}»:\n\n${result.slice(0, 1500)}` : `🛰 ${t.title} — ${agent.name}\n\n${result.slice(0, 1800)}`);
    } catch (e) {
      const msg = String(e.message || e).slice(0, 1000);
      if (e.budget) {
        db.run(`UPDATE tasks SET status='blocked', error=? WHERE id=?`, msg, t.id);
        if (!db.setting('budget_alert_' + new Date().toISOString().slice(0, 10))) { db.setSetting('budget_alert_' + new Date().toISOString().slice(0, 10), true); ctx.notify?.('⏸ ' + msg + '. Агенты на паузе до завтра или до увеличения лимита.'); }
        db.feed('⏸', msg, null, 'warn');
      } else if (t.attempts < 3) { // попытки 1 и 2 — повтор, 3-я — окончательный сбой
        db.run(`UPDATE tasks SET status='queued', error=?, due_at=datetime('now','+' || ? || ' minutes') WHERE id=?`, msg, 2 * t.attempts, t.id);
        db.feed('🔁', `Задача «${t.title}» упала (${msg}) — повтор через ${2 * t.attempts} мин`, t.agent_id, 'warn');
      } else {
        db.run(`UPDATE tasks SET status='failed', error=?, finished_at=datetime('now') WHERE id=?`, msg, t.id);
        db.feed('❌', `Задача «${t.title}» не выполнена: ${msg}`, t.agent_id, 'bad');
      }
    } finally { running--; }
  }

  async function tick() {
    if (stopped || db.setting('paused', false) || !inWorkHours(cfg)) return;
    while (running < cfg.workers.concurrency) {
      const t = claim();
      if (!t) break;
      running++;
      processTask(t);
    }
  }

  return {
    start() {
      // задачи, прерванные перезапуском сервера, возвращаем в очередь
      db.run(`UPDATE tasks SET status='queued' WHERE status='running'`);
      timer = setInterval(tick, cfg.workers.pollMs); tick();
    },
    stop() { stopped = true; clearInterval(timer); },
    tick, claim, process: processTask,
    get running() { return running; },
  };
}

export function addTask(db, { title, body = '', dept = null, agentId = null, projectId = null, priority = 5, createdBy = 'director', dueAt = null }) {
  const r = db.run('INSERT INTO tasks(title,body,dept,agent_id,project_id,priority,created_by,due_at) VALUES(?,?,?,?,?,?,?,?)', title, body, dept, agentId, projectId, priority, createdBy, dueAt);
  return Number(r.lastInsertRowid);
}
