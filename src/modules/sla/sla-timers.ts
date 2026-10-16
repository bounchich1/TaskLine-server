import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import { one, requireOne, type Database, type Sql } from '../../shared/db.js';
import type { Ticket } from '../../shared/types/entities.js';

import { addBusinessTime, type Calendar } from './business-time.js';
import { escalate, type ClockName } from './escalation.js';
import { calendarOf, loadSlaSettings, type SlaSettings } from './sla-settings.js';

const BATCH = 100;
const BREACHED = 2;

interface ClockState {
    name: ClockName;
    stage: number;
    target: number;
    warn: Date;
    due: Date;
}

interface Evaluation {
    next: Date | null;
    stages: Partial<Record<ClockName, number>>;
    breached: ClockName[];
}

export class SlaTimers {
    private readonly ctx: Ctx;

    constructor(
        private readonly db: Database,
        config: Config,
    ) {
        this.ctx = createCtx(config);
    }

    async run(): Promise<void> {
        const { rows } = await this.db.query<{ id: string; client_id: string }>(
            `SELECT id,client_id FROM tickets WHERE org_id=$1 AND sla_next_check_at<=now()
       ORDER BY sla_next_check_at LIMIT ${BATCH}`,
            [this.ctx.org],
        );

        for (const row of rows) {
            await this.db.tx(async (tx) => checkTicket(tx, this.ctx, row));
        }
    }
}

async function checkTicket(tx: Sql, ctx: Ctx, { id, client_id: clientId }: { id: string; client_id: string }) {
    await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [clientId]);

    const ticket = await one<Ticket>(tx, 'SELECT * FROM tickets WHERE id=$1 AND sla_next_check_at<=now() FOR UPDATE', [
        id,
    ]);

    if (!ticket) {
        return;
    }

    const settings = await loadSlaSettings(tx, ctx.org);
    const clocks = settings?.enabled ? activeClocks(ticket) : [];
    const now = new Date((await requireOne<{ now: Date }>(tx, 'SELECT now() AS now')).now);
    const evaluation = evaluate(clocks, now, settings ? calendarOf(settings) : undefined);

    if (settings) {
        await notify(tx, ctx, { ticket, clocks, evaluation, now, settings });
    }

    await tx.query(
        `UPDATE tickets SET first_response_stage=$2,resolution_stage=$3,sla_next_check_at=$4,
       sla_breached=ARRAY(SELECT DISTINCT unnest(sla_breached||$5::text[]) ORDER BY 1) WHERE id=$1`,
        [
            ticket.id,
            evaluation.stages.first_response ?? ticket.first_response_stage,
            evaluation.stages.resolution ?? ticket.resolution_stage,
            evaluation.next,
            evaluation.breached,
        ],
    );
}

function activeClocks(ticket: Ticket): ClockState[] {
    if (!['open', 'in_progress'].includes(ticket.status)) {
        return [];
    }

    const clocks: ClockState[] = [];
    const response = ticket.sla_first_response_minutes;
    const resolution = ticket.sla_resolution_minutes;

    if (!ticket.first_responded_at && response && ticket.first_response_warn_at && ticket.first_response_due_at) {
        clocks.push({
            name: 'first_response',
            stage: ticket.first_response_stage,
            target: response,
            warn: new Date(ticket.first_response_warn_at),
            due: new Date(ticket.first_response_due_at),
        });
    }

    if (!ticket.waiting_since && resolution && ticket.resolution_warn_at && ticket.resolution_due_at) {
        clocks.push({
            name: 'resolution',
            stage: ticket.resolution_stage,
            target: resolution,
            warn: new Date(ticket.resolution_warn_at),
            due: new Date(ticket.resolution_due_at),
        });
    }

    return clocks;
}

export function evaluate(clocks: ClockState[], now: Date, calendar: Calendar | undefined): Evaluation {
    const evaluation: Evaluation = { next: null, stages: {}, breached: [] };

    for (const clock of clocks) {
        const checkpoints = [clock.warn, clock.due];

        if (calendar) {
            checkpoints.push(addBusinessTime(clock.due, clock.target, calendar));
        }

        const reached = checkpoints.filter((point) => point.getTime() <= now.getTime()).length;
        const stage = Math.max(clock.stage, reached);
        const next = stage < checkpoints.length ? checkpoints[stage] : undefined;

        evaluation.stages[clock.name] = stage;

        if (stage >= BREACHED) {
            evaluation.breached.push(clock.name);
        }

        if (next && (!evaluation.next || next < evaluation.next)) {
            evaluation.next = next;
        }
    }

    return evaluation;
}

interface Notification {
    ticket: Ticket;
    clocks: ClockState[];
    evaluation: Evaluation;
    now: Date;
    settings: SlaSettings;
}

async function notify(tx: Sql, ctx: Ctx, { ticket, clocks, evaluation, now, settings }: Notification) {
    for (const clock of clocks) {
        const stage = evaluation.stages[clock.name] ?? clock.stage;

        if (stage > clock.stage) {
            await escalate(tx, ctx, {
                ticket,
                clock: clock.name,
                stage,
                due: clock.due,
                now,
                timezone: settings.timezone,
                notifyMax: settings.notify_max,
            });
        }
    }
}
