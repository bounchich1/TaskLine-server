import { z } from 'zod';

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

/**
 * WHERE clauses with positional parameters. `$n` numbers follow push order, so conditions must
 * be added in the order their values are pushed.
 */
export class SqlConditions {
  readonly values: unknown[];
  readonly clauses: string[];

  constructor(org: string) {
    this.values = [org];
    this.clauses = ['t.org_id=$1'];
  }

  /** Adds a condition; every `?` in it refers to the single new parameter. */
  add(sql: string, value: unknown): void {
    this.values.push(value);
    this.clauses.push(sql.replaceAll('?', `$${this.values.length}`));
  }

  /** Pushes a parameter without a condition (e.g. LIMIT) and returns its placeholder. */
  param(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  where(): string {
    return this.clauses.join(' AND ');
  }
}

export function filterConditions(org: string, filters: Filters): SqlConditions {
  const conditions = new SqlConditions(org);
  for (const field of ['tag', 'urgency', 'complexity', 'status'] as const) {
    if (filters[field]) {
      conditions.add(`t.${field}=?`, filters[field]);
    }
  }
  if (filters.assignee) {
    conditions.add('t.assignee_id=?', filters.assignee);
  }
  if (filters.from) {
    conditions.add('t.created_at>=?::timestamptz', filters.from);
  }
  if (filters.to) {
    conditions.add('t.created_at<?::timestamptz', filters.to);
  }
  addSearch(conditions, filters.q);
  return conditions;
}

/** "№42" / "42" finds a ticket by number; anything else is Russian full-text search. */
function addSearch(conditions: SqlConditions, rawQuery: string): void {
  if (!rawQuery.trim()) {
    return;
  }
  const query = rawQuery.trim().replace(/^№\s*/, '');
  if (/^\d{1,6}$/.test(query)) {
    conditions.add('t.ticket_number=?', Number(query));
    return;
  }
  conditions.add(
    `(to_tsvector('russian',t.description) @@ plainto_tsquery('russian',?)
      OR EXISTS(SELECT 1 FROM messages m WHERE m.ticket_id=t.id AND NOT m.deleted
        AND to_tsvector('russian',m.text) @@ plainto_tsquery('russian',?)))`,
    query,
  );
}
