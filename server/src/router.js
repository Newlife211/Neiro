// Выбор модели под задачу (идея 3-уровневой маршрутизации Ruflo, своя реализация).
// Три уровня: fast (Haiku) — рутина, worker (Sonnet) — обычная работа, lead (Opus) — стратегия и сложное.
// Для каждой категории задач сервер учится, какой уровень справляется: сэмплирование Томпсона по
// успехам и сбоям; из уровней, которые справляются с вероятностью ≥ TARGET, берётся самый дешёвый.

export const TIERS = ['fast', 'worker', 'lead'];
export const TIER_RU = { fast: 'быстрая (Haiku)', worker: 'основная (Sonnet)', lead: 'старшая (Opus)' };
const TARGET = 0.8;

// Категория задачи — по смыслу заголовка и отделу. Порядок важен: первое совпадение.
const CATS = [
  ['strategy', /стратег|решени[ея] директора|бизнес-план|инвест|архитектур|ценообразован|юнит-эконом|roi|судьб|pivot/i],
  ['money', /оплат|возврат|трат|бюджет|счёт|счет|сверк|выписк|налог|бухгалт|refund|invoice/i],
  ['security', /безопасн|уязвим|доступ|ключ|утечк|аудит|комплаенс|compliance/i],
  ['code', /код|разработ|деплой|релиз|баг|ошибк|api|интеграц|скрипт|лендинг|сайт/i],
  ['research', /исследован|анализ|рынок|конкурент|радар|обзор|сравн|гипотез/i],
  ['content', /пост|текст|стать|письм|рассылк|креатив|контент|описани|перевод/i],
  ['support', /обращени|клиент|ответ|тикет|поддержк|опрос/i],
  ['routine', /отчёт|отчет|планёрк|сводк|статус|напомин|ежедневн|еженедельн|метрик/i],
];
export function categorize(task, agent) {
  const t = `${task.title || ''}`;
  for (const [c, re] of CATS) if (re.test(t)) return c;
  return agent?.dept === 'support' ? 'support' : 'general';
}

// Допустимые уровни: руководители не опускаются ниже основной модели; критичное — не ниже основной;
// стратегия у руководителей — всегда старшая.
function allowed(task, agent, cat) {
  const lead = !!agent?.head || agent?.id === 'cdo';
  if (lead && (cat === 'strategy' || task.created_by === 'director')) return ['lead']; // поручения директора руководителям — всегда старшая
  if (lead) return ['worker', 'lead'];
  if (['strategy', 'money', 'security', 'code'].includes(cat) || task.created_by === 'director') return ['worker', 'lead'];
  return ['fast', 'worker'];
}

// Бета-распределение через два гамма-распределения (Марсалья — Цан)
function gamma(k, rnd) {
  if (k < 1) return gamma(k + 1, rnd) * Math.pow(rnd(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { const u1 = rnd(), u2 = rnd(); x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rnd();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export const betaSample = (a, b, rnd = Math.random) => { const x = gamma(a, rnd), y = gamma(b, rnd); return x / (x + y); };

export function createRouter(ctx, { rnd = Math.random } = {}) {
  const { db, cfg } = ctx;
  const mode = () => db.setting('routing_mode', cfg.anthropic.routing || 'learn'); // learn | fixed
  const stat = (cat, tier) => db.get('SELECT * FROM model_stats WHERE category=? AND tier=?', cat, tier) || { wins: 0, losses: 0, runs: 0, cost: 0 };
  // Априорные ожидания: дешёвой модели доверяем меньше, пока она не докажет обратное
  const PRIOR = { fast: [2, 2], worker: [4, 1], lead: [6, 1] };

  function route(task, agent) {
    const cat = categorize(task, agent);
    let tiers = allowed(task, agent, cat);
    if (!cfg.anthropic.modelFast) tiers = tiers.filter((t) => t !== 'fast');
    if (!tiers.length) tiers = ['worker'];
    // повтор после сбоя — на ступень выше той, что не справилась
    if (task.attempts > 1 && task.tier) { const up = TIERS[Math.min(2, TIERS.indexOf(task.tier) + 1)]; tiers = tiers.filter((t) => TIERS.indexOf(t) >= TIERS.indexOf(up)); if (!tiers.length) tiers = [up]; }
    if (mode() === 'fixed') { const fixed = agent?.head || agent?.id === 'cdo' ? 'lead' : 'worker'; return { tier: tiers.includes(fixed) ? fixed : tiers.at(-1), category: cat, reason: 'фиксированный режим' }; }
    const draws = tiers.map((t) => { const s = stat(cat, t), [a, b] = PRIOR[t]; return { t, p: betaSample(a + s.wins, b + s.losses, rnd) }; });
    const ok = draws.filter((d) => d.p >= TARGET);
    const pick = ok.length ? ok[0] : draws.reduce((x, y) => (y.p > x.p ? y : x));
    return { tier: pick.t, category: cat, reason: ok.length ? `самая дешёвая из справляющихся (${Math.round(pick.p * 100)}%)` : `лучшая из доступных (${Math.round(pick.p * 100)}%)` };
  }

  function outcome(cat, tier, success, cost = 0) {
    if (!cat || !tier) return;
    db.run(`INSERT INTO model_stats(category,tier,wins,losses,cost,runs) VALUES(?,?,?,?,?,1)
      ON CONFLICT(category,tier) DO UPDATE SET wins=wins+excluded.wins, losses=losses+excluded.losses, cost=cost+excluded.cost, runs=runs+1`, cat, tier, success ? 1 : 0, success ? 0 : 1, cost || 0);
  }

  function overview() {
    const rows = db.all('SELECT * FROM model_stats ORDER BY category, tier');
    const spent = db.all(`SELECT model, COUNT(*) calls, ROUND(SUM(cost_base),2) cost FROM runs WHERE ts>=datetime('now','-30 days') GROUP BY model`);
    // сколько стоило бы, если бы всё шло на основной модели: оценка по ценам за токен
    const pr = cfg.anthropic;
    const tok = db.get(`SELECT COALESCE(SUM(in_tokens),0) i, COALESCE(SUM(out_tokens),0) o FROM runs WHERE ts>=datetime('now','-30 days')`);
    const k = (cfg.fx[cfg.baseCurrency] || 1) / (cfg.fx.USD || 1);
    const allWorker = Math.round(((tok.i * pr.priceIn.worker + tok.o * pr.priceOut.worker) / 1e6) * k * 100) / 100;
    const actual = Math.round(spent.reduce((s, x) => s + (x.cost || 0), 0) * 100) / 100;
    return { mode: mode(), target: TARGET, stats: rows.map((r) => ({ ...r, tier_ru: TIER_RU[r.tier], success_pct: r.runs ? Math.round((r.wins / r.runs) * 100) : null })), spent_30d: spent, actual_30d: actual, if_all_worker_30d: allWorker };
  }

  return { route, outcome, overview, mode };
}
