// Курсы валют: ЕЦБ (все валюты к евро) и ЦБ РФ (рубль). Обновляются автоматически раз в день.
// Формат курсов в системе: «сколько единиц валюты за 1 EUR».

export function parseEcb(xml) {
  const rates = { EUR: 1 };
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) rates[m[1]] = Number(m[2]);
  const date = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1] || null;
  return { rates, date };
}

// ЦБ РФ публикует «рублей за N единиц валюты». Нам нужен рубль за 1 EUR.
export function parseCbr(xml) {
  const blocks = [...xml.matchAll(/<Valute[^>]*>([\s\S]*?)<\/Valute>/g)].map((m) => m[1]);
  const pick = (b, tag) => b.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
  const eur = blocks.find((b) => pick(b, 'CharCode') === 'EUR');
  if (!eur) return null;
  const value = Number(pick(eur, 'Value').replace(',', '.')), nominal = Number(pick(eur, 'Nominal') || 1);
  const date = xml.match(/Date="(\d{2})\.(\d{2})\.(\d{4})"/);
  return { rubPerEur: value / nominal, date: date ? `${date[3]}-${date[2]}-${date[1]}` : null };
}

export function applyRates(cfg, saved) {
  if (saved?.rates) Object.assign(cfg.fx, saved.rates);
}

export async function updateRates(ctx) {
  const { db, cfg } = ctx;
  const f = ctx.fetch || fetch;
  const out = { rates: {}, sources: [] };
  try {
    const r = await f('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
    if (r.ok) { const e = parseEcb(await r.text()); if (Object.keys(e.rates).length > 5) { Object.assign(out.rates, e.rates); out.sources.push('ЕЦБ ' + e.date); } }
  } catch (e) { ctx.log?.error('fx ecb', e.message); }
  try {
    const r = await f('https://www.cbr.ru/scripts/XML_daily.asp');
    if (r.ok) { const c = parseCbr(await r.text()); if (c?.rubPerEur > 0) { out.rates.RUB = Math.round(c.rubPerEur * 10000) / 10000; out.sources.push('ЦБ РФ ' + c.date); } }
  } catch (e) { ctx.log?.error('fx cbr', e.message); }
  if (!out.sources.length) return null; // оставляем последние известные курсы
  const saved = { rates: { ...(db.setting('fx_rates', {})?.rates || {}), ...out.rates }, sources: out.sources, updated: new Date().toISOString() };
  db.setSetting('fx_rates', saved);
  applyRates(cfg, saved);
  db.audit('system', 'fx.updated', { sources: out.sources, RUB: saved.rates.RUB, USD: saved.rates.USD });
  return saved;
}
