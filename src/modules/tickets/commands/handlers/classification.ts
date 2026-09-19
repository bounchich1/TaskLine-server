import { ensure } from '../../../../shared/errors.js';
import type { Row } from '../../../../shared/types/entities.js';
import { findActiveDictionaryEntry } from '../../../dictionaries/index.js';
import type { TicketCommandHandler } from '../command-context.js';

const FIELDS = ['tag', 'urgency', 'complexity'] as const;

/**
 * Staff override of tag/urgency/complexity. Each field carries the revision the caller saw, so a
 * concurrent change (by staff or by AI triage) is a conflict rather than a silent overwrite.
 */
export const classify: TicketCommandHandler = async (tx, ctx, { ticket, body }) => {
  ensure(['open', 'in_progress'].includes(ticket.status), 'ticket_closed');
  for (const field of FIELDS) {
    if (body[field] === undefined) {
      continue;
    }
    const entry = await findActiveDictionaryEntry(tx, ctx.org, field, body[field]);
    ensure(entry, 'invalid_dictionary', 422);
    const revisions = body.revisions as Row | undefined;
    ensure(revisions?.[field] === ticket[`${field}_revision`], 'classification_conflict');
    await tx.query(
      `UPDATE tickets SET ${field}=$2,${field}_revision=${field}_revision+1,
         classification_labels=jsonb_set(classification_labels,ARRAY[$3],$4::jsonb)
       WHERE id=$1`,
      [
        ticket.id,
        body[field],
        field,
        JSON.stringify({ label: entry.label, version: entry.version }),
      ],
    );
  }
};
