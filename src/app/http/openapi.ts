const error = {
  type: 'object',
  required: ['code', 'message', 'request_id', 'retryable'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    request_id: { type: 'string' },
    retryable: { type: 'boolean' },
  },
};
const parameters = [
  {
    in: 'header',
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', minLength: 8, maxLength: 128 },
  },
  { in: 'header', name: 'If-Match', required: true, schema: { type: 'string' } },
];
const paths: Record<string, unknown> = {};
for (const [path, method] of [
  ['/v1/auth/max', 'post'],
  ['/v1/me', 'get'],
  ['/v1/auth/refresh', 'post'],
  ['/v1/auth/logout', 'post'],
  ['/v1/tickets', 'get'],
  ['/v1/tickets/counts', 'get'],
  ['/v1/tickets/{id}', 'get'],
  ['/v1/tickets/{id}/messages', 'get'],
  ['/v1/tickets/{id}/assign', 'post'],
  ['/v1/tickets/{id}/transfer', 'post'],
  ['/v1/tickets/{id}/classification', 'patch'],
  ['/v1/tickets/{id}/messages', 'post'],
  ['/v1/tickets/{id}/close', 'post'],
  ['/v1/tickets/{id}/reopen', 'post'],
  ['/v1/uploads', 'post'],
  ['/v1/uploads/{id}/content', 'put'],
  ['/v1/uploads/{id}/complete', 'post'],
  ['/v1/uploads/{id}', 'delete'],
  ['/v1/attachments/{id}/download', 'get'],
  ['/v1/attachments/{id}/download-grant', 'post'],
  ['/v1/events', 'get'],
  ['/v1/dictionaries', 'get'],
  ['/v1/employees', 'get'],
  ['/v1/notifications', 'get'],
  ['/v1/admin/employees', 'get'],
  ['/v1/admin/employees', 'post'],
  ['/v1/admin/employees/{id}', 'patch'],
  ['/v1/admin/dictionaries', 'put'],
  ['/v1/admin/templates', 'get'],
  ['/v1/admin/templates/{code}', 'put'],
  ['/v1/admin/settings', 'get'],
  ['/v1/admin/settings', 'put'],
  ['/v1/admin/diagnostics', 'get'],
  ['/v1/admin/audit', 'get'],
]) {
  paths[path] = {
    ...(paths[path] as object | undefined),
    [method]: {
      summary: path.split('/').at(-1),
      security: path === '/v1/auth/max' ? [] : [{ bearerAuth: [] }],
      parameters: method === 'get' ? [] : parameters,
      responses: {
        '200': { description: 'Successful response' },
        '401': { description: 'Session invalid' },
        '409': {
          description: 'Version or state conflict',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
  };
}
export const openapi = {
  openapi: '3.1.0',
  info: { title: 'MAX Support API', version: '1.0.0' },
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: { Error: error },
  },
};
