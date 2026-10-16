import { DEFAULT_TEMPLATES } from '../../modules/templates/index.js';
import type { Config } from '../../shared/config.js';
import { one, requireOne, type Database, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

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

        await ensureTicketSequence(tx, config.ORG_ID);
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

const SHARED_SEQUENCE = 'ticket_number_seq';

async function ensureTicketSequence(tx: Sql, org: string): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(7136002)');
    const own = await requireOne(tx, 'SELECT ticket_sequence FROM organizations WHERE id=$1', [org]);

    const sharedWithOthers = await one(
        tx,
        'SELECT 1 AS taken FROM organizations WHERE id<>$1 AND ticket_sequence=$2 LIMIT 1',
        [org, SHARED_SEQUENCE],
    );

    if (own.ticket_sequence !== SHARED_SEQUENCE || !sharedWithOthers) {
        return;
    }

    ensure(/^[\da-f-]{36}$/.test(org), 'invalid_org_id', 422);
    const name = `${SHARED_SEQUENCE}_${org.replaceAll('-', '')}`;

    const next = await requireOne(tx, 'SELECT coalesce(max(ticket_number),0)+1 AS n FROM tickets WHERE org_id=$1', [
        org,
    ]);

    await tx.query(
        `CREATE SEQUENCE IF NOT EXISTS ${name} MINVALUE 1 MAXVALUE 2147483647 START ${Number(next.n)} NO CYCLE CACHE 1`,
    );

    await tx.query('UPDATE organizations SET ticket_sequence=$2 WHERE id=$1', [org, name]);
}
