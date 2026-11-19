// HTTP: пульт директора (API + страница), вебхуки платёжных систем, проверка здоровья.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { J } from './db.js';
import { addTask } from './worker.js';
import { decideProject, dailyMetrics } from './company.js';
import { verifyStripeSignature, handleStripeEvent, handleYookassaNotification, yookassaClient } from './payments.js';
import { configWarnings } from './config.js';
import { toBase } from './policy.js';
import { importBanks, reconcile, resolveBankTx } from './bank.js';
import { updateRates } from './fx.js';
import { collect, decideAdoption, ADOPTION_RU, dailyRadarTask } from './radar.js';
import { verifyInitData } from './tgauth.js';
import { SOCIAL, socialRights, RIGHTS_RU } from './ads.js';
import { importSimulator, exportCompany } from './archive.js';
import { answerQuestion, giveOrder, createMeeting, meetingsView, heads } from './director.js';

const MAX_BODY = 1_000_000;
const readBody = (req, max = MAX_BODY) => new Promise((res, rej) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > max) { rej(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => res(Buffer.concat(chunks).toString('utf8'))); req.on('error', rej);
});
const send = (res, code, data, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
};

export function createHttp(ctx) {
  const { db, cfg } = ctx;
  const fails = new Map();
  const panel = () => fs.readFileSync(path.join(cfg.root, 'public', 'panel.html'), 'utf8');

  function authed(req) {
    const ip = req.socket.remoteAddress || '';
    const f = fails.get(ip);
    if (f && f.n >= 10 && Date.now() - f.t < 15 * 60000) return 'locked';
    const h = req.headers.authorization || '';
    // Вход из Telegram Mini App: подпись Telegram + пользователь = директор
    if (h.startsWith('tma ')) {
      const v = verifyInitData(h.slice(4), cfg.telegram.token);
      const ok = !!(v && cfg.telegram.directorChatId && String(v.user?.id) === String(cfg.telegram.directorChatId));
      if (!ok) fails.set(ip, { n: (f && Date.now() - f.t < 15 * 60000 ? f.n : 0) + 1, t: Date.now() }); else fails.delete(ip);
      return ok;
    }
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    const ok = cfg.directorToken.length >= 24 && tok.length === cfg.directorToken.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(cfg.directorToken));
    if (!ok) fails.set(ip, { n: (f && Date.now() - f.t < 15 * 60000 ? f.n : 0) + 1, t: Date.now() }); else fails.delete(ip);
    return ok;
  }

  const routes = [];
  const R = (method, re, fn) => routes.push({ method, re, fn });

  // ---- чтение ----
  const balances = () => [...db.setting('bank_balances_revolut', []), ...db.setting('bank_balances_paysera', [])];
  R('GET', /^\/api\/bank$/, () => ({
    balances: balances(), fx: db.setting('fx_rates'), revolut: !!ctx.revolut, paysera: !!ctx.paysera?.enabled,
    unmatched: db.all(`SELECT * FROM bank_tx WHERE status IN ('unmatched','new') ORDER BY ts DESC LIMIT 200`),
    recent: db.all(`SELECT b.*, a.agent_id FROM bank_tx b LEFT JOIN actions a ON a.id=b.action_id ORDER BY b.ts DESC LIMIT 150`),
    cards_waiting: db.all(`SELECT id, agent_id, amount, currency, payload, result, created_at FROM actions WHERE kind='spend' AND status='manual' AND json_extract(result,'$.card_id') IS NOT NULL ORDER BY id DESC`).map((a) => ({ ...a, payload: JSON.parse(a.payload), result: JSON.parse(a.result) })),
  }));
  // ---- кабинет директора: вопросы, поручения, совещания ----
  R('GET', /^\/api\/questions$/, () => db.all(`SELECT q.*, a.name agent_name, a.role agent_role FROM questions q LEFT JOIN agents a ON a.id=q.agent_id ORDER BY q.status='open' DESC, q.id DESC LIMIT 100`).map((q) => ({ ...q, options: J(q.options, []) })));
  R('POST', /^\/api\/questions\/(\d+)\/answer$/, (q, m, b) => answerQuestion(ctx, Number(m[1]), b.answer, 'director:cabinet'));
  R('POST', /^\/api\/orders$/, (q, m, b) => giveOrder(ctx, { text: b.text, to: b.agent_id || (b.dept ? null : 'coo'), dept: b.dept || null, priority: Number(b.priority) || 2, via: 'cabinet' }));
  R('GET', /^\/api\/orders$/, () => db.all(`SELECT t.id,t.title,t.status,t.created_at,t.finished_at,substr(t.result,1,800) result,g.name agent_name FROM tasks t LEFT JOIN agents g ON g.id=t.agent_id WHERE t.created_by='director' ORDER BY t.id DESC LIMIT 50`));
  // ---- офис: кто чем занят прямо сейчас (для 3D-вида в кабинете) ----
  R('GET', /^\/api\/office$/, () => {
    const agents = db.all(`SELECT a.id,a.name,a.role,a.dept,a.head,a.enabled,
      (SELECT t.title FROM tasks t WHERE t.agent_id=a.id AND t.status='running' ORDER BY t.started_at DESC LIMIT 1) current,
      (SELECT t.started_at FROM tasks t WHERE t.agent_id=a.id AND t.status='running' ORDER BY t.started_at DESC LIMIT 1) started_at,
      (SELECT COUNT(*) FROM tasks t WHERE t.agent_id=a.id AND t.status='queued') queued,
      (SELECT COUNT(*) FROM tasks t WHERE t.agent_id=a.id AND t.status='blocked') blocked,
      (SELECT COUNT(*) FROM tasks t WHERE t.agent_id=a.id AND t.status='done' AND t.finished_at>=datetime('now','start of day')) done_today,
      (SELECT t.title FROM tasks t WHERE t.agent_id=a.id AND t.status='done' ORDER BY t.finished_at DESC LIMIT 1) last_title,
      (SELECT substr(t.result,1,300) FROM tasks t WHERE t.agent_id=a.id AND t.status='done' ORDER BY t.finished_at DESC LIMIT 1) last_result,
      (SELECT t.finished_at FROM tasks t WHERE t.agent_id=a.id AND t.status='done' ORDER BY t.finished_at DESC LIMIT 1) last_at,
      (SELECT COALESCE(SUM(cost_base),0) FROM runs r WHERE r.agent_id=a.id AND r.ts>=datetime('now','start of day')) cost_today
      FROM agents a WHERE a.enabled=1 ORDER BY a.dept, a.head DESC, a.id`);
    const paused = db.setting('paused', false), stopped = db.setting('stopped', false);
    for (const a of agents) a.state = a.current ? 'work' : a.blocked ? 'pause' : a.queued ? (paused ? 'pause' : 'queue') : 'idle';
    const meeting = db.get(`SELECT id, agenda, participants, status FROM meetings WHERE status!='done' ORDER BY id DESC LIMIT 1`);
    const depts = db.all('SELECT key, name FROM departments').filter((d) => agents.some((a) => a.dept === d.key));
    return { depts, agents, paused, stopped, meeting: meeting ? { ...meeting, participants: J(meeting.participants, []) } : null,
      stats: { work: agents.filter((a) => a.state === 'work').length, queue: agents.filter((a) => a.state === 'queue').length, idle: agents.filter((a) => a.state === 'idle').length, total: agents.length } };
  });
  R('GET', /^\/api\/agents\/([a-z0-9_]+)\/tasks$/, (q, m) => db.all(`SELECT id,title,status,created_by,created_at,finished_at,substr(result,1,500) result,error FROM tasks WHERE agent_id=? ORDER BY id DESC LIMIT 15`, m[1]));
  R('GET', /^\/api\/meetings$/, () => ({ meetings: meetingsView(db), heads: heads(db) }));
  R('POST', /^\/api\/meetings$/, (q, m, b) => createMeeting(ctx, { agenda: b.agenda, participants: b.participants, via: 'cabinet' }));
  // ---- маркетинг: тесты спроса ----
  const dir = { id: 'director:panel', name: 'Директор' };
  R('GET', /^\/api\/marketing$/, () => ({ tests: ctx.marketing.list(), platforms: { meta: ctx.marketing.platforms.meta.enabled, google: ctx.marketing.platforms.google.enabled }, base: cfg.baseCurrency,
    ads_month: db.get(`SELECT COALESCE(SUM(amount_base),0) s FROM ledger WHERE category='ads' AND direction='out' AND ts>=datetime('now','start of month')`).s }));
  R('GET', /^\/api\/marketing\/tests\/(\d+)$/, (q, m) => ctx.marketing.details(Number(m[1])) || (() => { throw Object.assign(new Error('Тест не найден'), { code: 404 }); })());
  R('POST', /^\/api\/marketing\/tests\/(\d+)\/(approve|reject)$/, (q, m, b) => ctx.marketing.decideTest(Number(m[1]), m[2] === 'approve', 'director:panel', b.note || ''));
  R('POST', /^\/api\/marketing\/tests\/(\d+)\/stop$/, (q, m, b) => ctx.marketing.stopTest(Number(m[1]), 'director:panel', b.reason || 'Остановлен директором'));
  R('POST', /^\/api\/marketing\/tests\/(\d+)\/verdict$/, (q, m, b) => ctx.marketing.decideVerdict(Number(m[1]), b.verdict, 'director:panel', b.note || ''));
  R('POST', /^\/api\/marketing\/tests\/(\d+)\/metrics$/, (q, m, b) => ctx.marketing.logMetrics(dir, { ...b, test_id: Number(m[1]) }));
  R('POST', /^\/api\/marketing\/campaigns\/(\d+)\/(activate|pause)$/, (q, m) => ctx.marketing.campaign(dir, { op: m[2], campaign_id: Number(m[1]), reason: 'Директор' }));
  R('POST', /^\/api\/marketing\/sync$/, () => ctx.marketing.sync());
  const socialView = () => ({ networks: Object.entries(SOCIAL).map(([k, v]) => ({ key: k, ...v, right: socialRights(db)[k], connected: ctx.social.has(k) })) });
  R('GET', /^\/api\/social$/, socialView);
  R('POST', /^\/api\/social$/, (q, m, b) => {
    if (!SOCIAL[b.network] || !['auto', 'approval', 'off'].includes(b.right)) throw Object.assign(new Error('network и right: auto | approval | off'), { code: 400 });
    db.setSetting('social_rights', { ...db.setting('social_rights', {}), [b.network]: b.right });
    db.audit('director:panel', 'social.rights', b);
    db.feed('🔑', `Права агентов: «${SOCIAL[b.network].title}» — ${RIGHTS_RU[b.right]}`);
    return socialView();
  });
  // ---- эффективность сотрудников ----
  R('GET', /^\/api\/hr$/, () => ctx.hr.overview());
  R('POST', /^\/api\/hr\/leave\/([\w-]+)$/, (q, m, b) => ctx.hr.sendOnLeave(m[1], 'director:panel', b.reason || 'решение директора'));
  R('POST', /^\/api\/hr\/recall\/([\w-]+)$/, (q, m) => ({ ok: ctx.hr.recall(m[1], 'вызван директором') }));
  R('POST', /^\/api\/hr\/replace\/(\d+)$/, (q, m, b) => ctx.hr.decideReplace(Number(m[1]), !!b.approve, 'director:panel'));
  // ---- сохранность наработок ----
  R('POST', /^\/api\/import\/simulator$/, (q, m, b) => importSimulator(db, b, 'director:panel'));
  R('GET', /^\/api\/export$/, () => { db.audit('director:panel', 'archive.export', {}); return exportCompany(db); });
  // ---- сопровождение проектов ----
  R('GET', /^\/api\/support$/, () => ctx.support.overview());
  R('POST', /^\/api\/support\/fate\/(\d+)$/, (q, m, b) => ctx.support.decideFate(Number(m[1]), b.decision, 'director:panel'));
  R('POST', /^\/api\/support\/budget$/, (q, m, b) => {
    const pid = Number(b.project_id), amount = Number(b.limit);
    const p = db.get('SELECT * FROM projects WHERE id=?', pid);
    if (!p || !(amount >= 0)) throw Object.assign(new Error('Нужны project_id и limit ≥ 0'), { code: 400 });
    const all = db.setting('project_budgets', {});
    all[pid] = { ...(all[pid] || {}), [b.stage || p.stage]: amount };
    db.setSetting('project_budgets', all);
    db.audit('director:panel', 'project.budget', b);
    db.feed('💶', `Бюджет «${p.name}» на этапе ${b.stage || p.stage}: ${amount} ${cfg.baseCurrency}`);
    return ctx.projectBudget(db.get('SELECT * FROM projects WHERE id=?', pid));
  });
  R('GET', /^\/api\/radar$/, () => ({
    adoptions: db.all(`SELECT a.*, g.name proposer FROM adoptions a LEFT JOIN agents g ON g.id=a.proposed_by ORDER BY CASE a.status WHEN 'proposed' THEN 0 WHEN 'pilot_done' THEN 1 WHEN 'security_review' THEN 2 WHEN 'pilot' THEN 3 ELSE 4 END, a.id DESC LIMIT 100`).map((x) => ({ ...x, status_ru: ADOPTION_RU[x.status] })),
    items: db.all(`SELECT id,source,title,url,summary,signal,verdict,relevance,assessment,fetched_at FROM radar_items ORDER BY CASE verdict WHEN 'pilot' THEN 0 WHEN 'watch' THEN 1 WHEN NULL THEN 2 ELSE 3 END, COALESCE(relevance,0) DESC, id DESC LIMIT 150`),
    digests: db.all(`SELECT id,title,created_at FROM documents WHERE kind IN ('digest','radar') ORDER BY id DESC LIMIT 14`),
    stats: db.get(`SELECT COUNT(*) total, SUM(verdict IS NULL) fresh, SUM(verdict='pilot') pilot, SUM(verdict='watch') watch FROM radar_items`),
  }));
  R('POST', /^\/api\/adoptions\/(\d+)\/(approve|reject)$/, (q, m, b) => decideAdoption(ctx, Number(m[1]), m[2] === 'approve', 'director:panel', b.note || ''));
  R('POST', /^\/api\/radar\/collect$/, async () => { const s = await collect(ctx); const task = dailyRadarTask(ctx); return { ...s, task }; });
  R('POST', /^\/api\/bank\/(\d+)\/resolve$/, (q, m, b) => resolveBankTx(db, Number(m[1]), b, 'director:panel'));
  R('POST', /^\/api\/bank\/sync$/, async () => {
    const fx = await updateRates(ctx).catch(() => null);
    const added = (ctx.revolut || ctx.paysera?.enabled) ? await importBanks(ctx) : 0;
    const rec = await reconcile(ctx);
    db.setSetting('bank_polled_at', Date.now());
    return { added, ...rec, fx: !!fx };
  });
  R('GET', /^\/api\/overview$/, () => ({ ...dailyMetrics(db, cfg), balances: balances(), questions_open: db.get(`SELECT COUNT(*) n FROM questions WHERE status='open'`).n, meetings_active: db.get(`SELECT COUNT(*) n FROM meetings WHERE status!='done'`).n, bank_unmatched: db.get(`SELECT COUNT(*) n FROM bank_tx WHERE status='unmatched'`).n, adoptions_waiting: db.get(`SELECT COUNT(*) n FROM adoptions WHERE status IN ('proposed','pilot_done')`).n, marketing_waiting: db.get(`SELECT COUNT(*) n FROM mk_tests WHERE status='proposed' OR (status='done' AND decision IS NULL)`).n, marketing_running: db.get(`SELECT COUNT(*) n FROM mk_tests WHERE status='running'`).n, hr_waiting: db.get(`SELECT COUNT(*) n FROM hr_reviews WHERE status='proposed'`).n, support_waiting: db.get(`SELECT (SELECT COUNT(*) FROM fate WHERE proposal IS NOT NULL AND decision IS NULL) + (SELECT COUNT(*) FROM tickets WHERE first_response_at IS NULL AND status NOT IN ('solved','closed') AND first_due<=datetime('now')) + (SELECT COUNT(*) FROM bugs WHERE level='P0' AND status NOT IN ('fixed','wontfix')) n`).n, paused: db.setting('paused', false), warnings: configWarnings(cfg), limits: cfg.limits, base: cfg.baseCurrency, telegram: !!ctx.telegram?.enabled }));
  R('GET', /^\/api\/actions$/, (q) => db.all(`SELECT a.*, g.name agent_name FROM actions a LEFT JOIN agents g ON g.id=a.agent_id WHERE (?='' OR a.status=?) ORDER BY a.id DESC LIMIT 200`, q.status || '', q.status || '').map((a) => ({ ...a, payload: J(a.payload, {}), result: J(a.result) })));
  R('GET', /^\/api\/projects$/, () => db.all(`SELECT p.*, (SELECT COALESCE(SUM(amount_base),0) FROM ledger l WHERE l.project_id=p.id AND l.direction='in') revenue FROM projects p ORDER BY p.id DESC`));
  R('GET', /^\/api\/tasks$/, (q) => db.all(`SELECT t.id,t.title,t.status,t.dept,t.agent_id,g.name agent_name,t.priority,t.created_by,t.project_id,t.created_at,t.finished_at,substr(t.result,1,600) result,t.error FROM tasks t LEFT JOIN agents g ON g.id=t.agent_id WHERE (?='' OR t.status=?) ORDER BY t.id DESC LIMIT 200`, q.status || '', q.status || ''));
  R('GET', /^\/api\/tasks\/(\d+)$/, (q, m) => db.get('SELECT * FROM tasks WHERE id=?', Number(m[1])));
  R('GET', /^\/api\/agents$/, () => db.all(`SELECT a.id,a.name,a.role,a.dept,a.head,a.enabled,a.email,(SELECT COUNT(*) FROM tasks t WHERE t.agent_id=a.id AND t.status='done') done,(SELECT COALESCE(SUM(cost_base),0) FROM runs r WHERE r.agent_id=a.id AND r.ts>=datetime('now','start of month')) cost_month FROM agents a ORDER BY a.enabled DESC, a.dept, a.head DESC`));
  R('GET', /^\/api\/departments$/, () => db.all('SELECT key,name FROM departments ORDER BY name'));
  R('GET', /^\/api\/documents$/, () => db.all(`SELECT d.id,d.title,d.kind,d.project_id,d.created_at,g.name agent_name FROM documents d LEFT JOIN agents g ON g.id=d.agent_id ORDER BY d.id DESC LIMIT 200`));
  R('GET', /^\/api\/documents\/(\d+)$/, (q, m) => db.get('SELECT * FROM documents WHERE id=?', Number(m[1])));
  R('GET', /^\/api\/ledger$/, () => db.all('SELECT * FROM ledger ORDER BY id DESC LIMIT 300'));
  R('GET', /^\/api\/feed$/, () => db.all('SELECT f.*, g.name agent_name FROM feed f LEFT JOIN agents g ON g.id=f.agent_id ORDER BY f.id DESC LIMIT 200'));
  R('GET', /^\/api\/audit$/, () => db.all('SELECT * FROM audit ORDER BY id DESC LIMIT 300'));

  // ---- решения директора ----
  R('POST', /^\/api\/actions\/(\d+)\/(approve|reject)$/, async (q, m, b) => ctx.actions.decide(Number(m[1]), m[2] === 'approve', 'director:panel', b.note || ''));
  R('POST', /^\/api\/actions\/(\d+)\/done$/, (q, m) => ctx.actions.markManualDone(Number(m[1]), 'director:panel'));
  R('POST', /^\/api\/projects\/(\d+)\/(approve|reject)$/, (q, m, b) => decideProject(ctx, Number(m[1]), m[2] === 'approve', 'director:panel', b.note || ''));
  R('POST', /^\/api\/tasks$/, (q, m, b) => {
    if (!b.title) throw Object.assign(new Error('Нужен заголовок задачи'), { code: 400 });
    const id = addTask(db, { title: String(b.title).slice(0, 200), body: b.body || '', dept: b.dept || null, agentId: b.agent_id || null, projectId: b.project_id || null, priority: Number(b.priority) || 3, createdBy: 'director' });
    db.audit('director:panel', 'task.created', { id, title: b.title });
    db.feed('📌', `Директор поставил задачу: «${b.title}»`, b.agent_id || null);
    return { id };
  });
  R('POST', /^\/api\/tasks\/(\d+)\/cancel$/, (q, m) => { db.run(`UPDATE tasks SET status='cancelled', finished_at=datetime('now') WHERE id=? AND status IN ('queued','blocked')`, Number(m[1])); return { ok: true }; });
  R('PATCH', /^\/api\/agents\/([a-z0-9_]+)$/, (q, m, b) => {
    const a = db.get('SELECT * FROM agents WHERE id=?', m[1]);
    if (!a) throw Object.assign(new Error('Нет агента'), { code: 404 });
    if (b.enabled !== undefined) db.run('UPDATE agents SET enabled=? WHERE id=?', b.enabled ? 1 : 0, a.id);
    if (b.email !== undefined) db.run('UPDATE agents SET email=? WHERE id=?', String(b.email || '').trim() || null, a.id);
    db.audit('director:panel', 'agent.updated', { id: a.id, ...b });
    if (b.enabled !== undefined) db.feed(b.enabled ? '🤝' : '🚪', `Директор ${b.enabled ? 'включил в штат' : 'вывел из штата'}: ${a.name}`, a.id);
    return db.get('SELECT id,name,enabled,email FROM agents WHERE id=?', a.id);
  });
  R('POST', /^\/api\/control$/, async (q, m, b) => {
    if (b.stopped !== undefined) { db.setSetting('stopped', !!b.stopped); db.feed(b.stopped ? '🛑' : '▶', b.stopped ? 'Директор включил режим «СТОП»' : 'Директор снял режим «СТОП»', null, b.stopped ? 'bad' : 'good'); }
    if (b.paused !== undefined) { db.setSetting('paused', !!b.paused); db.feed(b.paused ? '⏸' : '▶', b.paused ? 'Директор поставил агентов на паузу' : 'Агенты снова работают'); }
    if (b.stopped) await ctx.marketing.stopAllAds();
    db.audit('director:panel', 'control', b);
    return { stopped: db.setting('stopped', false), paused: db.setting('paused', false) };
  });
  R('POST', /^\/api\/ledger$/, (q, m, b) => {
    const amount = Number(b.amount), cur = String(b.currency || cfg.baseCurrency).toUpperCase();
    if (!(amount > 0) || !['in', 'out'].includes(b.direction)) throw Object.assign(new Error('Нужны direction in/out и сумма > 0'), { code: 400 });
    db.run(`INSERT INTO ledger(direction,category,amount,currency,amount_base,source,ref,project_id,note) VALUES(?,?,?,?,?,'manual',?,?,?)`,
      b.direction, b.category || 'other', amount, cur, toBase(cfg, amount, cur), 'm-' + Date.now(), b.project_id || null, b.note || '');
    db.audit('director:panel', 'ledger.manual', b);
    return { ok: true };
  });

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });
      if (req.method === 'GET' && (p === '/' || p === '/panel')) return send(res, 200, panel(), 'text/html; charset=utf-8');
      if (req.method === 'GET' && (p === '/tg' || p === '/tg/')) return send(res, 200, fs.readFileSync(path.join(cfg.root, 'public', 'miniapp.html'), 'utf8'), 'text/html; charset=utf-8');
      if (req.method === 'GET' && p === '/paid') return send(res, 200, '<!doctype html><meta charset="utf-8"><title>Спасибо</title><body style="font-family:sans-serif;padding:40px">Спасибо! Оплата обрабатывается — подтверждение придёт на почту.</body>', 'text/html; charset=utf-8');

      // Маркетинг: короткие ссылки с метками и счётчик лендингов (публично, без токена)
      if (req.method === 'GET' && p.startsWith('/go/')) {
        const loc = ctx.marketing.go(p.slice(4).replace(/[^A-Za-z0-9_-]/g, ''));
        if (!loc) return send(res, 404, 'Ссылка не найдена', 'text/plain; charset=utf-8');
        res.writeHead(302, { Location: loc, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
      }
      if (req.method === 'GET' && p === '/t.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
        return res.end(ctx.marketing.snippet());
      }
      if (p === '/t' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
        if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
        let body = {};
        try { const raw = await readBody(req); if (raw.length > 2000) throw new Error('big'); body = JSON.parse(raw || '{}'); } catch { res.writeHead(400, h); return res.end(); }
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        res.writeHead(ctx.marketing.track(body, ip).code, h); return res.end();
      }
      // Сопровождение: форма «Написать нам», опросы, оценка ответа (публично, без токена)
      if (p.startsWith('/support/') && (req.method === 'POST' || req.method === 'OPTIONS')) {
        const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
        if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
        let body = {};
        try { const raw = await readBody(req); if (raw.length > 8000) throw new Error('big'); body = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw)); } catch { res.writeHead(400, h); return res.end('{}'); }
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const r = ctx.support.formSubmit(p.slice(9), body, ip);
        res.writeHead(r.code, h); return res.end(JSON.stringify(r.code === 200 ? { ok: true, ticket: r.id } : { ok: false }));
      }
      if (p.startsWith('/s/')) {
        const tok = p.slice(3);
        if (req.method === 'POST') {
          let body = {}; try { body = Object.fromEntries(new URLSearchParams(await readBody(req))); } catch {}
          ctx.support.surveyAnswer(tok, body);
        }
        const page = ctx.support.surveyPage(tok);
        return page ? send(res, 200, page, 'text/html; charset=utf-8') : send(res, 404, 'Не найдено', 'text/plain; charset=utf-8');
      }
      if (req.method === 'GET' && /^\/r\/[^/]+\/[01]$/.test(p)) {
        const [, , tok, v] = p.split('/');
        const ok = ctx.support.rate(tok, v === '1');
        return send(res, ok ? 200 : 404, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;padding:40px;max-width:520px;margin:auto">${ok ? (v === '1' ? 'Спасибо! Рады, что помогли.' : 'Спасибо за честность — мы разберёмся и ответим ещё раз.') : 'Ссылка устарела.'}</body>`, 'text/html; charset=utf-8');
      }
      if (req.method === 'POST' && p === '/webhooks/stripe') {
        const raw = await readBody(req);
        if (!verifyStripeSignature(raw, req.headers['stripe-signature'], cfg.stripe.webhookSecret)) return send(res, 400, { error: 'bad signature' });
        const ev = JSON.parse(raw);
        const msg = handleStripeEvent(db, cfg, ev);
        try { ctx.marketing.attributeStripe(ev); } catch (e) { ctx.log?.error('mk attribution', e.message); }
        ctx.support.onStripe(ev).catch((e) => ctx.log?.error('support stripe', e.message));
        db.audit('stripe', 'webhook', { id: ev.id, type: ev.type });
        if (msg) { db.feed('💰', msg, null, 'good'); ctx.notify?.(msg); }
        return send(res, 200, { received: true });
      }
      if (req.method === 'POST' && p === '/webhooks/yookassa') {
        const key = process.env.YOOKASSA_WEBHOOK_KEY;
        if (key && url.searchParams.get('k') !== key) return send(res, 403, { error: 'forbidden' });
        const body = JSON.parse(await readBody(req) || '{}');
        const msg = await handleYookassaNotification(db, cfg, body, ctx.yookassa || yookassaClient(cfg, ctx.fetch));
        db.audit('yookassa', 'webhook', { event: body.event, id: body.object?.id });
        if (msg) { db.feed('💰', msg, null, 'good'); ctx.notify?.(msg); }
        return send(res, 200, { ok: true });
      }

      if (p.startsWith('/api/')) {
        const a = authed(req);
        if (a === 'locked') return send(res, 429, { error: 'Слишком много неверных попыток, подождите 15 минут' });
        if (!a) return send(res, 401, { error: 'Нужен токен директора' });
        const r = routes.find((x) => x.method === req.method && x.re.test(p));
        if (!r) return send(res, 404, { error: 'not found' });
        const body = ['POST', 'PATCH'].includes(req.method) ? JSON.parse((await readBody(req, p === '/api/import/simulator' ? 30e6 : MAX_BODY)) || '{}') : {};
        const out = await r.fn(Object.fromEntries(url.searchParams), p.match(r.re), body);
        return send(res, 200, out ?? null);
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      ctx.log?.error('http', p, e.message);
      return send(res, e.code && e.code < 600 ? e.code : 500, { error: e.message || 'error' });
    }
  }

  return { handler, listen(port) { const s = http.createServer(handler); s.listen(port); return s; } };
}
