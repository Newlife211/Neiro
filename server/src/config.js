// Конфигурация берётся только из переменных окружения (файл .env на сервере).
// Ключи и пароли никогда не хранятся в коде и не попадают в репозиторий.
import fs from 'node:fs';
import path from 'node:path';

export function loadDotEnv(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export function buildConfig(env = process.env) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  return {
    root,
    port: num(env.PORT, 8080),
    publicUrl: (env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, ''),
    dataDir: env.DATA_DIR || path.join(root, 'var'),
    workspaceDir: env.WORKSPACE_DIR || path.join(root, 'var', 'workspace'),
    directorToken: env.DIRECTOR_TOKEN || '',
    baseCurrency: (env.BASE_CURRENCY || 'EUR').toUpperCase(),
    fx: { RUB: num(env.FX_RUB_PER_EUR, 100), USD: num(env.FX_USD_PER_EUR, 1.08), EUR: 1 },

    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY || '',
      baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      modelWorker: env.MODEL_WORKER || 'claude-sonnet-5-5',
      modelLead: env.MODEL_LEAD || 'claude-opus-5-5',
      // Цены за 1 млн токенов в USD. ОБЯЗАТЕЛЬНО сверьте с https://www.anthropic.com/pricing перед запуском.
      priceIn: { worker: num(env.PRICE_IN_WORKER, 3), lead: num(env.PRICE_IN_LEAD, 15) },
      priceOut: { worker: num(env.PRICE_OUT_WORKER, 15), lead: num(env.PRICE_OUT_LEAD, 75) },
      // Веб-поиск Claude: цена за 1000 запросов в USD (сверьте на anthropic.com/pricing)
      priceWebSearch: num(env.PRICE_WEB_SEARCH, 10),
      maxTokens: num(env.LLM_MAX_TOKENS, 2048),
      maxTurns: num(env.AGENT_MAX_TURNS, 8),
    },

    limits: {
      // Траты, которые агенты делают сами (в базовой валюте). Выше — только с подтверждением директора.
      perAction: num(env.LIMIT_PER_ACTION, 50),
      daily: num(env.LIMIT_DAILY, 100),
      monthly: num(env.LIMIT_MONTHLY, 1000),
      // Отдельный потолок на расходы Claude API (защита от зацикливания агентов).
      llmDaily: num(env.LIMIT_LLM_DAILY, 20),
      llmMonthly: num(env.LIMIT_LLM_MONTHLY, 300),
      // Сколько внешних писем/постов агенты могут отправить сами за сутки.
      outboundDaily: num(env.LIMIT_OUTBOUND_DAILY, 40),
    },

    workers: { concurrency: num(env.WORKER_CONCURRENCY, 2), pollMs: num(env.WORKER_POLL_MS, 3000), enabled: bool(env.WORKERS_ENABLED, true) },
    workHours: { start: env.WORK_START || '00:00', end: env.WORK_END || '24:00', tz: env.TZ || 'Europe/Vilnius' },

    telegram: { token: env.TELEGRAM_BOT_TOKEN || '', directorChatId: env.TELEGRAM_DIRECTOR_CHAT_ID || '' },
    stripe: { secretKey: env.STRIPE_SECRET_KEY || '', webhookSecret: env.STRIPE_WEBHOOK_SECRET || '' },
    yookassa: { shopId: env.YOOKASSA_SHOP_ID || '', secretKey: env.YOOKASSA_SECRET_KEY || '' },
    agentmail: { apiKey: env.AGENTMAIL_API_KEY || '', baseUrl: env.AGENTMAIL_BASE_URL || 'https://api.agentmail.to/v0', domain: env.AGENTMAIL_DOMAIN || 'agentmail.to' },
  };
}

export function configWarnings(c) {
  const w = [];
  if (!c.directorToken || c.directorToken.length < 24) w.push('DIRECTOR_TOKEN не задан или короче 24 символов — пульт директора закрыт.');
  if (!c.anthropic.apiKey) w.push('ANTHROPIC_API_KEY не задан — агенты не будут работать.');
  if (!c.telegram.token) w.push('TELEGRAM_BOT_TOKEN не задан — подтверждения только через пульт.');
  if (!c.stripe.secretKey) w.push('Stripe не настроен.');
  if (c.stripe.secretKey && !c.stripe.webhookSecret) w.push('STRIPE_WEBHOOK_SECRET не задан — вебхуки Stripe будут отклоняться.');
  if (!c.yookassa.shopId) w.push('ЮKassa не настроена.');
  if (!c.agentmail.apiKey) w.push('AgentMail не настроен — агенты не смогут отправлять письма.');
  if (!process.env.REVOLUT_CLIENT_ID) w.push('Revolut не подключён — траты агентов оплачиваются вручную, выписки не сверяются.');
  return w;
}
