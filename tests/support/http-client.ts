import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';

export type StaffHeaders = (extra?: Record<string, string>) => Record<string, string>;

export async function staffLogin(
    app: FastifyInstance,
    origin: string,
    userId: string,
): Promise<{ headers: StaffHeaders; token: string }> {
    const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev',
        headers: { origin },
        payload: { user_id: userId },
    });

    expect(response.statusCode).toBe(200);
    const { token, csrf } = response.json<{ token: string; csrf: string }>();

    const headers: StaffHeaders = (extra = {}) => ({
        origin,
        authorization: `Bearer ${token}`,
        'x-csrf-token': csrf,
        'idempotency-key': randomUUID(),
        ...extra,
    });

    return { headers, token };
}

export async function uploadNote(app: FastifyInstance, headers: StaffHeaders, ticketId: string): Promise<string> {
    const prepared = await app.inject({
        method: 'POST',
        url: '/v1/uploads',
        headers: headers(),
        payload: { ticket_id: ticketId, filename: 'note.txt', kind: 'file' },
    });

    const { id } = prepared.json<{ id: string }>();
    const boundary = `----test${randomUUID()}`;

    const received = await app.inject({
        method: 'PUT',
        url: `/v1/uploads/${id}/content`,
        headers: headers({ 'content-type': `multipart/form-data; boundary=${boundary}` }),
        payload:
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\n` +
            `Content-Type: text/plain\r\n\r\nhello world\r\n--${boundary}--\r\n`,
    });

    expect(received.statusCode).toBe(200);

    return id;
}
