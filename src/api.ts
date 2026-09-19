import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';

import { Admin } from './admin.js';
import { authenticate, capabilities, issueSession, verifyLaunch, type Session } from './auth.js';
import { DeliveryWorker } from './delivery.js';
import { Domain } from './domain.js';
import { Files, safeFilename } from './files.js';
import { MaxClient, type MaxTransport, normalizeUpdate } from './integrations/max/index.js';
import { openapi } from './openapi.js';
import { filtersSchema, publicAttachment, Queries } from './queries.js';
import type { Config } from './shared/config.js';
import { equal, hash, token } from './shared/crypto.js';
import { one, type Database } from './shared/db.js';
import { AppError, ensure } from './shared/errors.js';
import { strictJson } from './shared/json.js';
import type { Row } from './shared/types/entities.js';

declare module 'fastify' {
  interface FastifyRequest {
    staff?: Session;
  }
}
const uuid = z.uuid();
const commandSchemas: Record<string, z.ZodType> = {
  assign: z.object({}).strict(),
  transfer: z.object({ employee_id: uuid, comment: z.string().trim().min(1).max(2000) }).strict(),
  classification: z
    .object({
      tag: z.string().max(64).optional(),
      urgency: z.string().max(64).optional(),
      complexity: z.string().max(64).optional(),
      revisions: z
        .object({
          tag: z.number().int().optional(),
          urgency: z.number().int().optional(),
          complexity: z.number().int().optional(),
        })
        .strict(),
    })
    .strict()
    .refine((v) => v.tag !== undefined || v.urgency !== undefined || v.complexity !== undefined),
  messages: z
    .object({
      text: z.string().max(4000).default(''),
      attachment_ids: z.array(uuid).max(10).default([]),
    })
    .strict(),
  close: z.object({ note: z.string().max(2000).optional() }).strict(),
  reopen: z
    .object({ reason: z.string().trim().min(1).max(2000), employee_id: uuid.optional() })
    .strict(),
};
const paramsId = (request: FastifyRequest) => uuid.parse((request.params as Row).id);
const key = (request: FastifyRequest) =>
  z.string().min(8).max(128).parse(request.headers['idempotency-key']);
const version = (request: FastifyRequest) => {
  const raw = request.headers['if-match'];
  ensure(typeof raw === 'string' && /^"?\d+"?$/.test(raw), 'version_required', 422);
  return Number(raw.replaceAll('"', ''));
};
const sessionToken = (request: FastifyRequest) =>
  request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : request.cookies.support_session;

export async function buildApi(db: Database, c: Config, transport?: MaxTransport) {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    logger:
      c.NODE_ENV === 'test'
        ? false
        : {
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
                path: req.url.startsWith('/download/')
                  ? '/download/[redacted]'
                  : req.url.split('?')[0],
              }),
            },
          },
  });
  const domain = new Domain(db, c);
  const queries = new Queries(db, c.ORG_ID);
  const admin = new Admin(db, c.ORG_ID);
  const files = new Files(db, c);
  const deliveries = new DeliveryWorker(db, c, transport ?? new MaxClient(c), files);
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  await app.register(multipart, {
    limits: { files: 1, fileSize: 100 * 1024 * 1024, fields: 0, parts: 1 },
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (request.url === '/webhooks/max') {
      done(null, body);
      return;
    }
    try {
      done(null, strictJson(String(body), false, 1024 * 1024));
    } catch {
      done(new AppError('invalid_json', 400, 'Некорректные данные запроса.'));
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({
        code: error.code,
        message: error.message,
        request_id: request.id,
        retryable: error.retryable,
      });
    }
    if (error instanceof ZodError || (error as { validation?: unknown }).validation) {
      return reply.code(422).send({
        code: 'invalid_input',
        message: 'Проверьте введённые данные.',
        request_id: request.id,
        retryable: false,
      });
    }
    if ((error as { code?: string }).code === '23505') {
      return reply.code(409).send({
        code: 'conflict',
        message: 'Данные уже изменились или существуют.',
        request_id: request.id,
        retryable: false,
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({
        code: 'request_rejected',
        message: 'Запрос отклонён.',
        request_id: request.id,
        retryable: false,
      });
    }
    request.log.error(
      {
        reason: (error as { code?: string }).code ?? (error as Error).name,
        request_id: request.id,
      },
      'Request failed',
    );
    return reply.code(503).send({
      code: 'temporarily_unavailable',
      message: 'Сервис временно недоступен. Повторите позже.',
      request_id: request.id,
      retryable: true,
    });
  });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin === c.APP_ORIGIN) {
      reply
        .header('Access-Control-Allow-Origin', origin)
        .header('Access-Control-Allow-Credentials', 'true')
        .header('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      ensure(origin === c.APP_ORIGIN, 'origin_denied', 403);
      return reply
        .header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
        .header(
          'Access-Control-Allow-Headers',
          'Content-Type,Authorization,X-CSRF-Token,Idempotency-Key,If-Match,Last-Event-ID',
        )
        .code(204)
        .send();
    }
    if (request.url.startsWith('/v1/')) {
      reply.header('Cache-Control', 'no-store');
      if (request.method !== 'GET') {
        ensure(origin === c.APP_ORIGIN, 'origin_denied', 403);
      }
    }
  });
  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/v1/') || ['/v1/auth/max', '/v1/auth/dev'].includes(request.url)) {
      return;
    }
    request.staff = await authenticate(db, c.ORG_ID, sessionToken(request));
    if (request.method !== 'GET') {
      const csrf = request.headers['x-csrf-token'];
      ensure(
        typeof csrf === 'string' && equal(hash(csrf), request.staff.csrfHash),
        'csrf_failed',
        403,
      );
    }
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await db.query('SELECT version FROM schema_migrations WHERE version=1');
    return { status: 'ready' };
  });
  app.get('/openapi.json', async () => openapi);
  app.post('/webhooks/max', async (request, reply) => {
    const secret = request.headers['x-max-bot-api-secret'];
    ensure(
      typeof secret === 'string' && equal(secret, c.MAX_WEBHOOK_SECRET),
      'webhook_unauthorized',
      401,
    );
    let input;
    try {
      input = normalizeUpdate(String(request.body));
    } catch {
      input = { kind: 'unknown' as const, sourceKey: `malformed:${hash(String(request.body))}` };
    }
    await domain.ingest(input);
    return reply.code(200).send({ ok: true });
  });
  app.post(
    '/v1/auth/max',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = z
        .object({ init_data: z.string().min(1).max(16384) })
        .strict()
        .parse(request.body);
      let launch;
      try {
        launch = verifyLaunch(body.init_data, c.MAX_BOT_TOKEN);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          'invalid_launch',
          401,
          'Не удалось проверить запуск. Откройте приложение из MAX.',
        );
      }
      const issued = await issueSession(db, c, launch.userId, launch.digest);
      reply.setCookie('support_session', issued.token, {
        httpOnly: true,
        secure: c.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: 28800,
      });
      return { ...issued, start_param: launch.startParam ?? null };
    },
  );
  app.post('/v1/auth/dev', async (request, reply) => {
    ensure(
      c.NODE_ENV !== 'production' &&
        c.DEV_AUTH_ENABLED &&
        ['127.0.0.1', '::1'].includes(request.ip),
      'not_found',
      404,
    );
    const body = z
      .object({ user_id: z.string().regex(/^\d+$/) })
      .strict()
      .parse(request.body);
    const issued = await issueSession(
      db,
      c,
      body.user_id,
      hash(`dev:${body.user_id}:${Math.floor(Date.now() / 300000)}`),
    );
    reply.setCookie('support_session', issued.token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 28800,
    });
    return issued;
  });
  app.get('/v1/me', async (request) => ({
    employee: request.staff!.employee,
    capabilities: capabilities(request.staff!.employee),
    organization: await one(db, 'SELECT name,timezone FROM organizations WHERE id=$1', [c.ORG_ID]),
  }));
  app.post('/v1/auth/logout', async (request, reply) => {
    await db.query('UPDATE staff_sessions SET revoked=true WHERE hash=$1', [request.staff!.hash]);
    reply.clearCookie('support_session', { path: '/' });
    return { ok: true };
  });
  app.post('/v1/auth/refresh', async (request, reply) => {
    const secret = token();
    const csrf = token();
    await db.tx(async (tx) => {
      const row = await tx.query(
        'UPDATE staff_sessions SET hash=$2,csrf_hash=$3,last_seen_at=now() WHERE hash=$1 AND NOT revoked AND expires_at>now() RETURNING hash',
        [request.staff!.hash, hash(secret), hash(csrf)],
      );
      ensure(row.rows.length, 'unauthorized', 401);
    });
    reply.setCookie('support_session', secret, {
      httpOnly: true,
      secure: c.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
    });
    return { token: secret, csrf };
  });
  app.get('/v1/tickets', async (request) => queries.list(filtersSchema.parse(request.query)));
  app.get('/v1/tickets/counts', async (request) =>
    queries.list(filtersSchema.parse(request.query), true),
  );
  app.get('/v1/tickets/:id', async (request) => queries.ticket(paramsId(request)));
  app.get('/v1/tickets/:id/messages', async (request) => {
    const q = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        after: z.coerce.number().int().nonnegative().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(request.query);
    return queries.messages(paramsId(request), q.before, q.after, q.limit);
  });
  for (const [name, schema] of Object.entries(commandSchemas)) {
    app.route({
      method: name === 'classification' ? 'PATCH' : 'POST',
      url: `/v1/tickets/:id/${name}`,
      handler: async (request, reply) => {
        const result = await domain.command(
          request.staff!.employee,
          paramsId(request),
          name,
          schema.parse(request.body ?? {}) as Row,
          version(request),
          key(request),
        );
        if (name === 'messages') {
          reply.code(202);
        }
        return result;
      },
    });
  }
  app.get('/v1/employees', async () => ({
    items: (
      await db.query(
        'SELECT id,name,role,blocked,version FROM employees WHERE org_id=$1 ORDER BY name',
        [c.ORG_ID],
      )
    ).rows,
  }));
  app.get('/v1/dictionaries', async () => ({
    items: (
      await db.query(
        'SELECT * FROM dictionaries WHERE org_id=$1 ORDER BY dimension,rank DESC,code',
        [c.ORG_ID],
      )
    ).rows,
  }));
  app.get('/v1/notifications', async (request) => ({
    items: (
      await db.query(
        'SELECT * FROM notifications WHERE org_id=$1 AND employee_id=$2 ORDER BY created_at DESC LIMIT 100',
        [c.ORG_ID, request.staff!.employee.id],
      )
    ).rows,
  }));
  app.post('/v1/notifications/:id/read', async (request) => {
    await db.query(
      'UPDATE notifications SET read_at=coalesce(read_at,now()) WHERE org_id=$1 AND employee_id=$2 AND id=$3',
      [c.ORG_ID, request.staff!.employee.id, paramsId(request)],
    );
    return { ok: true };
  });
  for (const action of ['cancel', 'retry'] as const) {
    app.post(`/v1/messages/:id/${action}`, async (request) => {
      key(request);
      const body = z
        .object({ evidence: z.string().max(2000).optional() })
        .strict()
        .parse(request.body ?? {});
      return deliveries.resolve(request.staff!.employee, paramsId(request), action, body.evidence);
    });
  }

  app.post('/v1/uploads', async (request) => {
    key(request);
    const body = z
      .object({
        ticket_id: uuid,
        filename: z.string().min(1).max(200),
        kind: z.enum(['image', 'video', 'file']),
      })
      .strict()
      .parse(request.body);
    return files.prepare(request.staff!.employee, body.ticket_id, body.filename, body.kind);
  });
  app.put('/v1/uploads/:id/content', { bodyLimit: 101 * 1024 * 1024 }, async (request) => {
    const file = await request.file();
    ensure(file, 'file_required', 422);
    return files.receive(
      request.staff!.employee,
      paramsId(request),
      file.file,
      () => file.file.truncated,
    );
  });
  app.post('/v1/uploads/:id/complete', async (request) => {
    const row = await one(
      db,
      'SELECT * FROM attachments WHERE org_id=$1 AND id=$2 AND owner_id=$3 AND message_id IS NULL',
      [c.ORG_ID, paramsId(request), request.staff!.employee.id],
    );
    ensure(row, 'not_found', 404);
    return publicAttachment(row);
  });
  app.delete('/v1/uploads/:id', async (request) => {
    await db.query(
      "UPDATE attachments SET status='canceled' WHERE org_id=$1 AND id=$2 AND owner_id=$3 AND message_id IS NULL AND status<>'receiving'",
      [c.ORG_ID, paramsId(request), request.staff!.employee.id],
    );
    return { ok: true };
  });
  const attachment = async (id: string) => {
    const row = await one(
      db,
      "SELECT a.* FROM attachments a JOIN tickets t ON t.id=a.ticket_id AND t.org_id=a.org_id WHERE a.org_id=$1 AND a.id=$2 AND a.status='clean' AND a.message_id IS NOT NULL",
      [c.ORG_ID, id],
    );
    ensure(row, 'not_found', 404);
    return row;
  };
  app.get('/v1/attachments/:id/download', async (request, reply) => {
    const row = await attachment(paramsId(request));
    reply
      .header('Content-Type', 'application/octet-stream')
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename(String(row.filename)))}`,
      )
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(await files.read(String(row.object_key)));
  });
  app.post('/v1/attachments/:id/download-grant', async (request) => {
    const row = await attachment(paramsId(request));
    const grant = token();
    await db.query(
      'INSERT INTO download_grants(hash,org_id,attachment_id,employee_id,session_hash) VALUES($1,$2,$3,$4,$5)',
      [hash(grant), c.ORG_ID, row.id, request.staff!.employee.id, request.staff!.hash],
    );
    return {
      url: `${c.PUBLIC_URL}/download/${grant}`,
      filename: safeFilename(String(row.filename)),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
  });
  app.get('/download/:grant', async (request, reply) => {
    const grant = z
      .string()
      .min(32)
      .max(128)
      .parse((request.params as Row).grant);
    const record = await one(
      db,
      `SELECT g.attachment_id FROM download_grants g JOIN employees e ON e.id=g.employee_id AND e.org_id=g.org_id JOIN staff_sessions s ON s.hash=g.session_hash
      WHERE g.hash=$1 AND g.org_id=$2 AND g.expires_at>now() AND NOT e.blocked AND NOT s.revoked AND s.employee_version=e.version AND s.expires_at>now()`,
      [hash(grant), c.ORG_ID],
    );
    ensure(record, 'not_found', 404);
    const file = await attachment(String(record.attachment_id));
    reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('Content-Type', 'application/octet-stream')
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename(String(file.filename)))}`,
      );
    return reply.send(await files.read(String(file.object_key)));
  });

  const requireAdmin = (request: FastifyRequest) =>
    ensure(request.staff!.employee.role === 'admin', 'forbidden', 403);
  const requireOps = (request: FastifyRequest) =>
    ensure(request.staff!.employee.role !== 'support', 'forbidden', 403);
  app.get('/v1/admin/employees', async (request) => {
    requireAdmin(request);
    return {
      items: (await db.query('SELECT * FROM employees WHERE org_id=$1 ORDER BY name', [c.ORG_ID]))
        .rows,
    };
  });
  app.post('/v1/admin/employees', async (request) =>
    admin.employee(
      request.staff!.employee,
      undefined,
      request.body,
      version(request),
      key(request),
    ),
  );
  app.patch('/v1/admin/employees/:id', async (request) =>
    admin.employee(
      request.staff!.employee,
      paramsId(request),
      request.body,
      version(request),
      key(request),
    ),
  );
  app.get('/v1/admin/roles', async (request) => {
    requireAdmin(request);
    return { items: ['support', 'supervisor', 'admin'].map((role) => ({ code: role })) };
  });
  app.put('/v1/admin/dictionaries', async (request) =>
    admin.dictionary(request.staff!.employee, request.body, version(request), key(request)),
  );
  app.get('/v1/admin/templates', async (request) => {
    requireAdmin(request);
    return {
      items: (
        await db.query('SELECT code,body,version FROM templates WHERE org_id=$1 ORDER BY code', [
          c.ORG_ID,
        ])
      ).rows,
    };
  });
  app.put('/v1/admin/templates/:code', async (request) =>
    admin.template(
      request.staff!.employee,
      String((request.params as Row).code),
      request.body,
      version(request),
      key(request),
    ),
  );
  app.get('/v1/admin/settings', async (request) => {
    requireAdmin(request);
    return one(db, 'SELECT name,timezone,version FROM organizations WHERE id=$1', [c.ORG_ID]);
  });
  app.put('/v1/admin/settings', async (request) =>
    admin.settings(request.staff!.employee, request.body, version(request), key(request)),
  );
  app.get('/v1/admin/diagnostics', async (request) => {
    requireOps(request);
    return queries.diagnostics();
  });
  app.get('/v1/admin/audit', async (request) => {
    requireAdmin(request);
    return {
      items: (
        await db.query('SELECT * FROM audit WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100', [
          c.ORG_ID,
        ])
      ).rows,
    };
  });
  app.post('/v1/admin/jobs/:id/retry', async (request) => {
    requireOps(request);
    key(request);
    const result = await db.query(
      "UPDATE jobs SET state='pending',due_at=now() WHERE org_id=$1 AND id=$2 AND state='failed' AND kind IN('file','scan','memory_delete','message_revision') RETURNING id",
      [c.ORG_ID, paramsId(request)],
    );
    ensure(result.rows.length, 'retry_not_allowed');
    return { ok: true };
  });

  app.get('/v1/events', async (request, reply) => {
    const q = z
      .object({ cursor: z.string().regex(/^\d+$/).optional() })
      .strict()
      .parse(request.query);
    let cursor = q.cursor ?? String(request.headers['last-event-id'] ?? '0');
    ensure(/^\d+$/.test(cursor), 'invalid_cursor', 422);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(request.headers.origin === c.APP_ORIGIN
        ? {
            'Access-Control-Allow-Origin': c.APP_ORIGIN,
            'Access-Control-Allow-Credentials': 'true',
          }
        : {}),
    });
    let alive = true;
    request.raw.on('close', () => {
      alive = false;
    });
    reply.raw.write('event: ready\ndata: {}\n\n');
    let heartbeat = 0;
    try {
      while (alive && !reply.raw.destroyed) {
        await authenticate(db, c.ORG_ID, sessionToken(request));
        const bounds = await one(
          db,
          'SELECT min(cursor)::text AS first,max(cursor)::text AS last FROM ui_events WHERE org_id=$1',
          [c.ORG_ID],
        );
        if (
          bounds?.first &&
          BigInt(cursor) > 0n &&
          BigInt(cursor) < BigInt(String(bounds.first)) - 1n
        ) {
          reply.raw.write(`event: resync\ndata: {}\n\n`);
          cursor = String(bounds.last);
        }
        const rows = (
          await db.query(
            'SELECT cursor::text,type,ticket_id,payload FROM ui_events WHERE org_id=$1 AND cursor>$2 ORDER BY cursor LIMIT 100',
            [c.ORG_ID, cursor],
          )
        ).rows;
        for (const event of rows) {
          if (
            !reply.raw.write(
              `id: ${event.cursor}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`,
            )
          ) {
            alive = false;
            break;
          }
          cursor = String(event.cursor);
        }
        if (++heartbeat % 8 === 0) {
          reply.raw.write(': heartbeat\n\n');
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch {
      if (!reply.raw.destroyed) {
        reply.raw.write('event: session_expired\ndata: {}\n\n');
      }
    } finally {
      reply.raw.end();
    }
  });
  if (c.DEV_AUTH_ENABLED && c.NODE_ENV !== 'production') {
    app.post('/v1/dev/inbound', async (request) => {
      requireOps(request);
      const input = z
        .object({
          user_id: z.string().regex(/^\d+$/),
          text: z.string().max(16000),
          message_id: z.string().max(100),
        })
        .strict()
        .parse(request.body);
      await domain.ingest({
        kind: 'message',
        userId: input.user_id,
        chatId: input.user_id,
        sourceKey: `message_created:${input.message_id}`,
        messageId: input.message_id,
        text: input.text,
      });
      return { ok: true };
    });
  }
  app.addHook('onClose', async () => {
    await emitShutdown();
  });
  async function emitShutdown() {
    /* No SDK lifecycle call: subscriptions belong to the deployment command. */
  }
  return app;
}
