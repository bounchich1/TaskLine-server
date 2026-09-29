import { randomUUID } from 'node:crypto';

import type { Config } from '../../../shared/config.js';
import { createCtx, type Ctx } from '../../../shared/context.js';
import { encrypt, hash } from '../../../shared/crypto.js';
import { one, type Database } from '../../../shared/db.js';
import { AppError, ensure } from '../../../shared/errors.js';
import type { Job } from '../../../shared/types/entities.js';

import { admitCall } from './admission.js';
import type { ExecuteRequest } from './execute-request.js';
import { eligibleJob, triageTimeLeftMs } from './job-eligibility.js';
import { mockModel } from './mock-model.js';
import type { CallOptions, Model, ModelProvider, ModelReply, ModelRequest } from './model.js';
import { callOpenAi } from './openai-provider.js';
import { settleFailure, settleSuccess, type CallOutcome } from './settle.js';

const PROVIDER_ANSWERED = ['provider_rejected', 'provider_bad_reply'];
const PROVIDER_RETRYABLE = ['provider_busy', 'provider_unavailable'];
const TRIAGE_APPLY_MARGIN_MS = 3000;
const MIN_TRIAGE_CALL_MS = 5000;

type CallPhase = 'preparing' | 'calling' | 'answered';

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

        let phase: CallPhase = 'preparing';

        try {
            ensure(await this.isStillRunnable(job), 'job_ineligible');
            const options = await this.callOptions(job);

            phase = 'calling';
            const response = await this.invoke(request, options);

            phase = 'answered';

            await settleSuccess(this.db, {
                callId,
                permit: admission,
                encryptedReply: encrypt(response, this.config.ENCRYPTION_KEY),
                usage: JSON.stringify(response.usage),
            });

            return response;
        } catch (error) {
            await settleFailure(this.db, { callId, permit: admission, outcome: callOutcome(error, phase) });
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
            (await eligibleJob(this.db, this.ctx, current))
        );
    }

    private async callOptions(job: Job): Promise<CallOptions> {
        const { config } = this;

        if (job.kind !== 'triage') {
            return {
                timeoutMs: config.AI_LEARNING_TIMEOUT_SECONDS * 1000,
                maxTokens: config.AI_LEARNING_MAX_TOKENS,
                reasoningEffort: config.AI_LEARNING_REASONING_EFFORT,
                cacheKey: job.id,
            };
        }

        const timeLeftMs = (await triageTimeLeftMs(this.db, this.ctx, job.ref_id)) - TRIAGE_APPLY_MARGIN_MS;

        ensure(timeLeftMs >= MIN_TRIAGE_CALL_MS, 'triage_deadline', 422);

        return {
            timeoutMs: Math.min(config.AI_TRIAGE_TIMEOUT_SECONDS * 1000, timeLeftMs),
            maxTokens: config.AI_TRIAGE_MAX_TOKENS,
            reasoningEffort: config.AI_TRIAGE_REASONING_EFFORT,
            cacheKey: job.id,
        };
    }

    private async invoke(request: ModelRequest, options: CallOptions): Promise<ModelReply> {
        if (this.provider) {
            return this.provider(request, options);
        }

        if (this.config.AI_MODE === 'mock') {
            return mockModel(request);
        }

        return callOpenAi(this.config, request, options);
    }
}

function callOutcome(error: unknown, phase: CallPhase): CallOutcome {
    const code = error instanceof AppError ? error.code : '';

    if (phase === 'preparing' || PROVIDER_RETRYABLE.includes(code)) {
        return 'retryable';
    }

    return phase === 'answered' || PROVIDER_ANSWERED.includes(code) ? 'answered' : 'unknown';
}
