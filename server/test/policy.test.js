import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, toBase } from '../src/policy.js';
import { makeApp, testConfig } from './helpers.js';

test('траты: в пределах лимита — сами, выше — директор', async () => {
  const { db, cfg, actions } = makeApp({ executors: {} });
  assert.equal(evaluate(db, cfg, { kind: 'spend', amount: 20, currency: 'EUR', payload: {} }).decision, 'auto');
  assert.equal(evaluate(db, cfg, { kind: 'spend', amount: 60, currency: 'EUR', payload: {} }).decision, 'approval');
  // накопление за день: 3 траты по 40 → третья превысит дневной лимит 100
  await actions.propose({ kind: 'spend', amount: 40, payload: { vendor: 'a' } });
  await actions.propose({ kind: 'spend', amount: 40, payload: { vendor: 'b' } });
  const third = evaluate(db, cfg, { kind: 'spend', amount: 40, payload: {} });
  assert.equal(third.decision, 'approval');
  assert.match(third.reason, /дневной лимит/);
});

test('подписки, необратимые действия и неизвестные типы', () => {
  const { db, cfg } = makeApp();
  assert.equal(evaluate(db, cfg, { kind: 'spend', amount: 5, payload: { recurring: true } }).decision, 'approval');
  for (const k of ['refund', 'deploy', 'change_price', 'real_trade', 'custom']) assert.equal(evaluate(db, cfg, { kind: k, payload: {} }).decision, 'approval');
  assert.equal(evaluate(db, cfg, { kind: 'hack_bank', payload: {} }).decision, 'deny');
  assert.equal(evaluate(db, cfg, { kind: 'spend', amount: 0, payload: {} }).decision, 'deny');
});

test('письма: массовая рассылка и дневной лимит — к директору', async () => {
  const { db, cfg, actions } = makeApp({ executors: { send_email: async () => ({ result: { ok: 1 } }) } });
  assert.equal(evaluate(db, cfg, { kind: 'send_email', payload: { to: ['a@x', 'b@x', 'c@x', 'd@x'] } }).decision, 'approval');
  for (let i = 0; i < 3; i++) assert.equal((await actions.propose({ kind: 'send_email', payload: { to: ['u' + i + '@x'], subject: 's', text: 't' } })).status, 'executed');
  assert.equal((await actions.propose({ kind: 'send_email', payload: { to: ['z@x'], subject: 's', text: 't' } })).status, 'pending');
});

test('режим СТОП переводит всё в ожидание', () => {
  const { db, cfg } = makeApp();
  db.setSetting('stopped', true);
  assert.equal(evaluate(db, cfg, { kind: 'spend', amount: 1, payload: {} }).decision, 'approval');
  assert.equal(evaluate(db, cfg, { kind: 'send_email', payload: { to: ['a@x'] } }).decision, 'approval');
});

test('пересчёт валют в базовую', () => {
  const cfg = testConfig();
  assert.equal(toBase(cfg, 5000, 'RUB'), 50);
  assert.equal(toBase(cfg, 10, 'EUR'), 10);
  assert.throws(() => toBase(cfg, 1, 'XYZ'));
});
