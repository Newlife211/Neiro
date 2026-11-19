import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, fakeFetch } from './helpers.js';
import { agentStats } from '../src/hr.js';

function setup() {
  const tg = [];
  const f = fakeFetch([['https://api.telegram.org', (url, init) => { if (url.endsWith('/sendMessage')) tg.push(JSON.parse(init.body)); return { ok: true, result: { message_id: 1 } }; }]]);
  const app = makeApp({ fetch: f });
  app.db.run('DELETE FROM tasks');
  return { app, tg, hr: { id: 'hr_head', name: 'Светлана', dept: 'hr' } };
}
const T = (db, agent, status, cost = 0.05, ago = 1) => {
  const id = Number(db.run(`INSERT INTO tasks(title,agent_id,dept,status,started_at,finished_at) VALUES('t',?,'marketing',?,datetime('now',?),datetime('now',?))`, agent, status, `-${ago} days`, `-${ago} days`).lastInsertRowid);
  db.run(`INSERT INTO runs(task_id,agent_id,model,cost_base,ts) VALUES(?,?,?,?,datetime('now',?))`, id, agent, 'm', cost, `-${ago} days`);
};

test('цифры по сотрудникам: сделано, сбои, стоимость задачи, доля успеха', () => {
  const s = setup();
  for (let i = 0; i < 4; i++) T(s.app.db, 'mk_copy', 'done', 0.1);
  T(s.app.db, 'mk_copy', 'failed', 0.2);
  T(s.app.db, 'mk_copy', 'done', 1, 20); // старше недели — не в счёт
  const st = agentStats(s.app.db, 7, { agent_id: 'mk_copy' })[0];
  assert.deepEqual([st.done, st.failed, st.cost, st.cost_per_task, st.success_pct], [4, 1, 0.6, 0.15, 80]);
});

test('отпуск: без задач — в отпуск; пришла задача — сотрудник вернулся сам', async () => {
  const s = setup();
  assert.ok(s.app.hr.sendOnLeave('mk_copy', 'director', 'нет текстов на этой неделе').ok);
  assert.equal(s.app.db.get(`SELECT enabled, on_leave FROM agents WHERE id='mk_copy'`).enabled, 0);
  assert.match(s.app.hr.sendOnLeave('coo', 'director', 'x').error, /Руководство/);
  // задача лично ему — возврат при выборе исполнителя
  const tid = Number(s.app.db.run(`INSERT INTO tasks(title,agent_id,dept) VALUES('Тексты для лендинга','mk_copy','marketing')`).lastInsertRowid);
  const a = s.app.runtime.pickAgent(s.app.db.get('SELECT * FROM tasks WHERE id=?', tid));
  assert.equal(a.id, 'mk_copy');
  const row = s.app.db.get(`SELECT enabled, on_leave FROM agents WHERE id='mk_copy'`);
  assert.deepEqual([row.enabled, row.on_leave], [1, 0]);
  assert.match(s.tg.at(-1).text, /вернулся\(лась\) из отпуска/);
});

test('оценка HR: наставление попадает в память; замена — только кнопкой директора, на сотрудника из резерва', async () => {
  const s = setup();
  assert.ok(s.app.hr.review(s.hr, { agent_id: 'mk_copy', score: 2, verdict: 'coach', reason: '3 из 5 текстов вернули на доработку', coaching: 'Сначала структура, потом текст; проверяй факты' }).ok);
  assert.match(s.app.db.get(`SELECT text FROM memory WHERE agent_id='mk_copy' ORDER BY id DESC`).text, /Наставление HR.*структура/);
  assert.match(s.app.hr.review(s.hr, { agent_id: 'hr_head', score: 5, verdict: 'ok', reason: 'я молодец' }).error, /Себя/);
  s.app.db.run(`UPDATE agents SET enabled=0 WHERE id='mk_smm'`);
  const r = s.app.hr.review(s.hr, { agent_id: 'mk_copy', score: 1, verdict: 'replace', reason: 'Две недели оценка 1–2 после наставления', replacement_id: 'mk_smm' });
  assert.equal(s.app.db.get(`SELECT enabled FROM agents WHERE id='mk_copy'`).enabled, 1, 'до решения директора ничего не меняется');
  const msg = s.tg.at(-1);
  assert.match(msg.text, /HR предлагает заменить/);
  await s.app.telegram.handle({ callback_query: { id: 'c', data: msg.reply_markup.inline_keyboard[0][0].callback_data, message: { chat: { id: 42 }, message_id: 1 } } });
  assert.equal(s.app.db.get(`SELECT enabled FROM agents WHERE id='mk_copy'`).enabled, 0);
  assert.equal(s.app.db.get(`SELECT enabled FROM agents WHERE id='mk_smm'`).enabled, 1);
  assert.equal(s.app.db.get('SELECT status FROM hr_reviews WHERE id=?', r.review_id).status, 'approved');
});

test('еженедельная оценка: задача HR с цифрами и списком сотрудников без задач; сбои за сутки — руководителю', () => {
  const s = setup();
  s.app.db.run(`UPDATE agents SET enabled=1 WHERE id='hr_head'`);
  T(s.app.db, 'mk_copy', 'done');
  s.app.hr.weekly();
  const t = s.app.db.get(`SELECT * FROM tasks WHERE title='Еженедельная оценка эффективности'`);
  assert.equal(t.agent_id, 'hr_head'); assert.match(t.body, /Без задач всю неделю: .*Вера/);
  for (let i = 0; i < 3; i++) T(s.app.db, 'mk_ads', 'failed', 0.01, 0);
  s.app.hr.daily();
  assert.ok(s.app.db.get(`SELECT id FROM tasks WHERE title LIKE 'Сбои у Егор%'`));
});
