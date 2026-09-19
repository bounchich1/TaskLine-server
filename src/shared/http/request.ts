import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ensure } from '../errors.js';
import type { Row } from '../types/entities.js';
import type { Session } from '../types/session.js';

// Request accessors shared by the route plugins. Where a handler reads several of them, it
// reads them in the order params → body → If-Match → Idempotency-Key: that order decides which
// validation error the client sees.

const uuid = z.uuid();
const idempotencyKeySchema = z.string().min(8).max(128);

/** The `:id` route parameter, which must be a UUID. */
export function paramsId(request: FastifyRequest): string {
  return uuid.parse((request.params as Row).id);
}

/** A named route parameter, unvalidated. */
export function routeParam(request: FastifyRequest, name: string): unknown {
  return (request.params as Row)[name];
}

export function idempotencyKey(request: FastifyRequest): string {
  return idempotencyKeySchema.parse(request.headers['idempotency-key']);
}

/** The expected entity version from `If-Match` (quoted or bare digits). */
export function ifMatchVersion(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  ensure(typeof raw === 'string' && /^"?\d+"?$/.test(raw), 'version_required', 422);
  return Number(raw.replaceAll('"', ''));
}

/** The session token from `Authorization: Bearer …`, falling back to the session cookie. */
export function sessionToken(request: FastifyRequest): string | undefined {
  return request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : request.cookies.support_session;
}

/** The session the auth hook attached; every /v1 route except login has one. */
export function staffOf(request: FastifyRequest): Session {
  if (!request.staff) {
    throw new Error('Route requires an authenticated staff session');
  }
  return request.staff;
}

export function requireAdmin(request: FastifyRequest): void {
  ensure(staffOf(request).employee.role === 'admin', 'forbidden', 403);
}

/** Operations tools are for supervisors and admins. */
export function requireOps(request: FastifyRequest): void {
  ensure(staffOf(request).employee.role !== 'support', 'forbidden', 403);
}
