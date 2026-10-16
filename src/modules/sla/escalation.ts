import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import { emit, enqueue } from '../../shared/events.js';
import { formatTicketNumber } from '../../shared/ticket-number.js';
import type { Ticket } from '../../shared/types/entities.js';

import { formatDue } from './eta.js';

export type ClockName = 'first_response' | 'resolution';

export interface Escalation {
    ticket: Ticket;
    clock: ClockName;
    stage: number;
    due: Date;
    now: Date;
    timezone: string;
    notifyMax: boolean;
}

type Recipient = {
    id: string;
    max_user_id: string;
    activated_at: Date | string | null;
};

const STAGES = ['warning', 'breached', 'escalated'] as const;

const ALERT_TEXT: Record<ClockName, readonly string[]> = {
    first_response: ['первый ответ под угрозой', 'первый ответ просрочен', 'первый ответ просрочен вдвое'],
    resolution: ['решение под угрозой', 'решение просрочено', 'решение просрочено вдвое'],
};

function notificationType(clock: ClockName, stage: number): string {
    return `sla.${clock === 'first_response' ? 'response' : 'resolution'}_${STAGES[stage - 1] ?? 'escalated'}`;
}

async function employeesWith(tx: Sql, ctx: Ctx, { ids, roles }: { ids: string[]; roles: string[] }) {
    const result = await tx.query<Recipient>(
        `SELECT id,max_user_id,activated_at FROM employees
     WHERE org_id=$1 AND NOT blocked AND (id=ANY($2::uuid[]) OR role=ANY($3::text[])) ORDER BY id`,
        [ctx.org, ids, roles],
    );

    return result.rows;
}

async function recipientsFor(tx: Sql, ctx: Ctx, { ticket, stage }: Escalation): Promise<Recipient[]> {
    const assignee = ticket.assignee_id ? [ticket.assignee_id] : [];

    if (stage === 1) {
        return employeesWith(tx, ctx, { ids: assignee, roles: assignee.length ? [] : ['support', 'supervisor'] });
    }

    if (stage === 2) {
        const supervisors = await employeesWith(tx, ctx, { ids: assignee, roles: ['supervisor'] });

        return supervisors.some((employee) => employee.id !== ticket.assignee_id)
            ? supervisors
            : employeesWith(tx, ctx, { ids: assignee, roles: ['admin'] });
    }

    return employeesWith(tx, ctx, { ids: [], roles: ['admin'] });
}

export async function escalate(tx: Sql, ctx: Ctx, escalation: Escalation): Promise<void> {
    const { ticket, clock, stage } = escalation;
    const recipients = await recipientsFor(tx, ctx, escalation);

    await emit(tx, ctx.org, {
        type: notificationType(clock, stage),
        ticketId: ticket.id,
        payload: { clock, stage },
        employeeIds: recipients.map((employee) => employee.id),
    });

    if (!escalation.notifyMax) {
        return;
    }

    const text = alertText(escalation);

    for (const employee of recipients.filter((recipient) => recipient.activated_at)) {
        await enqueue(tx, ctx.org, {
            key: `staff-alert:${ticket.id}:${ticket.lifecycle}:${clock}:${stage}:${employee.id}`,
            kind: 'staff_alert',
            refId: ticket.id,
            payload: { user_id: employee.max_user_id, text },
        });
    }
}

function alertText({ ticket, clock, stage, due, now, timezone }: Escalation): string {
    const what = ALERT_TEXT[clock][stage - 1] ?? '';

    return `SLA · обращение №${formatTicketNumber(ticket.ticket_number)}: ${what} (срок ${formatDue(due, now, timezone)}).`;
}
