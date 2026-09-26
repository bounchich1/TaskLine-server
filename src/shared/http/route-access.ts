import type { Permission } from '../access.js';

export type RouteAccess = Permission | 'session' | 'public';

declare module 'fastify' {
    interface FastifyContextConfig {
        access?: RouteAccess;
    }
}

export function access(rule: RouteAccess) {
    return { config: { access: rule } };
}
