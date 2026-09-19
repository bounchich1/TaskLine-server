import { z } from 'zod';

import { one, type Database } from './shared/db.js';
import { ensure } from './shared/errors.js';
import type { Row, Ticket } from './shared/types/entities.js';

export const filtersSchema = z
  .object({
    tab: z.enum(['open', 'closed']).default('open'),
    q: z.string().max(300).default(''),
    tag: z.string().max(64).optional(),
    urgency: z.string().max(64).optional(),
    complexity: z.string().max(64).optional(),
    status: z.enum(['open', 'in_progress', 'awaiting_rating', 'closed']).optional(),
    assignee: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    sort: z.enum(['urgency', 'complexity', 'newest', 'oldest', 'rating']).default('urgency'),
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export type Filters = z.infer<typeof filtersSchema>;
const projection = `t.*,lpad(t.ticket_number::text,6,'0') AS number,e.name AS assignee_name,c.rating,c.rated_at,c.learning_status,
  coalesce(t.classification_labels->'tag'->>'label',dt.label,t.tag) AS tag_label,
  coalesce(t.classification_labels->'urgency'->>'label',du.label,t.urgency) AS urgency_label,
  coalesce(t.classification_labels->'complexity'->>'label',dc.label,t.complexity) AS complexity_label`;
const joins = `FROM tickets t LEFT JOIN employees e ON e.id=t.assignee_id AND e.org_id=t.org_id
  LEFT JOIN closures c ON c.id=t.current_cycle_id
  LEFT JOIN dictionaries dt ON dt.org_id=t.org_id AND dt.dimension='tag' AND dt.code=t.tag
  LEFT JOIN dictionaries du ON du.org_id=t.org_id AND du.dimension='urgency' AND du.code=t.urgency
  LEFT JOIN dictionaries dc ON dc.org_id=t.org_id AND dc.dimension='complexity' AND dc.code=t.complexity`;

export class Queries {
  constructor(
    readonly db: Database,
    readonly org: string,
  ) {}
  async list(f: Filters, countsOnly = false) {
    const values: unknown[] = [this.org];
    const clauses = ['t.org_id=$1'];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replaceAll('?', `$${values.length}`));
    };
    for (const field of ['tag', 'urgency', 'complexity', 'status'] as const) {
      if (f[field]) {
        add(`t.${field}=?`, f[field]);
      }
    }
    if (f.assignee) {
      add('t.assignee_id=?', f.assignee);
    }
    if (f.from) {
      add('t.created_at>=?::timestamptz', f.from);
    }
    if (f.to) {
      add('t.created_at<?::timestamptz', f.to);
    }
    if (f.q.trim()) {
      const q = f.q.trim().replace(/^№\s*/, '');
      if (/^\d{1,6}$/.test(q)) {
        add('t.ticket_number=?', Number(q));
      } else {
        add(
          `(to_tsvector('russian',t.description) @@ plainto_tsquery('russian',?) OR EXISTS(SELECT 1 FROM messages m WHERE m.ticket_id=t.id AND NOT m.deleted AND to_tsvector('russian',m.text) @@ plainto_tsquery('russian',?)))`,
          q,
        );
      }
    }
    const counts = await one(
      this.db,
      `SELECT count(*) FILTER(WHERE t.status IN('open','in_progress'))::int AS open,count(*) FILTER(WHERE t.status IN('awaiting_rating','closed'))::int AS closed,now() AS snapshot_at ${joins} WHERE ${clauses.join(' AND ')}`,
      values,
    );
    if (countsOnly) {
      return counts;
    }
    clauses.push(
      f.tab === 'open'
        ? "t.status IN('open','in_progress')"
        : "t.status IN('awaiting_rating','closed')",
    );
    const score =
      f.sort === 'urgency'
        ? 'coalesce(du.rank,0)'
        : f.sort === 'complexity'
          ? 'coalesce(dc.rank,0)'
          : f.sort === 'rating'
            ? 'coalesce(c.rating,-1)'
            : '0';
    const descendingDate = f.sort === 'newest';
    const key = `(-(${score}),${descendingDate ? '-' : ''}extract(epoch FROM t.created_at),t.id)`;
    if (f.cursor) {
      let cursor: unknown;
      try {
        cursor = JSON.parse(Buffer.from(f.cursor, 'base64url').toString('utf8'));
      } catch {
        ensure(false, 'invalid_cursor', 422);
      }
      const parsed = z.tuple([z.number(), z.number(), z.uuid()]).parse(cursor);
      values.push(...parsed);
      clauses.push(
        `${key}>($${values.length - 2}::numeric,$${values.length - 1}::numeric,$${values.length}::uuid)`,
      );
    }
    values.push(f.limit + 1);
    const rows = (
      await this.db.query(
        `SELECT ${projection},-(${score}) AS cursor_rank,(${descendingDate ? '-' : ''}extract(epoch FROM t.created_at))::text AS cursor_date ${joins} WHERE ${clauses.join(' AND ')} ORDER BY ${key} ASC LIMIT $${values.length}`,
        values,
      )
    ).rows;
    const hasMore = rows.length > f.limit;
    const items = rows.slice(0, f.limit);
    const last = items.at(-1);
    const cursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify([Number(last.cursor_rank), Number(last.cursor_date), last.id]),
          ).toString('base64url')
        : null;
    return {
      items,
      counts,
      next_cursor: cursor,
      cursor: (await one(this.db, 'SELECT cursor FROM organizations WHERE id=$1', [this.org]))
        ?.cursor,
    };
  }
  async ticket(id: string) {
    const ticket = await one<Ticket>(
      this.db,
      `SELECT ${projection} ${joins} WHERE t.org_id=$1 AND t.id=$2`,
      [this.org, id],
    );
    ensure(ticket, 'not_found', 404);
    const closures = (
      await this.db.query(
        'SELECT id,cycle_no,closed_at,closed_by,reason,note,rating,rated_at,finished_reason,learning_status,invalidated,coverage FROM closures WHERE org_id=$1 AND ticket_id=$2 ORDER BY cycle_no',
        [this.org, id],
      )
    ).rows;
    const attachments = (
      await this.db.query(
        'SELECT id,message_id,filename,kind,status,mime,bytes,extraction_status FROM attachments WHERE org_id=$1 AND ticket_id=$2 AND message_id IS NOT NULL ORDER BY created_at',
        [this.org, id],
      )
    ).rows;
    return { ...ticket, closures, attachments };
  }
  async messages(id: string, before?: number, after?: number, limit = 50) {
    ensure(
      await one(this.db, 'SELECT id FROM tickets WHERE org_id=$1 AND id=$2', [this.org, id]),
      'not_found',
      404,
    );
    const rows = (
      await this.db.query(
        `SELECT m.*,e.name AS author_name FROM messages m LEFT JOIN employees e ON e.id=m.author_id AND e.org_id=m.org_id WHERE m.org_id=$1 AND m.ticket_id=$2 AND ($3::int IS NULL OR seq<$3) AND ($4::int IS NULL OR seq>$4) ORDER BY seq ${after === undefined ? 'DESC' : 'ASC'} LIMIT $5`,
        [this.org, id, before ?? null, after ?? null, limit + 1],
      )
    ).rows;
    const more = rows.length > limit;
    const items = rows.slice(0, limit).sort((a, b) => Number(a.seq) - Number(b.seq));
    return { items, has_more: more, next_before: items[0]?.seq ?? null };
  }
  async diagnostics() {
    const [jobs, deliveries, memory, permits] = await Promise.all([
      this.db.query(
        'SELECT id,kind,ref_id,state,attempts,reason,created_at,due_at FROM jobs WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100',
        [this.org],
      ),
      this.db.query(
        "SELECT id,ticket_id,message_id,kind,state,attempts,reason,created_at FROM deliveries WHERE org_id=$1 AND state NOT IN('delivered','canceled') ORDER BY created_at LIMIT 100",
        [this.org],
      ),
      this.db.query(
        'SELECT id,ticket_id,closure_id,state,eligible,reason,created_at FROM memory_records WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100',
        [this.org],
      ),
      this.db.query('SELECT slot,state,started_at FROM ai_permits ORDER BY slot'),
    ]);
    return {
      jobs: jobs.rows,
      deliveries: deliveries.rows,
      memory: memory.rows,
      permits: permits.rows,
    };
  }
}
export function publicAttachment(row: Row) {
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    mime: row.mime,
    bytes: row.bytes,
  };
}
