import { z } from 'zod';

import { one, requireOne, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

export const incidentSettingsBody = z
    .object({
        detection: z.boolean(),
        auto_link: z.boolean(),
        window_minutes: z.number().int().min(5).max(120),
        min_tickets: z.number().int().min(2).max(1000),
        spike_factor: z.number().min(1).max(50),
        relink_hours: z.number().int().min(0).max(72),
    })
    .strict();

export type IncidentSettingsBody = z.infer<typeof incidentSettingsBody>;

export type IncidentSettings = IncidentSettingsBody & {
    version: number;
} & Record<string, unknown>;

const COLUMNS =
    'detection,auto_link,window_minutes,min_tickets,spike_factor::float AS spike_factor,relink_hours,version';

const DEFAULTS: IncidentSettings = {
    detection: true,
    auto_link: false,
    window_minutes: 15,
    min_tickets: 8,
    spike_factor: 4,
    relink_hours: 6,
    version: 0,
};

export async function readIncidentSettings(db: Sql, org: string): Promise<IncidentSettings> {
    const row = await one<IncidentSettings>(db, `SELECT ${COLUMNS} FROM incident_settings WHERE org_id=$1`, [org]);

    return row ?? DEFAULTS;
}

export async function ensureIncidentSettings(db: Sql, org: string): Promise<void> {
    await db.query('INSERT INTO incident_settings(org_id) VALUES($1) ON CONFLICT DO NOTHING', [org]);
}

export async function saveIncidentSettings(
    tx: Sql,
    org: string,
    { body, expectedVersion }: { body: IncidentSettingsBody; expectedVersion: number },
): Promise<IncidentSettings> {
    await ensureIncidentSettings(tx, org);

    const current = await requireOne<{ version: number }>(
        tx,
        'SELECT version FROM incident_settings WHERE org_id=$1 FOR UPDATE',
        [org],
    );

    ensure(
        current.version === expectedVersion || (expectedVersion === 0 && current.version === 1),
        'version_conflict',
        409,
        'Настройки изменились. Обновите страницу.',
    );

    return requireOne<IncidentSettings>(
        tx,
        `UPDATE incident_settings SET detection=$2,auto_link=$3,window_minutes=$4,min_tickets=$5,spike_factor=$6,
       relink_hours=$7,version=version+1 WHERE org_id=$1 RETURNING ${COLUMNS}`,
        [
            org,
            body.detection,
            body.auto_link,
            body.window_minutes,
            body.min_tickets,
            body.spike_factor,
            body.relink_hours,
        ],
    );
}
