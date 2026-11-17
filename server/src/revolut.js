// Revolut Business API: OAuth 2.0 с подписанным JWT (private_key_jwt), виртуальные карты, счета, операции.
// Данные карт (номер, CVV) сервер НЕ читает: доступ READ_SENSITIVE_CARD_DATA не нужен и не запрашивается.
import crypto from 'node:crypto';
import fs from 'node:fs';

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function clientAssertion({ clientId, iss, privateKeyPem, nowSec = Math.floor(Date.now() / 1000) }) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss, sub: clientId, aud: 'https://revolut.com', exp: nowSec + 60 * 60 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

export function revolutConfig(env = process.env) {
  const sandbox = (env.REVOLUT_ENV || 'production') === 'sandbox';
  let key = env.REVOLUT_PRIVATE_KEY || '';
  if (!key && env.REVOLUT_PRIVATE_KEY_PATH && fs.existsSync(env.REVOLUT_PRIVATE_KEY_PATH)) key = fs.readFileSync(env.REVOLUT_PRIVATE_KEY_PATH, 'utf8');
  return {
    enabled: !!(env.REVOLUT_CLIENT_ID && key && (env.REVOLUT_REFRESH_TOKEN)),
    base: sandbox ? 'https://sandbox-b2b.revolut.com/api/1.0' : 'https://b2b.revolut.com/api/1.0',
    clientId: env.REVOLUT_CLIENT_ID || '', iss: env.REVOLUT_JWT_ISS || '', privateKeyPem: key,
    refreshToken: env.REVOLUT_REFRESH_TOKEN || '',
    cardCurrency: (env.REVOLUT_CARD_CURRENCY || 'EUR').toUpperCase(), // должна совпадать с основной валютой бизнеса в Revolut
    contactIds: (env.REVOLUT_CARD_CONTACT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    accountIds: (env.REVOLUT_CARD_ACCOUNT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    cardDays: Number(env.REVOLUT_CARD_DAYS || 14),
    terminateAfterUse: env.REVOLUT_TERMINATE_AFTER_USE !== '0',
  };
}

export function revolutClient(rc, db, fetchImpl = fetch) {
  async function token() {
    const t = db.setting('revolut_token');
    if (t && t.exp > Date.now() + 60000) return t.access;
    const body = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: db.setting('revolut_refresh') || rc.refreshToken, client_id: rc.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion(rc),
    });
    const r = await fetchImpl(rc.base + '/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const j = await r.json();
    if (!r.ok || !j.access_token) throw new Error('Revolut auth: ' + (j.error_description || j.error || r.status));
    db.setSetting('revolut_token', { access: j.access_token, exp: Date.now() + (j.expires_in || 2400) * 1000 });
    if (j.refresh_token) db.setSetting('revolut_refresh', j.refresh_token);
    return j.access_token;
  }
  async function call(method, path, body) {
    const r = await fetchImpl(rc.base + path, { method, headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Revolut ${method} ${path}: ${j.message || j.error || r.status}`);
    return j;
  }
  return {
    call,
    accounts: () => call('GET', '/accounts'),
    transactions: (fromIso) => call('GET', `/transactions?from=${encodeURIComponent(fromIso)}&count=1000`),
    // Карта под одну трату: лимит ровно на сумму, срок действия ограничен, метка с номером действия.
    async createSpendCard({ actionId, amount, vendor }) {
      const end = new Date(Date.now() + rc.cardDays * 86400000).toISOString().slice(0, 10);
      const lim = { amount: Math.round(amount * 100) / 100, currency: rc.cardCurrency };
      const body = {
        request_id: `neuro-action-${actionId}`, virtual: true,
        label: `NS#${actionId} ${String(vendor || '').slice(0, 20)}`.trim(),
        spending_limits: { single: lim, all_time: lim },
        spending_period: { end_date: end, end_date_action: 'terminate' },
        references: [{ name: 'action', value: String(actionId) }],
      };
      if (rc.contactIds.length) body.contact_ids = rc.contactIds.slice(0, 5);
      if (rc.accountIds?.length) body.accounts = rc.accountIds; // карты списывают только с субсчёта «Агенты»
      return call('POST', '/cards', body);
    },
    terminateCard: (id) => call('DELETE', '/cards/' + encodeURIComponent(id)),
  };
}
