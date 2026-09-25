import type { ServerResponse } from 'node:http';

export const READY_FRAME = 'event: ready\ndata: {}\n\n';
export const RESYNC_FRAME = 'event: resync\ndata: {}\n\n';
export const SESSION_EXPIRED_FRAME = 'event: session_expired\ndata: {}\n\n';
export const HEARTBEAT_FRAME = ': heartbeat\n\n';

export function changeFrame(event: { cursor: string }): string {
  return `id: ${event.cursor}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`;
}

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
