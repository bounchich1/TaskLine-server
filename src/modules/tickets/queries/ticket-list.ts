import { z } from 'zod';

import { one, type Sql } from '../../../shared/db.js';
import { ensure } from '../../../shared/errors.js';
import type { Row } from '../../../shared/types/entities.js';
import { LINKED_TO_OPEN_INCIDENT } from '../../incidents/index.js';

import { filterConditions, type Filters, type SqlConditions } from './ticket-filters.js';
import { SLA_DUE, SLA_WARN, TICKET_JOINS, TICKET_PROJECTION } from './ticket-projection.js';

const OPEN_STATUSES = "t.status IN('open','in_progress')";
const CLOSED_STATUSES = "t.status IN('awaiting_rating','closed')";
const QUEUE = `${OPEN_STATUSES} AND NOT ${LINKED_TO_OPEN_INCIDENT}`;
const INCIDENT_QUEUE = `${OPEN_STATUSES} AND ${LINKED_TO_OPEN_INCIDENT}`;

function tabCondition(filters: Filters): string {
    switch (filters.tab) {
        case 'open':
            return filters.incident ? OPEN_STATUSES : QUEUE;
        case 'closed':
            return CLOSED_STATUSES;
        case 'incident':
            return INCIDENT_QUEUE;
        case 'all':
            return 'true';
    }
}

const SORT_SCORES: Record<Filters['sort'], string> = {
    urgency: 'coalesce(du.rank,0)',
    complexity: 'coalesce(dc.rank,0)',
    rating: 'coalesce(c.rating,-1)',
    sla_risk: `-coalesce(extract(epoch FROM ${SLA_DUE}),1e11)`,
    newest: '0',
    oldest: '0',
};

const cursorSchema = z.tuple([z.number(), z.number(), z.uuid()]);

export async function listTickets(db: Sql, org: string, filters: Filters, countsOnly = false) {
    const conditions = filterConditions(org, filters);

    const counts = await one(
        db,
        `SELECT count(*) FILTER(WHERE ${QUEUE})::int AS open,
       count(*) FILTER(WHERE ${CLOSED_STATUSES})::int AS closed,
       count(*) FILTER(WHERE ${INCIDENT_QUEUE})::int AS incident,
       count(*) FILTER(WHERE ${SLA_WARN}<=now() AND NOT ${LINKED_TO_OPEN_INCIDENT})::int AS at_risk,now() AS snapshot_at
     ${TICKET_JOINS} WHERE ${conditions.where()}`,
        conditions.values,
    );

    if (countsOnly) {
        return counts;
    }

    conditions.clauses.push(tabCondition(filters));
    const score = SORT_SCORES[filters.sort];
    const date = `${filters.sort === 'newest' ? '-' : ''}extract(epoch FROM t.created_at)`;
    const sortKey = `(-(${score}),${date},t.id)`;

    if (filters.cursor) {
        addCursorCondition(conditions, sortKey, filters.cursor);
    }

    const limit = conditions.param(filters.limit + 1);

    const rows = (
        await db.query(
            `SELECT ${TICKET_PROJECTION},-(${score}) AS cursor_rank,(${date})::text AS cursor_date
       ${TICKET_JOINS} WHERE ${conditions.where()} ORDER BY ${sortKey} ASC LIMIT ${limit}`,
            conditions.values,
        )
    ).rows;

    const items = rows.slice(0, filters.limit);
    const organization = await one(db, 'SELECT cursor FROM organizations WHERE id=$1', [org]);

    return {
        items,
        counts,
        next_cursor: rows.length > filters.limit ? encodeCursor(items.at(-1)) : null,
        cursor: organization?.cursor,
    };
}

function addCursorCondition(conditions: SqlConditions, sortKey: string, cursor: string): void {
    const [rank, date, id] = decodeCursor(cursor);
    const rankParam = conditions.param(rank);
    const dateParam = conditions.param(date);
    const idParam = conditions.param(id);

    conditions.clauses.push(`${sortKey}>(${rankParam}::numeric,${dateParam}::numeric,${idParam}::uuid)`);
}

function decodeCursor(cursor: string): z.infer<typeof cursorSchema> {
    let decoded: unknown;

    try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
        ensure(false, 'invalid_cursor', 422);
    }

    return cursorSchema.parse(decoded);
}

function encodeCursor(last: Row | undefined): string | null {
    if (!last) {
        return null;
    }

    const key = [Number(last.cursor_rank), Number(last.cursor_date), last.id];

    return Buffer.from(JSON.stringify(key)).toString('base64url');
}
