// Telegram-бот директора: уведомления и подтверждения кнопками. Работает через long polling —
// публичный адрес для бота не нужен. Команды принимаются ТОЛЬКО из чата директора.
import { KINDS } from './policy.js';
import { decideProject, dailyMetrics } from './company.js';
import { decideAdoption, ADOPTION_RU } from './radar.js';
import { addTask } from './worker.js';

export function createTelegram(ctx) {
  const { cfg, db } = ctx;
  const f = ctx.fetch || fetch;
  const on = !!(cfg.telegram.token && cfg.telegram.directorChatId);
  let stopped = false;

  async function api(method, body) {
    const r = await f(`https://api.telegram.org/bot${cfg.telegram.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  }
  async function send(text, keyboard) {
    if (!on) return;
    try { await api('sendMessage', { chat_id: cfg.telegram.directorChatId, text: text.slice(0, 4000), reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined }); }
    catch (e) { ctx.log?.error('telegram send', e.message); }
  }

  function actionText(a) {
    const ag = a.agent_id ? db.get('SELECT name, role FROM agents WHERE id=?', a.agent_id) : null;
    const p = a.payload || {};
    const lines = [`⏳ Нужно ваше решение (#${a.id})`, `${KINDS[a.kind]?.title || a.kind}${ag ? ' — ' + ag.name + ', ' + ag.role : ''}`];
    if (a.amount) lines.push(`Сумма: ${a.amount} ${a.currency}${a.currency !== cfg.baseCurrency ? ` (≈ ${a.amount_base} ${cfg.baseCurrency})` : ''}`);
    if (p.vendor || p.purpose) lines.push(`На что: ${[p.vendor, p.purpose].filter(Boolean).join(' — ')}`);
    if (p.to) lines.push(`Кому: ${[].concat(p.to).join(', ')}`);
    if (p.subject) lines.push(`Тема: ${p.subject}`);
    if (p.text) lines.push(`Текст: ${String(p.text).slice(0, 700)}`);
    if (p.description) lines.push(String(p.description).slice(0, 700));
    lines.push(`Почему ждёт: ${a.policy_reason}`);
    return lines.join('\n');
  }

  async function notifyAction(a) {
    await send(actionText(a), [[{ text: '✅ Одобрить', callback_data: `a:${a.id}:y` }, { text: '✖ Отклонить', callback_data: `a:${a.id}:n` }]]);
  }
  async function notify(text, opts = {}) {
    if (opts.project) return send(text, [[{ text: '✅ Утвердить', callback_data: `p:${opts.project}:y` }, { text: '✖ Отклонить', callback_data: `p:${opts.project}:n` }]]);
    return send(text);
  }

  async function handle(u) {
    const fromChat = String(u.callback_query?.message?.chat?.id ?? u.message?.chat?.id ?? '');
    if (fromChat !== String(cfg.telegram.directorChatId)) return; // чужие чаты игнорируем
    if (u.callback_query) {
      const [type, id, yn] = (u.callback_query.data || '').split(':');
      let msg = 'Готово';
      try {
        if (type === 'a') { const r = await ctx.actions.decide(Number(id), yn === 'y', 'director:telegram'); msg = `#${id}: ${r.status}`; }
        if (type === 't') { const r = decideAdoption(ctx, Number(id), yn === 'y', 'director:telegram'); msg = `«${r.title}»: ${ADOPTION_RU[r.status]}`; }
        if (type === 'p') { const r = decideProject(ctx, Number(id), yn === 'y', 'director:telegram'); msg = `Проект «${r.name}»: ${r.stage}`; }
      } catch (e) { msg = 'Ошибка: ' + e.message; }
      await api('answerCallbackQuery', { callback_query_id: u.callback_query.id, text: msg.slice(0, 190) });
      await api('editMessageReplyMarkup', { chat_id: fromChat, message_id: u.callback_query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await send(msg);
      return;
    }
    const text = (u.message?.text || '').trim();
    if (text === '/stop') { db.setSetting('stopped', true); db.audit('director:telegram', 'stop', null); db.feed('🛑', 'Директор включил режим «СТОП»: внешние действия приостановлены', null, 'bad'); return send('🛑 СТОП включён. Агенты продолжают думать и готовить, но ничего не отправляют и не тратят.'); }
    if (text === '/resume') { db.setSetting('stopped', false); db.audit('director:telegram', 'resume', null); db.feed('▶', 'Директор снял режим «СТОП»', null, 'good'); return send('▶ Работа возобновлена.'); }
    if (text === '/status') { const m = dailyMetrics(db, cfg); return send(`📊 Месяц: выручка ${m.revenue_month}, расходы ${m.expenses_month}, Claude API ${m.claude_api_month} ${cfg.baseCurrency}\nТраты сегодня: ${m.spend_limits.spent_today}/${m.spend_limits.day}\nЖдут решения: ${m.pending_approvals}\nСТОП: ${m.stopped ? 'включён' : 'нет'}`); }
    if (text === '/approvals') {
      const list = db.all(`SELECT * FROM actions WHERE status='pending' ORDER BY id LIMIT 10`);
      if (!list.length) return send('Нет действий, ждущих решения.');
      for (const a of list) await notifyAction(ctx.actions.get(a.id));
      return;
    }
    if (text.startsWith('/task ')) { const id = addTask(db, { title: text.slice(6, 200), body: text.slice(6), dept: 'admin', agentId: 'coo', priority: 2, createdBy: 'director' }); return send(`📌 Поручение #${id} передано COO.`); }
    if (text === '/start' || text === '/help') return send('Команды:\n/status — цифры\n/approvals — что ждёт решения\n/task текст — поручение (через COO)\n/stop — СТОП всех внешних действий\n/resume — снять СТОП');
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

  return { enabled: on, start() { if (on) loop(); }, stop() { stopped = true; }, notify, notifyAction, handle, send };
}
