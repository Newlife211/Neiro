// Связь директора с компанией: вопросы агентов, поручения, совещания.
import { addTask } from './worker.js';
import { J } from './db.js';

export const QUESTIONS_PER_DAY = 15;

// ---------- вопросы агентов директору ----------
export function askDirector(ctx, agent, task, input) {
  const { db } = ctx;
  if (!input.question) return { error: 'Нужен текст вопроса' };
  const today = db.get(`SELECT COUNT(*) n FROM questions WHERE created_at>=datetime('now','start of day')`).n;
  const mine = db.get(`SELECT COUNT(*) n FROM questions WHERE agent_id=? AND created_at>=datetime('now','start of day')`, agent.id).n;
  if (mine >= 3) return { error: 'Ты уже задал директору 3 вопроса сегодня. Реши сам в рамках полномочий или спроси руководителя.' };
  const dup = db.get(`SELECT id FROM questions WHERE agent_id=? AND question=? AND status='open'`, agent.id, input.question);
  if (dup) return { ok: true, question_id: dup.id, note: 'Этот вопрос уже ждёт ответа' };
  const options = (input.options || []).map(String).filter(Boolean).slice(0, 4);
  const r = db.run(`INSERT INTO questions(agent_id,task_id,question,context,options,urgency) VALUES(?,?,?,?,?,?)`,
    agent.id, task?.id ?? null, String(input.question).slice(0, 1000), String(input.context || '').slice(0, 1500), JSON.stringify(options), input.urgency === 'high' ? 'high' : 'normal');
  const id = Number(r.lastInsertRowid);
  db.feed('❓', `${agent.name} спрашивает директора: «${String(input.question).slice(0, 140)}»`, agent.id, 'warn');
  if (today < QUESTIONS_PER_DAY || input.urgency === 'high') ctx.telegram?.sendQuestion?.(id);
  return { ok: true, question_id: id, note: 'Вопрос отправлен директору. Ответ придёт отдельной задачей — не жди его, продолжай другую работу.' };
}

export function answerQuestion(ctx, id, answer, by = 'director') {
  const { db } = ctx;
  const q = db.get('SELECT * FROM questions WHERE id=?', id);
  if (!q) throw Object.assign(new Error('Вопрос не найден'), { code: 404 });
  if (q.status !== 'open') return q;
  const text = String(answer || '').trim();
  if (!text) throw Object.assign(new Error('Пустой ответ'), { code: 400 });
  db.run(`UPDATE questions SET status='answered', answer=?, answered_at=datetime('now') WHERE id=?`, text.slice(0, 2000), id);
  const ag = db.get('SELECT * FROM agents WHERE id=?', q.agent_id);
  addTask(db, { title: `Ответ директора на твой вопрос #${id}`, agentId: q.agent_id, dept: ag?.dept, priority: q.urgency === 'high' ? 1 : 2, createdBy: 'director', projectId: null,
    body: `Ты спрашивал: «${q.question}»\nДиректор ответил: «${text}»\nПродолжи работу с учётом ответа${q.task_id ? ` (исходная задача #${q.task_id})` : ''} и коротко отчитайся.` });
  db.audit(by, 'question.answered', { id });
  db.feed('💬', `Директор ответил ${ag?.name || q.agent_id}: «${text.slice(0, 140)}»`, q.agent_id, 'good');
  return db.get('SELECT * FROM questions WHERE id=?', id);
}

// ---------- поручения ----------
export function giveOrder(ctx, { text, to = 'coo', dept = null, priority = 2, via = 'telegram' }) {
  const { db } = ctx;
  const body = String(text || '').trim();
  if (!body) throw Object.assign(new Error('Пустое поручение'), { code: 400 });
  let agentId = null, d = dept;
  if (to) {
    const a = db.get('SELECT id, dept, enabled FROM agents WHERE id=?', to);
    if (a?.enabled) { agentId = a.id; d = a.dept; }
  }
  if (!agentId && !d) { agentId = 'coo'; d = 'admin'; }
  const title = body.split('\n')[0].slice(0, 120);
  const id = addTask(db, { title, body: `Поручение директора: ${body}`, agentId, dept: d, priority, createdBy: 'director' });
  db.audit('director:' + via, 'order', { id, to: agentId || d });
  const who = agentId ? db.get('SELECT name FROM agents WHERE id=?', agentId).name : db.get('SELECT name FROM departments WHERE key=?', d)?.name || d;
  db.feed('📌', `Директор поручил ${who}: «${title}»`, agentId);
  return { id, to: who };
}

// ---------- совещания ----------
export function heads(db) {
  return db.all(`SELECT a.id, a.name, a.role, a.dept, d.name dept_name FROM agents a LEFT JOIN departments d ON d.key=a.dept WHERE a.enabled=1 AND (a.head=1 OR a.id IN ('cdo','coo')) ORDER BY a.id='coo' DESC, a.dept`);
}

export function createMeeting(ctx, { agenda, participants, via = 'telegram' }) {
  const { db } = ctx;
  const topic = String(agenda || '').trim();
  if (!topic) throw Object.assign(new Error('Нужна повестка'), { code: 400 });
  let list = (participants && participants.length ? participants : heads(db).map((h) => h.id))
    .filter((id) => db.get('SELECT 1 FROM agents WHERE id=? AND enabled=1', id));
  if (!list.length) throw Object.assign(new Error('Нет участников'), { code: 400 });
  list = [...new Set(list)].slice(0, 12);
  const r = db.run(`INSERT INTO meetings(agenda,participants,status) VALUES(?,?,'collecting')`, topic.slice(0, 1000), JSON.stringify(list));
  const id = Number(r.lastInsertRowid);
  for (const pid of list) {
    const a = db.get('SELECT dept FROM agents WHERE id=?', pid);
    const t = addTask(db, { title: `Доклад на совещание #${id}`, agentId: pid, dept: a.dept, priority: 1, createdBy: 'director',
      body: `Директор созвал совещание. Повестка: «${topic}».\nПодготовь доклад от своего отдела (до 1500 знаков): текущее положение по теме с цифрами, проблемы, что предлагаешь, что нужно от директора или других отделов. Не выдумывай данные — опирайся на company_status, документы и задачи. Итоговый ответ — это и есть доклад.` });
    db.run('INSERT INTO meeting_tasks(meeting_id,task_id,agent_id) VALUES(?,?,?)', id, t, pid);
  }
  db.audit('director:' + via, 'meeting.created', { id, agenda: topic, participants: list });
  db.feed('📣', `Директор созвал совещание: «${topic.slice(0, 120)}» — участников: ${list.length}`, null, 'warn');
  return { id, participants: list };
}

// Когда все доклады собраны — COO сводит протокол с решениями и поручениями.
export function meetingTick(ctx) {
  const { db } = ctx;
  for (const m of db.all(`SELECT * FROM meetings WHERE status='collecting'`)) {
    const rows = db.all(`SELECT t.status, t.result, t.error, a.name, a.role FROM meeting_tasks mt JOIN tasks t ON t.id=mt.task_id JOIN agents a ON a.id=mt.agent_id WHERE mt.meeting_id=?`, m.id);
    const pending = rows.filter((r) => ['queued', 'running', 'blocked'].includes(r.status));
    const ageH = (Date.now() - Date.parse(m.created_at + 'Z')) / 3600000;
    if (pending.length && ageH < 6) continue;
    const reports = rows.map((r) => `### ${r.name} — ${r.role}\n${r.status === 'done' ? r.result : '(доклад не получен: ' + (r.error || r.status) + ')'}`).join('\n\n');
    const t = addTask(db, { title: `Протокол совещания #${m.id}`, agentId: 'coo', dept: 'admin', priority: 1, createdBy: 'system:notify',
      body: `Сведи протокол совещания. Повестка: «${m.agenda}».\nДоклады участников:\n\n${reports.slice(0, 14000)}\n\nСделай: 1) краткие итоги по теме; 2) решения, которые можно принять в рамках полномочий, — оформи задачами отделам (create_task) с ответственными и сроками; 3) вопросы, требующие решения директора, — отдельным списком. Сохрани протокол через write_document (kind=protocol, title «Протокол совещания #${m.id}»). Итоговый ответ — выжимка для директора в Telegram (до 1500 знаков).` });
    db.run(`UPDATE meetings SET status='summarizing', summary_task_id=? WHERE id=?`, t, m.id);
  }
  for (const m of db.all(`SELECT m.*, t.status tstatus, t.result FROM meetings m JOIN tasks t ON t.id=m.summary_task_id WHERE m.status='summarizing'`)) {
    if (m.tstatus === 'done' || m.tstatus === 'failed') {
      const doc = db.get(`SELECT id FROM documents WHERE task_id=? AND kind='protocol' ORDER BY id DESC LIMIT 1`, m.summary_task_id);
      db.run(`UPDATE meetings SET status='done', protocol=?, protocol_doc_id=?, finished_at=datetime('now') WHERE id=?`, m.result || null, doc?.id ?? null, m.id);
      db.feed('📋', `Совещание #${m.id} завершено, протокол готов`, 'coo', 'good');
    }
  }
}

export function meetingsView(db) {
  return db.all('SELECT * FROM meetings ORDER BY id DESC LIMIT 30').map((m) => ({
    ...m, participants: J(m.participants, []),
    reports: db.all(`SELECT a.name, t.status FROM meeting_tasks mt JOIN tasks t ON t.id=mt.task_id JOIN agents a ON a.id=mt.agent_id WHERE mt.meeting_id=?`, m.id),
  }));
}
