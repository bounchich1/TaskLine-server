import type { ServerResponse } from 'node:http';

import type { FastifyRequest } from 'fastify';

import { one, type Database } from '../../shared/db.js';
import { sessionToken } from '../../shared/http/request.js';
import { authenticate, touchPresence } from '../staff/index.js';

import { changeFrame, HEARTBEAT_FRAME, READY_FRAME, RESYNC_FRAME, SESSION_EXPIRED_FRAME, viewersFrame } from './sse.js';
import { ticketViewers } from './viewers.js';

const POLL_INTERVAL_MS = 2000;
const HEARTBEAT_EVERY_POLLS = 8;

interface UiEvent extends Record<string, unknown> {
    cursor: string;
    type: string;
    ticket_id: string | null;
    payload: unknown;
}

export interface EventStreamOptions {
    db: Database;
    org: string;
    request: FastifyRequest;
    raw: ServerResponse;
}

export class UiEventStream {
    private alive = true;
    private polls = 0;
    private viewersVersion = 0;

    constructor(
        private readonly options: EventStreamOptions,
        private cursor: string,
    ) {
        options.request.raw.on('close', () => {
            this.alive = false;
        });
    }

    async run(): Promise<void> {
        const { raw } = this.options;

        raw.write(READY_FRAME);

        try {
            while (this.alive && !raw.destroyed) {
                await this.poll();
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            }
        } catch {
            if (!raw.destroyed) {
                raw.write(SESSION_EXPIRED_FRAME);
            }
        } finally {
            raw.end();
        }
    }

    private async poll(): Promise<void> {
        const { db, org, request, raw } = this.options;

        const session = await authenticate(db, org, sessionToken(request));

        await this.skipPrunedEvents();

        const { rows } = await db.query<UiEvent>(
            `SELECT cursor::text,type,ticket_id,payload FROM ui_events WHERE org_id=$1 AND cursor>$2
       ORDER BY cursor LIMIT 100`,
            [org, this.cursor],
        );

        for (const event of rows) {
            if (!raw.write(changeFrame(event))) {
                this.alive = false;
                break;
            }

            this.cursor = event.cursor;
        }

        this.writeViewers();

        if (this.polls++ % HEARTBEAT_EVERY_POLLS === 0) {
            await touchPresence(db, org, session.employee.id);
            raw.write(HEARTBEAT_FRAME);
        }
    }

    private writeViewers(): void {
        const { version, tickets } = ticketViewers.changesSince(this.viewersVersion);

        for (const ticketId of tickets) {
            this.options.raw.write(viewersFrame(ticketId, ticketViewers.snapshot(ticketId)));
        }

        this.viewersVersion = version;
    }

    private async skipPrunedEvents(): Promise<void> {
        const { db, org, raw } = this.options;

        const bounds = await one<{ first: string | null; last: string | null }>(
            db,
            'SELECT min(cursor)::text AS first,max(cursor)::text AS last FROM ui_events WHERE org_id=$1',
            [org],
        );

        const cursor = BigInt(this.cursor);

        if (bounds?.first && cursor > 0n && cursor < BigInt(bounds.first) - 1n) {
            raw.write(RESYNC_FRAME);
            this.cursor = String(bounds.last);
        }
    }
}
