import type { FastifyServerOptions } from 'fastify';

import type { Config } from '../../shared/config.js';

export function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  if (config.NODE_ENV === 'test') {
    return false;
  }
  return {
    level: 'info',
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers.x-max-bot-api-secret',
      'res.headers.set-cookie',
    ],
    serializers: {
      req: (req: { method: string; url: string }) => ({
        method: req.method,
        path: req.url.startsWith('/download/') ? '/download/[redacted]' : req.url.split('?')[0],
      }),
    },
  };
}
