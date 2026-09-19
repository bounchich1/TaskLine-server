import type { FastifyPluginAsync } from 'fastify';

import type { Database } from '../../shared/db.js';
import { paramsId, staffOf } from '../../shared/http/request.js';

import { listNotifications, markNotificationRead } from './notifications.js';

export const notificationsRoutes: FastifyPluginAsync<{ db: Database; org: string }> = async (
  app,
  { db, org },
) => {
  app.get('/v1/notifications', async (request) =>
    listNotifications(db, org, staffOf(request).employee.id),
  );
  app.post('/v1/notifications/:id/read', async (request) => {
    const employeeId = staffOf(request).employee.id;
    await markNotificationRead(db, org, { employeeId, notificationId: paramsId(request) });
    return { ok: true };
  });
};
