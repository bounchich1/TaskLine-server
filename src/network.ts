import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch, type RequestInit, type Response } from 'undici';
import { ensure } from './errors.js';

export async function boundedText(response: Response, limit = 1024 * 1024): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) {
    await response.body?.cancel();
    throw new Error('response_too_large');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) {
      throw new Error('response_too_large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) === 6)
    return (
      !/^(::|fc|fd|fe[89ab]|ff)/i.test(address) && !address.toLowerCase().startsWith('2001:db8:')
    );
  return false;
}
/** Media requests have no credentials, no redirects and a DNS-pinned public destination. */
export async function mediaFetch(
  raw: string,
  allowedHosts: string[],
  init: RequestInit = {},
): Promise<{ response: Response; close: () => Promise<void> }> {
  const url = new URL(raw);
  ensure(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      allowedHosts.includes(url.hostname),
    'media_host_denied',
    422,
  );
  const addresses = await lookup(url.hostname, { all: true });
  ensure(
    addresses.length && addresses.every((a) => publicAddress(a.address)),
    'media_address_denied',
    422,
  );
  const selected = addresses[0];
  const dispatcher = new Agent({
    connect: {
      lookup: ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
        if ((options as { all?: boolean }).all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      }) as never,
    },
  });
  try {
    const response = await fetch(url, {
      ...init,
      dispatcher,
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    });
    return { response, close: () => dispatcher.close() };
  } catch (error) {
    await dispatcher.close();
    throw error;
  }
}
