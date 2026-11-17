// Маркетинг проектов: тесты спроса с бюджетом, одобренным директором, рекламные кампании в рамках
// этого бюджета, метки каналов и счётчик на лендинге, сбор цифр, стоп-правила и отчёт на последний день.
// Деньгами управляет сервер, а не агент: лимиты бюджета, остановка по правилам и по сроку
// выполняются в коде, даже если агент ошибся или промолчал.
import crypto from 'node:crypto';
import { J } from './db.js';
import { addTask } from './worker.js';
import { toBase, round2 } from './policy.js';
import { CHANNELS, normChannel, adsConfig, metaAds, googleAds } from './ads.js';

export const TEST_RU = { proposed: 'ждёт решения директора', approved: 'одобрен — подготовка', running: 'идёт', reporting: 'завершён — готовится отчёт', done: 'отчёт готов', rejected: 'отклонён' };
export const VERDICT_RU = { go: 'масштабировать', iterate: 'ещё один тест', kill: 'закрыть направление' };
export const DEFAULT_RULES = { min_ctr: 0.5, min_impressions: 1000, no_leads_share: 0.5 };
const CLIENT_EVENTS = new Set(['visit', 'lead', 'signup', 'checkout']);
const LIVE = ['approved', 'running', 'reporting'];
const DAY = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'c';
const pct = (a, b) => (b ? round2((a / b) * 100) : null);
const per = (a, b) => (b ? round2(a / b) : null);
const ts = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');
const httpsUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.toString() : null; } catch { return null; } };

export function fromBase(cfg, amountBase, currency) {
  const cur = (currency || cfg.baseCurrency).toUpperCase();
  if (cur === cfg.baseCurrency) return round2(amountBase);
  const perEur = cfg.fx[cur], basePerEur = cfg.fx[cfg.baseCurrency];
  if (!perEur || !basePerEur) throw new Error('Нет курса для валюты ' + cur);
  return round2((amountBase / basePerEur) * perEur);
}

export function createMarketing(ctx, opts = {}) {
  const { db, cfg } = ctx;
  const ac = opts.adsCfg || adsConfig();
  const f = ctx.fetch || fetch;
  const platforms = opts.platforms || { meta: metaAds(ac.meta, f), google: googleAds(ac.google, f) };
  const accCurrency = { meta: ac.meta.currency || cfg.baseCurrency, google: ac.google.currency || cfg.baseCurrency };
  const syncEveryMs = Number(process.env.MK_SYNC_HOURS || 3) * 3600000;
  const rate = new Map();

  const getTest = (id) => { const t = db.get('SELECT * FROM mk_tests WHERE id=?', id); if (t) { t.channels = J(t.channels, []); t.stop_rules = { ...DEFAULT_RULES, ...J(t.stop_rules, {}) }; t.success = J(t.success, {}); } return t; };
  const campaigns = (testId) => db.all('SELECT * FROM mk_campaigns WHERE test_id=? ORDER BY id', testId).map((c) => ({ ...c, extra: J(c.extra, {}) }));
  const adapterFor = (channel) => { const api = CHANNELS[channel]?.api; const p = api && platforms[api]; return p?.enabled ? p : null; };
  const spentBase = (testId, channel) => db.get(`SELECT COALESCE(SUM(spend_base),0) s FROM mk_metrics WHERE test_id=? AND (? IS NULL OR channel=?)`, testId, channel ?? null, channel ?? null).s;
  const daysLeft = (t) => Math.max(1, Math.ceil((ts(t.ends_at) - Date.now()) / DAY));
  const send = (text, kb) => ctx.telegram?.send?.(text, kb);
  const agentName = (id) => db.get('SELECT name FROM agents WHERE id=?', id)?.name || id || 'Система';
  const planBudgetBase = (t, channel) => { const p = t.channels.find((c) => c.channel === channel); return p && p.budget ? toBase(cfg, p.budget, t.currency) : null; };

  // ---------------- план теста ----------------
  function proposeTest(agent, input) {
    if (agent.dept !== 'marketing' && agent.id !== 'cdo') return { error: 'План теста предлагает отдел маркетинга' };
    const need = ['title', 'hypothesis', 'segment', 'offer'].filter((k) => !input[k]);
    if (need.length) return { error: 'Не хватает полей: ' + need.join(', ') };
    const channels = (input.channels || []).map((c) => ({ channel: normChannel(c.channel), budget: Number(c.budget) || 0, goal: String(c.goal || '').slice(0, 300) }))
      .filter((c) => CHANNELS[c.channel]);
    if (!channels.length || channels.length > 4) return { error: 'Нужно 1–4 канала из списка: ' + Object.keys(CHANNELS).join(', ') };
    const noApi = channels.filter((c) => CHANNELS[c.channel].paid && !adapterFor(c.channel));
    if (noApi.length) return { error: `Эти рекламные площадки агенты сейчас вести не могут (нет подключённого API): ${noApi.map((c) => CHANNELS[c.channel].title).join(', ')}. Подключены: ${Object.keys(CHANNELS).filter((k) => adapterFor(k)).join(', ') || 'ни одной'} — остальное через бесплатные каналы (соцсети, переписка, письма) или вопрос директору о подключении.` };
    const budget = Number(input.budget), days = Math.round(Number(input.days) || 14);
    if (!(budget > 0)) return { error: 'Нужен общий бюджет теста > 0' };
    if (days < 3 || days > 60) return { error: 'Срок теста — от 3 до 60 дней' };
    const sumCh = channels.reduce((s, c) => s + c.budget, 0);
    if (sumCh > budget + 0.01) return { error: `Сумма бюджетов каналов (${sumCh}) больше общего бюджета (${budget})` };
    const success = input.success || {};
    if (!['max_cpl', 'min_conversion', 'max_cac', 'min_leads', 'min_purchases'].some((k) => success[k] != null)) return { error: 'Нужен порог успеха: max_cpl, min_conversion, max_cac, min_leads или min_purchases' };
    if (input.project_id && !db.get('SELECT id FROM projects WHERE id=?', input.project_id)) return { error: 'Нет такого проекта' };
    if (input.landing_url && !httpsUrl(input.landing_url)) return { error: 'landing_url должен быть https' };
    const dup = db.get(`SELECT id FROM mk_tests WHERE title=? AND status IN ('proposed','approved','running')`, input.title);
    if (dup) return { ok: true, test_id: dup.id, note: 'Такой тест уже есть' };
    const currency = String(input.currency || cfg.baseCurrency).toUpperCase();
    const budgetBase = toBase(cfg, budget, currency);
    const key = 'k' + crypto.randomBytes(5).toString('hex');
    const r = db.run(`INSERT INTO mk_tests(key,project_id,title,hypothesis,segment,offer,channels,budget,currency,budget_base,days,stop_rules,success,landing_url,status,proposed_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'proposed', ?)`,
      key, input.project_id || null, String(input.title).slice(0, 200), input.hypothesis, input.segment, input.offer, JSON.stringify(channels), budget, currency, budgetBase, days,
      JSON.stringify({ ...DEFAULT_RULES, ...(input.stop_rules || {}) }), JSON.stringify(success), input.landing_url ? httpsUrl(input.landing_url) : null, agent.id);
    const id = Number(r.lastInsertRowid);
    const monthAds = round2(db.get(`SELECT COALESCE(SUM(amount_base),0) s FROM ledger WHERE category='ads' AND direction='out' AND ts>=datetime('now','start of month')`).s);
    const live = round2(db.get(`SELECT COALESCE(SUM(budget_base),0) s FROM mk_tests WHERE status IN ('approved','running')`).s);
    db.feed('📣', `${agent.name} предлагает тест спроса «${input.title}» — ${budget} ${currency} на ${days} дн.`, agent.id, 'warn');
    db.audit(agent.id, 'mk.test.proposed', { id, budget, currency });
    const proj = input.project_id ? db.get('SELECT name FROM projects WHERE id=?', input.project_id)?.name : null;
    send(`📣 План теста спроса (#${id})${proj ? ` · проект «${proj}»` : ''}\n${input.title}\n\nГипотеза: ${String(input.hypothesis).slice(0, 400)}\nКому: ${String(input.segment).slice(0, 200)}\nОффер: ${String(input.offer).slice(0, 300)}\nКаналы: ${channels.map((c) => `${CHANNELS[c.channel].title} — ${c.budget} ${currency}`).join('; ')}\nБюджет: ${budget} ${currency} (≈ ${budgetBase} ${cfg.baseCurrency}) на ${days} дн.\nПорог успеха: ${JSON.stringify(success)}\nСтоп-правила: CTR < ${DEFAULT_RULES.min_ctr}% после ${DEFAULT_RULES.min_impressions} показов; канал без заявок на половине бюджета — стоп.\nРеклама в этом месяце: потрачено ${monthAds}, в работе бюджетов ${live} ${cfg.baseCurrency}.\n\nПосле одобрения команда тратит только внутри этого бюджета; сервер сам остановит кампании по правилам и по сроку.`,
      [[{ text: '✅ Одобрить бюджет', callback_data: `m:${id}:y` }, { text: '✖ Отклонить', callback_data: `m:${id}:n` }]]);
    return { ok: true, test_id: id, status: 'proposed', note: 'План отправлен директору. Кампании можно готовить после одобрения.' };
  }

  function decideTest(id, approve, by = 'director', note = '') {
    const t = getTest(id);
    if (!t) throw Object.assign(new Error('Тест не найден'), { code: 404 });
    if (t.status !== 'proposed') return t;
    if (approve) {
      db.run(`UPDATE mk_tests SET status='approved', decided_at=datetime('now'), started_at=datetime('now'), ends_at=datetime('now', ?), director_note=? WHERE id=?`, `+${t.days} days`, note || null, id);
      addTask(db, { title: `Тест спроса #${id}: подготовка и запуск`, agentId: db.get(`SELECT id FROM agents WHERE id='mk_head' AND enabled=1`) ? 'mk_head' : null, dept: 'marketing', projectId: t.project_id, priority: 2, createdBy: by,
        body: `Директор одобрил бюджет теста #${id} «${t.title}»: ${t.budget} ${t.currency} на ${t.days} дн.${note ? ' Комментарий директора: ' + note : ''}
Распредели работу:
1) Никита — тексты лендинга и 3–5 вариантов объявлений; Вера — креативы и посты; IT — лендинг (ui_front/ai_product через create_task).
2) На лендинг поставить счётчик: <script src="${cfg.publicUrl}/t.js" data-test="${t.key}" defer></script>. Форма заявки — атрибут data-neiro="lead", кнопка оплаты Stripe отслеживается сама.
3) Бесплатные каналы ведёт команда сама: посты — propose_action(post_social), письма и переписка — продажи; ссылки с метками — mk_link, цифры — mk_log.
4) Егор — кампании через mk_campaign (create → проверка → activate). Сервер не даст выйти за бюджет канала и теста.
5) Продажи — переписка с тёплыми лидами.
Порог успеха: ${JSON.stringify(t.success)}. Цифры в любой момент — mk_status(test_id=${id}).` });
    } else {
      db.run(`UPDATE mk_tests SET status='rejected', decided_at=datetime('now'), director_note=? WHERE id=?`, note || null, id);
      if (note) addTask(db, { title: `Тест #${id} отклонён — доработать план`, dept: 'marketing', agentId: t.proposed_by, priority: 4, createdBy: by, body: `Директор отклонил план «${t.title}». Комментарий: ${note}. Если есть смысл — предложи исправленный план через mk_propose_test.` });
    }
    db.audit(by, approve ? 'mk.test.approved' : 'mk.test.rejected', { id, note });
    db.feed(approve ? '✅' : '✖', `Директор ${approve ? 'одобрил' : 'отклонил'} тест спроса «${t.title}»${approve ? ` (${t.budget} ${t.currency})` : ''}`, null, approve ? 'good' : 'info');
    return getTest(id);
  }

  // ---------------- кампании ----------------
  function tagUrl(url, channel, campaign, medium = 'cpc', content) {
    const u = new URL(url);
    u.searchParams.set('utm_source', channel); u.searchParams.set('utm_medium', medium); u.searchParams.set('utm_campaign', slug(campaign));
    if (content) u.searchParams.set('utm_content', slug(content));
    return u.toString();
  }

  // Сколько ещё можно тратить с учётом уже включённых кампаний (дневной бюджет × оставшиеся дни)
  function budgetCheck(t, channel, addDaily, excludeId) {
    const dl = daysLeft(t);
    const active = campaigns(t.id).filter((c) => c.status === 'active' && c.id !== excludeId);
    const testLeft = t.budget_base - spentBase(t.id);
    const testCommit = active.reduce((s, c) => s + c.daily_budget_base, 0) * dl + addDaily * dl;
    if (testCommit > testLeft + 0.01) return `Выйдет за бюджет теста: включённые кампании × ${dl} дн. = ${round2(testCommit)} ${cfg.baseCurrency}, осталось ${round2(testLeft)}. Уменьши дневной бюджет.`;
    const chBudget = planBudgetBase(t, channel);
    if (chBudget != null) {
      const chLeft = chBudget - spentBase(t.id, channel);
      const chCommit = active.filter((c) => c.channel === channel).reduce((s, c) => s + c.daily_budget_base, 0) * dl + addDaily * dl;
      if (chCommit > chLeft + 0.01) return `Выйдет за бюджет канала ${channel}: ${round2(chCommit)} > ${round2(chLeft)} ${cfg.baseCurrency}.`;
    }
    return null;
  }

  async function campaign(actor, input) {
    const isDirector = String(actor.id).startsWith('director');
    if (!isDirector && actor.dept !== 'marketing') return { error: 'Кампаниями управляет отдел маркетинга' };
    const op = input.op;
    if (op === 'create') {
      const t = getTest(input.test_id);
      if (!t) return { error: 'Нет такого теста' };
      if (!['approved', 'running'].includes(t.status)) return { error: `Тест в статусе «${TEST_RU[t.status]}» — кампании только после одобрения директором` };
      const channel = normChannel(input.channel);
      if (!t.channels.some((c) => c.channel === channel)) return { error: `Канала ${channel} нет в плане теста: ${t.channels.map((c) => c.channel).join(', ')}` };
      const daily = Number(input.daily_budget) || 0;
      if (!(daily > 0)) return { error: `Нужен daily_budget в ${cfg.baseCurrency}` };
      if (daily * daysLeft(t) > t.budget_base - spentBase(t.id) + 0.01) return { error: `Дневной бюджет × ${daysLeft(t)} дн. больше остатка бюджета теста` };
      const raw = httpsUrl(input.url || t.landing_url || '');
      if (!raw) return { error: 'Нужен https-адрес лендинга (url или landing_url теста)' };
      const name = `N#${t.id} ${String(input.name || channel).slice(0, 60)}`;
      const url = tagUrl(raw, channel, input.name || channel);
      const ad = adapterFor(channel);
      if (!CHANNELS[channel].paid) return { error: `«${CHANNELS[channel].title}» — не рекламный кабинет: публикуй через propose_action(post_social), ссылки — mk_link, цифры — mk_log` };
      if (!ad) return { error: `Кабинет «${CHANNELS[channel].title}» не подключён по API — агенты его не ведут. Спроси директора через ask_director, если канал нужен.` };
      const spec = { creatives: input.creatives || [], keywords: input.keywords || [], headlines: input.headlines || [], descriptions: input.descriptions || [], countries: input.countries || [], age_min: input.age_min, age_max: input.age_max, geo_target_ids: input.geo_target_ids || [], language_ids: input.language_ids || [] };
      if (channel === 'meta' && !spec.creatives.length) return { error: 'Для Meta нужны creatives: [{headline, text, description?, image_url?}] (без image_url берётся картинка лендинга)' };
      if (channel === 'google' && (spec.headlines.length < 3 || spec.descriptions.length < 2 || !spec.keywords.length)) return { error: 'Для Google нужны keywords, не меньше 3 headlines (до 30 знаков) и 2 descriptions (до 90 знаков)' };
      const accDaily = fromBase(cfg, daily, accCurrency[CHANNELS[channel].api]);
      const out = await ad.createCampaign({ name, url, dailyBudgetMinor: Math.round(accDaily * 100), dailyBudgetMicros: Math.round(accDaily * 1e6), countries: spec.countries, ageMin: spec.age_min, ageMax: spec.age_max,
        creatives: spec.creatives, keywords: spec.keywords, headlines: spec.headlines, descriptions: spec.descriptions, geoTargetIds: spec.geo_target_ids, languageIds: spec.language_ids,
        endTime: new Date(ts(t.ends_at)).toISOString() });
      const extId = out.extId, extra = out.extra || {}, status = 'paused', note = 'Кампания создана выключенной. Проверь объявления и включи: mk_campaign(op=activate).';
      const r = db.run(`INSERT INTO mk_campaigns(test_id,channel,ext_id,extra,name,url,daily_budget_base,status,spec,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        t.id, channel, extId, JSON.stringify(extra), name, url, daily, status, JSON.stringify(spec), actor.id);
      const cid = Number(r.lastInsertRowid);
      db.feed('🎯', `${actor.name || 'Директор'}: кампания «${name}» (${CHANNELS[channel].title}, ${daily} ${cfg.baseCurrency}/день) создана выключенной`, isDirector ? null : actor.id);
      return { ok: true, campaign_id: cid, status, url, note };
    }
    const c = db.get('SELECT * FROM mk_campaigns WHERE id=?', input.campaign_id);
    if (!c) return { error: 'Нет такой кампании' };
    c.extra = J(c.extra, {});
    const t = getTest(c.test_id);
    const ad = c.ext_id ? adapterFor(c.channel) : null;
    if (op === 'activate') {
      if (!['approved', 'running'].includes(t.status)) return { error: `Тест в статусе «${TEST_RU[t.status]}» — включать нельзя` };
      if (db.setting('stopped', false)) return { error: 'Включён режим «СТОП» — реклама не включается' };
      const why = budgetCheck(t, c.channel, c.daily_budget_base, c.id);
      if (why) return { error: why };
      if (ad) await ad.setStatus(c.ext_id, true);
      db.run(`UPDATE mk_campaigns SET status='active', stop_reason=NULL, updated_at=datetime('now') WHERE id=?`, c.id);
      if (t.status === 'approved') db.run(`UPDATE mk_tests SET status='running' WHERE id=?`, t.id);
      db.feed('▶', `Реклама включена: «${c.name}» — ${c.daily_budget_base} ${cfg.baseCurrency}/день`, isDirector ? null : actor.id, 'good');
      db.audit(actor.id, 'mk.campaign.activate', { id: c.id });
      return { ok: true, status: 'active' };
    }
    if (op === 'pause') {
      await pauseCampaign(c, input.reason || `Пауза: ${actor.name || actor.id}`);
      return { ok: true, status: 'paused' };
    }
    if (op === 'set_budget') {
      const daily = Number(input.daily_budget) || 0;
      if (!(daily > 0)) return { error: 'Нужен daily_budget > 0' };
      if (c.status === 'active') { const why = budgetCheck(t, c.channel, daily, c.id); if (why) return { error: why }; }
      if (ad) { const acc = fromBase(cfg, daily, accCurrency[CHANNELS[c.channel].api]); await ad.setDailyBudget(c.ext_id, c.extra, c.channel === 'google' ? Math.round(acc * 1e6) : Math.round(acc * 100)); }
      db.run(`UPDATE mk_campaigns SET daily_budget_base=?, updated_at=datetime('now') WHERE id=?`, daily, c.id);
      db.feed('💶', `Бюджет «${c.name}»: ${c.daily_budget_base} → ${daily} ${cfg.baseCurrency}/день`, isDirector ? null : actor.id);
      return { ok: true, daily_budget: daily };
    }
    return { error: 'op: create | activate | pause | set_budget' };
  }

  async function pauseCampaign(c, reason) {
    if (c.status !== 'active') { db.run(`UPDATE mk_campaigns SET stop_reason=COALESCE(stop_reason,?) WHERE id=?`, reason, c.id); return; }
    const ad = c.ext_id ? adapterFor(c.channel) : null;
    try { if (ad) await ad.setStatus(c.ext_id, false); }
    catch (e) { ctx.log?.error('mk pause', e.message); send(`⚠️ Не удалось поставить на паузу «${c.name}»: ${e.message}. Выключите кампанию вручную в кабинете площадки!`); throw e; }
    db.run(`UPDATE mk_campaigns SET status='paused', stop_reason=?, updated_at=datetime('now') WHERE id=?`, reason, c.id);
    db.feed('⏸', `Реклама на паузе: «${c.name}» — ${reason}`, null, 'warn');
  }

  // Режим «СТОП» директора: вся включённая реклама — на паузу
  async function stopAllAds(reason = 'Директор включил режим «СТОП»') {
    let n = 0;
    for (const c of db.all(`SELECT * FROM mk_campaigns WHERE status='active'`)) { try { await pauseCampaign({ ...c, extra: J(c.extra, {}) }, reason); n++; } catch {} }
    return n;
  }

  // ---------------- метки и счётчик ----------------
  function link(actor, input) {
    const t = getTest(input.test_id);
    if (!t || !LIVE.includes(t.status)) return { error: 'Тест не найден или не одобрен' };
    const url = httpsUrl(input.url || t.landing_url || '');
    if (!url) return { error: 'Нужен https-адрес (url или landing_url теста)' };
    const channel = normChannel(input.channel);
    if (!CHANNELS[channel]) return { error: 'Неизвестный канал: ' + Object.keys(CHANNELS).join(', ') };
    const code = crypto.randomBytes(4).toString('base64url');
    db.run(`INSERT INTO mk_links(code,test_id,channel,medium,campaign,content,url,created_by) VALUES(?,?,?,?,?,?,?,?)`,
      code, t.id, channel, input.medium || (['outreach', 'email'].includes(channel) ? 'email' : 'social'), slug(input.campaign || t.title), input.content ? slug(input.content) : null, url, actor.id);
    return { ok: true, short_url: `${cfg.publicUrl}/go/${code}`, note: 'Короткая ссылка считает переходы и сама добавит метки канала.' };
  }

  function go(code) {
    const l = db.get('SELECT * FROM mk_links WHERE code=?', code);
    if (!l) return null;
    db.run('UPDATE mk_links SET clicks=clicks+1 WHERE code=?', code);
    const t = db.get('SELECT status FROM mk_tests WHERE id=?', l.test_id);
    if (t && LIVE.includes(t.status)) db.run(`INSERT INTO mk_events(test_id,event,channel,medium,campaign,content) VALUES(?,?,?,?,?,?)`, l.test_id, 'click', l.channel, l.medium, l.campaign, l.content);
    return tagUrl(l.url, l.channel, l.campaign, l.medium, l.content);
  }

  // События со счётчика на лендинге. Публичный вход: проверяем ключ теста, ограничиваем частоту, режем длину.
  function track(body, ip = '') {
    const now = Date.now(), r = rate.get(ip);
    if (r && now - r.t < 60000 && r.n >= 60) return { code: 429 };
    rate.set(ip, r && now - r.t < 60000 ? { t: r.t, n: r.n + 1 } : { t: now, n: 1 });
    if (rate.size > 5000) rate.clear();
    const s = (v, n = 80) => (v == null ? null : String(v).replace(/[^\p{L}\p{N}_.\-]/gu, '').slice(0, n) || null);
    const e = s(body?.e, 20), k = s(body?.k, 20), v = s(body?.v, 60);
    if (!CLIENT_EVENTS.has(e) || !k) return { code: 400 };
    const t = db.get('SELECT id, status FROM mk_tests WHERE key=?', k);
    if (!t || !LIVE.includes(t.status)) return { code: 404 };
    const day = today();
    const dk = !v ? null : e === 'visit' ? `v:${v}:${day}` : `${e}:${v}`;
    db.run(`INSERT OR IGNORE INTO mk_events(test_id,event,channel,medium,campaign,content,visitor,dk) VALUES(?,?,?,?,?,?,?,?)`,
      t.id, e, normChannel(body.s), s(body.m), s(body.c), s(body.ct), v, dk);
    return { code: 204 };
  }

  const snippet = () => `(function(){var s=document.currentScript,k=s&&s.getAttribute('data-test');if(!k)return;var E=s.src.replace(/\\/t\\.js.*$/,'')+'/t';
var q=new URLSearchParams(location.search),K='neiro_'+k,st={};try{st=JSON.parse(localStorage.getItem(K)||'{}')}catch(e){}
if(!st.v)st.v=Math.random().toString(36).slice(2,12)+Date.now().toString(36);
if(q.get('utm_source')){st.s=q.get('utm_source');st.m=q.get('utm_medium');st.c=q.get('utm_campaign');st.ct=q.get('utm_content')}
try{localStorage.setItem(K,JSON.stringify(st))}catch(e){}
function send(e){var b=JSON.stringify({k:k,e:e,v:st.v,s:st.s,m:st.m,c:st.c,ct:st.ct});try{if(navigator.sendBeacon&&navigator.sendBeacon(E,new Blob([b],{type:'text/plain'})))return}catch(x){}fetch(E,{method:'POST',body:b,keepalive:true,mode:'no-cors',headers:{'Content-Type':'text/plain'}})}
window.neiro={track:send};send('visit');
document.addEventListener('submit',function(ev){var f=ev.target;if(f&&f.getAttribute&&f.getAttribute('data-neiro'))send(f.getAttribute('data-neiro'))},true);
document.addEventListener('click',function(ev){var el=ev.target&&ev.target.closest?ev.target:null;if(!el)return;var a=el.closest('a[href*="buy.stripe.com"]');
if(a){try{var u=new URL(a.href);u.searchParams.set('client_reference_id','n_'+k+'_'+st.v);a.href=u.toString()}catch(x){}send('checkout');return}
var t=el.closest('[data-neiro]');if(t&&t.tagName!=='FORM')send(t.getAttribute('data-neiro'))},true)})();`;

  // Оплата Stripe со страницы теста: client_reference_id = n_<ключ теста>_<посетитель>
  function attributeStripe(ev) {
    const o = ev?.data?.object || {};
    if (ev?.type !== 'checkout.session.completed' || o.payment_status !== 'paid') return false;
    const m = String(o.client_reference_id || '').match(/^n_(k[0-9a-f]{10})_([A-Za-z0-9]{1,60})$/);
    if (!m) return false;
    const t = db.get('SELECT id FROM mk_tests WHERE key=?', m[1]);
    if (!t) return false;
    const first = db.get(`SELECT channel, medium, campaign, content FROM mk_events WHERE test_id=? AND visitor=? AND channel!='direct' ORDER BY id LIMIT 1`, t.id, m[2]) || { channel: 'direct' };
    const cur = String(o.currency || cfg.baseCurrency).toUpperCase();
    const value = (Number(o.amount_total) || 0) / 100;
    let vb = value; try { vb = toBase(cfg, value, cur); } catch {}
    return db.run(`INSERT OR IGNORE INTO mk_events(test_id,event,channel,medium,campaign,content,visitor,value,currency,value_base,dk) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      t.id, 'purchase', first.channel, first.medium, first.campaign, first.content, m[2], value, cur, vb, 'p:' + o.id).changes > 0;
  }

  // ---------------- цифры ----------------
  function upsertMetric(m) {
    db.run(`INSERT INTO mk_metrics(test_id,campaign_id,channel,day,impressions,clicks,spend,currency,spend_base,leads,sales,source,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(test_id,campaign_id,channel,day,source) DO UPDATE SET impressions=excluded.impressions, clicks=excluded.clicks, spend=excluded.spend, currency=excluded.currency,
      spend_base=excluded.spend_base, leads=excluded.leads, sales=excluded.sales, note=COALESCE(excluded.note,note), updated_at=datetime('now')`,
      m.test_id, m.campaign_id || 0, m.channel, m.day, m.impressions || 0, m.clicks || 0, m.spend || 0, m.currency, m.spend_base || 0, m.leads || 0, m.sales || 0, m.source, m.note || null);
    // Реклама — в учёт расходов (сумма за день обновляется, пока день не закончился)
    const ref = `${m.source === 'api' ? m.channel + ':' + m.ext_id : 'manual:' + m.test_id + ':' + m.channel}:${m.day}`;
    if (m.spend > 0) db.run(`INSERT INTO ledger(direction,category,amount,currency,amount_base,source,ref,project_id,note,ts) VALUES('out','ads',?,?,?,'ads',?,?,?,?)
      ON CONFLICT(source,ref) DO UPDATE SET amount=excluded.amount, amount_base=excluded.amount_base`,
      round2(m.spend), m.currency, round2(m.spend_base), ref, m.project_id || null, `Реклама: тест #${m.test_id}, ${CHANNELS[m.channel]?.title || m.channel}`, m.day + ' 12:00:00');
  }

  function logMetrics(actor, input) {
    const t = getTest(input.test_id);
    if (!t || !LIVE.includes(t.status)) return { error: 'Тест не найден или не одобрен' };
    const channel = normChannel(input.channel);
    if (!CHANNELS[channel]) return { error: 'Неизвестный канал' };
    const day = /^\d{4}-\d{2}-\d{2}$/.test(input.day || '') ? input.day : today();
    const currency = String(input.currency || cfg.baseCurrency).toUpperCase();
    const spend = Math.max(0, Number(input.spend) || 0);
    upsertMetric({ test_id: t.id, project_id: t.project_id, campaign_id: 0, channel, day, impressions: Math.max(0, Math.round(Number(input.impressions) || 0)), clicks: Math.max(0, Math.round(Number(input.clicks) || 0)),
      spend, currency, spend_base: spend ? toBase(cfg, spend, currency) : 0, leads: Math.max(0, Math.round(Number(input.leads) || 0)), sales: Math.max(0, Math.round(Number(input.sales) || 0)), source: 'manual', note: input.note ? String(input.note).slice(0, 500) : null });
    db.audit(actor.id, 'mk.metrics.manual', { test: t.id, channel, day });
    return { ok: true, note: 'Цифры за день записаны (повторная запись за тот же день и канал заменяет прежнюю)' };
  }

  async function sync() {
    const res = { rows: 0, errors: [] };
    const tests = db.all(`SELECT * FROM mk_tests WHERE status IN ('running','reporting') OR (status='done' AND finished_at>=datetime('now','-3 days'))`);
    for (const t of tests) {
      const cs = campaigns(t.id).filter((c) => c.ext_id);
      const byApi = {};
      for (const c of cs) { const api = CHANNELS[c.channel]?.api; if (api && platforms[api]?.enabled) (byApi[api] ||= []).push(c); }
      for (const [api, list] of Object.entries(byApi)) {
        try {
          const rows = await platforms[api].insights(list.map((c) => c.ext_id), String(t.started_at).slice(0, 10), today());
          for (const r of rows) {
            const c = list.find((x) => x.ext_id === r.extId);
            if (!c) continue;
            const cur = (r.currency || accCurrency[api]).toUpperCase();
            let sb; try { sb = toBase(cfg, r.spend, cur); } catch { sb = r.spend; }
            upsertMetric({ test_id: t.id, project_id: t.project_id, campaign_id: c.id, ext_id: c.ext_id, channel: c.channel, day: r.day, impressions: r.impressions, clicks: r.clicks, spend: r.spend, currency: cur, spend_base: sb, source: 'api' });
            res.rows++;
          }
        } catch (e) { res.errors.push(`${api}: ${e.message}`); }
      }
    }
    db.setSetting('mk_synced_at', Date.now());
    for (const t of db.all(`SELECT id FROM mk_tests WHERE status='running'`)) await enforce(t.id);
    if (res.errors.length) ctx.log?.error('mk sync', res.errors.join('; '));
    return res;
  }

  // ---------------- воронка теста ----------------
  function stats(testId) {
    const t = getTest(testId);
    if (!t) return null;
    const met = db.all(`SELECT channel, SUM(impressions) impressions, SUM(clicks) clicks, SUM(spend_base) spend, SUM(leads) leads, SUM(sales) sales FROM mk_metrics WHERE test_id=? GROUP BY channel`, t.id);
    const ev = db.all(`SELECT channel, event, COUNT(*) n, COALESCE(SUM(value_base),0) v FROM mk_events WHERE test_id=? GROUP BY channel, event`, t.id);
    const keys = new Set([...t.channels.map((c) => c.channel), ...met.map((m) => m.channel), ...ev.map((e) => e.channel)]);
    const evn = (ch, e) => ev.find((x) => x.channel === ch && x.event === e)?.n || 0;
    const rows = [...keys].map((ch) => {
      const m = met.find((x) => x.channel === ch) || {};
      const r = { channel: ch, title: CHANNELS[ch]?.title || ch, budget: planBudgetBase(t, ch), impressions: m.impressions || 0, clicks: (m.clicks || 0) + evn(ch, 'click'), spend: round2(m.spend || 0),
        visits: evn(ch, 'visit'), leads: evn(ch, 'lead') + evn(ch, 'signup') + (m.leads || 0), checkouts: evn(ch, 'checkout'), purchases: evn(ch, 'purchase') + (m.sales || 0),
        revenue: round2(ev.filter((x) => x.channel === ch && x.event === 'purchase').reduce((s, x) => s + x.v, 0)) };
      return { ...r, ctr: pct(r.clicks, r.impressions), cpc: per(r.spend, r.clicks), conversion: pct(r.leads, r.visits), cpl: per(r.spend, r.leads), cac: per(r.spend, r.purchases) };
    });
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    const total = { impressions: sum('impressions'), clicks: sum('clicks'), spend: round2(sum('spend')), visits: sum('visits'), leads: sum('leads'), checkouts: sum('checkouts'), purchases: sum('purchases'), revenue: round2(sum('revenue')) };
    Object.assign(total, { ctr: pct(total.clicks, total.impressions), conversion: pct(total.leads, total.visits), cpl: per(total.spend, total.leads), cac: per(total.spend, total.purchases) });
    const s = t.success, checks = [];
    if (s.max_cpl != null) checks.push({ name: `Цена заявки ≤ ${s.max_cpl}`, ok: total.cpl != null && total.cpl <= s.max_cpl, value: total.cpl });
    if (s.min_conversion != null) checks.push({ name: `Конверсия лендинга ≥ ${s.min_conversion}%`, ok: total.conversion != null && total.conversion >= s.min_conversion, value: total.conversion });
    if (s.max_cac != null) checks.push({ name: `Цена клиента ≤ ${s.max_cac}`, ok: total.cac != null && total.cac <= s.max_cac, value: total.cac });
    if (s.min_leads != null) checks.push({ name: `Заявок ≥ ${s.min_leads}`, ok: total.leads >= s.min_leads, value: total.leads });
    if (s.min_purchases != null) checks.push({ name: `Покупок/предзаказов ≥ ${s.min_purchases}`, ok: total.purchases >= s.min_purchases, value: total.purchases });
    const passed = checks.filter((c) => c.ok).length;
    const suggestion = checks.length && passed === checks.length ? 'go' : passed > 0 || total.leads > 0 ? 'iterate' : 'kill';
    const started = t.started_at ? ts(t.started_at) : null;
    return {
      test: { id: t.id, key: t.key, title: t.title, status: t.status, status_ru: TEST_RU[t.status], project_id: t.project_id, hypothesis: t.hypothesis, segment: t.segment, offer: t.offer, landing_url: t.landing_url,
        budget: t.budget, currency: t.currency, budget_base: t.budget_base, days: t.days, started_at: t.started_at, ends_at: t.ends_at, success: t.success, stop_rules: t.stop_rules, channels: t.channels,
        verdict: t.verdict, decision: t.decision, report: t.report, finish_reason: t.finish_reason, report_doc_id: t.report_doc_id },
      base: cfg.baseCurrency, spent: total.spend, left: round2(t.budget_base - total.spend),
      day: started ? Math.min(t.days, Math.max(1, Math.ceil((Date.now() - started) / DAY))) : 0, rows, total, checks, suggestion,
    };
  }

  // Стоп-правила, бюджет и срок — исполняет сервер
  async function enforce(testId) {
    const t = getTest(testId);
    if (!t || t.status !== 'running') return;
    const st = stats(testId);
    if (st.spent >= t.budget_base * 0.95) return finishTest(testId, `Бюджет теста исчерпан: ${st.spent} из ${t.budget_base} ${cfg.baseCurrency}`);
    if (Date.now() >= ts(t.ends_at)) return finishTest(testId, 'Срок теста истёк');
    const R = t.stop_rules, paused = [];
    const active = campaigns(testId).filter((c) => c.status === 'active');
    for (const c of active) {
      const m = db.get(`SELECT COALESCE(SUM(impressions),0) i, COALESCE(SUM(clicks),0) k FROM mk_metrics WHERE campaign_id=?`, c.id);
      if (m.i >= R.min_impressions && (m.k / m.i) * 100 < R.min_ctr) { await pauseCampaign(c, `CTR ${round2((m.k / m.i) * 100)}% < ${R.min_ctr}% после ${m.i} показов`).catch(() => {}); paused.push(c.name); }
    }
    for (const row of st.rows) {
      const cs = active.filter((c) => c.channel === row.channel && !paused.includes(c.name));
      if (!cs.length) continue;
      let why = null;
      if (row.budget && row.spend >= row.budget * R.no_leads_share && row.leads + row.purchases === 0) why = `Потрачено ${row.spend} из ${row.budget} ${cfg.baseCurrency}, заявок нет`;
      else if (R.max_cpl && row.leads > 0 && row.cpl > R.max_cpl * 1.3 && row.spend >= R.max_cpl * 2) why = `Цена заявки ${row.cpl} > ${R.max_cpl} на 30%+`;
      if (why) for (const c of cs) { await pauseCampaign(c, why).catch(() => {}); paused.push(c.name); }
    }
    if (paused.length) {
      send(`⏸ Тест #${t.id} «${t.title}»: стоп-правила остановили ${paused.length} кампан.: ${paused.join(', ')}. Команда предложит замену.`);
      addTask(db, { title: `Тест #${t.id}: кампании остановлены правилами`, dept: 'marketing', agentId: 'mk_ads', priority: 3, createdBy: 'system',
        body: `Сервер остановил: ${paused.join(', ')} (причины — в mk_status). Разбери, что не сработало (оффер, аудитория, креатив), и предложи замену в пределах остатка бюджета. Остаток: ${st.left} ${cfg.baseCurrency}.` });
    }
  }

  async function finishTest(testId, reason) {
    const t = getTest(testId);
    if (!t || !['approved', 'running'].includes(t.status)) return;
    for (const c of campaigns(testId).filter((x) => x.status === 'active')) await pauseCampaign(c, reason).catch(() => {});
    db.run(`UPDATE mk_tests SET status='reporting', finish_reason=?, finished_at=datetime('now') WHERE id=?`, reason, testId);
    const st = stats(testId);
    db.feed('🏁', `Тест спроса «${t.title}» завершён: ${reason}`, null, 'warn');
    addTask(db, { title: `Отчёт по тесту спроса #${testId}`, agentId: db.get(`SELECT id FROM agents WHERE id='mk_head' AND enabled=1`) ? 'mk_head' : null, dept: 'marketing', projectId: t.project_id, priority: 2, createdBy: 'system',
      body: `Тест «${t.title}» завершён (${reason}). Реклама остановлена.
Цифры по каналам (из рекламных кабинетов и счётчика): ${JSON.stringify({ rows: st.rows, total: st.total, checks: st.checks })}
Собери у продаж, что говорили люди в переписке (почему покупали или нет). Затем сдай отчёт через mk_report(test_id=${testId}, summary, learnings, verdict): verdict — go (масштабировать), iterate (ещё тест: что меняем), kill (закрыть направление). Подсказка сервера по порогам успеха: ${VERDICT_RU[st.suggestion]}. Цифры не округляй в свою пользу.` });
  }

  function report(agent, input) {
    const t = getTest(input.test_id);
    if (!t) return { error: 'Нет такого теста' };
    if (t.status !== 'reporting') return { error: `Отчёт сдаётся после завершения теста (сейчас: ${TEST_RU[t.status]})` };
    if (!['go', 'iterate', 'kill'].includes(input.verdict) || !input.summary) return { error: 'Нужны summary и verdict: go | iterate | kill' };
    const st = stats(t.id);
    const fmt = (v, suf = '') => (v == null ? '—' : v + suf);
    const card = [`Тест спроса #${t.id}: ${t.title}`, `Срок: ${t.days} дн., причина завершения: ${t.finish_reason || '—'}`,
      `Потрачено: ${st.spent} из ${t.budget_base} ${cfg.baseCurrency}`,
      `Показы ${st.total.impressions} · клики ${st.total.clicks} (CTR ${fmt(st.total.ctr, '%')}) · визиты ${st.total.visits} · заявки ${st.total.leads} (конверсия ${fmt(st.total.conversion, '%')}) · покупки ${st.total.purchases} · выручка ${st.total.revenue}`,
      `Цена заявки: ${fmt(st.total.cpl)} · цена клиента: ${fmt(st.total.cac)} ${cfg.baseCurrency}`, '', 'По каналам:',
      ...st.rows.map((r) => `• ${r.title}: ${r.spend} ${cfg.baseCurrency}, заявок ${r.leads}, покупок ${r.purchases}, цена заявки ${fmt(r.cpl)}`), '',
      'Пороги успеха:', ...st.checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.name} (факт: ${fmt(c.value)})`)].join('\n');
    const text = `${card}\n\nВыводы команды:\n${input.summary}\n${input.learnings ? '\nЧему научились:\n' + input.learnings : ''}\n\nРекомендация: ${VERDICT_RU[input.verdict]} (подсказка по порогам: ${VERDICT_RU[st.suggestion]})`;
    const doc = db.run('INSERT INTO documents(title,kind,content,agent_id,project_id) VALUES(?,?,?,?,?)', `Отчёт теста спроса #${t.id}: ${t.title}`.slice(0, 200), 'report', text, agent.id, t.project_id);
    db.run(`UPDATE mk_tests SET status='done', report=?, verdict=?, report_doc_id=? WHERE id=?`, text, input.verdict, Number(doc.lastInsertRowid), t.id);
    db.feed('📊', `${agent.name}: отчёт по тесту «${t.title}» — рекомендация «${VERDICT_RU[input.verdict]}»`, agent.id, 'warn');
    send(`📊 ${text}`.slice(0, 3900), [[{ text: '🚀 Масштабировать', callback_data: `v:${t.id}:go` }, { text: '🔁 Ещё тест', callback_data: `v:${t.id}:iterate` }], [{ text: '✖ Закрыть направление', callback_data: `v:${t.id}:kill` }]]);
    return { ok: true, status: 'done', note: 'Отчёт у директора' };
  }

  function decideVerdict(id, verdict, by = 'director', note = '') {
    const t = getTest(id);
    if (!t) throw Object.assign(new Error('Тест не найден'), { code: 404 });
    if (!VERDICT_RU[verdict]) throw Object.assign(new Error('Решение: go | iterate | kill'), { code: 400 });
    if (t.status !== 'done' || t.decision) return t;
    db.run(`UPDATE mk_tests SET decision=?, director_note=COALESCE(?,director_note) WHERE id=?`, verdict, note || null, id);
    const proj = t.project_id ? db.get('SELECT name FROM projects WHERE id=?', t.project_id)?.name : null;
    if (verdict === 'go') addTask(db, { title: `План роста по итогам теста #${id}`, dept: 'marketing', agentId: 'mk_head', projectId: t.project_id, priority: 2, createdBy: by,
      body: `Директор решил масштабировать${proj ? ` «${proj}»` : ''} по итогам теста #${id}.${note ? ' Комментарий: ' + note : ''} Оставь только каналы, где клиент дешевле трети его годовой выручки, добавь постоянные каналы (соцсети, статьи, письма клиентам) и предложи бюджет на месяц новым планом через mk_propose_test.\nОтчёт: ${String(t.report || '').slice(0, 3000)}` });
    if (verdict === 'iterate') addTask(db, { title: `Следующий тест по итогам #${id}`, dept: 'marketing', agentId: 'mk_head', projectId: t.project_id, priority: 3, createdBy: by,
      body: `Директор просит ещё один тест.${note ? ' Комментарий: ' + note : ''} Меняй одну вещь за раз (оффер, аудиторию или канал) и предложи план через mk_propose_test.\nОтчёт прошлого теста: ${String(t.report || '').slice(0, 3000)}` });
    db.audit(by, 'mk.verdict', { id, verdict, note });
    db.feed(verdict === 'kill' ? '✖' : '✅', `Директор по тесту «${t.title}»: ${VERDICT_RU[verdict]}${verdict === 'kill' && proj ? ` (проект «${proj}» можно закрыть во вкладке «Проекты»)` : ''}`, null, verdict === 'kill' ? 'info' : 'good');
    return getTest(id);
  }

  async function stopTest(id, by = 'director', reason = 'Остановлен директором') {
    const t = getTest(id);
    if (!t) throw Object.assign(new Error('Тест не найден'), { code: 404 });
    db.audit(by, 'mk.test.stop', { id, reason });
    await finishTest(id, reason);
    return getTest(id);
  }

  function list() {
    return db.all(`SELECT id FROM mk_tests ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'running' THEN 1 WHEN 'approved' THEN 2 WHEN 'reporting' THEN 3 WHEN 'done' THEN 4 ELSE 5 END, id DESC LIMIT 60`)
      .map((r) => { const s = stats(r.id); return { ...s.test, spent: s.spent, left: s.left, day: s.day, total: s.total, checks: s.checks, suggestion: s.suggestion, project: s.test.project_id ? db.get('SELECT name FROM projects WHERE id=?', s.test.project_id)?.name : null }; });
  }

  function details(id) {
    const s = stats(id);
    if (!s) return null;
    return { ...s, campaigns: campaigns(id).map((c) => ({ ...c, spec: J(c.spec, {}), channel_title: CHANNELS[c.channel]?.title })), links: db.all('SELECT * FROM mk_links WHERE test_id=? ORDER BY created_at DESC', id),
      snippet: `<script src="${cfg.publicUrl}/t.js" data-test="${s.test.key}" defer></script>`, proposer: agentName(db.get('SELECT proposed_by FROM mk_tests WHERE id=?', id)?.proposed_by) };
  }

  function status(input = {}) {
    if (input.test_id) { const d = details(input.test_id); return d || { error: 'Нет такого теста' }; }
    return { tests: list().map((t) => ({ id: t.id, title: t.title, status: t.status_ru, project_id: t.project_id, spent: t.spent, budget: t.budget_base, day: t.day, days: t.days, leads: t.total.leads, purchases: t.total.purchases, cpl: t.total.cpl })),
      platforms: { meta: platforms.meta.enabled, google: platforms.google.enabled }, channels: Object.fromEntries(Object.entries(CHANNELS).map(([k, v]) => [k, v.title + (v.paid ? (v.api && platforms[v.api]?.enabled ? ' (API подключён)' : ' (не подключён — не использовать)') : ' (без кабинета: посты, письма, переписка)')])) };
  }

  // ---------------- расписание ----------------
  async function tick(hour, once) {
    const running = db.all(`SELECT id, ends_at, days, started_at FROM mk_tests WHERE status='running'`);
    const approvedExpired = db.all(`SELECT id FROM mk_tests WHERE status='approved' AND ends_at<=datetime('now')`);
    for (const t of approvedExpired) await finishTest(t.id, 'Срок теста истёк — реклама так и не была запущена');
    if (!running.length && !db.get(`SELECT 1 FROM mk_tests WHERE status='reporting' LIMIT 1`)) return;
    const due = running.some((t) => ts(t.ends_at) <= Date.now());
    if (due || Date.now() - db.setting('mk_synced_at', 0) > syncEveryMs) await sync();
    for (const t of running) {
      const half = ts(t.started_at) + (t.days * DAY) / 2;
      if (Date.now() >= half && !db.setting('mk_mid_' + t.id)) {
        db.setSetting('mk_mid_' + t.id, true);
        const s = stats(t.id);
        addTask(db, { title: `Тест #${t.id}: промежуточный итог`, dept: 'marketing', agentId: 'mk_head', priority: 3, createdBy: 'system',
          body: `Половина срока теста «${s.test.title}». Цифры: ${JSON.stringify({ total: s.total, rows: s.rows, spent: s.spent, left: s.left })}. Если заявок ноль — меняй оффер или аудиторию, а не бюджет. Итог — 3 строки.` });
      }
    }
    if (running.length && hour >= 10) once('mk_daily', () => {
      addTask(db, { title: 'Ежедневная проверка рекламы', dept: 'marketing', agentId: 'mk_ads', priority: 3, createdBy: 'system',
        body: `Идущие тесты: ${running.map((t) => '#' + t.id).join(', ')}. Посмотри mk_status по каждому: отключи слабые объявления, перераспредели бюджет в рамках плана (mk_campaign set_budget/pause/activate). Итог — до 3 строк на тест.` });
    });
  }

  return { proposeTest, decideTest, campaign, link, go, track, snippet, attributeStripe, logMetrics, sync, stats, details, list, status, report, decideVerdict, stopTest, stopAllAds, finishTest, enforce, tick, platforms };
}
