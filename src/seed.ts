import type { Config } from './config.js';
import type { Database } from './db.js';
import { templates } from './templates.js';
export async function seed(db: Database, c: Config) {
  await db.tx(async (tx) => {
    await tx.query(
      'INSERT INTO organizations(id,name,timezone) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [c.ORG_ID, c.ORG_NAME, c.ORG_TIMEZONE],
    );
    await tx.query('INSERT INTO ai_settings(id,cap) VALUES(1,$1) ON CONFLICT DO NOTHING', [
      c.AI_MAX_CONCURRENCY,
    ]);
    await tx.query('INSERT INTO memory_writer(org_id) VALUES($1) ON CONFLICT DO NOTHING', [
      c.ORG_ID,
    ]);
    const values = [
      ['tag', 'undefined', 'Не определён', 0],
      ['urgency', 'low', 'Низкая', 0],
      ['urgency', 'medium', 'Средняя', 1],
      ['urgency', 'high', 'Высокая', 2],
      ['urgency', 'critical', 'Критическая', 3],
      ['complexity', 'low', 'Низкая', 0],
      ['complexity', 'medium', 'Средняя', 1],
      ['complexity', 'high', 'Высокая', 2],
    ];
    for (const [dimension, code, label, rank] of values) {
      await tx.query(
        'INSERT INTO dictionaries(org_id,dimension,code,label,rank) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [c.ORG_ID, dimension, code, label, rank],
      );
    }
    for (const [code, body] of Object.entries(templates)) {
      await tx.query(
        'INSERT INTO templates(org_id,code,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [c.ORG_ID, code, body],
      );
    }
  });
}
