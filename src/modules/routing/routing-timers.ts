import type { Config } from '../../shared/config.js';
import { one, type Database, type Sql } from '../../shared/db.js';

import { expireOffer, offerTicket } from './offers.js';
import { withdrawOffers } from './release.js';
import { routeTicket } from './rules.js';

const BATCH = 50;
const UNTRIAGED_GRACE = "interval '3 minutes'";

async function lockTicket(tx: Sql, org: string, ticketId: string): Promise<boolean> {
    const ref = await one<{ client_id: string }>(tx, 'SELECT client_id FROM tickets WHERE org_id=$1 AND id=$2', [
        org,
        ticketId,
    ]);

    if (!ref) {
        return false;
    }

    await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [ref.client_id]);
    await tx.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE', [ticketId]);

    return true;
}

export class RoutingTimers {
    private readonly org: string;

    constructor(
        private readonly db: Database,
        config: Config,
    ) {
        this.org = config.ORG_ID;
    }

    async run(): Promise<void> {
        await this.routeNewTickets();
        await this.withdrawStaleOffers();
        await this.expireOffers();
        await this.offerWaitingTickets();
    }

    private async eachTicket(sql: string, step: (tx: Sql, ticketId: string) => Promise<unknown>): Promise<void> {
        const { rows } = await this.db.query<{ id: string }>(sql, [this.org, BATCH]);

        for (const { id } of rows) {
            await this.db.tx(async (tx) => {
                if (await lockTicket(tx, this.org, id)) {
                    await step(tx, id);
                }
            });
        }
    }

    private async routeNewTickets(): Promise<void> {
        await this.eachTicket(
            `SELECT id FROM tickets WHERE org_id=$1 AND routed_at IS NULL
         AND (ai_status<>'pending' OR created_at<now()-${UNTRIAGED_GRACE}) ORDER BY created_at LIMIT $2`,
            async (tx, id) => {
                const changed = await routeTicket(tx, this.org, id);

                if (changed) {
                    await tx.query('UPDATE tickets SET version=version+1,updated_at=now() WHERE id=$1', [id]);
                }
            },
        );
    }

    private async withdrawStaleOffers(): Promise<void> {
        const { rows } = await this.db.query<{ id: string }>(
            `SELECT DISTINCT e.id FROM tickets t JOIN employees e ON e.org_id=t.org_id AND e.id=t.offered_to
       WHERE t.org_id=$1 AND (e.presence<>'online' OR e.blocked)`,
            [this.org],
        );

        await this.db.query(
            `UPDATE tickets SET offered_to=NULL,offered_at=NULL,offer_due_at=NULL
       WHERE org_id=$1 AND offered_to IS NOT NULL AND status<>'open'`,
            [this.org],
        );

        for (const { id } of rows) {
            await this.db.tx(async (tx) => withdrawOffers(tx, this.org, id));
        }
    }

    private async expireOffers(): Promise<void> {
        await this.eachTicket(
            'SELECT id FROM tickets WHERE org_id=$1 AND offer_due_at<=now() ORDER BY offer_due_at LIMIT $2',
            async (tx, id) => expireOffer(tx, this.org, id),
        );
    }

    private async offerWaitingTickets(): Promise<void> {
        await this.eachTicket(
            `SELECT t.id FROM tickets t
         JOIN teams tm ON tm.org_id=t.org_id AND tm.id=t.team_id AND tm.auto_assign AND tm.archived_at IS NULL
         WHERE t.org_id=$1 AND t.status='open' AND t.assignee_id IS NULL AND t.offered_to IS NULL
           AND EXISTS(SELECT 1 FROM team_members m JOIN employees e ON e.id=m.employee_id
             WHERE m.team_id=tm.id AND e.presence='online' AND NOT e.blocked)
         ORDER BY t.first_response_due_at NULLS LAST,t.created_at LIMIT $2`,
            async (tx, id) => offerTicket(tx, this.org, id),
        );
    }
}
