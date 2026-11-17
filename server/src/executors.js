// Исполнители внешних действий. Каждый получает уже разрешённое политикой действие.
import crypto from 'node:crypto';
import { stripeClient, yookassaClient } from './payments.js';
import { adsConfig, socialPublisher, SOCIAL } from './ads.js';

export function buildExecutors(cfg, fetchImpl = fetch, extra = {}) {
  const stripe = stripeClient(cfg, fetchImpl), yk = yookassaClient(cfg, fetchImpl);
  const adsC = extra.adsCfg || adsConfig();
  const social = socialPublisher(adsC, fetchImpl, { crypto, threadsToken: extra.threadsToken });

  async function agentmail(method, path, body) {
    if (!cfg.agentmail.apiKey) throw new Error('AgentMail не настроен (AGENTMAIL_API_KEY)');
    const r = await fetchImpl(cfg.agentmail.baseUrl + path, {
      method, headers: { Authorization: 'Bearer ' + cfg.agentmail.apiKey, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('AgentMail: ' + (j.message || j.error || r.status));
    return j;
  }
  const inboxOf = (db, agentId) => db.get('SELECT email FROM agents WHERE id=?', agentId)?.email;

  async function telegram(method, body) {
    if (!cfg.telegram.token) throw new Error('Telegram не настроен');
    const r = await fetchImpl(`https://api.telegram.org/bot${cfg.telegram.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j.ok) throw new Error('Telegram: ' + j.description);
    return j.result;
  }

  return {
    async send_email(a, { db }) {
      // письмо уходит только из собственного ящика агента — подменить отправителя нельзя
      const inbox = inboxOf(db, a.agent_id);
      if (!inbox) throw new Error('У агента нет почтового ящика (поле email в разделе «Агенты»)');
      const p = a.payload;
      const res = await agentmail('POST', `/inboxes/${encodeURIComponent(inbox)}/messages/send`, { to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, text: p.text, html: p.html, labels: ['neurosfera'] });
      return { result: { message_id: res.message_id, thread_id: res.thread_id, from: inbox } };
    },
    async reply_email(a, { db }) {
      const inbox = inboxOf(db, a.agent_id);
      if (!inbox || !a.payload.message_id) throw new Error('Нужны ящик агента и message_id исходного письма');
      const res = await agentmail('POST', `/inboxes/${encodeURIComponent(inbox)}/messages/${encodeURIComponent(a.payload.message_id)}/reply`, { text: a.payload.text, html: a.payload.html });
      return { result: { message_id: res.message_id, thread_id: res.thread_id } };
    },
    async post_telegram(a) {
      const chat = process.env.TELEGRAM_CHANNEL_ID; // только канал компании из настроек
      if (!chat) return { status: 'manual', result: { note: 'Не задан TELEGRAM_CHANNEL_ID — опубликуйте пост вручную' } };
      const m = await telegram('sendMessage', { chat_id: chat, text: a.payload.text, disable_web_page_preview: false });
      return { result: { message_id: m.message_id } };
    },
    // Соцсети: публикуют агенты от аккаунтов компании. Площадка и права проверены политикой.
    async post_social(a) {
      const p = a.payload, net = String(p.network || '').toLowerCase();
      if (!SOCIAL[net]) throw new Error('Неизвестная площадка: ' + net);
      if (!social.has(net)) return { status: 'manual', result: { note: `«${SOCIAL[net].title}» ещё не подключена: директору нужно завести аккаунт и положить ключи в .env (список — в «Задачах директора»). Текст поста сохранён в действии.` } };
      if (net === 'telegram' || net === 'telegram_chat') {
        const chat = net === 'telegram' ? adsC.telegramChannel : String(p.target || '');
        if (net === 'telegram_chat' && !adsC.telegramChats.includes(chat)) throw new Error('Этого чата нет в списке разрешённых директором (TELEGRAM_COMMUNITY_CHATS)');
        const m = await telegram('sendMessage', { chat_id: chat, text: p.text, disable_web_page_preview: false });
        return { result: { network: net, message_id: m.message_id } };
      }
      return { result: { network: net, ...(await social[net]({ text: p.text, image_url: p.image_url, link: p.link, title: p.title, target: p.target })) } };
    },
    async create_payment_link(a, { db }) {
      const p = a.payload, provider = p.provider || (a.currency === 'RUB' ? 'yookassa' : 'stripe');
      let out;
      if (provider === 'yookassa') {
        if (p.recurring) throw new Error('Подписки в ЮKassa требуют отдельного договора на автоплатежи — используйте разовую оплату');
        out = await yk.createPayment({ title: p.title, amount: a.amount, currency: a.currency, projectId: p.project_id, customerEmail: p.customer_email, idem: a.idem_key });
      } else {
        out = await stripe.createPaymentLink({ title: p.title, amount: a.amount, currency: a.currency, recurring: p.recurring, projectId: p.project_id, idem: a.idem_key });
      }
      db.run(`INSERT OR IGNORE INTO payment_links(provider,ext_id,url,project_id,title,amount,currency,recurring,customer_email) VALUES(?,?,?,?,?,?,?,?,?)`,
        provider, out.extId, out.url, p.project_id || null, p.title, a.amount, a.currency, p.recurring || null, p.customer_email || null);
      return { result: { provider, url: out.url, id: out.extId } };
    },
    async refund(a) {
      const p = a.payload;
      if (p.provider === 'yookassa') return { result: await yk.refund({ paymentId: p.payment_id, amount: a.amount, currency: a.currency }) };
      return { result: await stripe.refund({ paymentIntent: p.payment_id, amount: a.amount, currency: a.currency }) };
    },
    async deploy(a) {
      const url = process.env.DEPLOY_WEBHOOK_URL;
      if (!url) return { status: 'manual', result: { note: 'Не задан DEPLOY_WEBHOOK_URL (Coolify/Vercel/Render deploy hook) — выкатите вручную' } };
      const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: a.payload.project, ref: a.payload.ref || 'main' }) });
      if (!r.ok) throw new Error('Deploy hook ответил ' + r.status);
      return { result: { status: r.status } };
    },
    // Трата: если подключён Revolut — выпускаем виртуальную карту ровно на сумму этой траты.
    // Оплату картой проводит человек (или сервис списывает сам по подписке); как только списание
    // появится в выписке, сверка закроет трату фактической суммой и (по умолчанию) закроет карту.
    async spend(a, ctx) {
      const rev = extra.revolut?.();
      if (!rev) return { status: 'manual', result: { note: 'Revolut не подключён — оплатите вручную и отметьте «Я выполнил»' } };
      const rc = extra.revolutCfg;
      let amount = a.amount;
      if (a.currency !== rc.cardCurrency) {
        // пересчёт в валюту карты через базовую валюту + 3% запаса на курс и комиссию
        const { toBase } = await import('./policy.js');
        const base = toBase(cfg, a.amount, a.currency);
        amount = Math.ceil((base / (cfg.fx[cfg.baseCurrency] || 1)) * (cfg.fx[rc.cardCurrency] || 1) * 1.03 * 100) / 100;
      }
      const card = await rev.createSpendCard({ actionId: a.id, amount, vendor: a.payload.vendor });
      return { status: 'manual', result: { card_id: card.id, last_digits: card.last_digits, limit: amount, currency: rc.cardCurrency,
        note: `Создана виртуальная карта Revolut •••• ${card.last_digits || '????'} с лимитом ${amount} ${rc.cardCurrency} (только на эту трату, ${rc.cardDays} дн.). Оплатите ею у «${a.payload.vendor || 'поставщика'}» — списание сверится автоматически.` } };
    },
    // change_price, sign_contract, real_trade, custom — нет универсального API:
    // после одобрения исполнитель вернёт «manual», и директор подтвердит выполнение в пульте.
  };
}
