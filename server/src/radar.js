// Технологическая разведка: ежедневный сбор новостей и репозиториев (без затрат на ИИ),
// оценка находок агентами и цепочка внедрения: предложение → директор → проверка безопасности → пилот → директор.
import { addTask } from './worker.js';

export const DEFAULT_FEEDS = [
  'https://www.anthropic.com/news/rss.xml',
  'https://openai.com/news/rss.xml',
  'https://huggingface.co/blog/feed.xml',
  'https://github.blog/changelog/feed/',
  'https://simonwillison.net/atom/everything/',
  'https://www.latent.space/feed',
];
export const DEFAULT_TOPICS = ['llm', 'ai-agents', 'mcp', 'claude', 'rag', 'agentic-ai'];
export const HN_KEYWORDS = /\b(ai|llm|gpt|claude|anthropic|openai|gemini|agent|agents|mcp|rag|model|inference|copilot|cursor|embedding|fine-?tun|open[- ]source|saas|stripe|automation)\b/i;

export function radarConfig(env = process.env) {
  return {
    feeds: env.RADAR_FEEDS ? env.RADAR_FEEDS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_FEEDS,
    topics: env.RADAR_GITHUB_TOPICS ? env.RADAR_GITHUB_TOPICS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_TOPICS,
    githubToken: env.GITHUB_TOKEN || '',
    hnMinPoints: Number(env.RADAR_HN_MIN_POINTS || 80),
    webSearch: env.RADAR_WEB_SEARCH !== '0',
    dailyItems: Number(env.RADAR_DAILY_ITEMS || 40),
  };
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const strip = (s = '') => decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// RSS 2.0 и Atom
export function parseFeed(xml, source) {
  const out = [];
  const blocks = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)].map((m) => m[0]);
  for (const b of blocks) {
    const tag = (t) => b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1];
    const title = strip(tag('title'));
    let url = strip(tag('link') || '');
    if (!url) url = b.match(/<link[^>]*href=["']([^"']+)["']/)?.[1] || '';
    const date = strip(tag('pubDate') || tag('published') || tag('updated') || tag('dc:date') || '');
    const summary = strip(tag('description') || tag('summary') || tag('content') || '').slice(0, 600);
    const id = strip(tag('guid') || tag('id') || url || title);
    if (title && url) out.push({ source, extId: id.slice(0, 300), title: title.slice(0, 300), url, summary, published: date ? new Date(date).toISOString() : null, signal: 0 });
  }
  return out;
}

function save(db, it) {
  return db.run(`INSERT OR IGNORE INTO radar_items(source,ext_id,title,url,summary,signal,published_at) VALUES(?,?,?,?,?,?,?)`,
    it.source, it.extId, it.title, it.url, it.summary || '', it.signal || 0, it.published && !isNaN(Date.parse(it.published)) ? it.published : null).changes > 0;
}

export async function collect(ctx) {
  const { db } = ctx;
  const rc = ctx.radarCfg || radarConfig();
  const f = ctx.fetch || fetch;
  const stats = { github: 0, hn: 0, rss: 0, errors: [] };
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  // GitHub: новые репозитории по темам, набирающие звёзды
  for (const topic of rc.topics) {
    try {
      const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'neurosfera-radar' };
      if (rc.githubToken) h.Authorization = 'Bearer ' + rc.githubToken;
      const r = await f(`https://api.github.com/search/repositories?q=${encodeURIComponent(`topic:${topic} created:>${since} stars:>30`)}&sort=stars&order=desc&per_page=15`, { headers: h });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || r.status);
      for (const x of j.items || []) if (save(db, { source: 'github', extId: x.full_name, title: `${x.full_name}: ${x.description || ''}`.slice(0, 300), url: x.html_url, summary: `★${x.stargazers_count} · ${x.language || ''} · лицензия ${x.license?.spdx_id || 'не указана'} · темы: ${(x.topics || []).slice(0, 6).join(', ')}`, signal: x.stargazers_count, published: x.created_at })) stats.github++;
    } catch (e) { stats.errors.push('github/' + topic + ': ' + e.message); }
  }
  // Hacker News: популярные истории за сутки по теме ИИ и технологий
  try {
    const ts = Math.floor(Date.now() / 1000) - 86400;
    const r = await f(`https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=100&numericFilters=${encodeURIComponent(`created_at_i>${ts},points>${rc.hnMinPoints}`)}`);
    const j = await r.json();
    for (const h of j.hits || []) {
      if (!HN_KEYWORDS.test(h.title || '')) continue;
      if (save(db, { source: 'hn', extId: String(h.objectID), title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, summary: `${h.points} очков, ${h.num_comments} комментариев · обсуждение: https://news.ycombinator.com/item?id=${h.objectID}`, signal: h.points, published: h.created_at })) stats.hn++;
    }
  } catch (e) { stats.errors.push('hn: ' + e.message); }
  // RSS/Atom: блоги компаний и обозреватели
  for (const url of rc.feeds) {
    try {
      const r = await f(url, { headers: { 'User-Agent': 'neurosfera-radar' } });
      if (!r.ok) throw new Error(String(r.status));
      const host = new URL(url).hostname.replace(/^www\./, '');
      const fresh = parseFeed(await r.text(), 'rss:' + host).filter((x) => !x.published || Date.parse(x.published) > Date.now() - 7 * 86400000);
      for (const it of fresh.slice(0, 20)) if (save(db, it)) stats.rss++;
    } catch (e) { stats.errors.push('rss ' + url + ': ' + e.message); }
  }
  db.audit('system', 'radar.collected', stats);
  return stats;
}

export function dailyRadarTask(ctx) {
  const { db } = ctx;
  const rc = ctx.radarCfg || radarConfig();
  const n = db.get(`SELECT COUNT(*) n FROM radar_items WHERE verdict IS NULL`).n;
  if (!n) return null;
  if (db.get(`SELECT 1 FROM tasks WHERE agent_id='tr_head' AND status IN ('queued','running') LIMIT 1`)) return null;
  return addTask(db, {
    title: 'Технологический дайджест дня', agentId: 'tr_head', dept: 'tech_radar', priority: 3, createdBy: 'system:notify',
    body: `Новых находок: ${n}. Получи их через radar_list (по ${rc.dailyItems} самых заметных) и оцени каждую через radar_assess: ignore / watch / pilot, польза для «Нейросферы» 0–10.
Критерии пользы: экономит деньги или время агентов, ускоряет запуск ИИ-продуктов, даёт новый канал продаж, повышает качество или безопасность. Учитывай текущие проекты (company_status) и стоимость внедрения.
Если находка требует глубины — поручи коллегам (Ольга — модели и API, Денис — open-source, скиллы, MCP) или сам используй web_search / read_url.
По каждой находке с вердиктом pilot оформи propose_adoption: что внедряем, польза в цифрах, стоимость, риски, план пилота на 1–2 недели, какой отдел внедряет.
В конце сохрани дайджест через write_document (kind=digest): 5–10 главных событий дня одной строкой каждое, с ссылками, и что предлагаешь. Итоговый ответ — короткая сводка для Telegram директора (до 1200 знаков).`,
  });
}

// ---------- цепочка внедрения ----------
export const ADOPTION_RU = { proposed: 'ждёт решения директора', security_review: 'проверка безопасности', pilot: 'пилот', pilot_done: 'пилот завершён — решение директора', adopted: 'внедрено', rejected: 'отклонено', blocked: 'заблокировано безопасностью', on_hold: 'отложено' };

export function proposeAdoption(ctx, agent, input) {
  const { db } = ctx;
  if (!input.title || !input.benefit || !input.plan) return { error: 'Нужны title, benefit и plan' };
  const owner = input.owner_dept && db.get('SELECT key FROM departments WHERE key=?', input.owner_dept) ? input.owner_dept : 'it';
  const dup = db.get(`SELECT id FROM adoptions WHERE title=? AND status NOT IN ('rejected','blocked')`, input.title);
  if (dup) return { ok: true, adoption_id: dup.id, note: 'Такое предложение уже есть' };
  const r = db.run(`INSERT INTO adoptions(title,summary,benefit,cost,risk,plan,owner_dept,items,status,proposed_by) VALUES(?,?,?,?,?,?,?,?, 'proposed', ?)`,
    input.title.slice(0, 200), input.summary || '', input.benefit, input.cost || '', input.risk || '', input.plan, owner, JSON.stringify(input.item_ids || []), agent.id);
  const id = Number(r.lastInsertRowid);
  db.feed('🛰', `${agent.name} предлагает внедрить: «${input.title}»`, agent.id, 'warn');
  ctx.telegram?.send?.(`🛰 Предложение внедрить (#${id}): ${input.title}\n\nПольза: ${String(input.benefit).slice(0, 500)}\nСтоимость: ${input.cost || '—'}\nРиски: ${input.risk || '—'}\nПлан пилота: ${String(input.plan).slice(0, 500)}\nВнедряет: ${owner}`,
    [[{ text: '✅ Запустить пилот', callback_data: `t:${id}:y` }, { text: '✖ Отклонить', callback_data: `t:${id}:n` }]]);
  return { ok: true, adoption_id: id, status: 'proposed', note: 'Ждёт решения директора' };
}

// Решения директора: на этапе proposed (пилот да/нет) и pilot_done (внедрить да/нет)
export function decideAdoption(ctx, id, approve, by = 'director', note = '') {
  const { db } = ctx;
  const a = db.get('SELECT * FROM adoptions WHERE id=?', id);
  if (!a) throw Object.assign(new Error('Предложение не найдено'), { code: 404 });
  let status = a.status;
  if (a.status === 'proposed') {
    status = approve ? 'security_review' : 'rejected';
    if (approve) {
      const sec = db.get(`SELECT id FROM agents WHERE id='sec_cyber' AND enabled=1`) ? 'sec_cyber' : null;
      addTask(db, { title: `Проверка безопасности: ${a.title}`, dept: 'security', agentId: sec, priority: 2, createdBy: by,
        body: `Директор согласовал пилот (предложение #${id}). Проверь до начала пилота: лицензию и условия использования, кто разработчик и насколько проект живой, какие данные и доступы нужны, риски утечки и промпт-инъекций, цепочку поставок (зависимости, кто может изменить код), стоимость. Читай первоисточники (read_url, web_search). Итог — adoption_update(id=${id}, security_ok=true|false, note). Код и пакеты на боевой сервер не устанавливать.\nПредложение: ${a.summary}\nПлан: ${a.plan}\nРиски по оценке разведки: ${a.risk}` });
    }
  } else if (a.status === 'pilot_done') {
    status = approve ? 'adopted' : 'rejected';
    if (approve) addTask(db, { title: `Внедрить в работу: ${a.title}`, dept: a.owner_dept, priority: 3, createdBy: by,
      body: `Директор утвердил внедрение по итогам пилота (#${id}). Внедри в постоянную работу, обнови регламент отдела (документ kind=plan), обучи коллег через задачи и сообщи, как измеряем эффект. Итоги пилота: ${a.result || '—'}` });
  } else return a;
  db.run(`UPDATE adoptions SET status=?, decided_at=datetime('now'), director_note=? WHERE id=?`, status, note || null, id);
  db.audit(by, 'adoption.' + status, { id, note });
  db.feed(approve ? '✅' : '✖', `Директор: «${a.title}» → ${ADOPTION_RU[status]}`, null, approve ? 'good' : 'info');
  return db.get('SELECT * FROM adoptions WHERE id=?', id);
}

// Шаги агентов: безопасность (отдел security) и итоги пилота (отдел-исполнитель)
export function adoptionUpdate(ctx, agent, input) {
  const { db } = ctx;
  const a = db.get('SELECT * FROM adoptions WHERE id=?', input.id);
  if (!a) return { error: 'Нет такого предложения' };
  if (a.status === 'security_review') {
    if (agent.dept !== 'security') return { error: 'Проверку безопасности закрывает только служба безопасности' };
    if (typeof input.security_ok !== 'boolean') return { error: 'Укажи security_ok: true/false и note' };
    if (!input.security_ok) {
      db.run(`UPDATE adoptions SET status='blocked', security_note=? WHERE id=?`, input.note || '', a.id);
      db.feed('🛡', `Безопасность заблокировала «${a.title}»: ${input.note || ''}`, agent.id, 'bad');
      ctx.notify?.(`🛡 Проверка безопасности не пройдена: «${a.title}»\n${String(input.note || '').slice(0, 800)}`);
      return { ok: true, status: 'blocked' };
    }
    const t = addTask(db, { title: `Пилот: ${a.title}`, dept: a.owner_dept, priority: 3, createdBy: agent.id,
      body: `Пилот согласован директором и проверен безопасностью (#${a.id}). План: ${a.plan}\nЗамечания безопасности: ${input.note || 'нет'}\nОграничения: без установки кода на боевой сервер, тестовые данные, траты только через propose_action. Измерь эффект в цифрах (время, деньги, качество) и закрой через adoption_update(id=${a.id}, pilot_result, recommend=adopt|reject).` });
    db.run(`UPDATE adoptions SET status='pilot', security_note=?, pilot_task_id=? WHERE id=?`, input.note || '', t, a.id);
    db.feed('🧪', `Пилот начат: «${a.title}»`, agent.id, 'good');
    return { ok: true, status: 'pilot', task_id: t };
  }
  if (a.status === 'pilot') {
    if (agent.dept !== a.owner_dept && agent.dept !== 'tech_radar') return { error: 'Итоги пилота сдаёт отдел-исполнитель' };
    if (!input.pilot_result) return { error: 'Нужен pilot_result с цифрами и recommend' };
    db.run(`UPDATE adoptions SET status='pilot_done', result=? WHERE id=?`, `${input.pilot_result}\nРекомендация: ${input.recommend || '—'}`, a.id);
    ctx.telegram?.send?.(`🧪 Пилот завершён (#${a.id}): ${a.title}\n\n${String(input.pilot_result).slice(0, 900)}\nРекомендация отдела: ${input.recommend === 'adopt' ? 'внедрять' : input.recommend === 'reject' ? 'не внедрять' : '—'}`,
      [[{ text: '✅ Внедрить', callback_data: `t:${a.id}:y` }, { text: '✖ Отказаться', callback_data: `t:${a.id}:n` }]]);
    db.feed('🧪', `Пилот «${a.title}» завершён — ждёт решения директора`, agent.id, 'warn');
    return { ok: true, status: 'pilot_done' };
  }
  return { error: `Сейчас этап «${ADOPTION_RU[a.status]}» — агент его не меняет` };
}

export function radarList(db, input = {}) {
  const lim = Math.min(Number(input.limit) || 40, 80);
  if (input.verdict) return db.all(`SELECT id,source,title,url,summary,signal,verdict,relevance FROM radar_items WHERE verdict=? ORDER BY id DESC LIMIT ?`, input.verdict, lim);
  // новые находки: GitHub/HN по силе сигнала, блоги — по свежести
  return db.all(`SELECT id,source,title,url,summary,signal,published_at FROM radar_items WHERE verdict IS NULL ORDER BY (source LIKE 'rss:%') DESC, signal DESC, id DESC LIMIT ?`, lim);
}

export function radarAssess(db, agent, input) {
  const ids = [].concat(input.items || [input]).filter((x) => x && x.item_id);
  let n = 0;
  for (const x of ids) {
    if (!['ignore', 'watch', 'pilot'].includes(x.verdict)) continue;
    n += db.run(`UPDATE radar_items SET verdict=?, relevance=?, assessment=?, assessed_by=?, assessed_at=datetime('now') WHERE id=?`,
      x.verdict, Math.max(0, Math.min(10, Number(x.relevance) || 0)), String(x.note || '').slice(0, 1000), agent.id, x.item_id).changes;
  }
  return { ok: true, assessed: n };
}
