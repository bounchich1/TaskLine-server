import { z } from 'zod';

import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

export const settingsBody = z
    .object({
        new_tickets: z.enum(['all', 'topics', 'off']),
        topics: z
            .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
            .max(50)
            .transform((codes) => [...new Set(codes)]),
        max_alerts: z.boolean(),
    })
    .strict();

export type NotificationSettings = z.infer<typeof settingsBody>;

const DEFAULTS: NotificationSettings = { new_tickets: 'all', topics: [], max_alerts: false };

export async function readSettings(db: Sql, org: string, employeeId: string): Promise<NotificationSettings> {
    const row = await one<NotificationSettings>(
        db,
        'SELECT new_tickets,topics,max_alerts FROM notification_settings WHERE org_id=$1 AND employee_id=$2',
        [org, employeeId],
    );

    return row ?? DEFAULTS;
}

export async function saveSettings(
    db: Sql,
    org: string,
    { employeeId, body }: { employeeId: string; body: NotificationSettings },
): Promise<NotificationSettings> {
    const topics = body.new_tickets === 'topics' ? body.topics : [];

    if (topics.length) {
        const { rows } = await db.query<{ code: string }>(
            "SELECT code FROM dictionaries WHERE org_id=$1 AND dimension='tag' AND code=ANY($2::text[])",
            [org, topics],
        );

        ensure(rows.length === topics.length, 'unknown_topic', 422, 'Одна из тем больше не существует.');
    }

    ensure(body.new_tickets !== 'topics' || topics.length, 'topics_required', 422, 'Выберите хотя бы одну тему.');

    await db.query(
        `INSERT INTO notification_settings(org_id,employee_id,new_tickets,topics,max_alerts) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(org_id,employee_id) DO UPDATE SET new_tickets=$3,topics=$4,max_alerts=$5,updated_at=now()`,
        [org, employeeId, body.new_tickets, topics, body.max_alerts],
    );

    return { ...body, topics };
}
