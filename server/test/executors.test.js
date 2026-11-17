import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, fakeFetch, testConfig } from './helpers.js';
import { buildExecutors } from '../src/executors.js';

test('письмо уходит только из ящика самого агента, через AgentMail API', async () => {
  const cfg = testConfig(); cfg.agentmail.apiKey = 'am_test';
  const f = fakeFetch([['https://api.agentmail.to/v0/inboxes/', () => ({ message_id: 'm1', thread_id: 't1' })]]);
  const app = makeApp({ cfg, fetch: f, executors: buildExecutors(cfg, f) });
  const a = await app.actions.propose({ kind: 'send_email', agentId: 'sl_head', payload: { to: ['client@example.com'], subject: 'Привет', text: 'Текст', from: 'ceo@bank.com' } });
  assert.equal(a.status, 'executed');
  const call = f.calls.find((c) => c.url.includes('/messages/send'));
  assert.match(call.url, /neurosfera-novikov%40agentmail\.to\/messages\/send$/);
  assert.equal(call.init.headers.Authorization, 'Bearer am_test');
  assert.deepEqual(JSON.parse(call.body).to, ['client@example.com']);
  // агент без ящика — ошибка, а не отправка с чужого адреса
  const b = await app.actions.propose({ kind: 'send_email', agentId: 'ap_llm', payload: { to: ['x@example.com'], subject: 's', text: 't' } });
  assert.equal(b.status, 'failed');
});

test('ссылка на оплату в рублях идёт через ЮKassa и сохраняется', async () => {
  const cfg = testConfig();
  const f = fakeFetch([['https://api.yookassa.ru/v3/payments', () => ({ id: 'yk_1', confirmation: { confirmation_url: 'https://yoomoney.ru/pay/1' } })]]);
  const app = makeApp({ cfg, fetch: f, executors: buildExecutors(cfg, f) });
  const a = await app.actions.propose({ kind: 'create_payment_link', amount: 990, currency: 'RUB', payload: { title: 'Доступ на месяц', project_id: 1 } });
  assert.equal(a.status, 'executed');
  assert.equal(a.result.url, 'https://yoomoney.ru/pay/1');
  const body = JSON.parse(f.calls[0].body);
  assert.equal(body.amount.value, '990.00'); assert.equal(body.capture, true);
  assert.ok(f.calls[0].init.headers['Idempotence-Key']);
  assert.equal(app.db.get(`SELECT provider FROM payment_links`).provider, 'yookassa');
});
