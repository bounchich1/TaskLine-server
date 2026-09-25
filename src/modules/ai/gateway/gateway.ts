import { randomUUID } from 'node:crypto';

import type { Config } from '../../../shared/config.js';
import { createCtx, type Ctx } from '../../../shared/context.js';
import { encrypt, hash } from '../../../shared/crypto.js';
import { one, type Database } from '../../../shared/db.js';
import { AppError, ensure } from '../../../shared/errors.js';
import type { Job } from '../../../shared/types/entities.js';

import { admitCall } from './admission.js';
import type { ExecuteRequest } from './execute-request.js';
import { eligibleJob } from './job-eligibility.js';
import { mockModel } from './mock-model.js';
import type { Model, ModelProvider, ModelReply, ModelRequest } from './model.js';
import { callOpenAi } from './openai-provider.js';
import { settleFailure, settleSuccess } from './settle.js';

export class Gateway implements Model {
    private readonly ctx: Ctx;

    constructor(
        private readonly db: Database,
        private readonly config: Config,
        private readonly provider?: ModelProvider,
    ) {
        this.ctx = createCtx(config);
    }

    async complete(job: Job, step: string, request: ModelRequest): Promise<ModelReply> {
        const digest = hash(JSON.stringify(request));
        const callId = randomUUID();
        const admission = await this.db.tx(async (tx) => admitCall(tx, this.ctx, { job, step, digest, callId }));

        if ('cached' in admission) {
            return admission.cached;
        }

        let completed = false;

        try {
            if (!(await this.isStillRunnable(job))) {
                completed = true;
                throw new AppError('job_ineligible');
            }

            const response = await this.invoke(job, request);

            completed = true;

            await settleSuccess(this.db, {
                callId,
                permit: admission,
                encryptedReply: encrypt(response, this.config.ENCRYPTION_KEY),
                usage: JSON.stringify(response.usage),
            });

            return response;
        } catch (error) {
            const known = completed || (error instanceof AppError && error.code === 'provider_rejected');

            await settleFailure(this.db, { callId, permit: admission, known });
            throw error;
        }
    }

    async execute({ job_id: jobId, generation, step, request }: ExecuteRequest) {
        const job = await one<Job>(this.db, 'SELECT * FROM jobs WHERE id=$1 AND org_id=$2', [jobId, this.ctx.org]);

        ensure(job, 'not_found', 404);
        ensure(job.generation === generation, 'job_stale');

        return this.complete(job, step, request);
    }

    async permits() {
        return (await this.db.query('SELECT slot,state FROM ai_permits ORDER BY slot')).rows;
    }

    private async isStillRunnable(job: Job): Promise<boolean> {
        const current = await one<Job>(this.db, 'SELECT * FROM jobs WHERE id=$1', [job.id]);

        return (
            !!current &&
            current.state === 'running' &&
            current.generation === job.generation &&
            (await eligibleJob(this.db, this.ctx.org, current))
        );
    }

    private async invoke(job: Job, request: ModelRequest): Promise<ModelReply> {
        const seconds =
            job.kind === 'triage' ? this.config.AI_TRIAGE_TIMEOUT_SECONDS : this.config.AI_LEARNING_TIMEOUT_SECONDS;

        const timeoutMs = seconds * 1000;

        if (this.provider) {
            return this.provider(request, timeoutMs);
        }

        if (this.config.AI_MODE === 'mock') {
            return mockModel(request);
        }

        return callOpenAi(this.config, request, timeoutMs);
    }
}
