import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyStripeSignature, handleStripeEvent, handleYookassaNotification, stripeClient } from '../src/payments.js';
import { makeApp, fakeFetch, testConfig } from './helpers.js';

const sign = (body, secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('подпись Stripe: верная, поддельная, просроченная', () => {
  const body = '{"id":"evt_1"}';
  assert.equal(verifyStripeSignature(body, sign(body, 'whsec_test'), 'whsec_test'), true);
  assert.equal(verifyStripeSignature(body, sign(body, 'wrong'), 'whsec_test'), false);
  assert.equal(verifyStripeSignature(body + ' ', sign(body, 'whsec_test'), 'whsec_test'), false);
  assert.equal(verifyStripeSignature(body, sign(body, 'whsec_test', 1000), 'whsec_test'), false);
  assert.equal(verifyStripeSignature(body, undefined, 'whsec_test'), false);
});

test('оплата Stripe записывается один раз и привязывается к проекту', () => {
  const { db, cfg } = makeApp();
  db.run(`INSERT INTO projects(id,name) VALUES(7,'Резюме-ИИ')`);
  db.run(`INSERT INTO payment_links(provider,ext_id,project_id) VALUES('stripe','plink_1',7)`);
  const ev = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'payment', payment_status: 'paid', amount_total: 1900, currency: 'eur', payment_link: 'plink_1' } } };
  assert.match(handleStripeEvent(db, cfg, ev), /19 EUR/);
  assert.equal(handleStripeEvent(db, cfg, ev), null);
  const l = db.get('SELECT * FROM ledger');
  assert.equal(l.amount, 19); assert.equal(l.project_id, 7); assert.equal(l.direction, 'in');
  // подписка: первичная сессия не считается, считается invoice.paid
  assert.equal(handleStripeEvent(db, cfg, { type: 'checkout.session.completed', data: { object: { id: 'cs_2', mode: 'subscription', payment_status: 'paid', amount_total: 900, currency: 'eur' } } }), null);
  assert.match(handleStripeEvent(db, cfg, { type: 'invoice.paid', data: { object: { id: 'in_1', amount_paid: 900, currency: 'eur', subscription_details: { metadata: { project_id: '7' } } } } }), /подписки/);
  assert.equal(db.get(`SELECT SUM(amount_base) s FROM ledger WHERE direction='in'`).s, 28);
});

test('ЮKassa: оплата подтверждается через API, подделка игнорируется', async () => {
  const { db, cfg } = makeApp();
  const yk = { getPayment: async (id) => (id === 'real' ? { id, status: 'succeeded', paid: true, amount: { value: '990.00', currency: 'RUB' }, metadata: {} } : { id, status: 'pending', paid: false, amount: { value: '1', currency: 'RUB' } }) };
  assert.match(await handleYookassaNotification(db, cfg, { event: 'payment.succeeded', object: { id: 'real' } }, yk), /990 RUB/);
  assert.equal(await handleYookassaNotification(db, cfg, { event: 'payment.succeeded', object: { id: 'fake' } }, yk), null);
  assert.equal(await handleYookassaNotification(db, cfg, { event: 'payment.succeeded', object: { id: 'real' } }, yk), null);
  assert.equal(db.get('SELECT COUNT(*) n FROM ledger').n, 1);
  assert.equal(db.get('SELECT amount_base FROM ledger').amount_base, 9.9);
});

test('создание ссылки Stripe: цена и payment link с метаданными', async () => {
  const f = fakeFetch([
    ['https://api.stripe.com/v1/prices', () => ({ id: 'price_1' })],
    ['https://api.stripe.com/v1/payment_links', () => ({ id: 'plink_9', url: 'https://buy.stripe.com/x' })],
  ]);
  const out = await stripeClient(testConfig(), f).createPaymentLink({ title: 'Pro', amount: 19, currency: 'EUR', recurring: 'month', projectId: 3, idem: 'k' });
  assert.equal(out.url, 'https://buy.stripe.com/x');
  assert.match(decodeURIComponent(f.calls[0].body), /unit_amount=1900/);
  assert.match(decodeURIComponent(f.calls[0].body), /recurring\[interval\]=month/);
  assert.match(decodeURIComponent(f.calls[1].body), /subscription_data\[metadata\]\[project_id\]=3/);
  assert.equal(f.calls[0].init.headers['Idempotency-Key'], 'k-price');
});
