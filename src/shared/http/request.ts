import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ensure } from '../errors.js';
import type { Row } from '../types/entities.js';
import type { Session } from '../types/session.js';

const uuid = z.uuid();
const idempotencyKeySchema = z.string().min(8).max(128);

export function paramsId(request: FastifyRequest): string {
    return uuid.parse((request.params as Row).id);
}

export function routeParam(request: FastifyRequest, name: string): unknown {
    return (request.params as Row)[name];
}

export function idempotencyKey(request: FastifyRequest): string {
    return idempotencyKeySchema.parse(request.headers['idempotency-key']);
}

export function ifMatchVersion(request: FastifyRequest): number {
    const raw = request.headers['if-match'];

    ensure(typeof raw === 'string' && /^"?\d+"?$/.test(raw), 'version_required', 422);

    return Number(raw.replaceAll('"', ''));
}

export function sessionToken(request: FastifyRequest): string | undefined {
    return request.headers.authorization?.startsWith('Bearer ')
        ? request.headers.authorization.slice(7)
        : request.cookies.support_session;
}

export function staffOf(request: FastifyRequest): Session {
    if (!request.staff) {
        throw new Error('Route requires an authenticated staff session');
    }

    return request.staff;
}
