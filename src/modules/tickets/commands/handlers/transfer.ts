import { ensure } from '../../../../shared/errors.js';
import { emit } from '../../../../shared/events.js';
import { findActiveEmployee } from '../../../../shared/staff.js';
import { addMessage } from '../../../messages/index.js';
import { requireOwner, type TicketCommandHandler } from '../command-context.js';

/** Hand a ticket in work over to another employee, with a mandatory comment. */
export const transfer: TicketCommandHandler = async (tx, ctx, command) => {
  const { actor, ticket, body } = command;
  requireOwner(command);
  ensure(ticket.status === 'in_progress', 'ticket_closed');
  const target = await findActiveEmployee(tx, ctx.org, body.employee_id);
  ensure(target, 'invalid_employee', 422);
  ensure(
    typeof body.comment === 'string' && body.comment.trim().length > 0,
    'comment_required',
    422,
  );
  await tx.query('UPDATE tickets SET assignee_id=$2 WHERE id=$1', [ticket.id, target.id]);
  await addMessage(tx, ctx, ticket, {
    author: 'system',
    authorId: actor.id,
    text: `Передано сотруднику ${target.name}. ${body.comment}`,
    providerRef: null,
    state: 'internal',
  });
  await emit(tx, ctx.org, 'ticket.transferred', ticket.id, {}, target.id);
};
