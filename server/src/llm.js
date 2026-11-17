// Клиент Claude Messages API (без SDK — только fetch) с учётом стоимости каждого вызова.
import { round2 } from './policy.js';

export function createLLM(ctx) {
  const { cfg, db } = ctx;
  const fetchImpl = ctx.fetch || fetch;

  function cost(tier, usage) {
    const pin = cfg.anthropic.priceIn[tier] ?? cfg.anthropic.priceIn.worker;
    const pout = cfg.anthropic.priceOut[tier] ?? cfg.anthropic.priceOut.worker;
    const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
    const usd = (inTok * pin + (usage.output_tokens || 0) * pout) / 1e6;
    // USD → базовая валюта через курсы из конфига
    return round2((usd / (cfg.fx.USD || 1)) * (cfg.fx[cfg.baseCurrency] || 1) * 10000) / 10000;
  }

  async function call({ tier = 'worker', system, messages, tools, taskId = null, agentId = null }) {
    if (!cfg.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY не задан');
    const model = tier === 'lead' ? cfg.anthropic.modelLead : cfg.anthropic.modelWorker;
    const body = { model, max_tokens: cfg.anthropic.maxTokens, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages };
    if (tools?.length) body.tools = tools;
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetchImpl(cfg.anthropic.baseUrl + '/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': cfg.anthropic.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 429 || r.status === 529 || r.status >= 500) {
        lastErr = new Error('Claude API ' + r.status);
        await new Promise((res) => setTimeout(res, Math.min(30000, 1000 * 2 ** attempt) * (ctx.backoffScale ?? 1)));
        continue;
      }
      const j = await r.json();
      if (!r.ok) throw new Error('Claude API: ' + (j.error?.message || r.status));
      const c = cost(tier, j.usage || {});
      db.run('INSERT INTO runs(task_id,agent_id,model,in_tokens,out_tokens,cost_base) VALUES(?,?,?,?,?,?)', taskId, agentId, model, j.usage?.input_tokens || 0, j.usage?.output_tokens || 0, c);
      return j;
    }
    throw lastErr;
  }
  return { call, cost };
}
