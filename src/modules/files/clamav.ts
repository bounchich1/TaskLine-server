import { createReadStream } from 'node:fs';
import { Socket } from 'node:net';

const SCAN_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_LENGTH = 4096;
const CHUNK_SIZE = 64 * 1024;

/** Scans a file with clamd's INSTREAM command. Resolves true when clean, false when infected. */
export async function clamScan(path: string, host: string, port: number): Promise<boolean> {
  const socket = new Socket();
  const verdict = readVerdict(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(port, host, resolve);
    });
    socket.write('zINSTREAM\0');
    for await (const chunk of createReadStream(path, { highWaterMark: CHUNK_SIZE })) {
      await writeChunk(socket, chunk as Buffer);
    }
    socket.write(Buffer.alloc(4));
    return await verdict;
  } finally {
    socket.destroy();
    void verdict.catch(() => undefined);
  }
}

function readVerdict(socket: Socket): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let response = '';
    socket.setTimeout(SCAN_TIMEOUT_MS, () => socket.destroy(new Error('scanner_timeout')));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      response += chunk.toString();
      if (response.length > MAX_RESPONSE_LENGTH) {
        socket.destroy(new Error('scanner_invalid_response'));
      }
    });
    socket.on('end', () => {
      if (response.includes('stream: OK')) {
        resolve(true);
      } else if (response.includes('FOUND')) {
        resolve(false);
      } else {
        reject(new Error('scanner_unavailable'));
      }
    });
  });
}

/** INSTREAM framing: 4-byte big-endian length, then the bytes; waits for drain when needed. */
async function writeChunk(socket: Socket, bytes: Buffer): Promise<void> {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  socket.write(size);
  if (!socket.write(bytes)) {
    await new Promise<void>((resolve) => socket.once('drain', resolve));
  }
}
