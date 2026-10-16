import type { FastifyRequest } from 'fastify';

import { equal } from '../crypto.js';
import { ensure } from '../errors.js';

export function requireOpsToken(request: FastifyRequest, token: string): void {
    const header = request.headers.authorization ?? '';

    ensure(!!token && equal(header, `Bearer ${token}`), 'unauthorized', 401);
}
