import type { Sql } from '../../../shared/db.js';
import type { Row } from '../../../shared/types/entities.js';

import { TICKET_JOINS, TICKET_PROJECTION } from './ticket-projection.js';

const SUMMARY_COLUMNS = `s.id,s.number,s.status,s.description,s.tag,s.tag_label,s.urgency,s.urgency_label,s.ai_status,
  s.assignee_id,s.assignee_name,s.rating,s.purged_at,s.first_response_due_at,s.first_responded_at,s.resolution_due_at,
  s.waiting_since,s.sla_due_at,s.sla_warn_at`;

export async function ticketSummaries(db: Sql, org: string, ids: readonly string[]): Promise<Row[]> {
    if (!ids.length) {
        return [];
    }

    const { rows } = await db.query(
        `SELECT ${SUMMARY_COLUMNS}
     FROM (SELECT ${TICKET_PROJECTION} ${TICKET_JOINS} WHERE t.org_id=$1 AND t.id=ANY($2::uuid[])) s`,
        [org, ids],
    );

    return rows;
}
