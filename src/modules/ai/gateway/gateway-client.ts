import { fetch } from 'undici';

import type { Config } from '../../../shared/config.js';
import { AppError } from '../../../shared/errors.js';
import { object, strictJson } from '../../../shared/json.js';
import { boundedText } from '../../../shared/network.js';
import type { Job } from '../../../shared/types/entities.js';

import type { Model, ModelReply, ModelRequest } from './model.js';

const MAX_RESPONSE_BYTES = 128 * 1024;
const TIMEOUT_MS = 150000;

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
            signal: AbortSignal.timeout(TIMEOUT_MS),
            redirect: 'error',
        });

        const data = object(strictJson(await boundedText(response, MAX_RESPONSE_BYTES), false, MAX_RESPONSE_BYTES));

        if (!response.ok) {
            throw new AppError(
                typeof data.code === 'string' ? data.code : 'gateway_unavailable',
                response.status,
                'Модель временно недоступна.',
                true,
            );
        }

        return data as ModelReply;
    }
}
