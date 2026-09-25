import type { Employee } from './entities.js';

export interface Session {
    employee: Employee;
    hash: string;
    csrfHash: string;
}

declare module 'fastify' {
    interface FastifyRequest {
        staff?: Session;
    }
}
