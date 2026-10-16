import { z } from 'zod';

import type { Sql } from '../../shared/db.js';

const MAX_TEXT = 3500;

const alertsBody = z.object({
    alerts: z
        .array(
            z.object({
                status: z.string(),
                labels: z.record(z.string(), z.string()),
                annotations: z.record(z.string(), z.string()).default({}),
            }),
        )
        .max(200),
});

export interface AlertSender {
    sendToUser(userId: string, text: string): Promise<void>;
}

type Alert = z.infer<typeof alertsBody>['alerts'][number];

export function alertText(body: unknown): string | null {
    const { alerts } = alertsBody.parse(body);

    const sections = [
        section(
            'Тревога',
            alerts.filter((alert) => alert.status === 'firing'),
        ),
        section(
            'Решено',
            alerts.filter((alert) => alert.status !== 'firing'),
        ),
    ].filter(Boolean);

    return sections.length ? sections.join('\n\n').slice(0, MAX_TEXT) : null;
}

function section(title: string, alerts: Alert[]): string {
    if (!alerts.length) {
        return '';
    }

    const lines = alerts.map((alert) => {
        const notes: Partial<Record<string, string>> = alert.annotations;
        const labels: Partial<Record<string, string>> = alert.labels;
        const summary = notes.summary ?? notes.description ?? '';

        return `• ${labels.alertname ?? 'alert'}${summary ? ` — ${summary}` : ''}`;
    });

    return [`${title} · TaskLine`, ...lines].join('\n');
}

export async function relayAlerts(db: Sql, org: string, sender: AlertSender, body: unknown): Promise<number> {
    const text = alertText(body);

    if (!text) {
        return 0;
    }

    const { rows } = await db.query<{ max_user_id: string }>(
        `SELECT max_user_id FROM employees
     WHERE org_id=$1 AND role='admin' AND NOT blocked AND activated_at IS NOT NULL`,
        [org],
    );

    for (const admin of rows) {
        await sender.sendToUser(admin.max_user_id, text);
    }

    return rows.length;
}

const staffAlertPayload = z.object({ user_id: z.string().min(1), text: z.string().min(1).max(MAX_TEXT) });

export async function sendStaffAlert(sender: AlertSender, payload: unknown): Promise<void> {
    const alert = staffAlertPayload.parse(payload);

    await sender.sendToUser(alert.user_id, alert.text);
}
