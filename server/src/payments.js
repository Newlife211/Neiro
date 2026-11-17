// Платежи: Stripe (ЕС/международно) и ЮKassa (РФ). Деньги поступают напрямую на ваши счета у провайдеров;
// сервер только создаёт ссылки на оплату и записывает подтверждённые оплаты в учёт.
import crypto from 'node:crypto';
import { toBase } from './policy.js';

const form = (obj, prefix = '', out = []) => {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out); else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
};
const ZERO_DEC = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF']);
export const toMinor = (amount, cur) => (ZERO_DEC.has(cur.toUpperCase()) ? Math.round(amount) : Math.round(amount * 100));
export const fromMinor = (v, cur) => (ZERO_DEC.has(cur.toUpperCase()) ? v : v / 100);

// ---------------- Stripe ----------------
export function stripeClient(cfg, fetchImpl = fetch) {
  const call = async (method, path, body, idem) => {
    if (!cfg.stripe.secretKey) throw new Error('Stripe не настроен (STRIPE_SECRET_KEY)');
    const headers = { Authorization: 'Bearer ' + cfg.stripe.secretKey, 'Content-Type': 'application/x-www-form-urlencoded' };
    if (idem) headers['Idempotency-Key'] = idem;
    const r = await fetchImpl('https://api.stripe.com/v1' + path, { method, headers, body: body ? form(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error('Stripe: ' + (j.error?.message || r.status));
    return j;
  };
  return {
    // Постоянная ссылка на оплату (Payment Link). recurring: 'month' | 'year' | undefined
    async createPaymentLink({ title, amount, currency, recurring, projectId, idem }) {
      const cur = currency.toLowerCase();
      const price = await call('POST', '/prices', {
        currency: cur, unit_amount: toMinor(amount, cur), product_data: { name: title.slice(0, 250) },
        recurring: recurring ? { interval: recurring } : undefined,
      }, idem && idem + '-price');
      const meta = { project_id: projectId ?? '' };
      const link = await call('POST', '/payment_links', {
        line_items: { 0: { price: price.id, quantity: 1 } }, metadata: meta,
        ...(recurring ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } }),
      }, idem && idem + '-link');
      return { extId: link.id, url: link.url };
    },
    async refund({ paymentIntent, amount, currency }) {
      return call('POST', '/refunds', { payment_intent: paymentIntent, amount: amount ? toMinor(amount, currency) : undefined });
    },
  };
}

export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = header.split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

function linkProject(db, provider, extId) {
  return db.get('SELECT project_id FROM payment_links WHERE provider=? AND ext_id=?', provider, extId)?.project_id ?? null;
}
function addIncome(db, cfg, { source, ref, amount, currency, projectId, note }) {
  const r = db.run(`INSERT OR IGNORE INTO ledger(direction,category,amount,currency,amount_base,source,ref,project_id,note) VALUES('in','revenue',?,?,?,?,?,?,?)`,
    amount, currency.toUpperCase(), toBase(cfg, amount, currency), source, ref, projectId, note || '');
  return r.changes > 0;
}
function addRefund(db, cfg, { source, ref, amount, currency, projectId, note }) {
  const r = db.run(`INSERT OR IGNORE INTO ledger(direction,category,amount,currency,amount_base,source,ref,project_id,note) VALUES('out','refund',?,?,?,?,?,?,?)`,
    amount, currency.toUpperCase(), toBase(cfg, amount, currency), source, ref, projectId, note || '');
  return r.changes > 0;
}

// Обработка события Stripe (подпись уже проверена). Возвращает описание для ленты или null.
export function handleStripeEvent(db, cfg, ev) {
  const o = ev.data?.object || {};
  if (ev.type === 'checkout.session.completed' && o.mode === 'payment' && o.payment_status === 'paid') {
    const cur = o.currency.toUpperCase(), amount = fromMinor(o.amount_total, cur);
    const pid = (o.payment_link && linkProject(db, 'stripe', o.payment_link)) ?? (Number(o.metadata?.project_id) || null);
    if (addIncome(db, cfg, { source: 'stripe', ref: o.id, amount, currency: cur, projectId: pid, note: o.customer_details?.email || '' })) return `💰 Оплата Stripe: ${amount} ${cur}`;
  }
  if (ev.type === 'invoice.paid' && o.amount_paid > 0) {
    const cur = o.currency.toUpperCase(), amount = fromMinor(o.amount_paid, cur);
    const pid = Number(o.subscription_details?.metadata?.project_id || o.lines?.data?.[0]?.metadata?.project_id) || null;
    if (addIncome(db, cfg, { source: 'stripe', ref: o.id, amount, currency: cur, projectId: pid, note: 'подписка ' + (o.customer_email || '') })) return `💰 Оплата подписки Stripe: ${amount} ${cur}`;
  }
  if (ev.type === 'charge.refunded') {
    const cur = o.currency.toUpperCase(), amount = fromMinor(o.amount_refunded, cur);
    if (addRefund(db, cfg, { source: 'stripe', ref: 'refund-' + o.id, amount, currency: cur, projectId: Number(o.metadata?.project_id) || null })) return `↩️ Возврат Stripe: ${amount} ${cur}`;
  }
  return null;
}

// ---------------- ЮKassa ----------------
export function yookassaClient(cfg, fetchImpl = fetch) {
  const call = async (method, path, body, idem) => {
    if (!cfg.yookassa.shopId || !cfg.yookassa.secretKey) throw new Error('ЮKassa не настроена (YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY)');
    const headers = { Authorization: 'Basic ' + Buffer.from(cfg.yookassa.shopId + ':' + cfg.yookassa.secretKey).toString('base64'), 'Content-Type': 'application/json' };
    if (method === 'POST') headers['Idempotence-Key'] = idem || crypto.randomUUID();
    const r = await fetchImpl('https://api.yookassa.ru/v3' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error('ЮKassa: ' + (j.description || r.status));
    return j;
  };
  return {
    async createPayment({ title, amount, currency = 'RUB', projectId, customerEmail, idem }) {
      const body = {
        amount: { value: amount.toFixed(2), currency: currency.toUpperCase() }, capture: true,
        confirmation: { type: 'redirect', return_url: cfg.publicUrl + '/paid' },
        description: title.slice(0, 128), metadata: { project_id: String(projectId ?? '') },
      };
      // Чек по 54-ФЗ: включите YOOKASSA_RECEIPTS=1 и укажите систему налогообложения/НДС (сверьте с бухгалтером)
      if (process.env.YOOKASSA_RECEIPTS === '1') {
        if (!customerEmail) throw new Error('Для чека нужен email покупателя');
        body.receipt = {
          customer: { email: customerEmail },
          items: [{ description: title.slice(0, 128), quantity: '1.00', amount: body.amount, vat_code: Number(process.env.YOOKASSA_VAT_CODE || 1), payment_subject: 'service', payment_mode: 'full_payment' }],
        };
      }
      const p = await call('POST', '/payments', body, idem);
      return { extId: p.id, url: p.confirmation?.confirmation_url };
    },
    getPayment: (id) => call('GET', '/payments/' + encodeURIComponent(id)),
    getRefund: (id) => call('GET', '/refunds/' + encodeURIComponent(id)),
    refund: ({ paymentId, amount, currency = 'RUB' }) => call('POST', '/refunds', { payment_id: paymentId, amount: { value: amount.toFixed(2), currency } }),
  };
}

// Уведомление ЮKassa: данные в теле не доверяем — перепроверяем статус через API.
export async function handleYookassaNotification(db, cfg, body, yk) {
  const ev = body?.event, id = body?.object?.id;
  if (!ev || !id) return null;
  if (ev === 'payment.succeeded') {
    const p = await yk.getPayment(id);
    if (p.status !== 'succeeded' || !p.paid) return null;
    const amount = Number(p.amount.value), cur = p.amount.currency;
    const pid = linkProject(db, 'yookassa', p.id) ?? (Number(p.metadata?.project_id) || null);
    db.run(`UPDATE payment_links SET status='paid' WHERE provider='yookassa' AND ext_id=?`, p.id);
    if (addIncome(db, cfg, { source: 'yookassa', ref: p.id, amount, currency: cur, projectId: pid, note: p.description || '' })) return `💰 Оплата ЮKassa: ${amount} ${cur}`;
  }
  if (ev === 'refund.succeeded') {
    const r = await yk.getRefund(id);
    if (r.status !== 'succeeded') return null;
    const amount = Number(r.amount.value), cur = r.amount.currency;
    if (addRefund(db, cfg, { source: 'yookassa', ref: 'refund-' + r.id, amount, currency: cur, projectId: linkProject(db, 'yookassa', r.payment_id) })) return `↩️ Возврат ЮKassa: ${amount} ${cur}`;
  }
  return null;
}
