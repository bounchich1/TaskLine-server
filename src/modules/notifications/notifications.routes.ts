import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { Database } from '../../shared/db.js';
import { paramsId, staffOf } from '../../shared/http/request.js';
import { access } from '../../shared/http/route-access.js';

import { listNotifications, markNotificationRead, markTicketNotificationsRead } from './notifications.js';
import { readSettings, saveSettings, settingsBody } from './settings.js';

const readTicketBody = z.object({ ticket_id: z.uuid() }).strict();

export const notificationsRoutes: FastifyPluginAsync<{ db: Database; org: string }> = async (app, { db, org }) => {
    app.get('/v1/notifications', access('tickets.view'), async (request) =>
        listNotifications(db, org, staffOf(request).employee.id),
    );

    app.post('/v1/notifications/:id/read', access('tickets.view'), async (request) => {
        const employeeId = staffOf(request).employee.id;

        await markNotificationRead(db, org, { employeeId, notificationId: paramsId(request) });

        return { ok: true };
    });

    app.post('/v1/notifications/read', access('tickets.view'), async (request) => {
        const employeeId = staffOf(request).employee.id;
        const { ticket_id: ticketId } = readTicketBody.parse(request.body);

        return { read: await markTicketNotificationsRead(db, org, { employeeId, ticketId }) };
    });

    app.get('/v1/notifications/settings', access('tickets.view'), async (request) =>
        readSettings(db, org, staffOf(request).employee.id),
    );

    app.put('/v1/notifications/settings', access('tickets.view'), async (request) =>
        saveSettings(db, org, { employeeId: staffOf(request).employee.id, body: settingsBody.parse(request.body) }),
    );
};
