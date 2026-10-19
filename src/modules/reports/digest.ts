import type { Config } from '../../shared/config.js';
import { one, type Database, type Sql } from '../../shared/db.js';
import { enqueue } from '../../shared/events.js';
import { loadBusinessCalendar } from '../sla/index.js';

import { refreshFacts } from './facts-refresh.js';
import { windowMetrics, type OverviewMetrics } from './overview.js';

const DIGEST_HOUR = 9;

interface DueWeek extends Record<string, unknown> {
    week_start: string;
    start: Date | string;
    end: Date | string;
    label: string;
}

const DUE_WEEK = `SELECT to_char(w.week_start,'YYYY-MM-DD') AS week_start,
  (w.week_start-7)::timestamp AT TIME ZONE o.timezone AS start,w.week_start::timestamp AT TIME ZONE o.timezone AS "end",
  to_char(w.week_start-7,'DD.MM')||'–'||to_char(w.week_start-1,'DD.MM') AS label
FROM organizations o
CROSS JOIN LATERAL (SELECT date_trunc('week',now() AT TIME ZONE o.timezone)::date AS week_start,
  now() AT TIME ZONE o.timezone AS local_now) w
WHERE o.id=$1 AND extract(isodow FROM w.local_now)=1 AND extract(hour FROM w.local_now)>=$2
  AND NOT EXISTS(SELECT 1 FROM report_digests d WHERE d.org_id=o.id AND d.week_start=w.week_start)`;

export function formatDuration(totalSeconds: number | null): string {
    if (totalSeconds === null) {
        return '—';
    }

    const minutes = Math.round(totalSeconds / 60);

    if (minutes < 60) {
        return `${minutes} мин`;
    }

    if (minutes < 48 * 60) {
        return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
    }

    return `${(minutes / 1440).toFixed(1).replace('.', ',')} дн`;
}

function change(current: number, previous: number): string {
    if (previous === 0) {
        return '';
    }

    const delta = Math.round(((current - previous) / previous) * 100);

    return delta === 0 ? ' (как неделей ранее)' : ` (${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}%)`;
}

export function digestText(
    label: string,
    metrics: { current: OverviewMetrics; previous: OverviewMetrics; accuracy: number | null },
    link: string,
): string {
    const { current, previous, accuracy } = metrics;
    const csat = current.csat === null ? '—' : `${current.csat.toFixed(1).replace('.', ',')} из 10`;

    return [
        `Неделя ${label} · TaskLine`,
        `Новых обращений: ${current.created}${change(current.created, previous.created)}`,
        `Закрыто: ${current.closed}`,
        `Первый ответ, медиана: ${formatDuration(current.response_p50)}`,
        `Оценка клиентов: ${csat}`,
        `ИИ верно определил тему: ${accuracy === null ? '—' : `${Math.round(accuracy * 100)}%`}`,
        ...(link ? [`Отчёты: ${link}`] : []),
    ].join('\n');
}

async function topicAccuracy(db: Sql, org: string, window: { start: Date; end: Date }): Promise<number | null> {
    const row = await one<{ classified: number; kept: number }>(
        db,
        `SELECT count(*)::int AS classified,count(*) FILTER (WHERE ai_tag_kept)::int AS kept FROM ticket_facts
     WHERE org_id=$1 AND lifecycle=1 AND ai_classified AND closed_at>=$2 AND closed_at<$3`,
        [org, window.start, window.end],
    );

    return row && row.classified > 0 ? row.kept / row.classified : null;
}

export class ReportDigest {
    constructor(
        private readonly db: Database,
        private readonly config: Config,
    ) {}

    async run(): Promise<boolean> {
        const org = this.config.ORG_ID;
        const due = await one<DueWeek>(this.db, DUE_WEEK, [org, DIGEST_HOUR]);

        if (!due) {
            return false;
        }

        await refreshFacts(this.db, org, 0);
        const end = new Date(due.end);
        const start = new Date(due.start);
        const businessHours = (await loadBusinessCalendar(this.db, org)) !== undefined;
        const current = await windowMetrics(this.db, org, { start, end, businessHours });
        const previousStart = new Date(start.getTime() - (end.getTime() - start.getTime()));
        const previous = await windowMetrics(this.db, org, { start: previousStart, end: start, businessHours });
        const accuracy = await topicAccuracy(this.db, org, { start, end });

        const link = this.config.STAFF_APP_URL
            ? `${this.config.STAFF_APP_URL}${this.config.STAFF_APP_URL.includes('?') ? '&' : '?'}startapp=reports`
            : '';

        const text = digestText(due.label, { current, previous, accuracy }, link);

        return this.db.tx(async (tx) => this.send(tx, due.week_start, text));
    }

    private async send(tx: Sql, weekStart: string, text: string): Promise<boolean> {
        const org = this.config.ORG_ID;

        const claimed = await one(
            tx,
            'INSERT INTO report_digests(org_id,week_start) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING week_start',
            [org, weekStart],
        );

        if (!claimed) {
            return false;
        }

        const { rows } = await tx.query<{ id: string; max_user_id: string }>(
            `SELECT id,max_user_id FROM employees WHERE org_id=$1 AND role IN('supervisor','admin')
       AND NOT blocked AND activated_at IS NOT NULL`,
            [org],
        );

        for (const employee of rows) {
            await enqueue(tx, org, {
                key: `report-digest:${weekStart}:${employee.id}`,
                kind: 'staff_alert',
                refId: employee.id,
                payload: { user_id: employee.max_user_id, text },
            });
        }

        return true;
    }
}
