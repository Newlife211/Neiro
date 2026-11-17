import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, fakeFetch, testConfig } from './helpers.js';
import { rice } from '../src/support.js';

function setup() {
  const tg = []; let n = 500;
  const f = fakeFetch([['https://api.telegram.org', (url, init) => { if (url.endsWith('/sendMessage')) tg.push(JSON.parse(init.body)); return { ok: true, result: { message_id: ++n } }; }]]);
  const sent = [];
  const ok = (k) => async (a) => { sent.push({ kind: k, ...a }); return { result: { message_id: 'm' + a.id } }; };
  const cfg = testConfig({ publicUrl: 'https://neiro.example' }); cfg.limits.outboundDaily = 100; cfg.limits.daily = 1000;
  const app = makeApp({ fetch: f, cfg, executors: { send_email: ok('send_email'), reply_email: ok('reply_email'), deploy: ok('deploy'), spend: async () => ({ result: {} }) } });
  app.db.run('DELETE FROM tasks');
  const pid = Number(app.db.run(`INSERT INTO projects(name,stage,stage_since) VALUES('ИИ-резюме','launch',datetime('now','-31 days'))`).lastInsertRowid);
  const sup = { id: 'sup_head', name: 'Игорь', dept: 'support' }, prod = { id: 'ap_head', name: 'Ева', dept: 'ai_product' }, cdo = { id: 'cdo', name: 'Глеб', dept: 'admin' };
  return { app, tg, sent, pid, sup, prod, cdo, S: app.support };
}

test('обращение из почты поддержки: срок ответа по типу, ответ клиенту отмечает первый ответ, «ответ помог?»', async () => {
  const s = setup();
  const id = s.S.inboundEmail({ id: 'sup_head' }, { message_id: 'msg1', from: 'Анна <anna@example.com>', subject: 'Как выгрузить в PDF?', text: 'Подскажите' });
  const t = s.app.db.get('SELECT * FROM tickets WHERE id=?', id);
  assert.equal(t.customer, 'anna@example.com'); assert.equal(t.assignee, 'sup_head');
  assert.ok(s.app.db.get(`SELECT id FROM tasks WHERE title LIKE 'Обращение #%'`));
  s.S.ticketUpdate(s.sup, { ticket_id: id, kind: 'feature', topic: 'Экспорт PDF', project_id: s.pid });
  const t2 = s.app.db.get('SELECT * FROM tickets WHERE id=?', id);
  assert.equal(Math.round((Date.parse(t2.first_due.replace(' ', 'T') + 'Z') - Date.parse(t2.created_at.replace(' ', 'T') + 'Z')) / 3600000), 24);
  const r = await s.S.ticketReply(s.sup, { ticket_id: id, text: 'Кнопка «Экспорт» вверху справа.', solved: true });
  assert.equal(r.status, 'executed');
  assert.equal(s.sent[0].kind, 'reply_email'); assert.match(s.sent[0].payload.text, /Ответ помог\? Да: https:\/\/neiro\.example\/r\/t\d+\.[\w-]{12}\/1/);
  const t3 = s.app.db.get('SELECT * FROM tickets WHERE id=?', id);
  assert.ok(t3.first_response_at); assert.equal(t3.status, 'solved');
  const tok = s.sent[0].payload.text.match(/\/r\/(t[^/]+)\/1/)[1];
  assert.ok(s.S.rate(tok, true)); assert.equal(s.S.rate(tok.slice(0, -1) + 'x', true), false, 'подделанная ссылка не принимается');
  assert.equal(s.app.db.get('SELECT rating FROM tickets WHERE id=?', id).rating, 1);
  // повторяющаяся тема → статья в базу знаний
  for (let i = 0; i < 2; i++) { const x = s.S.createTicket({ channel: 'form', customer: `c${i}@x.io`, subject: 'pdf' }); s.S.ticketUpdate(s.sup, { ticket_id: x, topic: 'экспорт pdf' }); }
  assert.ok(s.app.db.get(`SELECT id FROM tasks WHERE title LIKE 'Повторяющийся вопрос%'`));
});

test('просрочка первого ответа: срочная задача руководителю поддержки, при 3+ — сигнал директору', () => {
  const s = setup();
  for (let i = 0; i < 3; i++) s.S.createTicket({ channel: 'form', customer: `c${i}@x.io`, subject: 'Не работает' });
  s.app.db.run(`UPDATE tickets SET first_due=datetime('now','-5 minutes')`);
  s.S.slaCheck();
  assert.equal(s.app.db.get(`SELECT COUNT(*) n FROM tasks WHERE title LIKE 'Просрочено обращение%' AND priority=1`).n, 3);
  assert.match(s.tg.at(-1).text, /Поддержка не успевает: 3/);
  s.S.slaCheck();
  assert.equal(s.app.db.get(`SELECT COUNT(*) n FROM tasks WHERE title LIKE 'Просрочено обращение%'`).n, 3, 'повторно не дёргает');
});

test('ошибки: P0 — сразу в Telegram и задача №1; исправлена — клиентам «исправили» и разбор аварии', () => {
  const s = setup();
  const tid = s.S.createTicket({ projectId: s.pid, channel: 'email', customer: 'a@x.io', subject: 'Оплата не проходит' });
  const b = s.S.bugReport(s.sup, { project_id: s.pid, title: 'Оплата падает с ошибкой 500', level: 'P0', affected: 12, ticket_id: tid });
  assert.match(s.tg.at(-1).text, /АВАРИЯ \(P0\)/);
  assert.equal(s.app.db.get(`SELECT priority FROM tasks WHERE title LIKE '🚨 P0%'`).priority, 1);
  assert.equal(s.S.bugReport(s.sup, { title: 'Оплата падает с ошибкой 500', level: 'P0' }).bug_id, b.bug_id, 'дубль увеличивает счётчик');
  s.S.bugUpdate(s.prod, { bug_id: b.bug_id, status: 'fixed' });
  assert.ok(s.app.db.get(`SELECT id FROM tasks WHERE title LIKE 'Ошибка #% исправлена%'`));
  assert.ok(s.app.db.get(`SELECT id FROM tasks WHERE title LIKE 'Разбор аварии%'`));
  assert.match(s.tg.at(-1).text, /Авария #\d+ устранена/);
});

test('бэклог по RICE, план недели, релиз после «да» директора закрывает задачи и ставит пост «что нового»', async () => {
  const s = setup();
  const a = s.S.backlogAdd(s.prod, { project_id: s.pid, title: 'Экспорт в PDF', reach: 200, impact: 2, confidence: 0.8, effort: 2, metric: 'удержание 30 дней' });
  const b = s.S.backlogAdd(s.prod, { project_id: s.pid, title: 'Тёмная тема', reach: 50, impact: 0.5, confidence: 0.5, effort: 1 });
  assert.equal(a.rice, rice({ reach: 200, impact: 2, confidence: 0.8, effort: 2 }));
  assert.equal(s.S.backlogAdd(s.sup, { project_id: s.pid, title: 'экспорт в pdf', ticket_id: null }).requests, 1, 'дубль = ещё одна просьба');
  assert.equal(s.S.backlogList({ project_id: s.pid })[0].id, a.backlog_id);
  const plan = s.S.releasePlan(s.prod, { project_id: s.pid, backlog_ids: [a.backlog_id] });
  assert.match(s.tg.at(-1).text, /План недели .*для сведения/s);
  const d = await s.app.actions.propose({ kind: 'deploy', agentId: 'ap_head', payload: { project: 'cv', ref: 'v1.2', release_id: plan.release_id } });
  assert.equal(d.status, 'pending', 'выкладка — только с «да» директора');
  await s.app.actions.decide(d.id, true);
  assert.equal(s.app.db.get('SELECT status FROM releases WHERE id=?', plan.release_id).status, 'released');
  assert.equal(s.app.db.get('SELECT status FROM backlog WHERE id=?', a.backlog_id).status, 'done');
  assert.equal(s.app.db.get('SELECT status FROM backlog WHERE id=?', b.backlog_id).status, 'new');
  assert.ok(s.app.db.get(`SELECT id FROM tasks WHERE title LIKE 'Что нового%' AND agent_id='mk_smm'`));
});

test('метрики проекта и недельная сводка; опрос через 7 дней; отмена подписки — тоже отзыв', async () => {
  const s = setup();
  const L = (amt, email, days, cat = 'revenue', dir = 'in') => s.app.db.run(`INSERT INTO ledger(direction,category,amount,currency,amount_base,source,ref,project_id,note,ts) VALUES(?,?,?,?,?,'stripe',?,?,?,datetime('now',?))`, dir, cat, amt, 'EUR', amt, 'r' + Math.random(), s.pid, email, `-${days} days`);
  L(9, 'a@x.io', 40); L(9, 'a@x.io', 8); L(9, 'b@x.io', 8); L(9, 'c@x.io', 2); L(30, 'Реклама', 5, 'ads', 'out');
  await s.S.onStripe({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer_email: 'a@x.io', metadata: { project_id: String(s.pid) }, cancellation_details: { feedback: 'too_expensive' } } } });
  const m = s.S.metrics(s.pid);
  assert.equal(m.mrr, 27); assert.equal(m.new_customers_week, 1); assert.equal(m.active_customers, 3);
  assert.equal(m.churn_pct, 100, '1 отмена из 1 клиента прошлого месяца'); assert.equal(m.cac, 15, '30 € рекламы / 2 новых за месяц');
  assert.equal(s.sent.at(-1).payload.subject, 'Жаль, что вы уходите');
  s.S.weeklySummary();
  assert.match(s.tg.at(-1).text, /Сводка проектов.*«ИИ-резюме»: выручка 30 дн\. 27/s);
  const n = await s.S.sendSurveys();
  assert.equal(n, 1, 'b@x.io заплатил 8 дней назад — опрос d7');
  const url = s.sent.at(-1).payload.text.match(/https:\/\/neiro\.example\/s\/(\S+)/)[1];
  assert.match(s.S.surveyPage(url), /порекомендуете/);
  assert.ok(s.S.surveyAnswer(url, { score: '3', answer: 'Дорого и медленно' }));
  assert.ok(s.app.db.get(`SELECT id FROM tickets WHERE channel='survey' AND kind='complaint'`));
  assert.equal(s.S.surveyAnswer(url, { score: '9' }), false, 'повторно не принимается');
  assert.equal(await s.S.sendSurveys(), 0, 'второй раз не отправляется');
});

test('судьба проекта на 30 днях: задача CDO, предложение с кнопками, решение «закрыть» — клиентов предупреждают за 30 дней', async () => {
  const s = setup();
  s.S.fateCheck();
  assert.ok(s.app.db.get(`SELECT id FROM tasks WHERE title LIKE 'Судьба «ИИ-резюме»: 30 дней%' AND agent_id='cdo'`));
  assert.ok(s.S.proposeFate(s.cdo, { project_id: s.pid, verdict: 'close', reasoning: 'За месяц 3 клиента, расходы выше выручки' }).ok);
  const msg = s.tg.at(-1);
  assert.match(msg.text, /Судьба проекта «ИИ-резюме»/);
  const cb = msg.reply_markup.inline_keyboard[1][1].callback_data;
  assert.match(cb, /^f:\d+:close$/);
  await s.app.telegram.handle({ callback_query: { id: 'c', data: cb, message: { chat: { id: 42 }, message_id: 1 } } });
  assert.ok(s.app.db.setting('closing_' + s.pid));
  assert.ok(s.app.db.get(`SELECT id FROM tasks WHERE title LIKE 'Закрытие «ИИ-резюме»%'`));
});

test('бюджет проекта по этапам: трата сверх бюджета этапа ждёт директора; форма «Написать нам» с ключом проекта', async () => {
  const s = setup();
  s.app.db.run(`UPDATE projects SET stage='build', stage_since=datetime('now') WHERE id=?`, s.pid);
  const a = await s.app.actions.propose({ kind: 'spend', amount: 40, payload: { vendor: 'Хостинг', project_id: s.pid }, agentId: 'ap_back' });
  assert.equal(a.status, 'executed');
  for (let i = 0; i < 2; i++) await s.app.actions.propose({ kind: 'spend', amount: 45, payload: { vendor: 'API ' + i, project_id: s.pid }, agentId: 'ap_back' });
  const c = await s.app.actions.propose({ kind: 'spend', amount: 30, payload: { vendor: 'Ещё', project_id: s.pid }, agentId: 'ap_back' });
  assert.equal(c.status, 'pending'); assert.match(c.policy_reason, /бюджет проекта на этапе «MVP»: 130 \+ 30 > 150/);
  const key = s.S.projectKey(s.pid);
  assert.equal(s.S.formSubmit('p999.aaaaaaaaaaaa', { email: 'x@y.io', message: 'hi there' }, '1').code, 404);
  assert.equal(s.S.formSubmit(key, { email: 'x@y.io', message: 'Не приходит письмо' }, '1').code, 200);
  assert.equal(s.app.db.get(`SELECT channel FROM tickets WHERE customer='x@y.io'`).channel, 'form');
});
