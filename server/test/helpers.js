import { buildConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/index.js';

export function testConfig(over = {}) {
  const cfg = buildConfig({ DIRECTOR_TOKEN: 'test-director-token-0123456789', ANTHROPIC_API_KEY: 'sk-test', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', YOOKASSA_SHOP_ID: '1', YOOKASSA_SECRET_KEY: 'y', TELEGRAM_BOT_TOKEN: 'tg', TELEGRAM_DIRECTOR_CHAT_ID: '42', LIMIT_PER_ACTION: '50', LIMIT_DAILY: '100', LIMIT_MONTHLY: '1000', LIMIT_LLM_DAILY: '5', LIMIT_OUTBOUND_DAILY: '3' });
  return Object.assign(cfg, over);
}

// Поддельный fetch: обработчики по префиксу URL. Записывает все вызовы.
export function fakeFetch(handlers) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init, body: init.body });
    for (const [prefix, h] of handlers) if (url.startsWith(prefix)) {
      const out = await h(url, init);
      const status = out?.__status || 200;
      return { ok: status < 400, status, json: async () => out, text: async () => JSON.stringify(out) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
  };
  f.calls = calls;
  return f;
}

export function makeApp({ fetch, executors, cfg } = {}) {
  const c = cfg || testConfig();
  return createApp(c, { db: openDb(':memory:'), fetch: fetch || fakeFetch([]), executors, backoffScale: 0 });
}
