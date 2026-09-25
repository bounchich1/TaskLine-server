import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { normalizeUpdate } from '../../integrations/max/index.js';
import type { Config } from '../../shared/config.js';
import { equal, hash } from '../../shared/crypto.js';
import { ensure } from '../../shared/errors.js';
import { requireOps } from '../../shared/http/request.js';
import type { ClientInput } from '../../shared/types/client-input.js';

import type { Inbox } from './inbox.js';

const devInboundBody = z
  .object({
    user_id: z.string().regex(/^\d+$/),
    text: z.string().max(16000),
    message_id: z.string().max(100),
  })
  .strict();

export const webhookRoutes: FastifyPluginAsync<{ inbox: Inbox; config: Config }> = async (
  app,
  { inbox, config },
) => {
  app.post('/webhooks/max', async (request, reply) => {
    const secret = request.headers['x-max-bot-api-secret'];
    ensure(
      typeof secret === 'string' && equal(secret, config.MAX_WEBHOOK_SECRET),
      'webhook_unauthorized',
      401,
    );
    await inbox.ingest(parseUpdate(String(request.body)));
    return reply.code(200).send({ ok: true });
  });
};

function parseUpdate(raw: string): ClientInput {
  try {
    return normalizeUpdate(raw);
  } catch {
    return { kind: 'unknown', sourceKey: `malformed:${hash(raw)}` };
  }
}

export const devInboundRoutes: FastifyPluginAsync<{ inbox: Inbox }> = async (app, { inbox }) => {
  app.post('/v1/dev/inbound', async (request) => {
    requireOps(request);
    const input = devInboundBody.parse(request.body);
    await inbox.ingest({
      kind: 'message',
      userId: input.user_id,
      chatId: input.user_id,
      sourceKey: `message_created:${input.message_id}`,
      messageId: input.message_id,
      text: input.text,
    });
    return { ok: true };
  });
};
