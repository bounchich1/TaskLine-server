import { one, type Database } from '../../../shared/db.js';
import { ensure } from '../../../shared/errors.js';
import type { Ticket } from '../../../shared/types/entities.js';

import { sourceExcerpt, type SourceRequest } from './source-excerpt.js';
import { suggestionSources } from './suggestion-sources.js';
import type { Filters } from './ticket-filters.js';
import { listTickets } from './ticket-list.js';
import { TICKET_JOINS, TICKET_PROJECTION } from './ticket-projection.js';

export interface MessagePage {
    before?: number;
    after?: number;
    limit?: number;
}

export class TicketQueries {
    constructor(
        private readonly db: Database,
        private readonly org: string,
    ) {}

    async list(filters: Filters, countsOnly = false) {
        return listTickets(this.db, this.org, filters, countsOnly);
    }

    async ticket(id: string) {
        const ticket = await one<Ticket>(
            this.db,
            `SELECT ${TICKET_PROJECTION} ${TICKET_JOINS} WHERE t.org_id=$1 AND t.id=$2`,
            [this.org, id],
        );

        ensure(ticket, 'not_found', 404);

        const closures = (
            await this.db.query(
                `SELECT id,cycle_no,closed_at,closed_by,reason,note,rating,rated_at,finished_reason,learning_status,invalidated,coverage
         FROM closures WHERE org_id=$1 AND ticket_id=$2 ORDER BY cycle_no`,
                [this.org, id],
            )
        ).rows;

        const attachments = (
            await this.db.query(
                `SELECT id,message_id,filename,kind,status,mime,bytes,extraction_status
         FROM attachments WHERE org_id=$1 AND ticket_id=$2 AND message_id IS NOT NULL
         ORDER BY created_at`,
                [this.org, id],
            )
        ).rows;

        const sources = await suggestionSources(this.db, this.org, ticket.suggestion);

        return { ...ticket, closures, attachments, suggestion_sources: sources };
    }

    async openSource(request: SourceRequest) {
        return sourceExcerpt(this.db, this.org, request);
    }

    async messages(id: string, { before, after, limit = 50 }: MessagePage = {}) {
        ensure(
            await one(this.db, 'SELECT id FROM tickets WHERE org_id=$1 AND id=$2', [this.org, id]),
            'not_found',
            404,
        );

        const rows = (
            await this.db.query(
                `SELECT m.*,e.name AS author_name FROM messages m
         LEFT JOIN employees e ON e.id=m.author_id AND e.org_id=m.org_id
         WHERE m.org_id=$1 AND m.ticket_id=$2 AND ($3::int IS NULL OR seq<$3) AND ($4::int IS NULL OR seq>$4)
         ORDER BY seq ${after === undefined ? 'DESC' : 'ASC'} LIMIT $5`,
                [this.org, id, before ?? null, after ?? null, limit + 1],
            )
        ).rows;

        const items = rows.slice(0, limit).sort((left, right) => Number(left.seq) - Number(right.seq));

        return { items, has_more: rows.length > limit, next_before: items[0]?.seq ?? null };
    }
}
