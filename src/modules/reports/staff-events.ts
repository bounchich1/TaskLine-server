import { z } from 'zod';

import type { Database } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { recordTicketEvent } from '../../shared/events.js';

const DEDUPE_MINUTES = 5;

export const staffEventBody = z.object({ kind: z.enum(['draft_inserted', 'tip_viewed']) }).strict();

interface StaffEvent {
    ticketId: string;
    employeeId: string;
    kind: z.infer<typeof staffEventBody>['kind'];
}

export async function recordStaffEvent(db: Database, org: string, event: StaffEvent): Promise<void> {
    await db.tx(async (tx) => {
        const { rows } = await tx.query<{ recent: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id AND employee_id=$3 AND kind=$4
         AND created_at>now()-$5*interval '1 minute') AS recent
       FROM tickets t WHERE t.org_id=$1 AND t.id=$2`,
            [org, event.ticketId, event.employeeId, event.kind, DEDUPE_MINUTES],
        );

        const ticket = rows.at(0);

        ensure(ticket, 'not_found', 404);

        if (!ticket.recent) {
            await recordTicketEvent(tx, org, {
                ticketId: event.ticketId,
                employeeId: event.employeeId,
                kind: event.kind,
            });
        }
    });
}
