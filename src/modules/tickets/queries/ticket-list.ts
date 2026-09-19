import { z } from 'zod';

import { one, type Sql } from '../../../shared/db.js';
import { ensure } from '../../../shared/errors.js';
import type { Row } from '../../../shared/types/entities.js';

import { filterConditions, type Filters, type SqlConditions } from './ticket-filters.js';
import { TICKET_JOINS, TICKET_PROJECTION } from './ticket-projection.js';

const OPEN_STATUSES = "t.status IN('open','in_progress')";
const CLOSED_STATUSES = "t.status IN('awaiting_rating','closed')";

/** Primary sort score per sort option (higher first); ties break by creation date, then id. */
const SORT_SCORES: Record<Filters['sort'], string> = {
  urgency: 'coalesce(du.rank,0)',
  complexity: 'coalesce(dc.rank,0)',
  rating: 'coalesce(c.rating,-1)',
  newest: '0',
  oldest: '0',
};

const cursorSchema = z.tuple([z.number(), z.number(), z.uuid()]);

/**
 * The ticket queue: filtered, sorted and keyset-paginated. Tab counts ignore the tab and the
 * page, so they are computed before those conditions are added.
 */
export async function listTickets(db: Sql, org: string, filters: Filters, countsOnly = false) {
  const conditions = filterConditions(org, filters);
  const counts = await one(
    db,
    `SELECT count(*) FILTER(WHERE ${OPEN_STATUSES})::int AS open,
       count(*) FILTER(WHERE ${CLOSED_STATUSES})::int AS closed,now() AS snapshot_at
     ${TICKET_JOINS} WHERE ${conditions.where()}`,
    conditions.values,
  );
  if (countsOnly) {
    return counts;
  }
  conditions.clauses.push(filters.tab === 'open' ? OPEN_STATUSES : CLOSED_STATUSES);
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
  conditions.clauses.push(
    `${sortKey}>(${rankParam}::numeric,${dateParam}::numeric,${idParam}::uuid)`,
  );
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
