import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

test('авто-трата исполняется и попадает в учёт', async () => {
  let called = 0;
  const { db, actions } = makeApp({ executors: { spend: async () => { called++; return { result: { paid: true } }; } } });
  const a = await actions.propose({ kind: 'spend', amount: 30, currency: 'EUR', payload: { vendor: 'Figma', category: 'tools' }, agentId: 'mk_head' });
  assert.equal(a.status, 'executed');
  assert.equal(called, 1);
  const l = db.get(`SELECT * FROM ledger WHERE source='action'`);
  assert.equal(l.direction, 'out'); assert.equal(l.amount_base, 30); assert.equal(l.category, 'tools');
});

test('крупная трата ждёт директора; одобрение исполняет, отказ — нет', async () => {
  let called = 0;
  const { db, actions } = makeApp({ executors: { spend: async () => { called++; return { result: {} }; } } });
  const a = await actions.propose({ kind: 'spend', amount: 500, payload: { vendor: 'Google Ads' } });
  assert.equal(a.status, 'pending'); assert.equal(called, 0);
  const ok = await actions.decide(a.id, true);
  assert.equal(ok.status, 'executed'); assert.equal(called, 1);
  const b = await actions.propose({ kind: 'spend', amount: 700, payload: { vendor: 'X' } });
  const no = await actions.decide(b.id, false);
  assert.equal(no.status, 'rejected'); assert.equal(called, 1);
  assert.equal(db.get(`SELECT COUNT(*) n FROM ledger`).n, 1);
});

test('без интеграции — «вручную», директор отмечает выполнение', async () => {
  const { db, actions } = makeApp({ executors: {} });
  const a = await actions.propose({ kind: 'spend', amount: 10, payload: { vendor: 'Хостинг' } });
  assert.equal(a.status, 'manual');
  assert.equal(db.get('SELECT COUNT(*) n FROM ledger').n, 0);
  assert.equal(actions.markManualDone(a.id).status, 'executed');
  assert.equal(db.get('SELECT COUNT(*) n FROM ledger').n, 1);
});

test('повторное предложение того же действия не дублируется', async () => {
  const { db, actions } = makeApp({ executors: { spend: async () => ({ result: {} }) } });
  const p = { kind: 'spend', amount: 10, payload: { vendor: 'A' }, agentId: 'x', taskId: 1 };
  const a = await actions.propose(p), b = await actions.propose(p);
  assert.equal(a.id, b.id);
  assert.equal(db.get('SELECT COUNT(*) n FROM actions').n, 1);
});

test('ошибка исполнителя → failed, деньги не списаны', async () => {
  const { db, actions } = makeApp({ executors: { spend: async () => { throw new Error('карта отклонена'); } } });
  const a = await actions.propose({ kind: 'spend', amount: 10, payload: { vendor: 'A' } });
  assert.equal(a.status, 'failed'); assert.match(a.error, /карта/);
  assert.equal(db.get('SELECT COUNT(*) n FROM ledger').n, 0);
});
