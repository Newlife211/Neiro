// Telegram-бот директора: уведомления, решения кнопками, вопросы агентов, поручения, совещания,
// лента событий и вход в мини-приложение «Кабинет». Long polling — публичный адрес для бота не нужен.
// Команды и кнопки принимаются ТОЛЬКО из чата директора.
import { KINDS } from './policy.js';
import { decideProject, dailyMetrics } from './company.js';
import { decideAdoption, ADOPTION_RU } from './radar.js';
import { answerQuestion, giveOrder, createMeeting } from './director.js';
import { J } from './db.js';
import { TEST_RU, VERDICT_RU } from './marketing.js';

const HELP = `Я — связь с вашей компанией.

Просто напишите сообщение — это поручение, его получит COO.
Ответьте реплаем на вопрос сотрудника — ответ уйдёт ему.

Команды:
/cabinet — открыть кабинет директора
/status — цифры компании
/approvals — что ждёт вашего решения
/questions — вопросы сотрудников
/meeting повестка — созвать совещание руководителей
/marketing — тесты спроса и реклама
/feed all|important|off — сколько событий присылать
/stop — СТОП всех внешних действий
/resume — снять СТОП`;

export function createTelegram(ctx) {
  const { cfg, db } = ctx;
  const f = ctx.fetch || fetch;
  const on = !!(cfg.telegram.token && cfg.telegram.directorChatId);
  const cabinetUrl = cfg.publicUrl.startsWith('https://') ? cfg.publicUrl + '/tg' : null;
  let stopped = false;

  async function api(method, body) {
    const r = await f(`https://api.telegram.org/bot${cfg.telegram.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  }
  async function send(text, keyboard, extra = {}) {
    if (!on) return null;
    try {
      const r = await api('sendMessage', { chat_id: cfg.telegram.directorChatId, text: String(text).slice(0, 4000), reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined, ...extra });
      return r?.result || null;
    } catch (e) { ctx.log?.error('telegram send', e.message); return null; }
  }

  function actionText(a) {
    const ag = a.agent_id ? db.get('SELECT name, role FROM agents WHERE id=?', a.agent_id) : null;
    const p = a.payload || {};
    const lines = [`⏳ Нужно ваше решение (#${a.id})`, `${KINDS[a.kind]?.title || a.kind}${ag ? ' — ' + ag.name + ', ' + ag.role : ''}`];
    if (a.amount) lines.push(`Сумма: ${a.amount} ${a.currency}${a.currency !== cfg.baseCurrency ? ` (≈ ${a.amount_base} ${cfg.baseCurrency})` : ''}`);
    if (p.vendor || p.purpose) lines.push(`На что: ${[p.vendor, p.purpose].filter(Boolean).join(' — ')}`);
    if (p.network) lines.push(`Где: ${p.network}${p.target ? ' → ' + p.target : ''}`);
    if (p.title) lines.push(`Заголовок: ${p.title}`);
    if (p.to) lines.push(`Кому: ${[].concat(p.to).join(', ')}`);
    if (p.subject) lines.push(`Тема: ${p.subject}`);
    if (p.text) lines.push(`Текст: ${String(p.text).slice(0, 700)}`);
    if (p.description) lines.push(String(p.description).slice(0, 700));
    lines.push(`Почему ждёт: ${a.policy_reason}`);
    return lines.join('\n');
  }
  const notifyAction = (a) => send(actionText(a), [[{ text: '✅ Одобрить', callback_data: `a:${a.id}:y` }, { text: '✖ Отклонить', callback_data: `a:${a.id}:n` }]]);
  async function notify(text, opts = {}) {
    if (opts.project) return send(text, [[{ text: '✅ Утвердить', callback_data: `p:${opts.project}:y` }, { text: '✖ Отклонить', callback_data: `p:${opts.project}:n` }]]);
    return send(text);
  }

  async function sendQuestion(id) {
    const q = db.get('SELECT q.*, a.name, a.role FROM questions q LEFT JOIN agents a ON a.id=q.agent_id WHERE q.id=?', id);
    if (!q || q.status !== 'open') return;
    const opts = J(q.options, []);
    const kb = opts.map((o, i) => [{ text: o.slice(0, 60), callback_data: `q:${id}:${i}` }]);
    const text = `${q.urgency === 'high' ? '🔴 Срочно. ' : ''}❓ ${q.name} (${q.role}) спрашивает:\n\n${q.question}${q.context ? `\n\nКонтекст: ${q.context.slice(0, 1200)}` : ''}\n\n${opts.length ? 'Выберите вариант или ответьте' : 'Ответьте'} на это сообщение текстом (реплаем).`;
    const m = await send(text, kb.length ? kb : null);
    if (m?.message_id) db.run('UPDATE questions SET tg_message_id=? WHERE id=?', m.message_id, id);
  }

  // Лента событий: all — пачками раз в минуту; important (по умолчанию) — только решения, деньги, итоги; off — только решения.
  async function forwardFeed() {
    if (!on || db.setting('tg_feed', 'important') !== 'all') return;
    const last = db.setting('tg_feed_last', 0);
    const rows = db.all('SELECT * FROM feed WHERE id>? ORDER BY id LIMIT 25', last);
    if (!rows.length) return;
    db.setSetting('tg_feed_last', rows.at(-1).id);
    await send('📰 Лента компании\n\n' + rows.map((r) => `${r.icon || '•'} ${r.text}`).join('\n').slice(0, 3900), null, { disable_notification: true });
  }

  async function handle(u) {
    const fromChat = String(u.callback_query?.message?.chat?.id ?? u.message?.chat?.id ?? '');
    if (fromChat !== String(cfg.telegram.directorChatId)) return; // чужие чаты игнорируем
    if (u.callback_query) {
      const [type, id, val] = (u.callback_query.data || '').split(':');
      let msg = 'Готово';
      try {
        if (type === 'a') { const r = await ctx.actions.decide(Number(id), val === 'y', 'director:telegram'); msg = `#${id}: ${r.status}`; }
        if (type === 'p') { const r = decideProject(ctx, Number(id), val === 'y', 'director:telegram'); msg = `Проект «${r.name}»: ${r.stage}`; }
        if (type === 't') { const r = decideAdoption(ctx, Number(id), val === 'y', 'director:telegram'); msg = `«${r.title}»: ${ADOPTION_RU[r.status]}`; }
        if (type === 'm') { const r = ctx.marketing.decideTest(Number(id), val === 'y', 'director:telegram'); msg = `Тест «${r.title}»: ${TEST_RU[r.status]}`; }
        if (type === 'v') { const r = ctx.marketing.decideVerdict(Number(id), val, 'director:telegram'); msg = `Тест «${r.title}»: ${VERDICT_RU[r.decision] || r.decision}`; }
        if (type === 'q') {
          const q = db.get('SELECT options FROM questions WHERE id=?', Number(id));
          const opt = J(q?.options, [])[Number(val)];
          if (!opt) throw new Error('Вариант не найден');
          answerQuestion(ctx, Number(id), opt, 'director:telegram'); msg = `Ответ отправлен: ${opt}`;
        }
      } catch (e) { msg = 'Ошибка: ' + e.message; }
      await api('answerCallbackQuery', { callback_query_id: u.callback_query.id, text: msg.slice(0, 190) }).catch(() => {});
      await api('editMessageReplyMarkup', { chat_id: fromChat, message_id: u.callback_query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await send(msg);
      return;
    }
    const text = (u.message?.text || '').trim();
    if (!text) return;
    // ответ реплаем на вопрос сотрудника
    const replyTo = u.message.reply_to_message?.message_id;
    if (replyTo) {
      const q = db.get('SELECT id FROM questions WHERE tg_message_id=?', replyTo);
      if (q) { const r = answerQuestion(ctx, q.id, text, 'director:telegram'); return send(r.answer === text ? '💬 Ответ передан сотруднику.' : 'На этот вопрос уже ответили.'); }
    }
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = text.slice(cmd.length).trim();
    const cabinetBtn = cabinetUrl ? [[{ text: '🏢 Открыть кабинет', web_app: { url: cabinetUrl } }]] : null;
    switch (cmd.replace(/@.*$/, '')) {
      case '/start': case '/help': return send(HELP, cabinetBtn);
      case '/cabinet': return cabinetBtn ? send('Ваш кабинет:', cabinetBtn) : send('Кабинет работает только по https: задайте PUBLIC_URL=https://ваш-домен.');
      case '/stop': { db.setSetting('stopped', true); const n = await ctx.marketing.stopAllAds(); if (n) await send(`⏸ Реклама на паузе: ${n} кампан.`); } db.audit('director:telegram', 'stop', null); db.feed('🛑', 'Директор включил режим «СТОП»: внешние действия приостановлены', null, 'bad'); return send('🛑 СТОП включён. Агенты продолжают думать и готовить, но ничего не отправляют и не тратят.');
      case '/resume': db.setSetting('stopped', false); db.audit('director:telegram', 'resume', null); db.feed('▶', 'Директор снял режим «СТОП»', null, 'good'); return send('▶ Работа возобновлена.');
      case '/status': {
        const m = dailyMetrics(db, cfg);
        return send(`📊 Месяц: выручка ${m.revenue_month}, расходы ${m.expenses_month}, Claude API ${m.claude_api_month} ${cfg.baseCurrency}\nЗа сутки: выручка ${m.revenue_24h}, задач выполнено ${m.tasks_done_24h}\nТраты сегодня: ${m.spend_limits.spent_today}/${m.spend_limits.day}\nЖдут решения: ${m.pending_approvals} · вопросов: ${db.get(`SELECT COUNT(*) n FROM questions WHERE status='open'`).n}\nСТОП: ${m.stopped ? 'включён' : 'нет'}`);
      }
      case '/approvals': {
        const list = db.all(`SELECT id FROM actions WHERE status='pending' ORDER BY id LIMIT 10`);
        if (!list.length) return send('Нет действий, ждущих решения.');
        for (const a of list) await notifyAction(ctx.actions.get(a.id));
        return;
      }
      case '/questions': {
        const list = db.all(`SELECT id FROM questions WHERE status='open' ORDER BY id LIMIT 10`);
        if (!list.length) return send('Открытых вопросов нет.');
        for (const q of list) await sendQuestion(q.id);
        return;
      }
      case '/meeting': {
        if (!arg) return send('Напишите повестку: /meeting Как выйти на первую выручку за 2 недели');
        const m = createMeeting(ctx, { agenda: arg, via: 'telegram' });
        return send(`📣 Совещание #${m.id} созвано, участников: ${m.participants.length}. Когда соберу доклады, пришлю протокол с решениями.`);
      }
      case '/marketing': {
        const ts = ctx.marketing.list().filter((t) => ['proposed', 'approved', 'running', 'reporting'].includes(t.status) || (t.status === 'done' && !t.decision));
        if (!ts.length) return send('📣 Активных тестов спроса нет.');
        return send('📣 Тесты спроса\n\n' + ts.map((t) => `#${t.id} ${t.title}${t.project ? ` (${t.project})` : ''}\n${TEST_RU[t.status]}${t.status === 'running' ? ` · день ${t.day}/${t.days}` : ''} · потрачено ${t.spent}/${t.budget_base} ${cfg.baseCurrency} · заявок ${t.total.leads} · покупок ${t.total.purchases}${t.total.cpl != null ? ` · заявка ${t.total.cpl}` : ''}`).join('\n\n'));
      }
      case '/feed': {
        const lvl = ['all', 'important', 'off'].includes(rest[0]) ? rest[0] : null;
        if (!lvl) return send(`Сейчас: ${db.setting('tg_feed', 'important')}.\n/feed all — вся лента пачками\n/feed important — только важное\n/feed off — только решения`);
        db.setSetting('tg_feed', lvl);
        if (lvl === 'all') db.setSetting('tg_feed_last', db.get('SELECT COALESCE(MAX(id),0) m FROM feed').m);
        return send(`Лента: ${lvl}.`);
      }
      case '/task': case '/order': {
        if (!arg) return send('Напишите поручение после команды или просто сообщением.');
        const o = giveOrder(ctx, { text: arg }); return send(`📌 Поручение #${o.id} → ${o.to}.`);
      }
      default: {
        if (text.startsWith('/')) return send('Не знаю такой команды. /help — список.');
        const o = giveOrder(ctx, { text }); return send(`📌 Принято. Поручение #${o.id} передано: ${o.to}. Отчёт пришлю сюда.`);
      }
    }
  }

  async function setup() {
    if (!on) return;
    await api('setMyCommands', { commands: [
      { command: 'cabinet', description: 'Кабинет директора' }, { command: 'status', description: 'Цифры компании' },
      { command: 'approvals', description: 'Что ждёт решения' }, { command: 'questions', description: 'Вопросы сотрудников' },
      { command: 'meeting', description: 'Созвать совещание' }, { command: 'marketing', description: 'Тесты спроса и реклама' }, { command: 'feed', description: 'Лента событий' },
      { command: 'stop', description: 'СТОП внешних действий' }, { command: 'resume', description: 'Снять СТОП' },
    ] }).catch(() => {});
    if (cabinetUrl) await api('setChatMenuButton', { chat_id: Number(cfg.telegram.directorChatId), menu_button: { type: 'web_app', text: 'Кабинет', web_app: { url: cabinetUrl } } }).catch(() => {});
  }

  async function loop() {
    let offset = db.setting('tg_offset', 0);
    while (!stopped) {
      try {
        const r = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const u of r.result || []) { offset = u.update_id + 1; db.setSetting('tg_offset', offset); await handle(u).catch((e) => ctx.log?.error('tg handle', e.message)); }
      } catch (e) { ctx.log?.error('telegram', e.message); await new Promise((res) => setTimeout(res, 5000)); }
    }
  }

  return { enabled: on, cabinetUrl, start() { if (on) { setup(); loop(); } }, stop() { stopped = true; }, notify, notifyAction, sendQuestion, forwardFeed, handle, send, setup };
}
