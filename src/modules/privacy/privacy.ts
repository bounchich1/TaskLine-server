import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import type { Database } from '../../shared/db.js';
import { audit } from '../../shared/events.js';
import type { Employee } from '../../shared/types/entities.js';
import type { Session } from '../../shared/types/session.js';

import { eraseClient, type ErasureResult } from './erase-client.js';
import { exportClient } from './export-client.js';
import { grantExport, redeemExportGrant } from './export-grants.js';

export class Privacy {
    private readonly ctx: Ctx;

    constructor(
        private readonly db: Database,
        config: Config,
    ) {
        this.ctx = createCtx(config);
    }

    async export(actor: Employee, clientId: string) {
        const data = await exportClient(this.db, this.ctx, clientId);

        await this.recordExport(actor.id, clientId);

        return data;
    }

    async grantExport(session: Session, clientId: string) {
        return grantExport(this.db, this.ctx, { clientId, session });
    }

    async redeemExport(grant: string) {
        const { clientId, employeeId } = await redeemExportGrant(this.db, this.ctx, grant);
        const data = await exportClient(this.db, this.ctx, clientId);

        await this.recordExport(employeeId, clientId);

        return { clientId, data };
    }

    async erase(actor: Employee, clientId: string): Promise<ErasureResult> {
        return this.db.tx(async (tx) => eraseClient(tx, this.ctx, { clientId, actorId: actor.id }));
    }

    private async recordExport(actorId: string, clientId: string): Promise<void> {
        await this.db.tx(async (tx) => {
            await audit(tx, this.ctx.org, { actor: actorId, action: 'client.exported', objectId: clientId });
        });
    }
}
