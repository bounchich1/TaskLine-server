import type { Sql } from '../../shared/db.js';

import { within, type Period } from './period.js';

const LOW_RATING = 6;
const LIMIT = 500;

const LOW_RATED = `SELECT f.ticket_id,f.lifecycle,
  lpad(f.ticket_number::text,greatest(6,length(f.ticket_number::text)),'0') AS number,
  f.tag,coalesce(d.label,f.tag) AS tag_label,f.assignee_id,e.name AS assignee_name,f.rating,f.closed_at,
  t.purged_at IS NOT NULL AS purged
FROM ticket_facts f
JOIN tickets t ON t.id=f.ticket_id
LEFT JOIN dictionaries d ON d.org_id=f.org_id AND d.dimension='tag' AND d.code=f.tag
LEFT JOIN employees e ON e.org_id=f.org_id AND e.id=f.assignee_id
WHERE f.org_id=$1 AND f.rating<=$4 AND ${within('f.closed_at')}
ORDER BY f.rating,f.closed_at DESC LIMIT ${LIMIT}`;

export async function qualityReport(db: Sql, org: string, period: Period) {
    const { rows } = await db.query(LOW_RATED, [org, period.start, period.end, LOW_RATING]);

    return {
        threshold: LOW_RATING,
        items: rows.map((row) => ({
            ticket_id: String(row.ticket_id),
            lifecycle: Number(row.lifecycle),
            number: String(row.number),
            tag: String(row.tag),
            tag_label: String(row.tag_label),
            assignee_id: row.assignee_id as string | null,
            assignee_name: row.assignee_name as string | null,
            rating: Number(row.rating),
            closed_at: new Date(row.closed_at as string).toISOString(),
            purged: Boolean(row.purged),
        })),
    };
}
