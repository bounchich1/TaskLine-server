import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';

import { fetch, FormData, type Response } from 'undici';

import { mediaHosts, type Config } from '../../shared/config.js';
import { jsonText, object, strictJson } from '../../shared/json.js';
import { boundedText, mediaFetch } from '../../shared/network.js';
import { maxDispatcher, maxTrustedRoots } from '../../shared/tls.js';
import type { Row } from '../../shared/types/entities.js';

export class TransportFailure extends Error {
    constructor(
        public outcome: 'unknown' | 'retry' | 'failed',
        public reason: string,
        public retryAfter = 2,
    ) {
        super(reason);
    }
}

export interface MaxTransport {
    send(chatId: string, body: Row): Promise<string>;
    answer(callbackId: string, text: string): Promise<void>;
    upload(kind: string, path: string, name: string, mime: string): Promise<Row>;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20000;
const noRateLimit = (): Promise<void> => Promise.resolve();

interface MaxClientOptions {
    rate?: () => Promise<void>;
    token?: string;
}

export class MaxClient implements MaxTransport {
    private rate: () => Promise<void>;
    private token: string;

    constructor(
        private c: Config,
        options: MaxClientOptions = {},
    ) {
        this.rate = options.rate ?? noRateLimit;
        this.token = options.token ?? c.MAX_BOT_TOKEN;
    }

    async request(path: string, body: Row, query: Record<string, string> = {}): Promise<Row> {
        await this.rate();
        const url = new URL(path, this.c.MAX_API_URL);

        for (const [key, value] of Object.entries(query)) {
            url.searchParams.set(key, value);
        }

        const response = await this.post(url, body);

        await rejectUnsuccessful(response);

        try {
            const result = object(strictJson(await boundedText(response), true, MAX_RESPONSE_BYTES));

            if (result.success === false) {
                throw new TransportFailure(
                    result.code === 'attachment.not.ready' ? 'retry' : 'failed',
                    jsonText(result.code ?? 'max_rejected'),
                );
            }

            return result;
        } catch (error) {
            if (error instanceof TransportFailure) {
                throw error;
            }

            throw new TransportFailure('unknown', 'max_invalid_response');
        }
    }

    private async post(url: URL, body: Row): Promise<Response> {
        try {
            return await fetch(url, {
                method: 'POST',
                headers: { Authorization: this.token, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                redirect: 'error',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                dispatcher: maxDispatcher(this.c),
            });
        } catch {
            throw new TransportFailure('unknown', 'max_transport_uncertain');
        }
    }

    async send(chatId: string, body: Row) {
        if (this.c.MAX_MODE === 'mock') {
            return `mock-${randomUUID()}`;
        }

        const result = await this.request(
            '/messages',
            { ...body, notify: true },
            { chat_id: chatId, disable_link_preview: 'true' },
        );

        const message = object(result.message);
        const responseBody = object(message.body);

        if (typeof responseBody.mid !== 'string') {
            throw new TransportFailure('unknown', 'max_missing_message_id');
        }

        return responseBody.mid;
    }

    async answer(callbackId: string, text: string) {
        if (this.c.MAX_MODE === 'mock') {
            return;
        }

        await this.request('/answers', { notification: text }, { callback_id: callbackId });
    }

    async upload(kind: string, path: string, name: string, mime: string): Promise<Row> {
        if (this.c.MAX_MODE === 'mock') {
            return { type: kind, payload: { token: `mock-${randomUUID()}` } };
        }

        const allocation = await this.request('/uploads', {}, { type: kind });

        if (typeof allocation.url !== 'string') {
            throw new TransportFailure('failed', 'invalid_upload_url');
        }

        const form = new FormData();

        form.set('data', await openAsBlob(path, { type: mime }), name);

        const media = await mediaFetch(
            allocation.url,
            mediaHosts(this.c),
            { method: 'POST', body: form },
            maxTrustedRoots(this.c),
        );

        try {
            if (!media.response.ok) {
                throw new TransportFailure('retry', 'upload_failed');
            }

            const result = object(strictJson(await boundedText(media.response), true, MAX_RESPONSE_BYTES));

            if (kind === 'video') {
                if (typeof allocation.token !== 'string') {
                    throw new TransportFailure('failed', 'video_token_missing');
                }

                return { type: kind, payload: { token: allocation.token } };
            }

            if (kind === 'image') {
                const photos = object(result.photos);
                const photo = object(Object.values(photos)[0]);

                if (typeof photo.token !== 'string') {
                    throw new TransportFailure('failed', 'image_token_missing');
                }

                return { type: 'image', payload: { token: photo.token } };
            }

            if (typeof result.token !== 'string') {
                throw new TransportFailure('failed', 'file_token_missing');
            }

            return { type: 'file', payload: { token: result.token } };
        } finally {
            await media.close();
        }
    }
}

async function rejectUnsuccessful(response: Response): Promise<void> {
    if (response.ok) {
        return;
    }

    await response.body?.cancel();

    if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after')) || 2;

        throw new TransportFailure('retry', 'max_rate_limited', Math.min(3600, Math.max(2, retryAfter)));
    }

    if (response.status >= 500) {
        throw new TransportFailure('unknown', 'max_server_uncertain');
    }

    throw new TransportFailure('failed', `max_rejected_${response.status}`);
}
