import { setTimeout as sleep } from 'node:timers/promises';

import { MaxClient, normalizeUpdate } from '../../integrations/max/index.js';
import { DeliveryWorker } from '../../modules/delivery/index.js';
import { Inbox } from '../../modules/inbox/index.js';
import { findActiveAdmin } from '../../modules/staff/index.js';
import { TicketCommands, TicketQueries } from '../../modules/tickets/index.js';
import type { Config } from '../../shared/config.js';
import type { Database } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Employee, Row } from '../../shared/types/entities.js';

const POLL_MS = 1000;
const STEP_TIMEOUT_MS = 60_000;
const TRIAGE_TIMEOUT_MS = 180_000;
const LEARNING_TIMEOUT_MS = 900_000;
const CHAT_OFFSET = 100_000_000;
const RETRY_CODES = new Set(['delivery_pending', 'input_pending', 'ticket_version_conflict']);
const LEARNING_DONE = new Set(['learned', 'needs_review', 'failed', 'suppressed', 'invalidated']);
const DELIVERY_PENDING = new Set(['queued', 'retry_wait', 'sending']);
const RELEARN = new Set(['failed', 'needs_review', 'suppressed']);
const RELEARN_REASON = 'Повторное обучение базы знаний';

interface Sender {
    user_id: number;
    first_name: string;
    last_name?: string;
}

export interface ResolvedCase {
    client: Sender;
    problem: string;
    reply: string;
    confirmation: string;
    rating: number;
}

type Log = (line: string) => void;

export class TestDataLoader {
    private readonly inbox: Inbox;
    private readonly deliveries: DeliveryWorker;
    private readonly queries: TicketQueries;
    private readonly commands: TicketCommands;
    private readonly learning: boolean;

    constructor(
        private readonly db: Database,
        private readonly config: Config,
        private readonly log: Log,
    ) {
        this.inbox = new Inbox(db, config);
        this.deliveries = new DeliveryWorker(db, config, new MaxClient(config));
        this.queries = new TicketQueries(db, config.ORG_ID);
        this.commands = new TicketCommands(db, config);
        this.learning = config.AI_ENABLED && config.MEMORY_ENABLED;
    }

    async loadResolved(cases: ResolvedCase[]): Promise<number> {
        const actor = await findActiveAdmin(this.db, this.config.ORG_ID);

        if (!actor) {
            this.log('Solved cases skipped: no administrator has signed in yet.');

            return 0;
        }

        if (!this.learning) {
            this.log('Learning not awaited: AI memory is disabled.');
        }

        for (const item of cases) {
            await this.resolve(actor, item);
        }

        return cases.length;
    }

    async loadOpen(updates: unknown[]): Promise<number> {
        const senders = bySender(updates);

        for (const inputs of senders) {
            let clientId = '';

            for (const input of inputs) {
                clientId = await this.ingest(input);
            }

            await this.awaitTriage(await this.ticketOf(clientId));
        }

        return senders.length;
    }

    private async resolve(actor: Employee, item: ResolvedCase): Promise<void> {
        const clientId = await this.ingest(caseInput(item.client, '1', item.problem));
        const ticketId = await this.ticketOf(clientId);
        const { ticket_number: number, status, closures } = await this.queries.ticket(ticketId);
        const ids = { clientId, ticketId };
        const learning = closures.at(-1)?.learning_status;

        if (status === 'open') {
            await this.awaitTriage(ticketId);
            await this.command(actor, { ...ids, name: 'assign', body: {} });
            await this.command(actor, { ...ids, name: 'messages', body: { text: item.reply, attachment_ids: [] } });
            await this.ingest(caseInput(item.client, '2', item.confirmation));
            await this.finish(actor, ids, caseInput(item.client, '3', String(item.rating)));
        } else if (this.learning && typeof learning === 'string' && RELEARN.has(learning)) {
            const cycle = String(closures.length + 1);

            await this.command(actor, { ...ids, name: 'reopen', body: { reason: RELEARN_REASON } });
            await this.ingest(caseInput(item.client, `2-${cycle}`, item.confirmation));
            await this.finish(actor, ids, caseInput(item.client, `3-${cycle}`, String(item.rating)));
        }

        this.log(`№${ticketLabel(number)}: solved case ${status === 'open' ? 'loaded' : 'present'}`);
        await this.awaitLearning(ticketId);
    }

    private async finish(actor: Employee, ids: { clientId: string; ticketId: string }, rating: ClientInput) {
        await this.command(actor, { ...ids, name: 'close', body: {} });
        await this.awaitDeliveries(ids.clientId, ids.ticketId);
        await this.ingest(rating);
    }

    private async ingest(input: ClientInput): Promise<string> {
        const clientId = await this.inbox.ingestConsented(input);

        await this.drive(clientId);

        return clientId;
    }

    private async drive(clientId: string): Promise<void> {
        let more = true;

        while (more) {
            more = await this.inbox.processClient(clientId);
        }

        more = true;

        while (more) {
            more = await this.deliveries.deliver(clientId);
        }
    }

    private async awaitDeliveries(clientId: string, ticketId: string): Promise<void> {
        await eventually(
            async () => {
                await this.drive(clientId);
                const { items } = await this.queries.messages(ticketId, { limit: 100 });

                return items.some((message) => DELIVERY_PENDING.has(String(message.delivery_state))) ? undefined : true;
            },
            STEP_TIMEOUT_MS,
            'deliveries',
        );
    }

    private async ticketOf(clientId: string): Promise<string> {
        return eventually(() => this.queries.latestOfClient(clientId), STEP_TIMEOUT_MS, 'the ticket');
    }

    private async command(actor: Employee, step: { clientId: string; ticketId: string; name: string; body: Row }) {
        const { clientId, ticketId, name, body } = step;

        await eventually(
            async () => {
                await this.drive(clientId);
                const { version } = await this.queries.ticket(ticketId);
                const idempotencyKey = `test-data:${name}:${ticketId}:${version}`;

                try {
                    return await this.commands.run({
                        actor,
                        ticketId,
                        name,
                        body,
                        expectedVersion: version,
                        idempotencyKey,
                    });
                } catch (error) {
                    if (error instanceof AppError && RETRY_CODES.has(error.code)) {
                        return undefined;
                    }

                    throw error;
                }
            },
            STEP_TIMEOUT_MS,
            `${name} on ${ticketId}`,
        );
    }

    private async awaitTriage(ticketId: string): Promise<void> {
        const ticket = await eventually(
            async () => {
                const current = await this.queries.ticket(ticketId);

                return current.ai_status === 'pending' ? undefined : current;
            },
            TRIAGE_TIMEOUT_MS,
            'AI triage',
        );

        this.log(describeTriage(ticket));
    }

    private async awaitLearning(ticketId: string): Promise<void> {
        if (!this.learning) {
            return;
        }

        const line = await eventually(
            async () => {
                const { ticket_number: number, closures } = await this.queries.ticket(ticketId);
                const learning = closures.at(-1)?.learning_status;
                const status = typeof learning === 'string' ? learning : '';

                return LEARNING_DONE.has(status) ? `№${ticketLabel(number)}: learning ${status}` : undefined;
            },
            LEARNING_TIMEOUT_MS,
            'learning',
        );

        this.log(line);
    }
}

async function eventually<T>(probe: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const value = await probe();

        if (value !== undefined) {
            return value;
        }

        await sleep(POLL_MS);
    }

    throw new Error(`Timed out waiting for ${what}`);
}

function bySender(updates: unknown[]): ClientInput[][] {
    const senders = new Map<string, ClientInput[]>();

    for (const update of updates) {
        const input = normalizeUpdate(JSON.stringify(update));
        const key = input.userId ?? '';

        senders.set(key, [...(senders.get(key) ?? []), input]);
    }

    return [...senders.values()];
}

function caseInput(client: Sender, step: string, text: string): ClientInput {
    return normalizeUpdate(
        JSON.stringify({
            update_type: 'message_created',
            message: {
                sender: { ...client, is_bot: false },
                recipient: { chat_id: client.user_id + CHAT_OFFSET, chat_type: 'dialog' },
                body: { mid: `resolved-${client.user_id}-${step}`, text },
            },
        }),
    );
}

function ticketLabel(number: number): string {
    return String(number).padStart(6, '0');
}

function describeTriage(ticket: Row): string {
    const sources = Array.isArray(ticket.suggestion_sources) ? ticket.suggestion_sources.length : 0;
    const tip = (ticket.suggestion as Row | null)?.tip as Row | null | undefined;
    const steps = Array.isArray(tip?.steps) ? tip.steps.length : 0;
    const tags = `${String(ticket.tag)}/${String(ticket.urgency)}/${String(ticket.complexity)}`;

    return `№${String(ticket.number)}: AI ${String(ticket.ai_status)}, ${tags}, ${steps} steps, ${sources} cited cases`;
}
