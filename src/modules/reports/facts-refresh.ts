import { one, requireOne, type Database, type Sql } from '../../shared/db.js';
import { businessMinutesBetween, loadBusinessCalendar, type Calendar } from '../sla/index.js';

import { CHANGED_TICKETS, UPSERT_FACTS } from './facts-sql.js';

const BATCH = 500;
const WATERMARK_OVERLAP = "interval '1 minute'";
const NO_TICKET = '00000000-0000-0000-0000-000000000000';

interface FactTimes extends Record<string, unknown> {
    ticket_id: string;
    lifecycle: number;
    started_at: Date | string;
    first_response_at: Date | string | null;
    closed_at: Date | string | null;
    waiting_seconds: number;
}

function businessSeconds(start: Date | string, end: Date | string | null, calendar: Calendar): number | null {
    return end === null ? null : Math.round(businessMinutesBetween(new Date(start), new Date(end), calendar) * 60);
}

async function storeBusinessTimes(tx: Sql, rows: FactTimes[], calendar: Calendar | undefined): Promise<void> {
    if (!rows.length) {
        return;
    }

    const response = rows.map((row) =>
        calendar ? businessSeconds(row.started_at, row.first_response_at, calendar) : null,
    );

    const resolution = rows.map((row) => {
        const total = calendar ? businessSeconds(row.started_at, row.closed_at, calendar) : null;

        return total === null ? null : Math.max(0, total - row.waiting_seconds);
    });

    await tx.query(
        `UPDATE ticket_facts f SET first_response_business_seconds=v.response,resolution_business_seconds=v.resolution
     FROM unnest($1::uuid[],$2::int[],$3::int[],$4::int[]) AS v(ticket_id,lifecycle,response,resolution)
     WHERE f.ticket_id=v.ticket_id AND f.lifecycle=v.lifecycle`,
        [rows.map((row) => row.ticket_id), rows.map((row) => row.lifecycle), response, resolution],
    );
}

export async function refreshTicketFacts(tx: Sql, org: string, ticketIds: string[]): Promise<void> {
    if (!ticketIds.length) {
        return;
    }

    const { rows } = await tx.query<FactTimes>(UPSERT_FACTS, [org, ticketIds]);

    await storeBusinessTimes(tx, rows, await loadBusinessCalendar(tx, org));
}

async function refreshChanged(tx: Sql, org: string, since: string): Promise<number> {
    const calendar = await loadBusinessCalendar(tx, org);
    let after = NO_TICKET;
    let total = 0;

    for (;;) {
        const { rows: ids } = await tx.query<{ id: string }>(CHANGED_TICKETS, [org, since, after, BATCH]);

        if (!ids.length) {
            return total;
        }

        const { rows } = await tx.query<FactTimes>(UPSERT_FACTS, [org, ids.map((row) => row.id)]);

        await storeBusinessTimes(tx, rows, calendar);
        total += ids.length;
        after = ids.at(-1)?.id ?? after;
    }
}

export async function refreshFacts(db: Database, org: string, maxAgeSeconds: number): Promise<number | null> {
    return db.tx(async (tx) => {
        const lock = await requireOne<{ locked: boolean }>(
            tx,
            "SELECT pg_try_advisory_xact_lock(hashtext('ticket_facts:'||$1::text)) AS locked",
            [org],
        );

        if (!lock.locked) {
            return null;
        }

        await tx.query('INSERT INTO facts_refresh(org_id) VALUES($1) ON CONFLICT DO NOTHING', [org]);

        const state = await one<{ since: string; fresh: boolean }>(
            tx,
            `SELECT (watermark-${WATERMARK_OVERLAP})::text AS since,
         coalesce(ran_at>now()-$2*interval '1 second',false) AS fresh
       FROM facts_refresh WHERE org_id=$1 FOR UPDATE`,
            [org, maxAgeSeconds],
        );

        if (!state || state.fresh) {
            return null;
        }

        await tx.query('UPDATE facts_refresh SET watermark=now(),ran_at=now() WHERE org_id=$1', [org]);

        return refreshChanged(tx, org, state.since);
    });
}
