import type { Employee } from './entities.js';

/** An authenticated staff session (mini-app bearer token + CSRF token hashes). */
export interface Session {
  employee: Employee;
  hash: string;
  csrfHash: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook for every authenticated /v1 request. */
    staff?: Session;
  }
}
