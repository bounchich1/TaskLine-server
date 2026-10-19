import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Database } from '../../shared/db.js';
import { paramsId, routeParam, staffOf } from '../../shared/http/request.js';
import { access } from '../../shared/http/route-access.js';

import { periodQuery } from './period.js';
import { grantReportExport, redeemReportGrant } from './report-grants.js';
import { exportFormat, reportName, type ExportFile, type Reports } from './reports.js';
import { recordStaffEvent, staffEventBody } from './staff-events.js';

const grantParam = z.string().min(32).max(128);

const exportQuery = z
    .object({ format: exportFormat, from: z.iso.date(), to: z.iso.date() })
    .strict()
    .transform(({ format, from, to }) => ({ format, period: periodQuery.parse({ from, to }) }));

function sendFile(reply: FastifyReply, file: ExportFile) {
    return reply
        .header('Cache-Control', 'no-store')
        .header('Content-Type', file.contentType)
        .header('Content-Disposition', `attachment; filename="${file.filename}"`)
        .send(file.body);
}

export const reportsRoutes: FastifyPluginAsync<{ reports: Reports; db: Database }> = async (app, { reports, db }) => {
    app.get('/v1/reports/:name', access('reports.view'), async (request) =>
        reports.report(reportName.parse(routeParam(request, 'name')), periodQuery.parse(request.query)),
    );

    app.get('/v1/reports/:name/export', access('reports.view'), async (request, reply) => {
        const { format, period } = exportQuery.parse(request.query);

        return sendFile(reply, await reports.export(reportName.parse(routeParam(request, 'name')), format, period));
    });

    app.post('/v1/reports/:name/export-grant', access('reports.view'), async (request) => {
        const { format, period } = exportQuery.parse(request.body ?? {});
        const name = reportName.parse(routeParam(request, 'name'));

        return grantReportExport(db, reports.ctx, staffOf(request), { name, format, period });
    });

    app.get('/download/report/:grant', async (request, reply) => {
        const { name, format, period } = await redeemReportGrant(
            db,
            reports.ctx,
            grantParam.parse(routeParam(request, 'grant')),
        );

        return sendFile(reply.header('Referrer-Policy', 'no-referrer'), await reports.export(name, format, period));
    });

    app.post('/v1/tickets/:id/events', access('tickets.view'), async (request, reply) => {
        const ticketId = paramsId(request);

        await recordStaffEvent(db, reports.ctx.org, {
            ticketId,
            employeeId: staffOf(request).employee.id,
            ...staffEventBody.parse(request.body ?? {}),
        });

        return reply.code(202).send({});
    });
};
