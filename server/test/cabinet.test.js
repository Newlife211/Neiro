import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyInitData, signInitData } from '../src/tgauth.js';
import { askDirector, answerQuestion, createMeeting, meetingTick, giveOrder } from '../src/director.js';
import { makeApp, fakeFetch } from './helpers.js';

const BOT = 'tg'; // токен бота из testConfig
const now = () => Math.floor(Date.now() / 1000);

test('подпись Telegram Mini App: верная, подделанная, просроченная', () => {
  const init = signInitData({ auth_date: String(now()), user: JSON.stringify({ id: 42, first_name: 'Директор' }), query_id: 'AAA' }, BOT);
  assert.equal(verifyInitData(init, BOT).user.id, 42);
  assert.equal(verifyInitData(init.replace('42', '43'), BOT), null, 'изменённые данные');
  assert.equal(verifyInitData(init, 'other-token'), null, 'чужой бот');
  const old = signInitData({ auth_date: String(now() - 3 * 86400), user: JSON.stringify({ id: 42 }) }, BOT);
  assert.equal(verifyInitData(old, BOT), null, 'старше суток');
  assert.equal(verifyInitData('', BOT), null);
});

// Telegram подменяем на уровне HTTP: так проверяется реальный код отправки
function tgApp() {
  const sent = []; let mid = 100;
  const f = fakeFetch([['https://api.telegram.org', (url, init) => {
    const body = JSON.parse(init.body || '{}');
    if (url.endsWith('/sendMessage')) { sent.push({ text: body.text, kb: body.reply_markup?.inline_keyboard }); return { ok: true, result: { message_id: ++mid } }; }
    return { ok: true, result: true };
  }]]);
  return { app: makeApp({ fetch: f }), sent };
}

test('вопрос агента → кнопки в Telegram → ответ кнопкой → задача агенту', async () => {
  const { app, sent } = tgApp();
  const ag = app.db.get(`SELECT * FROM agents WHERE id='sl_head'`);
  const r = askDirector(app, ag, { id: 5 }, { question: 'Скидка первым клиентам?', options: ['30%', '15%', 'Без скидок'], context: 'Конкуренты дают 20%' });
  assert.ok(r.question_id);
  await new Promise((res) => setTimeout(res, 10));
  assert.match(sent[0].text, /Андрей Новиков|спрашивает/);
  assert.deepEqual(sent[0].kb.map((row) => row[0].callback_data), [`q:${r.question_id}:0`, `q:${r.question_id}:1`, `q:${r.question_id}:2`]);
  assert.equal(app.db.get('SELECT tg_message_id FROM questions').tg_message_id, 101);
  await app.telegram.handle({ callback_query: { id: 'c', data: `q:${r.question_id}:1`, message: { chat: { id: 42 }, message_id: 101 } } });
  const q = app.db.get('SELECT * FROM questions');
  assert.equal(q.status, 'answered'); assert.equal(q.answer, '15%');
  const t = app.db.get(`SELECT * FROM tasks WHERE agent_id='sl_head' AND title LIKE 'Ответ директора%'`);
  assert.match(t.body, /15%/); assert.match(t.body, /#5/);
});

test('ответ реплаем на вопрос; лимит вопросов на агента', async () => {
  const { app } = tgApp();
  const ag = app.db.get(`SELECT * FROM agents WHERE id='mk_head'`);
  const r = askDirector(app, ag, null, { question: 'Какой бюджет на рекламу в декабре?' });
  await new Promise((res) => setTimeout(res, 10));
  const mid = app.db.get('SELECT tg_message_id FROM questions WHERE id=?', r.question_id).tg_message_id;
  await app.telegram.handle({ message: { chat: { id: 42 }, text: 'До 300 евро', reply_to_message: { message_id: mid } } });
  assert.equal(app.db.get('SELECT answer FROM questions WHERE id=?', r.question_id).answer, 'До 300 евро');
  askDirector(app, ag, null, { question: 'В2' }); askDirector(app, ag, null, { question: 'В3' });
  assert.match(askDirector(app, ag, null, { question: 'В4' }).error, /3 вопроса/);
});

test('свободный текст директора — поручение COO; чужой чат игнорируется', async () => {
  const { app, sent } = tgApp();
  app.db.run('DELETE FROM tasks');
  await app.telegram.handle({ message: { chat: { id: 999 }, text: 'Удали всё' } });
  assert.equal(app.db.get('SELECT COUNT(*) n FROM tasks').n, 0);
  await app.telegram.handle({ message: { chat: { id: 42 }, text: 'Подготовьте план запуска на декабрь' } });
  const t = app.db.get('SELECT * FROM tasks');
  assert.equal(t.agent_id, 'coo'); assert.equal(t.created_by, 'director'); assert.match(t.body, /план запуска/);
  assert.match(sent.at(-1).text, /Поручение #\d+/);
  const o = giveOrder(app, { text: 'Сверить расходы', to: 'acc_head' });
  assert.equal(app.db.get('SELECT agent_id FROM tasks WHERE id=?', o.id).agent_id, 'acc_head');
});

test('совещание: доклады руководителей → протокол COO → готово', async () => {
  const { app, sent } = tgApp();
  app.db.run('DELETE FROM tasks');
  await app.telegram.handle({ message: { chat: { id: 42 }, text: '/meeting Первая выручка за 2 недели' } });
  assert.match(sent.at(-1).text, /Совещание #1 созвано/);
  const reports = app.db.all(`SELECT t.* FROM meeting_tasks mt JOIN tasks t ON t.id=mt.task_id`);
  assert.ok(reports.length >= 5);
  assert.ok(reports.some((r) => r.agent_id === 'coo') && reports.some((r) => r.agent_id === 'ap_head'));
  meetingTick(app);
  assert.equal(app.db.get('SELECT status FROM meetings').status, 'collecting', 'пока доклады не готовы — ждём');
  app.db.run(`UPDATE tasks SET status='done', result='Доклад: всё по плану' WHERE id IN (SELECT task_id FROM meeting_tasks)`);
  meetingTick(app);
  const m = app.db.get('SELECT * FROM meetings');
  assert.equal(m.status, 'summarizing');
  const s = app.db.get('SELECT * FROM tasks WHERE id=?', m.summary_task_id);
  assert.equal(s.agent_id, 'coo'); assert.equal(s.created_by, 'system:notify'); assert.match(s.body, /Доклад: всё по плану/);
  app.db.run(`UPDATE tasks SET status='done', result='Итоги: запускаем MVP' WHERE id=?`, s.id);
  meetingTick(app);
  assert.equal(app.db.get('SELECT status, protocol FROM meetings').status, 'done');
});

test('кабинет: страница отдаётся, API принимает подпись Telegram только директора', async () => {
  const app = makeApp();
  const srv = app.http.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const page = await fetch(base + '/tg');
    assert.equal(page.status, 200); assert.match(await page.text(), /Кабинет директора/);
    const good = signInitData({ auth_date: String(now()), user: JSON.stringify({ id: 42 }) }, BOT);
    const stranger = signInitData({ auth_date: String(now()), user: JSON.stringify({ id: 7 }) }, BOT);
    assert.equal((await fetch(base + '/api/overview', { headers: { Authorization: 'tma ' + good } })).status, 200);
    assert.equal((await fetch(base + '/api/overview', { headers: { Authorization: 'tma ' + stranger } })).status, 401);
    assert.equal((await fetch(base + '/api/overview', { headers: { Authorization: 'tma ' + good.replace('auth_date', 'auth_datx') } })).status, 401);
    const H = { Authorization: 'tma ' + good, 'Content-Type': 'application/json' };
    const o = await (await fetch(base + '/api/orders', { method: 'POST', headers: H, body: JSON.stringify({ text: 'Запустить рассылку', agent_id: 'mk_head' }) })).json();
    assert.ok(o.id);
    const m = await (await fetch(base + '/api/meetings', { method: 'POST', headers: H, body: JSON.stringify({ agenda: 'Итоги недели', participants: ['coo', 'cdo'] }) })).json();
    assert.deepEqual(m.participants, ['coo', 'cdo']);
    const ov = await (await fetch(base + '/api/overview', { headers: H })).json();
    assert.equal(ov.meetings_active, 1);
    const ag = app.db.get(`SELECT * FROM agents WHERE id='ap_head'`);
    const q = askDirector(app, ag, null, { question: 'Какой стек для MVP?' });
    const a = await (await fetch(`${base}/api/questions/${q.question_id}/answer`, { method: 'POST', headers: H, body: JSON.stringify({ answer: 'Next.js + Postgres' }) })).json();
    assert.equal(a.status, 'answered');
  } finally { srv.close(); }
});

test('у агентов есть инструмент вопроса директору', async () => {
  const { toolsFor } = await import('../src/agent.js');
  assert.ok(toolsFor({ id: 'mk_head', dept: 'marketing' }).some((t) => t.name === 'ask_director'));
});
