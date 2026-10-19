import { MaxClient } from '../../integrations/max/index.js';
import { GatewayClient, Memory, Workflows, type Model } from '../../modules/ai/index.js';
import { Files } from '../../modules/files/index.js';
import { IncidentBroadcast } from '../../modules/incidents/index.js';
import { applyDeferredRevision } from '../../modules/messages/index.js';
import { NotificationAlerts } from '../../modules/notifications/index.js';
import { sendStaffAlert, type AlertSender } from '../../modules/staff/index.js';
import { DeferredClose } from '../../modules/tickets/index.js';
import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import { one, type Database, type Sql } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import type { Job } from '../../shared/types/entities.js';

import { classifyJobFailure, recordJobFailure } from './job-failure.js';
import { runMaintenance } from './maintenance.js';

export class JobRunner {
    readonly files: Files;
    private readonly ctx: Ctx;
    private readonly memory: Memory;
    private readonly workflows: Workflows;
    private readonly staffAlerts: AlertSender;
    private readonly notificationAlerts: NotificationAlerts;
    private readonly deferredClose: DeferredClose;
    private readonly incidentBroadcast: IncidentBroadcast;

    constructor(
        private readonly db: Database,
        config: Config,
        model: Model = new GatewayClient(config),
        memory?: Memory,
    ) {
        this.ctx = createCtx(config);
        this.files = new Files(db, config);
        this.memory = memory ?? new Memory(db, config);
        this.workflows = new Workflows(db, config, model, this.memory);

        this.staffAlerts = new MaxClient(
            config,
            config.MAX_STAFF_BOT_TOKEN ? { token: config.MAX_STAFF_BOT_TOKEN } : {},
        );

        this.notificationAlerts = new NotificationAlerts(db, this.ctx.org, this.staffAlerts);
        this.deferredClose = new DeferredClose(db, config);
        this.incidentBroadcast = new IncidentBroadcast(db, config);
    }

    async run(id: string): Promise<void> {
        const job = await this.db.tx(async (tx) => claimJob(tx, this.ctx, id));

        if (!job) {
            return;
        }

        try {
            const done = await this.dispatch(job);

            await this.db.query(
                `UPDATE jobs SET state=$3,due_at=now(),completed_at=CASE WHEN $3='done' THEN now() ELSE NULL END,
         payload=payload-'retry_count'-'error_detail',reason=NULL WHERE id=$1 AND generation=$2 AND state='running'`,
                [job.id, job.generation, done ? 'done' : 'pending'],
            );
        } catch (error) {
            const failure = classifyJobFailure(error, Number(job.payload.retry_count ?? 0));

            await this.db.tx(async (tx) => {
                await recordJobFailure(tx, this.ctx, { job, failure });
            });
        }
    }

    async maintenance(): Promise<void> {
        await runMaintenance(this.db, this.ctx);
    }

    private async dispatch(job: Job): Promise<boolean> {
        switch (job.kind) {
            case 'triage':
                await this.workflows.triage(job);

                return true;
            case 'learning':
                return this.workflows.learning(job);
            case 'file':
                await this.files.downloadInbound(job.ref_id);

                return true;
            case 'scan':
                await this.files.scan(job.ref_id);

                return true;
            case 'memory':
                await this.memory.persist(job.ref_id);

                return true;
            case 'memory_delete':
                await this.memory.remove(job.ref_id);

                return true;
            case 'attachment_purge':
                await this.files.purge(job.ref_id);

                return true;
            case 'message_revision':
                await applyDeferredRevision(this.db, this.ctx, job);

                return true;
            default:
                return this.dispatchStaffWork(job);
        }
    }

    private async dispatchStaffWork(job: Job): Promise<boolean> {
        switch (job.kind) {
            case 'staff_alert':
                await sendStaffAlert(this.staffAlerts, job.payload);

                return true;
            case 'notification_alert':
                await this.notificationAlerts.send(job.ref_id);

                return true;
            case 'deferred_close':
                await this.deferredClose.run(job);

                return true;
            case 'incident_broadcast':
                return this.incidentBroadcast.run(job);
            default:
                throw new AppError('unsupported_job_kind', 422);
        }
    }
}

async function claimJob(tx: Sql, ctx: Ctx, id: string): Promise<Job | undefined> {
    return one<Job>(
        tx,
        `UPDATE jobs SET state='running',generation=generation+1,claimed_at=now(),attempts=attempts+1
     WHERE org_id=$1 AND id=$2 AND state='pending' AND due_at<=now() RETURNING *`,
        [ctx.org, id],
    );
}
