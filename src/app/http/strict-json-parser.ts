import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { strictJson } from '../../shared/json.js';

const MAX_JSON_BYTES = 1024 * 1024;
/** Its body is parsed by the MAX normalizer, which keeps malformed updates for auditing. */
const RAW_BODY_ROUTE = '/webhooks/max';

/**
 * Replaces Fastify's JSON parser with the strict one (duplicate keys rejected, bounded size and
 * depth), except for the MAX webhook, which receives the raw string.
 */
export function useStrictJsonParser(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (request.url === RAW_BODY_ROUTE) {
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
