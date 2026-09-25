import { randomUUID } from 'node:crypto';

import { one } from '../../../shared/db.js';
import { ensure } from '../../../shared/errors.js';
import { audit } from '../../../shared/events.js';
import type { CliCommand } from '../cli-command.js';

export const bootstrapCommand: CliCommand = async ({ db, config }) => {
    ensure(/^\d{1,20}$/.test(config.BOOTSTRAP_MAX_USER_ID), 'bootstrap_id_required', 422);

    await db.tx(async (tx) => {
        await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [config.ORG_ID]);

        const existing = await one(tx, "SELECT id FROM employees WHERE org_id=$1 AND role='admin' AND NOT blocked", [
            config.ORG_ID,
        ]);

        ensure(!existing, 'admin_already_exists', 409, 'Use authenticated administration after initial bootstrap.');
        const id = randomUUID();

        await tx.query("INSERT INTO employees(id,org_id,max_user_id,name,role) VALUES($1,$2,$3,$4,'admin')", [
            id,
            config.ORG_ID,
            config.BOOTSTRAP_MAX_USER_ID,
            config.BOOTSTRAP_NAME,
        ]);

        await audit(tx, config.ORG_ID, { actor: null, action: 'admin.bootstrap', objectId: id });
    });

    return 'Initial administrator created.';
};
