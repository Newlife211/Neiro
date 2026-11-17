import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.js';
import { openDb } from '../src/db.js';
import { adsConfig } from '../src/ads.js';
import { reconcile } from '../src/bank.js';
import { testConfig, fakeFetch } from './helpers.js';

const G = { GOOGLE_ADS_DEVELOPER_TOKEN: 'd', GOOGLE_ADS_CLIENT_ID: 'c', GOOGLE_ADS_CLIENT_SECRET: 's', GOOGLE_ADS_REFRESH_TOKEN: 'r', GOOGLE_ADS_CUSTOMER_ID: '123-456-7890' };
const META = { META_ACCESS_TOKEN: 'meta-t', META_AD_ACCOUNT_ID: 'act_1', META_PAGE_ID: 'page1', META_CURRENCY: 'EUR', ...G };

function setup({ env = META, handlers = [], insights = [] } = {}) {
  const tg = [];
  let n = 100;
  const f = fakeFetch([
    ...handlers,
    ['https://api.telegram.org', (url, init) => { if (url.endsWith('/sendMessage')) tg.push(JSON.parse(init.body)); return { ok: true, result: { message_id: ++n } }; }],
    ['https://graph.facebook.com/v23.0/act_1/insights', () => ({ data: insights })],
    ['https://graph.facebook.com/v23.0/act_1/', () => ({ id: String(++n) })],
    ['https://graph.facebook.com/v23.0/', () => ({ success: true })],
  ]);
  const c = testConfig({ publicUrl: 'https://neiro.example' }); c.limits.outboundDaily = 40;
  const app = createApp(c, { db: openDb(':memory:'), fetch: f, adsCfg: adsConfig(env), backoffScale: 0 });
  app.db.run('DELETE FROM tasks');
  const mk = { id: 'mk_head', name: 'Мария', dept: 'marketing' }, ads = { id: 'mk_ads', name: 'Егор', dept: 'marketing' };
  return { app, f, tg, mk, ads };
}

const PLAN = { title: 'Тест: ИИ-резюме для IT в Германии', hypothesis: 'IT-соискатели платят 9 € за резюме под вакансию', segment: 'IT, Германия, английский', offer: 'Резюме под вакансию за 9 €, предзаказ −30%',
  channels: [{ channel: 'meta', budget: 120 }, { channel: 'outreach', budget: 0 }, { channel: 'google', budget: 80 }], budget: 200, days: 14, landing_url: 'https://cv.example.com', success: { max_cpl: 5, min_purchases: 3 } };

async function approved(s) {
  const r = s.app.marketing.proposeTest(s.mk, PLAN);
  s.app.marketing.decideTest(r.test_id, true, 'director:test');
  return r.test_id;
}

test('план теста: проверка полей, кнопки директору, одобрение кнопкой в Telegram ставит задачу маркетингу', async () => {
  const s = setup();
  assert.ok(s.app.marketing.proposeTest({ id: 'sl_head', dept: 'sales' }, PLAN).error, 'план предлагает только маркетинг');
  assert.match(s.app.marketing.proposeTest(s.mk, { ...PLAN, budget: 100 }).error, /больше общего/);
  assert.match(s.app.marketing.proposeTest(s.mk, { ...PLAN, success: {} }).error, /порог успеха/);
  const r = s.app.marketing.proposeTest(s.mk, PLAN);
  assert.equal(r.status, 'proposed');
  const msg = s.tg.at(-1);
  assert.match(msg.text, /План теста спроса/);
  assert.equal(msg.reply_markup.inline_keyboard[0][0].callback_data, `m:${r.test_id}:y`);
  await s.app.telegram.handle({ callback_query: { id: 'c1', data: `m:${r.test_id}:y`, message: { chat: { id: 42 }, message_id: 5 } } });
  const t = s.app.db.get('SELECT * FROM mk_tests WHERE id=?', r.test_id);
  assert.equal(t.status, 'approved');
  assert.ok(t.ends_at > t.started_at);
  const task = s.app.db.get(`SELECT * FROM tasks WHERE agent_id='mk_head'`);
  assert.match(task.body, /t\.js" data-test="k[0-9a-f]{10}"/);
});

test('кампании: до одобрения нельзя; Meta создаётся выключенной; включение не выходит за бюджет канала; СТОП ставит на паузу', async () => {
  const s = setup();
  const r = s.app.marketing.proposeTest(s.mk, PLAN);
  assert.match((await s.app.marketing.campaign(s.ads, { op: 'create', test_id: r.test_id, channel: 'meta', daily_budget: 5 })).error, /после одобрения/);
  s.app.marketing.decideTest(r.test_id, true);
  assert.match((await s.app.marketing.campaign(s.ads, { op: 'create', test_id: r.test_id, channel: 'tiktok', daily_budget: 5 })).error, /нет в плане/);
  const c = await s.app.marketing.campaign(s.ads, { op: 'create', test_id: r.test_id, channel: 'meta', name: 'Резюме DE', daily_budget: 8, countries: ['DE'], creatives: [{ headline: 'Резюме за 9 €', text: 'Под вакансию за 2 минуты' }] });
  assert.equal(c.status, 'paused');
  const calls = s.f.calls.filter((x) => x.url.includes('graph.facebook.com'));
  const camp = new URLSearchParams(calls[0].body);
  assert.equal(camp.get('status'), 'PAUSED');
  const adset = new URLSearchParams(calls[1].body);
  assert.equal(adset.get('daily_budget'), '800', 'бюджет в центах');
  assert.match(JSON.parse(new URLSearchParams(calls[2].body).get('object_story_spec')).link_data.link, /utm_source=meta&utm_medium=cpc/);
  // 8 €/день × 14 дней = 112 ≤ 120 — можно
  assert.equal((await s.app.marketing.campaign(s.ads, { op: 'activate', campaign_id: c.campaign_id })).status, 'active');
  assert.equal(s.app.db.get('SELECT status FROM mk_tests WHERE id=?', r.test_id).status, 'running');
  // вторая кампания в том же канале превысит 120 €
  const c2 = await s.app.marketing.campaign(s.ads, { op: 'create', test_id: r.test_id, channel: 'meta', name: 'B', daily_budget: 3, creatives: [{ headline: 'x', text: 'y' }] });
  assert.match((await s.app.marketing.campaign(s.ads, { op: 'activate', campaign_id: c2.campaign_id })).error, /бюджет канала meta/);
  // СТОП директора
  await s.app.http.handler(...fakeReq('POST', '/api/control', { stopped: true }));
  assert.equal(s.app.db.get('SELECT status FROM mk_campaigns WHERE id=?', c.campaign_id).status, 'paused');
  assert.match((await s.app.marketing.campaign(s.ads, { op: 'activate', campaign_id: c.campaign_id })).error, /СТОП/);
  // бесплатный канал — не рекламный кабинет; платная площадка без API в план не попадает
  assert.match((await s.app.marketing.campaign(s.ads, { op: 'create', test_id: r.test_id, channel: 'outreach', daily_budget: 0.01 })).error, /post_social/);
  assert.match(s.app.marketing.proposeTest(s.mk, { ...PLAN, title: 'TikTok', channels: [{ channel: 'tiktok', budget: 50 }], budget: 50 }).error, /нет подключённого API/);
});

test('метки и счётчик: короткая ссылка, визиты без дублей, заявка, чужой ключ, оплата Stripe с привязкой к каналу', async () => {
  const s = setup();
  const id = await approved(s);
  const l = s.app.marketing.link(s.mk, { test_id: id, channel: 'outreach', campaign: 'hr-leads' });
  const code = l.short_url.split('/go/')[1];
  const loc = s.app.marketing.go(code);
  assert.match(loc, /^https:\/\/cv\.example\.com\/\?utm_source=outreach&utm_medium=email&utm_campaign=hr-leads/);
  const key = s.app.db.get('SELECT key FROM mk_tests WHERE id=?', id).key;
  assert.equal(s.app.marketing.track({ k: key, e: 'visit', v: 'abc', s: 'outreach' }, '1.1.1.1').code, 204);
  s.app.marketing.track({ k: key, e: 'visit', v: 'abc', s: 'outreach' }, '1.1.1.1');
  s.app.marketing.track({ k: key, e: 'lead', v: 'abc', s: 'outreach' }, '1.1.1.1');
  assert.equal(s.app.marketing.track({ k: 'k0000000000', e: 'visit', v: 'x' }, '1.1.1.1').code, 404);
  assert.equal(s.app.marketing.track({ k: key, e: 'purchase', v: 'x' }, '1.1.1.1').code, 400, 'покупку засчитывает только Stripe');
  assert.ok(s.app.marketing.attributeStripe({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 900, currency: 'eur', client_reference_id: `n_${key}_abc` } } }));
  const row = s.app.marketing.stats(id).rows.find((r) => r.channel === 'outreach');
  assert.deepEqual([row.clicks, row.visits, row.leads, row.purchases, row.revenue], [1, 1, 1, 1, 9]);
  for (let i = 0; i < 70; i++) s.app.marketing.track({ k: key, e: 'visit', v: 'v' + i }, '9.9.9.9');
  assert.equal(s.app.marketing.track({ k: key, e: 'visit', v: 'zz' }, '9.9.9.9').code, 429);
  // HTTP: CORS и сниппет
  const res = await call(s.app, 'POST', '/t', JSON.stringify({ k: key, e: 'visit', v: 'h1' }));
  assert.equal(res.status, 204); assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  const js = await call(s.app, 'GET', '/t.js');
  assert.match(js.body, /client_reference_id/);
});

test('сбор цифр Meta → воронка и учёт расходов; правило CTR ставит кампанию на паузу; исчерпанный бюджет завершает тест и ставит задачу на отчёт', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const s = setup();
  const id = await approved(s);
  const c = await s.app.marketing.campaign(s.ads, { op: 'create', test_id: id, channel: 'meta', name: 'A', daily_budget: 8, creatives: [{ headline: 'h', text: 't' }] });
  await s.app.marketing.campaign(s.ads, { op: 'activate', campaign_id: c.campaign_id });
  const ext = s.app.db.get('SELECT ext_id FROM mk_campaigns WHERE id=?', c.campaign_id).ext_id;
  s.app.marketing.platforms.meta.insights = async () => [{ extId: ext, day, impressions: 2000, clicks: 6, spend: 20, currency: 'EUR' }];
  await s.app.marketing.sync();
  const cm = s.app.db.get('SELECT status, stop_reason FROM mk_campaigns WHERE id=?', c.campaign_id);
  assert.equal(cm.status, 'paused'); assert.match(cm.stop_reason, /CTR 0.3%/);
  assert.equal(s.app.db.get(`SELECT amount_base FROM ledger WHERE category='ads'`).amount_base, 20);
  s.app.marketing.platforms.meta.insights = async () => [{ extId: ext, day, impressions: 2000, clicks: 6, spend: 25, currency: 'EUR' }];
  await s.app.marketing.sync();
  assert.equal(s.app.db.get(`SELECT COUNT(*) n, SUM(amount_base) s FROM ledger WHERE category='ads'`).s, 25, 'сумма дня обновляется, без дублей');
  // ручные цифры переписки и исчерпание бюджета
  s.app.marketing.logMetrics(s.mk, { test_id: id, channel: 'outreach', impressions: 40, clicks: 8, leads: 3, spend: 180 });
  await s.app.marketing.sync();
  const t = s.app.db.get('SELECT status, finish_reason FROM mk_tests WHERE id=?', id);
  assert.equal(t.status, 'reporting'); assert.match(t.finish_reason, /Бюджет теста исчерпан/);
  assert.ok(s.app.db.get(`SELECT id FROM tasks WHERE title LIKE 'Отчёт по тесту спроса%'`));
});

test('отчёт: карточка директору с решениями; «ещё тест» ставит задачу; сверка не считает счёт Meta необъяснённым', async () => {
  const s = setup();
  const id = await approved(s);
  s.app.marketing.logMetrics(s.mk, { test_id: id, channel: 'outreach', impressions: 40, clicks: 8, leads: 4 });
  assert.match(s.app.marketing.report(s.mk, { test_id: id, summary: 'x', verdict: 'go' }).error, /после завершения/);
  await s.app.marketing.stopTest(id, 'director:test');
  const r = s.app.marketing.report(s.mk, { test_id: id, summary: 'Люди отвечают, но покупать не спешат', learnings: 'Оффер работает для джунов', verdict: 'iterate' });
  assert.equal(r.status, 'done');
  const msg = s.tg.at(-1);
  assert.match(msg.text, /Тест спроса #\d+/); assert.match(msg.text, /❌ Покупок\/предзаказов ≥ 3/);
  assert.equal(msg.reply_markup.inline_keyboard[0][1].callback_data, `v:${id}:iterate`);
  await s.app.telegram.handle({ callback_query: { id: 'c2', data: `v:${id}:iterate`, message: { chat: { id: 42 }, message_id: 6 } } });
  assert.equal(s.app.db.get('SELECT decision FROM mk_tests WHERE id=?', id).decision, 'iterate');
  assert.ok(s.app.db.get(`SELECT id FROM tasks WHERE title LIKE 'Следующий тест%'`));
  s.app.db.run(`INSERT INTO bank_tx(provider,ext_id,ts,amount,currency,amount_base,description,counterparty,status) VALUES('revolut','x1',datetime('now'),-50,'EUR',-50,'FACEBK *ADS','Meta Platforms','new')`);
  const rec = await reconcile(s.app);
  assert.equal(rec.ads, 1); assert.equal(rec.unmatched, 0);
});

test('Google Ads: кампания с бюджетом в микроединицах и статусом PAUSED, разбор статистики', async () => {
  const s = setup({ handlers: [
    ['https://oauth2.googleapis.com/token', () => ({ access_token: 'at', expires_in: 3600 })],
    ['https://googleads.googleapis.com/v21/customers/1234567890/googleAds:mutate', () => ({ mutateOperationResponses: [{ campaignBudgetResult: { resourceName: 'customers/1234567890/campaignBudgets/9' } }, { campaignResult: { resourceName: 'customers/1234567890/campaigns/77' } }] })],
    ['https://googleads.googleapis.com/v21/customers/1234567890/googleAds:search', () => ({ results: [{ campaign: { id: '77' }, segments: { date: '2026-11-18' }, metrics: { impressions: '500', clicks: '40', costMicros: '12500000' } }] })],
  ] });
  const id = await approved(s);
  const c = await s.app.marketing.campaign(s.ads, { op: 'create', test_id: id, channel: 'google', name: 'Поиск', daily_budget: 5, keywords: ['cv builder'], headlines: ['A', 'B', 'C'], descriptions: ['D1', 'D2'], geo_target_ids: [2276] });
  assert.equal(c.status, 'paused');
  const body = JSON.parse(s.f.calls.find((x) => x.url.endsWith('googleAds:mutate')).body);
  assert.equal(body.mutateOperations[0].campaignBudgetOperation.create.amountMicros, '5000000');
  assert.equal(body.mutateOperations[1].campaignOperation.create.status, 'PAUSED');
  const rows = await s.app.marketing.platforms.google.insights(['77'], '2026-11-01', '2026-11-18');
  assert.deepEqual(rows[0], { extId: '77', day: '2026-11-18', impressions: 500, clicks: 40, spend: 12.5, currency: null });
});

test('соцсети: свои страницы агенты ведут сами, сообщества — по правам директора, не чаще раза в неделю в одно место', async () => {
  const s = setup({ env: { IG_USER_ID: 'ig1', IG_ACCESS_TOKEN: 'igt', REDDIT_CLIENT_ID: 'rc', REDDIT_CLIENT_SECRET: 'rs', REDDIT_USERNAME: 'neiro', REDDIT_PASSWORD: 'pw', X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'ts' }, handlers: [
    ['https://graph.facebook.com/v23.0/ig1/media_publish', () => ({ id: 'post9' })],
    ['https://graph.facebook.com/v23.0/ig1/media', () => ({ id: 'cont1' })],
    ['https://www.reddit.com/api/v1/access_token', () => ({ access_token: 'rt', expires_in: 3600 })],
    ['https://oauth.reddit.com/api/submit', () => ({ json: { errors: [], data: { name: 't3_x', url: 'https://reddit.com/r/SaaS/x' } } })],
    ['https://api.x.com/2/tweets', () => ({ data: { id: '777' } })],
  ] });
  const a = await s.app.actions.propose({ kind: 'post_social', payload: { network: 'instagram', text: 'Запуск!', image_url: 'https://cv.example.com/og.jpg' }, agentId: 'mk_smm' });
  assert.equal(a.status, 'executed'); assert.equal(a.result.id, 'post9');
  const x = await s.app.actions.propose({ kind: 'post_social', payload: { network: 'x', text: 'Привет' }, agentId: 'mk_smm' });
  assert.equal(x.status, 'executed');
  assert.match(s.f.calls.find((c) => c.url === 'https://api.x.com/2/tweets').init.headers.Authorization, /^OAuth oauth_consumer_key="k".*oauth_signature="/);
  // Reddit по умолчанию — с одобрением; после «да» публикует агент
  const r = await s.app.actions.propose({ kind: 'post_social', payload: { network: 'reddit', target: 'r/SaaS', title: 'Как мы проверили спрос за 200 €', text: 'Разбор' }, agentId: 'mk_smm' });
  assert.equal(r.status, 'pending'); assert.match(r.policy_reason, /с одобрением/);
  assert.equal((await s.app.actions.decide(r.id, true)).status, 'executed');
  assert.equal(new URLSearchParams(s.f.calls.find((c) => c.url.endsWith('/api/submit')).body).get('sr'), 'SaaS');
  // директор дал права «сами» — но в то же сообщество чаще раза в неделю всё равно только с его «да»
  await call(s.app, 'POST', '/api/social', JSON.stringify({ network: 'reddit', right: 'auto' }), true);
  const r2 = await s.app.actions.propose({ kind: 'post_social', payload: { network: 'reddit', target: 'SaaS', title: 'Ещё', text: 'Ещё' }, agentId: 'mk_smm' });
  assert.equal(r2.status, 'pending'); assert.match(r2.policy_reason, /7 дней/);
  const r3 = await s.app.actions.propose({ kind: 'post_social', payload: { network: 'reddit', target: 'startups', title: 'Ещё', text: 'Ещё' }, agentId: 'mk_smm' });
  assert.equal(r3.status, 'executed');
  // запрет и неподключённая площадка
  await call(s.app, 'POST', '/api/social', JSON.stringify({ network: 'x', right: 'off' }), true);
  assert.equal((await s.app.actions.propose({ kind: 'post_social', payload: { network: 'x', text: 'нельзя' }, agentId: 'mk_smm' })).status, 'denied');
  const li = await s.app.actions.propose({ kind: 'post_social', payload: { network: 'linkedin', text: 'Пост' }, agentId: 'mk_smm' });
  assert.equal(li.status, 'manual'); assert.match(li.result.note, /не подключена/);
  assert.equal((await s.app.actions.propose({ kind: 'post_social', payload: { network: 'community', text: 'x' } })).status, 'denied');
  const v = JSON.parse((await call(s.app, 'GET', '/api/social', '', true)).body);
  assert.equal(v.networks.find((n) => n.key === 'reddit').right, 'auto');
  assert.equal(v.networks.find((n) => n.key === 'instagram').connected, true);
});

// --- мелкие помощники для вызова HTTP-обработчика без сети ---
function fakeReq(method, url, body) {
  const { req, res } = mockPair(method, url, body ? JSON.stringify(body) : '', { authorization: 'Bearer test-director-token-0123456789' });
  return [req, res];
}
function mockPair(method, url, raw = '', headers = {}) {
  const listeners = {};
  const req = { method, url, headers, socket: { remoteAddress: '127.0.0.1' }, on(ev, fn) { (listeners[ev] ||= []).push(fn); if (ev === 'end') queueMicrotask(() => { if (raw) listeners.data?.forEach((f) => f(Buffer.from(raw))); fn(); }); return req; }, destroy() {} };
  const res = { status: 0, headers: {}, body: '', writeHead(code, h) { this.status = code; Object.assign(this.headers, h || {}); }, end(b) { this.body = b ? String(b) : ''; this.done?.(); } };
  return { req, res };
}
async function call(app, method, url, raw = '', auth = false) {
  const { req, res } = mockPair(method, url, raw, auth ? { authorization: 'Bearer test-director-token-0123456789' } : {});
  const done = new Promise((r) => { res.done = r; });
  await app.http.handler(req, res);
  await done;
  return res;
}
