// Действия агентов во внешнем мире: предложить → политика → (подтверждение) → исполнить → учёт.
import crypto from 'node:crypto';
import { evaluate, KINDS, round2 } from './policy.js';
import { J } from './db.js';
import { scanOutbound, redactSecrets } from './guard.js';

export function createActions(ctx) {
  const { db, cfg } = ctx;
  const executors = ctx.executors || {};
  const listeners = [];
  const emit = (ev, a) => listeners.forEach((f) => { try { f(ev, a); } catch (e) { ctx.log?.error('listener', e); } });

  const get = (id) => { const a = db.get('SELECT * FROM actions WHERE id=?', id); if (a) { a.payload = J(a.payload, {}); a.result = J(a.result); } return a; };

  async function propose({ kind, payload = {}, amount = 0, currency, agentId = null, taskId = null, idemKey }) {
    const key = idemKey || crypto.createHash('sha256').update(JSON.stringify([kind, payload, amount, currency, agentId, taskId])).digest('hex').slice(0, 32);
    const dup = db.get('SELECT id FROM actions WHERE idem_key=?', key);
    if (dup) return get(dup.id);
    // Шлюз секретов: ключи, токены и номера карт не уходят наружу ни при каком режиме политики
    const secrets = scanOutbound(payload);
    if (secrets.length) payload = redactSecrets(payload);
    const ev = secrets.length ? { decision: 'deny', reason: `В тексте найден секрет (${secrets.join(', ')}) — отправка запрещена, секрет вырезан`, amountBase: 0 } : evaluate(db, cfg, { kind, payload, amount, currency });
    const status = ev.decision === 'auto' ? 'auto' : ev.decision === 'deny' ? 'denied' : 'pending';
    const cur = (currency || cfg.baseCurrency).toUpperCase();
    const r = db.run(`INSERT INTO actions(task_id,agent_id,kind,payload,amount,currency,amount_base,status,policy_reason,idem_key) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      taskId, agentId, kind, JSON.stringify(payload), amount || 0, cur, ev.amountBase || 0, status, ev.reason, key);
    const a = get(Number(r.lastInsertRowid));
    db.audit(agentId || 'system', 'action.proposed', { id: a.id, kind, status, reason: ev.reason, amount, currency: cur });
    const who = agentId ? (db.get('SELECT name FROM agents WHERE id=?', agentId)?.name || agentId) : 'Система';
    if (status === 'pending') { db.feed('⏳', `${who}: «${KINDS[kind].title}» ждёт решения директора — ${ev.reason}`, agentId, 'warn'); emit('pending', a); }
    if (status === 'denied') db.feed('⛔', `${who}: действие «${kind}» отклонено политикой — ${ev.reason}`, agentId, 'bad');
    if (secrets.length) { db.audit('guard', 'guard.secret_blocked', { action: a.id, kind, agent: agentId, found: secrets }); ctx.notify?.(`🛡 ${who} пытался(ась) отправить наружу секрет (${secrets.join(', ')}) в действии «${KINDS[kind]?.title || kind}». Отправка запрещена, секрет вырезан из базы. Проверьте, откуда он у агента, и при необходимости смените ключ.`); }
    if (status === 'auto') return execute(a.id);
    return a;
  }

  async function decide(id, approve, by = 'director', note = '') {
    const a = get(id);
    if (!a) throw new Error('Действие не найдено');
    if (a.status !== 'pending') return a;
    db.run(`UPDATE actions SET status=?, decided_by=?, decided_at=datetime('now') WHERE id=?`, approve ? 'approved' : 'rejected', by, id);
    db.audit(by, approve ? 'action.approved' : 'action.rejected', { id, note });
    db.feed(approve ? '✅' : '✖', `Директор ${approve ? 'одобрил' : 'отклонил'}: «${KINDS[a.kind]?.title || a.kind}» (#${id})${note ? ' — ' + note : ''}`, a.agent_id, approve ? 'good' : 'info');
    const res = approve ? await execute(id) : get(id);
    emit('decided', res);
    return res;
  }

  async function execute(id) {
    const a = get(id);
    if (!a || !['auto', 'approved'].includes(a.status)) return a;
    if (db.setting('stopped', false)) {
      db.run(`UPDATE actions SET status='pending', policy_reason='Включён режим «СТОП» — исполнение приостановлено' WHERE id=?`, id);
      return get(id);
    }
    const ex = executors[a.kind];
    try {
      const out = ex ? await ex(a, ctx) : { status: 'manual', result: { note: 'Нет подключённой интеграции — выполните вручную и отметьте в пульте' } };
      const st = out.status || 'executed';
      db.tx(() => {
        db.run(`UPDATE actions SET status=?, result=?, executed_at=datetime('now') WHERE id=?`, st, JSON.stringify(out.result ?? null), id);
        if (a.kind === 'spend' && st === 'executed') {
          db.run(`INSERT OR IGNORE INTO ledger(direction,category,amount,currency,amount_base,source,ref,project_id,note) VALUES('out',?,?,?,?,?,?,?,?)`,
            a.payload.category || 'services', a.amount, a.currency, a.amount_base, 'action', String(id), a.payload.project_id || null, a.payload.vendor || a.payload.purpose || '');
        }
      });
      db.audit('system', 'action.' + st, { id, kind: a.kind });
      if (st === 'manual') { db.feed('🖐', `Нужно выполнить вручную: «${KINDS[a.kind].title}» (#${id}) — ${out.result?.note || ''}`, a.agent_id, 'warn'); emit('manual', get(id)); }
      else { emit('executed', get(id)); db.feed('📤', `Выполнено: «${KINDS[a.kind].title}» (#${id})${a.amount_base ? ' · ' + round2(a.amount_base) + ' ' + cfg.baseCurrency : ''}`, a.agent_id, 'good'); }
    } catch (e) {
      db.run(`UPDATE actions SET status='failed', error=?, executed_at=datetime('now') WHERE id=?`, String(e.message || e).slice(0, 1000), id);
      db.audit('system', 'action.failed', { id, error: String(e.message || e) });
      db.feed('⚠️', `Ошибка при выполнении «${KINDS[a.kind]?.title || a.kind}» (#${id}): ${e.message || e}`, a.agent_id, 'bad');
      emit('failed', get(id));
    }
    return get(id);
  }

  // Директор отметил, что выполнил ручное действие (например, оплатил счёт сам)
  function markManualDone(id, by = 'director') {
    const a = get(id);
    if (!a || a.status !== 'manual') return a;
    db.tx(() => {
      db.run(`UPDATE actions SET status='executed', executed_at=datetime('now') WHERE id=?`, id);
      if (a.kind === 'spend') db.run(`INSERT OR IGNORE INTO ledger(direction,category,amount,currency,amount_base,source,ref,note) VALUES('out',?,?,?,?,?,?,?)`,
        a.payload.category || 'services', a.amount, a.currency, a.amount_base, 'action', String(id), a.payload.vendor || '');
    });
    db.audit(by, 'action.manual_done', { id });
    return get(id);
  }

  return { propose, decide, execute, markManualDone, get, on: (f) => listeners.push(f) };
}
