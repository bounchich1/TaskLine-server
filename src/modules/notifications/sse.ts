import type { ServerResponse } from 'node:http';

// Server-sent event frames written by the UI event stream. Byte-exact: the mini-app's
// EventSource handlers rely on these event names and on `data` being one line of JSON.

export const READY_FRAME = 'event: ready\ndata: {}\n\n';
export const RESYNC_FRAME = 'event: resync\ndata: {}\n\n';
export const SESSION_EXPIRED_FRAME = 'event: session_expired\ndata: {}\n\n';
/** A comment line: keeps proxies from closing an idle connection. */
export const HEARTBEAT_FRAME = ': heartbeat\n\n';

export function changeFrame(event: { cursor: string }): string {
  return `id: ${event.cursor}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Starts the SSE response, bypassing Fastify (the route has hijacked the reply). */
export function writeEventStreamHead(raw: ServerResponse, corsOrigin: string | undefined): void {
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(corsOrigin
      ? { 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Credentials': 'true' }
      : {}),
  });
}
