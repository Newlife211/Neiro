// Точка входа боевого сервера «Нейросфера».
import path from 'node:path';
import { loadDotEnv, buildConfig, configWarnings } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { createActions } from './actions.js';
import { buildExecutors } from './executors.js';
import { createLLM } from './llm.js';
import { createAgentRuntime } from './agent.js';
import { createWorker } from './worker.js';
import { createScheduler } from './company.js';
import { createTelegram } from './telegram.js';
import { createHttp } from './http.js';
import { revolutConfig, revolutClient } from './revolut.js';
import { payseraConfig } from './bank.js';
import { applyRates } from './fx.js';
import { radarConfig } from './radar.js';
import { createMarketing } from './marketing.js';
import { adsConfig, socialPublisher } from './ads.js';
import crypto from 'node:crypto';

const log = {
  info: (...a) => console.log(new Date().toISOString(), '[info]', ...a),
  error: (...a) => console.error(new Date().toISOString(), '[error]', ...a),
};

export function createApp(cfg, opts = {}) {
  const db = opts.db || openDb(path.join(cfg.dataDir, 'neurosfera.db'));
  const ctx = { cfg, db, log, fetch: opts.fetch || fetch, backoffScale: opts.backoffScale };
  seed(db, cfg);
  applyRates(cfg, db.setting('fx_rates')); // последние известные курсы ЕЦБ/ЦБ РФ
  ctx.revolutCfg = opts.revolutCfg || revolutConfig();
  ctx.revolut = opts.revolut || (ctx.revolutCfg.enabled ? revolutClient(ctx.revolutCfg, db, ctx.fetch) : null);
  ctx.paysera = opts.paysera || payseraConfig();
  ctx.radarCfg = opts.radarCfg || radarConfig();
  ctx.adsCfg = opts.adsCfg || adsConfig();
  ctx.executors = opts.executors || buildExecutors(cfg, ctx.fetch, { revolut: () => ctx.revolut, revolutCfg: ctx.revolutCfg, adsCfg: ctx.adsCfg, threadsToken: () => db.setting('threads_token') });
  ctx.social = socialPublisher(ctx.adsCfg, ctx.fetch, { crypto, threadsToken: () => db.setting('threads_token') });
  ctx.actions = createActions(ctx);
  ctx.marketing = createMarketing(ctx, { adsCfg: ctx.adsCfg, platforms: opts.platforms });
  ctx.llm = createLLM(ctx);
  ctx.runtime = createAgentRuntime(ctx);
  ctx.telegram = createTelegram(ctx);
  ctx.notify = (text, o) => ctx.telegram.notify(text, o);
  ctx.actions.on((ev, a) => {
    if (ev === 'pending') ctx.telegram.notifyAction(a);
    if (ev === 'manual') ctx.notify(`🖐 Нужно выполнить вручную (#${a.id}): ${a.kind} ${a.amount ? a.amount + ' ' + a.currency : ''}\n${a.result?.note || ''}\nПосле выполнения отметьте в пульте.`);
    if (ev === 'failed') ctx.notify(`⚠️ Действие #${a.id} (${a.kind}) не выполнено: ${a.error}`);
    // сообщаем агенту о решении директора, чтобы он продолжил работу
    if (ev === 'decided' && a.agent_id && a.task_id) {
      db.run('INSERT INTO tasks(title,body,agent_id,dept,parent_id,priority,created_by) VALUES(?,?,?,(SELECT dept FROM agents WHERE id=?),?,3,?)',
        `Решение по действию #${a.id}: ${a.status}`, `Твоё действие «${a.kind}» (#${a.id}) — статус: ${a.status}.${a.result ? ' Результат: ' + JSON.stringify(a.result) : ''}${a.error ? ' Ошибка: ' + a.error : ''} Продолжи работу с учётом этого или закрой вопрос коротким отчётом.`,
        a.agent_id, a.agent_id, a.task_id, 'system');
    }
  });
  ctx.worker = createWorker(ctx);
  ctx.scheduler = createScheduler(ctx);
  ctx.http = createHttp(ctx);
  return ctx;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnv(process.env.ENV_FILE || path.resolve(process.cwd(), '.env'));
  const cfg = buildConfig();
  const warnings = configWarnings(cfg);
  warnings.forEach((w) => log.info('⚠ ' + w));
  if (process.argv.includes('--check')) { console.log(warnings.length ? 'Есть замечания (см. выше)' : 'Конфигурация в порядке'); process.exit(0); }
  const app = createApp(cfg);
  app.http.listen(cfg.port);
  log.info(`Нейросфера слушает порт ${cfg.port}. Пульт: ${cfg.publicUrl}/`);
  if (cfg.workers.enabled && cfg.anthropic.apiKey) app.worker.start(); else log.info('Воркеры выключены (нет ANTHROPIC_API_KEY или WORKERS_ENABLED=0)');
  app.scheduler.start();
  app.telegram.start();
  if (app.telegram.enabled) app.notify('🏢 Нейросфера запущена. /help — команды.');
  const bye = () => { log.info('Остановка…'); app.worker.stop(); app.scheduler.stop(); app.telegram.stop(); setTimeout(() => { app.db.close(); process.exit(0); }, 500); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}
