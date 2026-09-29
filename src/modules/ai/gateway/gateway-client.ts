import { fetch } from 'undici';

import type { Config } from '../../../shared/config.js';
import { AppError } from '../../../shared/errors.js';
import { object, strictJson } from '../../../shared/json.js';
import { boundedText } from '../../../shared/network.js';
import type { Job } from '../../../shared/types/entities.js';

import type { Model, ModelReply, ModelRequest } from './model.js';

const MAX_RESPONSE_BYTES = 128 * 1024;
const GATEWAY_OVERHEAD_SECONDS = 30;

export class GatewayClient implements Model {
    constructor(private readonly config: Config) {}

    async complete(job: Job, step: string, request: ModelRequest): Promise<ModelReply> {
        const response = await fetch(`${this.config.GATEWAY_URL}/execute`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.config.GATEWAY_SECRET}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ job_id: job.id, generation: job.generation, step, request }),
            signal: AbortSignal.timeout(this.timeoutMs()),
            redirect: 'error',
        });

        const data = object(strictJson(await boundedText(response, MAX_RESPONSE_BYTES), false, MAX_RESPONSE_BYTES));

        if (!response.ok) {
            const error = new AppError(
                typeof data.code === 'string' ? data.code : 'gateway_unavailable',
                response.status,
                'Модель временно недоступна.',
                true,
            );

            if (typeof data.retry_after === 'number') {
                error.retryAfterSeconds = data.retry_after;
            }

            throw error;
        }

        return data as ModelReply;
    }

    private timeoutMs(): number {
        const { AI_TRIAGE_TIMEOUT_SECONDS, AI_LEARNING_TIMEOUT_SECONDS } = this.config;

        return (Math.max(AI_TRIAGE_TIMEOUT_SECONDS, AI_LEARNING_TIMEOUT_SECONDS) + GATEWAY_OVERHEAD_SECONDS) * 1000;
    }
}
