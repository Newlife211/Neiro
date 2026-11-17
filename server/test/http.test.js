import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeApp } from './helpers.js';

async function serve(app) {
  const s = app.http.listen(0);
  await new Promise((r) => s.once('listening', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const T = 'test-director-token-0123456789';
  const api = (p, o = {}) => fetch(base + p, { ...o, headers: { Authorization: 'Bearer ' + (o.token ?? T), 'Content-Type': 'application/json', ...(o.headers || {}) } });
  return { s, base, api };
}

test('пульт: без токена — 401, с токеном — данные; решения через API', async () => {
  const app = makeApp({ executors: { spend: async () => ({ result: {} }) } });
  const { s, base, api } = await serve(app);
  try {
    assert.equal((await fetch(base + '/api/overview')).status, 401);
    assert.equal((await api('/api/overview', { token: 'x'.repeat(29) })).status, 401);
    const ov = await (await api('/api/overview')).json();
    assert.equal(ov.base, 'EUR');
    const a = await app.actions.propose({ kind: 'spend', amount: 300, payload: { vendor: 'Ads' } });
    const r = await (await api(`/api/actions/${a.id}/approve`, { method: 'POST', body: '{}' })).json();
    assert.equal(r.status, 'executed');
    const t = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Проверить конкурентов', dept: 'rnd' }) })).json();
    assert.ok(t.id);
    const c = await (await api('/api/control', { method: 'POST', body: JSON.stringify({ stopped: true }) })).json();
    assert.equal(c.stopped, true);
    assert.equal((await api('/api/agents/ap_llm', { method: 'PATCH', body: JSON.stringify({ enabled: false }) })).status, 200);
    assert.equal(app.db.get(`SELECT enabled FROM agents WHERE id='ap_llm'`).enabled, 0);
    assert.ok(app.db.get(`SELECT 1 FROM audit WHERE event='control'`));
  } finally { s.close(); }
});

test('вебхук Stripe: подпись проверяется, оплата попадает в учёт', async () => {
  const app = makeApp();
  const { s, base } = await serve(app);
  try {
    const body = JSON.stringify({ id: 'evt_9', type: 'checkout.session.completed', data: { object: { id: 'cs_9', mode: 'payment', payment_status: 'paid', amount_total: 4900, currency: 'eur' } } });
    const bad = await fetch(base + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': 't=1,v1=00' } });
    assert.equal(bad.status, 400);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
    const ok = await fetch(base + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=${sig}` } });
    assert.equal(ok.status, 200);
    assert.equal(app.db.get(`SELECT amount FROM ledger WHERE source='stripe'`).amount, 49);
  } finally { s.close(); }
});

test('Telegram: кнопки работают только из чата директора', async () => {
  const app = makeApp({ executors: { spend: async () => ({ result: {} }) } });
  const a = await app.actions.propose({ kind: 'spend', amount: 300, payload: { vendor: 'Ads' } });
  await app.telegram.handle({ callback_query: { id: 'q1', data: `a:${a.id}:y`, message: { chat: { id: 999 }, message_id: 1 } } });
  assert.equal(app.actions.get(a.id).status, 'pending', 'чужой чат проигнорирован');
  await app.telegram.handle({ callback_query: { id: 'q2', data: `a:${a.id}:y`, message: { chat: { id: 42 }, message_id: 1 } } });
  assert.equal(app.actions.get(a.id).status, 'executed');
  await app.telegram.handle({ message: { chat: { id: 42 }, text: '/stop' } });
  assert.equal(app.db.setting('stopped'), true);
});
