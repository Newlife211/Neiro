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
import { answerQuestion, giveOrder, createMeeting, meetingsView, heads } from './director.js';

const MAX_BODY = 1_000_000;
const readBody = (req) => new Promise((res, rej) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { rej(new Error('too large')); req.destroy(); } else chunks.push(c); });
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
  R('GET', /^\/api\/meetings$/, () => ({ meetings: meetingsView(db), heads: heads(db) }));
  R('POST', /^\/api\/meetings$/, (q, m, b) => createMeeting(ctx, { agenda: b.agenda, participants: b.participants, via: 'cabinet' }));
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
  R('GET', /^\/api\/overview$/, () => ({ ...dailyMetrics(db, cfg), balances: balances(), questions_open: db.get(`SELECT COUNT(*) n FROM questions WHERE status='open'`).n, meetings_active: db.get(`SELECT COUNT(*) n FROM meetings WHERE status!='done'`).n, bank_unmatched: db.get(`SELECT COUNT(*) n FROM bank_tx WHERE status='unmatched'`).n, adoptions_waiting: db.get(`SELECT COUNT(*) n FROM adoptions WHERE status IN ('proposed','pilot_done')`).n, paused: db.setting('paused', false), warnings: configWarnings(cfg), limits: cfg.limits, base: cfg.baseCurrency, telegram: !!ctx.telegram?.enabled }));
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
  R('POST', /^\/api\/control$/, (q, m, b) => {
    if (b.stopped !== undefined) { db.setSetting('stopped', !!b.stopped); db.feed(b.stopped ? '🛑' : '▶', b.stopped ? 'Директор включил режим «СТОП»' : 'Директор снял режим «СТОП»', null, b.stopped ? 'bad' : 'good'); }
    if (b.paused !== undefined) { db.setSetting('paused', !!b.paused); db.feed(b.paused ? '⏸' : '▶', b.paused ? 'Директор поставил агентов на паузу' : 'Агенты снова работают'); }
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

      if (req.method === 'POST' && p === '/webhooks/stripe') {
        const raw = await readBody(req);
        if (!verifyStripeSignature(raw, req.headers['stripe-signature'], cfg.stripe.webhookSecret)) return send(res, 400, { error: 'bad signature' });
        const ev = JSON.parse(raw);
        const msg = handleStripeEvent(db, cfg, ev);
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
        const body = ['POST', 'PATCH'].includes(req.method) ? JSON.parse((await readBody(req)) || '{}') : {};
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
