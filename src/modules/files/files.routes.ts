import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ensure } from '../../shared/errors.js';
import { idempotencyKey, paramsId, routeParam, staffOf } from '../../shared/http/request.js';

import { attachmentDisposition } from './downloads.js';
import type { Files } from './files.js';

const UPLOAD_BODY_LIMIT = 101 * 1024 * 1024;

const prepareBody = z
    .object({
        ticket_id: z.uuid(),
        filename: z.string().min(1).max(200),
        kind: z.enum(['image', 'video', 'file']),
    })
    .strict();

const grantParam = z.string().min(32).max(128);

export const filesRoutes: FastifyPluginAsync<{ files: Files }> = async (app, { files }) => {
    addUploadRoutes(app, files);
    addDownloadRoutes(app, files);
};

function addUploadRoutes(app: FastifyInstance, files: Files): void {
    app.post('/v1/uploads', async (request) => {
        idempotencyKey(request);
        const body = prepareBody.parse(request.body);

        return files.prepare(staffOf(request).employee, {
            ticketId: body.ticket_id,
            filename: body.filename,
            kind: body.kind,
        });
    });

    app.put('/v1/uploads/:id/content', { bodyLimit: UPLOAD_BODY_LIMIT }, async (request) => {
        const file = await request.file();

        ensure(file, 'file_required', 422);

        return files.receive(staffOf(request).employee, {
            id: paramsId(request),
            stream: file.file,
            isTruncated: () => file.file.truncated,
        });
    });

    app.post('/v1/uploads/:id/complete', async (request) =>
        files.draftStatus(staffOf(request).employee, paramsId(request)),
    );

    app.delete('/v1/uploads/:id', async (request) => {
        await files.cancelDraft(staffOf(request).employee, paramsId(request));

        return { ok: true };
    });
}

function addDownloadRoutes(app: FastifyInstance, files: Files): void {
    app.get('/v1/attachments/:id/download', async (request, reply) => {
        const attachment = await files.sentAttachment(paramsId(request));

        reply
            .header('Content-Type', 'application/octet-stream')
            .header('Content-Disposition', attachmentDisposition(attachment.filename))
            .header('X-Content-Type-Options', 'nosniff');

        return reply.send(await files.read(String(attachment.object_key)));
    });

    app.post('/v1/attachments/:id/download-grant', async (request) =>
        files.grantDownload(staffOf(request), paramsId(request)),
    );

    app.get('/download/:grant', async (request, reply) => {
        const attachment = await files.redeemGrant(grantParam.parse(routeParam(request, 'grant')));

        reply
            .header('Cache-Control', 'no-store')
            .header('Referrer-Policy', 'no-referrer')
            .header('Content-Type', 'application/octet-stream')
            .header('Content-Disposition', attachmentDisposition(attachment.filename));

        return reply.send(await files.read(String(attachment.object_key)));
    });
}
