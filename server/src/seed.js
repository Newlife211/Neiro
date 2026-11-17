// Первичное наполнение: отделы и сотрудники из симулятора, стартовые задачи.
import fs from 'node:fs';
import path from 'node:path';
import { addTask } from './worker.js';

const KNOWN_EMAIL = { sl_head: 'neurosfera-novikov@agentmail.to', sl_b2b: 'neurosfera-fedorova@agentmail.to', sl_part: 'neurosfera-khasanov@agentmail.to' };

export function seed(db, cfg) {
  const data = JSON.parse(fs.readFileSync(path.join(cfg.root, 'data', 'agents.json'), 'utf8'));
  db.tx(() => {
    for (const [key, d] of Object.entries(data.departments)) db.run('INSERT OR IGNORE INTO departments(key,name,rules) VALUES(?,?,?)', key, d.name, JSON.stringify(d.rules || []));
    for (const a of data.agents) {
      db.run(`INSERT OR IGNORE INTO agents(id,name,role,dept,boss,head,skills,duties,character,goal,enabled,email) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        a.id, a.name, a.role, a.dept, a.boss, a.head ? 1 : 0, JSON.stringify(a.skills || []), JSON.stringify(a.duties || []), a.character || '', a.goal || '', a.enabled ? 1 : 0, KNOWN_EMAIL[a.id] || null);
    }
  });
  if (!db.setting('bootstrapped', false)) {
    db.setSetting('bootstrapped', true);
    addTask(db, {
      title: 'План первых 30 дней: путь к первой выручке', dept: 'admin', agentId: 'cdo', priority: 1, createdBy: 'system',
      body: 'Компания только запустилась в боевом режиме. Направление — ИИ-продукты/SaaS, оплаты через Stripe (ЕС) и ЮKassa (РФ). Составь план на 30 дней: цель по выручке, 3 приоритета, метрики, кто за что отвечает, бюджет в пределах лимитов. Сохрани как документ (kind=plan). Поставь R&D задачу подобрать гипотезы, если её ещё нет.',
    });
    addTask(db, {
      title: 'Три гипотезы ИИ-SaaS с быстрой окупаемостью', dept: 'rnd', agentId: 'rnd_head', priority: 2, createdBy: 'system',
      body: 'Найди 3 идеи ИИ-продукта, который можно сделать за 7–14 дней и продавать по подписке. Для каждой: кто платит и за что, конкуренты и цены (только проверяемые факты — где данных нет, так и пиши), MVP, цена, оценка ROI. Создай проекты через upsert_project, лучшую доведи до этапа «decision», чтобы директор принял решение. Итоговое сравнение — документом.',
    });
    db.feed('🏢', 'Нейросфера запущена в боевом режиме. Стартовые задачи поставлены директору по развитию и R&D.');
  }
}
