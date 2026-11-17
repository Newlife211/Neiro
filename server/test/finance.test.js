import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseEcb, parseCbr, updateRates } from '../src/fx.js';
import { clientAssertion, revolutClient } from '../src/revolut.js';
import { insertBankTx, mapRevolutTx, mapPayseraStatement, reconcile, resolveBankTx, importBanks } from '../src/bank.js';
import { buildExecutors } from '../src/executors.js';
import { toBase } from '../src/policy.js';
import { makeApp, fakeFetch, testConfig } from './helpers.js';

const ECB = `<gesmes:Envelope><Cube><Cube time='2026-11-17'><Cube currency='USD' rate='1.0850'/><Cube currency='GBP' rate='0.8412'/><Cube currency='PLN' rate='4.2810'/><Cube currency='CHF' rate='0.9400'/><Cube currency='SEK' rate='11.20'/><Cube currency='NOK' rate='11.70'/></Cube></Cube></gesmes:Envelope>`;
const CBR = `<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="17.11.2026" name="Foreign Currency Market"><Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>92,1000</Value></Valute><Valute ID="R01239"><NumCode>978</NumCode><CharCode>EUR</CharCode><Nominal>1</Nominal><Name>Евро</Name><Value>99,8765</Value></Valute></ValCurs>`;

test('курсы: разбор ЕЦБ и ЦБ РФ, обновление пересчёта', async () => {
  assert.equal(parseEcb(ECB).rates.USD, 1.085);
  assert.equal(parseEcb(ECB).date, '2026-11-17');
  assert.equal(parseCbr(CBR).rubPerEur, 99.8765);
  const f = fakeFetch([['https://www.ecb', () => ECB], ['https://www.cbr', () => CBR]]);
  // fakeFetch отдаёт JSON; для XML подменяем text()
  const xf = async (url) => ({ ok: true, status: 200, text: async () => (url.includes('ecb') ? ECB : CBR) });
  const app = makeApp({ fetch: xf });
  const saved = await updateRates(app);
  assert.equal(saved.rates.RUB, 99.8765);
  assert.equal(app.cfg.fx.USD, 1.085);
  assert.equal(toBase(app.cfg, 998.765, 'RUB'), 10);
  assert.ok(app.db.setting('fx_rates').sources.length === 2);
  void f;
});

test('курсы: при недоступности источников остаются прежние', async () => {
  const app = makeApp({ fetch: async () => { throw new Error('offline'); } });
  const before = app.cfg.fx.RUB;
  assert.equal(await updateRates(app), null);
  assert.equal(app.cfg.fx.RUB, before);
});

test('Revolut: JWT подписан RS256 и проверяется публичным ключом', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = clientAssertion({ clientId: 'cid', iss: 'office.example.com', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), nowSec: 1000 });
  const [h, b, s] = jwt.split('.');
  const payload = JSON.parse(Buffer.from(b, 'base64url'));
  assert.deepEqual(payload, { iss: 'office.example.com', sub: 'cid', aud: 'https://revolut.com', exp: 4600 });
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')));
});

function revolutFake() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rc = { enabled: true, base: 'https://sandbox-b2b.revolut.com/api/1.0', clientId: 'cid', iss: 'x.com', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), refreshToken: 'rt0', cardCurrency: 'EUR', contactIds: ['tm1'], cardDays: 14, terminateAfterUse: true };
  const state = { cards: [], terminated: [], tokenCalls: 0, txs: [] };
  const f = fakeFetch([
    [rc.base + '/auth/token', (u, init) => { state.tokenCalls++; assert.match(init.body, /grant_type=refresh_token/); assert.match(init.body, /client_assertion=ey/); return { access_token: 'oa_sand_x', expires_in: 2400, refresh_token: 'rt1' }; }],
    [rc.base + '/cards', (u, init) => {
      if (init.method === 'DELETE') { state.terminated.push(u.split('/').pop()); return {}; }
      const b = JSON.parse(init.body); state.cards.push(b); return { id: 'card_' + state.cards.length, last_digits: '4242', state: 'active' };
    }],
    [rc.base + '/accounts', () => [{ id: 'acc1', name: 'Main', balance: 1234.5, currency: 'EUR', state: 'active' }]],
    [rc.base + '/transactions', () => state.txs],
  ]);
  return { rc, state, f };
}

test('трата → виртуальная карта ровно на сумму → списание закрывает трату', async () => {
  const { rc, state, f } = revolutFake();
  const cfg = testConfig();
  const app = makeApp({ cfg, fetch: f });
  app.revolutCfg = rc; app.revolut = revolutClient(rc, app.db, f);
  app.executors.spend = buildExecutors(cfg, f, { revolut: () => app.revolut, revolutCfg: rc }).spend;
  const a = await app.actions.propose({ kind: 'spend', amount: 29, currency: 'EUR', agentId: 'ap_back', payload: { vendor: 'Vercel', purpose: 'хостинг MVP', category: 'hosting' } });
  assert.equal(a.status, 'manual');
  assert.equal(a.result.card_id, 'card_1'); assert.equal(a.result.last_digits, '4242');
  assert.deepEqual(state.cards[0].spending_limits.single, { amount: 29, currency: 'EUR' });
  assert.equal(state.cards[0].request_id, `neuro-action-${a.id}`);
  assert.deepEqual(state.cards[0].contact_ids, ['tm1']);
  assert.equal(app.db.setting('revolut_refresh'), 'rt1', 'новый refresh token сохранён');
  assert.equal(app.db.get('SELECT COUNT(*) n FROM ledger').n, 0, 'пока не списано — в учёте ничего');
  // в выписке появилось списание по карте (фактически 28.40 — меньше лимита)
  state.txs = [{ id: 'tx1', type: 'card_payment', state: 'completed', created_at: new Date().toISOString(), card: { id: 'card_1' }, merchant: { name: 'VERCEL INC' }, legs: [{ leg_id: 'l1', account_id: 'acc1', amount: -28.4, currency: 'EUR', description: 'Vercel' }] }];
  const added = await importBanks(app);
  assert.equal(added, 1);
  const r = await reconcile(app);
  assert.equal(r.cards, 1);
  assert.equal(app.actions.get(a.id).status, 'executed');
  const led = app.db.get(`SELECT * FROM ledger WHERE source='action'`);
  assert.equal(led.amount, 28.4); assert.equal(led.category, 'hosting');
  assert.deepEqual(state.terminated, ['card_1'], 'карта закрыта после использования');
  assert.equal(app.db.setting('bank_balances_revolut')[0].balance, 1234.5);
  // повторный импорт той же операции не дублирует
  assert.equal(await importBanks(app), 0);
  assert.equal(state.tokenCalls, 1, 'токен переиспользуется, пока не истёк');
});

test('трата в другой валюте: лимит карты пересчитан с запасом 3%', async () => {
  const { rc, state, f } = revolutFake();
  const cfg = testConfig();
  const app = makeApp({ cfg, fetch: f });
  const ex = buildExecutors(cfg, f, { revolut: () => revolutClient(rc, app.db, f), revolutCfg: rc });
  app.executors.spend = ex.spend;
  await app.actions.propose({ kind: 'spend', amount: 3000, currency: 'RUB', payload: { vendor: 'Хостинг РФ' } });
  assert.deepEqual(state.cards[0].spending_limits.single, { amount: 30.9, currency: 'EUR' });
});

test('сверка: выплата Stripe, внутренний перевод, совпадение с учётом, необъяснённое и решение директора', async () => {
  const app = makeApp();
  const { db, cfg } = app;
  const now = new Date().toISOString();
  db.run(`INSERT INTO ledger(ts,direction,category,amount,currency,amount_base,source,ref,note) VALUES(?,?,?,?,?,?,?,?,?)`, now, 'out', 'tools', 12, 'EUR', 12, 'manual', 'm1', 'Figma');
  insertBankTx(db, cfg, { provider: 'revolut', extId: 'a', ts: now, amount: 480.5, currency: 'EUR', description: 'STRIPE PAYMENTS UK LTD', counterparty: 'Stripe' });
  for (const t of mapRevolutTx({ id: 'ex1', type: 'exchange', state: 'completed', created_at: now, legs: [{ leg_id: '1', amount: -100, currency: 'EUR', account_id: 'e' }, { leg_id: '2', amount: 9900, currency: 'RUB', account_id: 'r' }] })) insertBankTx(db, cfg, t);
  insertBankTx(db, cfg, { provider: 'paysera', extId: 'p1', ts: now, amount: -12, currency: 'EUR', description: 'Figma subscription' });
  insertBankTx(db, cfg, { provider: 'paysera', extId: 'p2', ts: now, amount: -7.5, currency: 'EUR', description: 'Неизвестный платёж', counterparty: 'ACME' });
  const r = await reconcile(app);
  assert.deepEqual(r, { cards: 0, payouts: 1, ads: 0, internal: 2, linked: 1, unmatched: 1 });
  const u = db.get(`SELECT * FROM bank_tx WHERE status='unmatched'`);
  resolveBankTx(db, u.id, { as: 'expense', category: 'bank_fees' });
  const l = db.get(`SELECT * FROM ledger WHERE source='bank'`);
  assert.equal(l.amount, 7.5); assert.equal(l.category, 'bank_fees'); assert.equal(l.direction, 'out');
  assert.equal(db.get(`SELECT status FROM bank_tx WHERE id=?`, u.id).status, 'matched');
});

test('Paysera: разбор выписки разных форматов', () => {
  const a = mapPayseraStatement({ id: 77, amount: { amount: '15.00', currency: 'EUR' }, direction: 'out', date: 1763337600, details: 'Domain' }, 'EVP1');
  assert.equal(a.amount, -15); assert.equal(a.currency, 'EUR'); assert.equal(a.extId, '77'); assert.match(a.ts, /^2025|^2026/);
  const b = mapPayseraStatement({ id: 'x', amount: 20, currency: 'EUR', type: 'credit', created_at: '2026-11-17T10:00:00Z' }, 'EVP1');
  assert.equal(b.amount, 20);
});

test('пульт: вкладка сверки и ручное решение через API', async () => {
  const app = makeApp();
  insertBankTx(app.db, app.cfg, { provider: 'revolut', extId: 'z', ts: new Date().toISOString(), amount: -9, currency: 'EUR', description: 'X' });
  await reconcile(app);
  const s = app.http.listen(0); await new Promise((r) => s.once('listening', r));
  const H = { Authorization: 'Bearer test-director-token-0123456789', 'Content-Type': 'application/json' };
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const b = await (await fetch(base + '/api/bank', { headers: H })).json();
    assert.equal(b.unmatched.length, 1);
    const ov = await (await fetch(base + '/api/overview', { headers: H })).json();
    assert.equal(ov.bank_unmatched, 1);
    const r = await (await fetch(`${base}/api/bank/${b.unmatched[0].id}/resolve`, { method: 'POST', headers: H, body: JSON.stringify({ as: 'internal' }) })).json();
    assert.equal(r.status, 'internal');
  } finally { s.close(); }
});
