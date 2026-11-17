// Банковские выписки (Revolut, Paysera) и автоматическая сверка с учётом компании.
import { toBase, round2 } from './policy.js';
import { J } from './db.js';

const PROVIDER_PAYOUT = /stripe|yookassa|юkassa|yoomoney|юmoney|paddle/i;

export function insertBankTx(db, cfg, t) {
  const amountBase = toBase(cfg, Math.abs(t.amount), t.currency) * Math.sign(t.amount);
  return db.run(`INSERT OR IGNORE INTO bank_tx(provider,ext_id,account,ts,amount,currency,amount_base,description,counterparty,card_id,kind,raw)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, t.provider, t.extId, t.account || null, t.ts, t.amount, t.currency.toUpperCase(), round2(amountBase),
    (t.description || '').slice(0, 500), (t.counterparty || '').slice(0, 200), t.cardId || null, t.kind || null, JSON.stringify(t.raw ?? null)).changes > 0;
}

// ---- Revolut ----
export function mapRevolutTx(tx) {
  if (tx.state && !['completed'].includes(tx.state)) return [];
  const internal = tx.type === 'exchange' || (tx.legs || []).length > 1 || tx.type === 'transfer' && (tx.legs || []).every((l) => !l.counterparty || l.counterparty.account_type === 'self');
  return (tx.legs || []).map((l, i) => ({
    provider: 'revolut', extId: tx.id + ':' + (l.leg_id || i), account: l.account_id, ts: tx.completed_at || tx.created_at,
    amount: Number(l.amount), currency: l.currency, description: l.description || tx.reference || tx.merchant?.name || '',
    counterparty: tx.merchant?.name || l.counterparty?.name || '', cardId: tx.card?.id || null, kind: internal ? 'internal' : tx.type, raw: { type: tx.type, id: tx.id },
  }));
}

// ---- Paysera (персональный токен доступа, только чтение: statements:read) ----
export function payseraConfig(env = process.env) {
  return { enabled: !!(env.PAYSERA_TOKEN && env.PAYSERA_ACCOUNT), token: env.PAYSERA_TOKEN || '', accounts: (env.PAYSERA_ACCOUNT || '').split(',').map((s) => s.trim()).filter(Boolean) };
}
export function mapPayseraStatement(s, account) {
  const amt = typeof s.amount === 'object' ? s.amount : { amount: s.amount, currency: s.currency };
  let v = Number(amt.amount);
  if (s.direction === 'out' || s.type === 'debit') v = -Math.abs(v);
  if (s.direction === 'in' || s.type === 'credit') v = Math.abs(v);
  const ts = s.date ? (typeof s.date === 'number' ? new Date(s.date * 1000).toISOString() : s.date) : (s.created_at || new Date().toISOString());
  return { provider: 'paysera', extId: String(s.id ?? s.statement_id ?? `${account}:${ts}:${v}`), account, ts, amount: v, currency: amt.currency || 'EUR',
    description: s.details || s.purpose || s.description || '', counterparty: s.other_party?.name || s.counterparty?.name || s.beneficiary_name || '', kind: 'transfer', raw: s };
}

export async function importBanks(ctx) {
  const { db, cfg } = ctx;
  const f = ctx.fetch || fetch;
  let added = 0;
  const since = db.setting('bank_since') || new Date(Date.now() - 30 * 86400000).toISOString();
  if (ctx.revolut) {
    try {
      const accts = await ctx.revolut.accounts();
      db.setSetting('bank_balances_revolut', (accts || []).filter((a) => a.state === 'active').map((a) => ({ bank: 'Revolut', name: a.name, balance: a.balance, currency: a.currency })));
      const txs = await ctx.revolut.transactions(since);
      for (const tx of txs || []) for (const t of mapRevolutTx(tx)) if (insertBankTx(db, cfg, t)) added++;
    } catch (e) { ctx.log?.error('revolut import', e.message); db.feed('⚠️', 'Revolut: ' + e.message, null, 'bad'); }
  }
  const ps = ctx.paysera;
  if (ps?.enabled) {
    const balances = [];
    for (const acc of ps.accounts) {
      try {
        const H = { Authorization: 'Bearer ' + ps.token };
        const fromUnix = Math.floor(new Date(since).getTime() / 1000);
        const r = await f(`https://api.paysera.com/public/account/rest/v1/accounts/${encodeURIComponent(acc)}/statements?from=${fromUnix}&limit=200`, { headers: H });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error_description || j.error || r.status);
        for (const s of j.statements || j.items || (Array.isArray(j) ? j : [])) if (insertBankTx(db, cfg, mapPayseraStatement(s, acc))) added++;
        const b = await f(`https://api.paysera.com/public/account/rest/v1/accounts/${encodeURIComponent(acc)}/full-balance`, { headers: H });
        if (b.ok) { const bj = await b.json(); for (const x of bj.balances || bj.items || (Array.isArray(bj) ? bj : [])) if (x.at_disposal) balances.push({ bank: 'Paysera', name: acc, balance: Number(x.at_disposal.amount), currency: x.at_disposal.currency }); }
      } catch (e) { ctx.log?.error('paysera import', e.message); db.feed('⚠️', 'Paysera: ' + e.message, null, 'bad'); }
    }
    db.setSetting('bank_balances_paysera', balances);
  }
  // следующая выгрузка — с запасом в 3 дня назад (операции могут проводиться с задержкой)
  db.setSetting('bank_since', new Date(Date.now() - 3 * 86400000).toISOString());
  return added;
}

/**
 * Сверка: каждой операции банка ищем объяснение.
 *  1) списание с карты, выпущенной под трату агента → трата закрыта фактической суммой;
 *  2) поступление от Stripe/ЮKassa → выплата провайдера (выручка уже учтена по вебхуку);
 *  3) перевод между своими счетами / обмен → внутренняя операция;
 *  4) та же сумма в учёте в пределах 3 дней → связать;
 *  иначе — «требует внимания» директора.
 */
export async function reconcile(ctx) {
  const { db, cfg } = ctx;
  const res = { cards: 0, payouts: 0, internal: 0, linked: 0, unmatched: 0 };
  const rows = db.all(`SELECT * FROM bank_tx WHERE status='new' ORDER BY ts`);
  for (const t of rows) {
    // 1) карта под трату
    if (t.card_id && t.amount < 0) {
      const a = db.get(`SELECT * FROM actions WHERE kind='spend' AND json_extract(result,'$.card_id')=? LIMIT 1`, t.card_id);
      if (a) {
        db.tx(() => {
          db.run(`INSERT OR IGNORE INTO ledger(direction,category,amount,currency,amount_base,source,ref,project_id,note) VALUES('out',?,?,?,?,'action',?,?,?)`,
            J(a.payload, {}).category || 'services', Math.abs(t.amount), t.currency, Math.abs(t.amount_base), String(a.id), J(a.payload, {}).project_id || null, (J(a.payload, {}).vendor || '') + ' · карта Revolut');
          const led = db.get(`SELECT id FROM ledger WHERE source='action' AND ref=?`, String(a.id));
          db.run(`UPDATE bank_tx SET status='matched', action_id=?, ledger_id=? WHERE id=?`, a.id, led?.id ?? null, t.id);
          if (a.status === 'manual') db.run(`UPDATE actions SET status='executed', executed_at=datetime('now') WHERE id=?`, a.id);
        });
        db.feed('💳', `Трата #${a.id} оплачена картой: ${Math.abs(t.amount)} ${t.currency} (${t.counterparty || t.description})`, a.agent_id, 'good');
        if (ctx.revolut && ctx.revolutCfg?.terminateAfterUse) { try { await ctx.revolut.terminateCard(t.card_id); } catch (e) { ctx.log?.error('terminate card', e.message); } }
        res.cards++; continue;
      }
    }
    // 2) выплаты платёжных провайдеров
    if (t.amount > 0 && PROVIDER_PAYOUT.test(`${t.description} ${t.counterparty}`)) { db.run(`UPDATE bank_tx SET status='payout' WHERE id=?`, t.id); res.payouts++; continue; }
    // 3) внутренние переводы и обмены
    if (t.kind === 'internal') { db.run(`UPDATE bank_tx SET status='internal' WHERE id=?`, t.id); res.internal++; continue; }
    // 4) совпадение с записью в учёте
    const dir = t.amount > 0 ? 'in' : 'out';
    const led = db.get(`SELECT l.id FROM ledger l WHERE l.direction=? AND ABS(l.amount_base-?)<=0.01 AND ABS(julianday(l.ts)-julianday(?))<=3
      AND l.source NOT IN ('stripe','yookassa') AND NOT EXISTS (SELECT 1 FROM bank_tx b WHERE b.ledger_id=l.id) ORDER BY ABS(julianday(l.ts)-julianday(?)) LIMIT 1`, dir, Math.abs(t.amount_base), t.ts, t.ts);
    if (led) { db.run(`UPDATE bank_tx SET status='matched', ledger_id=? WHERE id=?`, led.id, t.id); res.linked++; continue; }
    db.run(`UPDATE bank_tx SET status='unmatched' WHERE id=?`, t.id); res.unmatched++;
  }
  if (res.unmatched) db.feed('🔎', `Сверка: ${res.unmatched} операций банка без объяснения — посмотрите вкладку «Сверка»`, null, 'warn');
  return res;
}

// Решение директора по необъяснённой операции
export function resolveBankTx(db, id, { as, category, note }, by = 'director') {
  const t = db.get('SELECT * FROM bank_tx WHERE id=?', id);
  if (!t) throw Object.assign(new Error('Операция не найдена'), { code: 404 });
  if (!['unmatched', 'new'].includes(t.status)) return t;
  if (as === 'expense' || as === 'income') {
    const dir = as === 'income' ? 'in' : 'out';
    const r = db.run(`INSERT OR IGNORE INTO ledger(ts,direction,category,amount,currency,amount_base,source,ref,note) VALUES(?,?,?,?,?,?,'bank',?,?)`,
      t.ts, dir, category || (dir === 'in' ? 'other_income' : 'other'), Math.abs(t.amount), t.currency, Math.abs(t.amount_base), `${t.provider}:${t.ext_id}`, note || t.counterparty || t.description);
    const led = db.get(`SELECT id FROM ledger WHERE source='bank' AND ref=?`, `${t.provider}:${t.ext_id}`);
    db.run(`UPDATE bank_tx SET status='matched', ledger_id=?, note=? WHERE id=?`, led?.id ?? null, note || null, id);
    void r;
  } else {
    db.run(`UPDATE bank_tx SET status=?, note=? WHERE id=?`, as === 'internal' ? 'internal' : 'ignored', note || null, id);
  }
  db.audit(by, 'bank.resolved', { id, as, category });
  return db.get('SELECT * FROM bank_tx WHERE id=?', id);
}
