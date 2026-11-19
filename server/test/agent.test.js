import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, fakeFetch } from './helpers.js';
import { addTask } from '../src/worker.js';

// Сценарий ответов «Claude»: каждый вызов отдаёт следующий шаг.
function scriptedClaude(steps) {
  let i = 0; const seen = [];
  return ['https://api.anthropic.com/v1/messages', (url, init) => {
    const body = JSON.parse(init.body); seen.push(body);
    const s = steps[Math.min(i++, steps.length - 1)];
    const content = [];
    if (s.text) content.push({ type: 'text', text: s.text });
    (s.tools || []).forEach((t, k) => content.push({ type: 'tool_use', id: `tu_${i}_${k}`, name: t[0], input: t[1] }));
    return { content, stop_reason: s.tools?.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 } };
  }, seen];
}

test('агент выполняет задачу: документ, делегирование, траты по политике, этапы проекта', async () => {
  const [prefix, handler, seen] = scriptedClaude([
    { text: 'Начинаю.', tools: [['upsert_project', { name: 'ИИ-резюме', summary: 'Генератор резюме', roi: 180 }]] },
    { tools: [['upsert_project', { project_id: 1, stage: 'build' }], ['write_document', { title: 'PRD ИИ-резюме', kind: 'prd', content: 'Цели…' }]] },
    { tools: [['create_task', { title: 'Лендинг ИИ-резюме', body: 'Сделать лендинг', dept: 'marketing' }], ['propose_action', { kind: 'spend', amount: 20, currency: 'EUR', payload: { vendor: 'Домен', category: 'services' } }], ['propose_action', { kind: 'spend', amount: 400, currency: 'EUR', payload: { vendor: 'Реклама', category: 'ads' } }]] },
    { text: 'Итог: PRD готов, лендинг поставлен маркетингу, реклама ждёт директора.' },
  ]);
  const app = makeApp({ fetch: fakeFetch([[prefix, handler]]), executors: { spend: async () => ({ result: { ok: true } }) } });
  const { db, worker } = app;
  db.run(`DELETE FROM tasks`);
  const id = addTask(db, { title: 'Запусти ИИ-резюме', dept: 'ai_product', agentId: 'ap_head' });
  const t = worker.claim();
  assert.equal(t.id, id);
  await worker.process(t);
  const done = db.get('SELECT * FROM tasks WHERE id=?', id);
  assert.equal(done.status, 'done'); assert.match(done.result, /PRD готов/);
  assert.equal(db.get('SELECT stage FROM projects WHERE id=1').stage, 'decision', 'без решения директора проект не уходит в разработку');
  assert.equal(db.get(`SELECT COUNT(*) n FROM documents`).n, 1);
  assert.equal(db.get(`SELECT dept FROM tasks WHERE title='Лендинг ИИ-резюме'`).dept, 'marketing');
  const acts = db.all('SELECT amount, status FROM actions ORDER BY id');
  assert.deepEqual(acts.map((a) => a.status), ['executed', 'pending']);
  assert.equal(db.get('SELECT COUNT(*) n FROM runs').n, 4);
  assert.ok(db.get('SELECT SUM(cost_base) s FROM runs').s > 0);
  // поручение директора руководителю — на «старшей» модели, системный промпт содержит правила
  assert.equal(seen[0].model, app.cfg.anthropic.modelLead);
  assert.match(seen[0].system[0].text, /только через propose_action/);
});

test('решение директора по проекту открывает разработку', async () => {
  const app = makeApp();
  const { db } = app;
  db.run(`INSERT INTO projects(id,name,stage) VALUES(5,'Бот-юрист','decision')`);
  const { decideProject } = await import('../src/company.js');
  decideProject(app, 5, true);
  assert.equal(db.get('SELECT stage FROM projects WHERE id=5').stage, 'build');
  assert.ok(db.get(`SELECT 1 FROM tasks WHERE project_id=5 AND dept='ai_product'`));
});

test('бюджет Claude API исчерпан → задача на паузе, не падает', async () => {
  const [prefix, handler] = scriptedClaude([{ text: 'ok' }]);
  const app = makeApp({ fetch: fakeFetch([[prefix, handler]]) });
  const { db, worker } = app;
  db.run(`DELETE FROM tasks`);
  db.run(`INSERT INTO runs(cost_base) VALUES(999)`);
  addTask(db, { title: 'X', dept: 'admin' });
  const t = worker.claim(); await worker.process(t);
  assert.equal(db.get('SELECT status FROM tasks WHERE id=?', t.id).status, 'blocked');
});

test('сбой API → повтор, после 3 попыток — failed', async () => {
  const app = makeApp({ fetch: fakeFetch([['https://api.anthropic.com', () => ({ __status: 400, error: { message: 'bad' } })]]) });
  const { db, worker } = app;
  db.run(`DELETE FROM tasks`);
  const id = addTask(db, { title: 'Y', dept: 'admin' });
  for (let k = 0; k < 3; k++) { db.run(`UPDATE tasks SET due_at=NULL WHERE id=?`, id); const t = worker.claim(); await worker.process(t); }
  assert.equal(db.get('SELECT status FROM tasks WHERE id=?', id).status, 'failed');
});
