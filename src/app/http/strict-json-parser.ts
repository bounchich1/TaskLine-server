import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { strictJson } from '../../shared/json.js';

const MAX_JSON_BYTES = 1024 * 1024;
const RAW_BODY_ROUTES = new Set(['/webhooks/max', '/webhooks/max-staff']);

export function useStrictJsonParser(app: FastifyInstance): void {
    app.removeContentTypeParser('application/json');

    app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
        if (RAW_BODY_ROUTES.has(request.url)) {
            done(null, body);

            return;
        }

        try {
            done(null, strictJson(String(body), false, MAX_JSON_BYTES));
        } catch {
            done(new AppError('invalid_json', 400, 'Некорректные данные запроса.'));
        }
    });
}
