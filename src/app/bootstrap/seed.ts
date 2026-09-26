import { DEFAULT_TEMPLATES } from '../../modules/templates/index.js';
import type { Config } from '../../shared/config.js';
import type { Database, Sql } from '../../shared/db.js';

const DEFAULT_DICTIONARY: [string, string, string, number][] = [
    ['tag', 'undefined', 'Не определён', 0],
    ['tag', 'no_connection', 'Нет интернета', 11],
    ['tag', 'unstable_connection', 'Обрывы, потери пакетов, пинг', 10],
    ['tag', 'slow_speed', 'Низкая скорость', 9],
    ['tag', 'wifi_router', 'Wi-Fi и роутер', 8],
    ['tag', 'equipment', 'Оборудование и кабель', 7],
    ['tag', 'billing', 'Оплата и баланс', 6],
    ['tag', 'tariff', 'Тарифы и услуги', 5],
    ['tag', 'connection_request', 'Подключение и переезд', 4],
    ['tag', 'account', 'Личный кабинет', 3],
    ['tag', 'complaint', 'Жалоба на обслуживание', 2],
    ['tag', 'other', 'Другое', 1],
    ['urgency', 'low', 'Низкая', 0],
    ['urgency', 'medium', 'Средняя', 1],
    ['urgency', 'high', 'Высокая', 2],
    ['urgency', 'critical', 'Критическая', 3],
    ['complexity', 'low', 'Низкая', 0],
    ['complexity', 'medium', 'Средняя', 1],
    ['complexity', 'high', 'Высокая', 2],
];

export async function seed(db: Database, config: Config): Promise<void> {
    await db.tx(async (tx) => {
        await tx.query('INSERT INTO organizations(id,name,timezone) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
            config.ORG_ID,
            config.ORG_NAME,
            config.ORG_TIMEZONE,
        ]);

        await tx.query('INSERT INTO ai_settings(id,cap) VALUES(1,$1) ON CONFLICT DO NOTHING', [
            config.AI_MAX_CONCURRENCY,
        ]);

        await tx.query('INSERT INTO memory_writer(org_id) VALUES($1) ON CONFLICT DO NOTHING', [config.ORG_ID]);
        await seedDictionary(tx, config.ORG_ID);

        for (const [code, body] of Object.entries(DEFAULT_TEMPLATES)) {
            await tx.query('INSERT INTO templates(org_id,code,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
                config.ORG_ID,
                code,
                body,
            ]);
        }
    });
}

async function seedDictionary(tx: Sql, org: string): Promise<void> {
    for (const [dimension, code, label, rank] of DEFAULT_DICTIONARY) {
        await tx.query(
            `INSERT INTO dictionaries(org_id,dimension,code,label,rank) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`,
            [org, dimension, code, label, rank],
        );
    }
}
