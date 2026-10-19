import type { Config } from '../../shared/config.js';
import { one, type Database } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { emit } from '../../shared/events.js';
import { findActiveEmployee } from '../../shared/staff.js';
import type { Job, Ticket } from '../../shared/types/entities.js';

import { TicketCommands } from './commands/ticket-commands.js';

const RETRY_AFTER_SECONDS = 5;
const GIVE_UP_AFTER_MS = 30 * 60000;
const WAITING_CODES = new Set(['delivery_pending', 'input_pending', 'ticket_version_conflict']);
const UNDELIVERABLE = new Set(['failed', 'canceled']);

function waitForDelivery(): AppError {
    return Object.assign(new AppError('close_waiting_delivery', 409), { retryAfterSeconds: RETRY_AFTER_SECONDS });
}

export class DeferredClose {
    private readonly commands: TicketCommands;
    private readonly org: string;

    constructor(
        private readonly db: Database,
        config: Config,
    ) {
        this.commands = new TicketCommands(db, config);
        this.org = config.ORG_ID;
    }

    async run(job: Job): Promise<void> {
        const ticket = await one<Ticket>(this.db, 'SELECT * FROM tickets WHERE org_id=$1 AND id=$2', [
            this.org,
            job.ref_id,
        ]);

        if (ticket?.status !== 'in_progress' || ticket.lifecycle !== Number(job.payload.lifecycle)) {
            return;
        }

        const message = await one<{ delivery_state: string }>(
            this.db,
            'SELECT delivery_state FROM messages WHERE id=$1',
            [job.payload.message_id],
        );

        if (!message || UNDELIVERABLE.has(message.delivery_state)) {
            await this.giveUp(job, 'reply_not_delivered');

            return;
        }

        if (message.delivery_state !== 'delivered') {
            await this.retryOrGiveUp(job);

            return;
        }

        await this.close(job, ticket);
    }

    private async close(job: Job, ticket: Ticket): Promise<void> {
        const actor = await findActiveEmployee(this.db, this.org, job.payload.actor_id);

        if (!actor) {
            return;
        }

        try {
            await this.commands.run({
                actor,
                ticketId: ticket.id,
                name: 'close',
                body: {},
                expectedVersion: ticket.version,
                idempotencyKey: `deferred-close:${job.id}`,
            });
        } catch (error) {
            if (error instanceof AppError && WAITING_CODES.has(error.code)) {
                await this.retryOrGiveUp(job);

                return;
            }

            await this.giveUp(job, error instanceof AppError ? error.code : 'close_failed');
        }
    }

    private async retryOrGiveUp(job: Job): Promise<void> {
        if (Date.now() - new Date(job.created_at).getTime() > GIVE_UP_AFTER_MS) {
            await this.giveUp(job, 'delivery_timeout');

            return;
        }

        throw waitForDelivery();
    }

    private async giveUp(job: Job, reason: string): Promise<void> {
        await this.db.tx(async (tx) => {
            await emit(tx, this.org, {
                type: 'ticket.close_failed',
                ticketId: job.ref_id,
                payload: { reason },
                employeeId: String(job.payload.actor_id),
            });
        });
    }
}
