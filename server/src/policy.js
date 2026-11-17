// Политика: что агенты делают сами, а что — только после «да» директора.
import { SOCIAL, socialRights, RIGHTS_RU } from './ads.js';
// Решение директора: траты до лимита — сами; выше лимита и любые необратимые действия — с подтверждением.

export const KINDS = {
  // внешние коммуникации
  send_email:          { cat: 'comm',   title: 'Отправить письмо' },
  reply_email:         { cat: 'comm',   title: 'Ответить на письмо' },
  post_telegram:       { cat: 'comm',   title: 'Пост в Telegram-канал' },
  post_social:         { cat: 'comm',   title: 'Пост в соцсети проекта' },
  // приём денег (деньги к нам — без риска потерь)
  create_payment_link: { cat: 'money_in', title: 'Создать ссылку на оплату' },
  // траты
  spend:               { cat: 'spend',  title: 'Оплатить расход' },
  // всегда с подтверждением директора
  refund:              { cat: 'always', title: 'Возврат денег клиенту' },
  deploy:              { cat: 'always', title: 'Выкатить в продакшн' },
  change_price:        { cat: 'always', title: 'Изменить цену продукта' },
  sign_contract:       { cat: 'always', title: 'Принять договор/оферту' },
  real_trade:          { cat: 'always', title: 'Реальная сделка на бирже' },
  custom:              { cat: 'always', title: 'Иное внешнее действие' },
};

export const MAX_RECIPIENTS_AUTO = 3; // массовые рассылки — только с подтверждением

export function toBase(cfg, amount, currency) {
  const cur = (currency || cfg.baseCurrency).toUpperCase();
  if (cur === cfg.baseCurrency) return round2(amount);
  // fx хранит «сколько единиц валюты за 1 EUR»; базовая валюта по умолчанию EUR
  const perEur = cfg.fx[cur], basePerEur = cfg.fx[cfg.baseCurrency];
  if (!perEur || !basePerEur) throw new Error('Нет курса для валюты ' + cur);
  return round2((amount / perEur) * basePerEur);
}
export const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Сколько уже потрачено (исполненные + одобренные, но ещё не исполненные траты) за сутки и месяц.
export function spentSoFar(db) {
  const q = (where) => db.get(`SELECT COALESCE(SUM(amount_base),0) s FROM actions WHERE kind='spend' AND status IN ('auto','approved','executed','manual') AND ${where}`).s;
  return {
    day: q("created_at >= datetime('now','start of day')"),
    month: q("created_at >= datetime('now','start of month')"),
  };
}
export function outboundToday(db) {
  return db.get(`SELECT COUNT(*) n FROM actions WHERE kind IN ('send_email','reply_email','post_telegram','post_social') AND status IN ('auto','approved','executed') AND created_at >= datetime('now','start of day')`).n;
}
export function llmSpent(db) {
  return {
    day: db.get(`SELECT COALESCE(SUM(cost_base),0) s FROM runs WHERE ts >= datetime('now','start of day')`).s,
    month: db.get(`SELECT COALESCE(SUM(cost_base),0) s FROM runs WHERE ts >= datetime('now','start of month')`).s,
  };
}

/**
 * Решает судьбу действия агента.
 * @returns {{decision:'auto'|'approval'|'deny', reason:string, amountBase:number}}
 */
export function evaluate(db, cfg, action) {
  const k = KINDS[action.kind];
  if (!k) return { decision: 'deny', reason: 'Неизвестный тип действия', amountBase: 0 };
  if (db.setting('stopped', false)) return { decision: 'approval', reason: 'Включён режим «СТОП»: все внешние действия ждут директора', amountBase: 0 };
  const p = action.payload || {};

  if (k.cat === 'always') {
    let amountBase = 0;
    if (action.amount) amountBase = toBase(cfg, action.amount, action.currency);
    return { decision: 'approval', reason: 'Необратимое действие — только с подтверждением директора', amountBase };
  }

  if (action.kind === 'post_social') {
    const net = String(p.network || '').toLowerCase(), s = SOCIAL[net];
    if (!s) return { decision: 'deny', reason: 'Неизвестная площадка: ' + (net || '—'), amountBase: 0 };
    if (!p.text) return { decision: 'deny', reason: 'Пустой пост', amountBase: 0 };
    const right = socialRights(db)[net];
    if (right === 'off') return { decision: 'deny', reason: `Директор запретил агентам публикации в «${s.title}»`, amountBase: 0 };
    if (!s.own) {
      if (!p.target) return { decision: 'deny', reason: `Для «${s.title}» нужен target: ${s.target}`, amountBase: 0 };
      p.target = String(p.target).trim().replace(/^\/?r\//i, ''); // одно сообщество — одна запись, как бы его ни написали
      const recent = db.get(`SELECT id FROM actions WHERE kind='post_social' AND status IN ('auto','approved','executed') AND json_extract(payload,'$.network')=? AND lower(json_extract(payload,'$.target'))=lower(?) AND created_at>=datetime('now','-7 days') LIMIT 1`, net, String(p.target));
      if (recent) return { decision: 'approval', reason: `В «${p.target}» уже был пост за последние 7 дней (#${recent.id}) — чаще только с вашего «да»`, amountBase: 0 };
    }
    if (right === 'approval') return { decision: 'approval', reason: `Права агентов: «${s.title}» — ${RIGHTS_RU.approval}`, amountBase: 0 };
  }

  if (k.cat === 'comm') {
    const to = [].concat(p.to || [], p.cc || [], p.bcc || []).filter(Boolean);
    if (to.length > MAX_RECIPIENTS_AUTO) return { decision: 'approval', reason: `Получателей ${to.length} (> ${MAX_RECIPIENTS_AUTO}) — массовая рассылка`, amountBase: 0 };
    const n = outboundToday(db);
    if (n >= cfg.limits.outboundDaily) return { decision: 'approval', reason: `Дневной лимит внешних сообщений исчерпан (${n}/${cfg.limits.outboundDaily})`, amountBase: 0 };
    return { decision: 'auto', reason: `В пределах лимита сообщений (${n + 1}/${cfg.limits.outboundDaily})`, amountBase: 0 };
  }

  if (k.cat === 'money_in') {
    if (!(action.amount > 0)) return { decision: 'deny', reason: 'Сумма оплаты должна быть больше нуля', amountBase: 0 };
    return { decision: 'auto', reason: 'Приём оплаты — без риска потерь', amountBase: toBase(cfg, action.amount, action.currency) };
  }

  if (k.cat === 'spend') {
    if (!(action.amount > 0)) return { decision: 'deny', reason: 'Сумма расхода должна быть больше нуля', amountBase: 0 };
    const amountBase = toBase(cfg, action.amount, action.currency);
    const s = spentSoFar(db), L = cfg.limits;
    if (amountBase > L.perAction) return { decision: 'approval', reason: `Сумма ${amountBase} ${cfg.baseCurrency} выше лимита на одну трату (${L.perAction})`, amountBase };
    if (s.day + amountBase > L.daily) return { decision: 'approval', reason: `Превысит дневной лимит: ${round2(s.day)} + ${amountBase} > ${L.daily} ${cfg.baseCurrency}`, amountBase };
    if (s.month + amountBase > L.monthly) return { decision: 'approval', reason: `Превысит месячный лимит: ${round2(s.month)} + ${amountBase} > ${L.monthly} ${cfg.baseCurrency}`, amountBase };
    if (p.recurring) return { decision: 'approval', reason: 'Подписка/регулярный платёж — только с подтверждением', amountBase };
    if (p.project_id) {
      const b = projectBudget(db, db.get('SELECT * FROM projects WHERE id=?', p.project_id));
      if (b && b.spent + amountBase > b.limit + 0.001) return { decision: 'approval', reason: `Превысит бюджет проекта на этапе «${b.stage_ru}»: ${b.spent} + ${amountBase} > ${b.limit} ${cfg.baseCurrency}`, amountBase };
    }
    return { decision: 'auto', reason: `В пределах лимитов (день ${round2(s.day + amountBase)}/${L.daily}, месяц ${round2(s.month + amountBase)}/${L.monthly} ${cfg.baseCurrency})`, amountBase };
  }
  return { decision: 'approval', reason: 'Требует решения директора', amountBase: 0 };
}

// Бюджет проекта по этапам (без рекламы — у неё свой бюджет теста, одобренный директором).
// Стартовые суммы из документа процесса; директор меняет их в пульте («Сопровождение»).
export const STAGE_BUDGET = { idea: 0, analysis: 100, decision: 100, build: 150, test: 150, launch: 300, revenue: null, closed: 0 };
export const STAGE_BUDGET_RU = { idea: 'идея', analysis: 'проверка спроса', decision: 'проверка спроса', build: 'MVP', test: 'MVP', launch: 'первый месяц после запуска', revenue: 'рост (30% выручки за 30 дней)', closed: 'закрыт' };
export function projectBudget(db, p) {
  if (!p) return null;
  const override = db.setting('project_budgets', {})[p.id]?.[p.stage];
  let limit = override ?? STAGE_BUDGET[p.stage];
  if (limit == null) limit = round2(0.3 * db.get(`SELECT COALESCE(SUM(amount_base),0) s FROM ledger WHERE direction='in' AND project_id=? AND ts>=datetime('now','-30 days')`, p.id).s);
  const since = p.stage_since || p.created_at;
  const spent = round2(db.get(`SELECT COALESCE(SUM(amount_base),0) s FROM actions WHERE kind='spend' AND status IN ('auto','approved','executed','manual') AND json_extract(payload,'$.project_id')=? AND created_at>=?`, p.id, since).s);
  return { stage: p.stage, stage_ru: STAGE_BUDGET_RU[p.stage], limit, spent, left: round2(limit - spent), since };
}

export function llmBudgetOk(db, cfg) {
  const s = llmSpent(db);
  if (s.day >= cfg.limits.llmDaily) return { ok: false, reason: `Дневной бюджет Claude API исчерпан (${round2(s.day)}/${cfg.limits.llmDaily} ${cfg.baseCurrency})` };
  if (s.month >= cfg.limits.llmMonthly) return { ok: false, reason: `Месячный бюджет Claude API исчерпан (${round2(s.month)}/${cfg.limits.llmMonthly} ${cfg.baseCurrency})` };
  return { ok: true };
}
