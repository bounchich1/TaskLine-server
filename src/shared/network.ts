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

    if (response.body) {
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
            size += chunk.byteLength;

            if (size > limit) {
                throw new Error('response_too_large');
            }

            chunks.push(chunk);
        }
    }

    return Buffer.concat(chunks).toString('utf8');
}

const NON_PUBLIC_IPV4: [number, number, number][] = [
    [0, 0, 255],
    [10, 0, 255],
    [127, 0, 255],
    [169, 254, 254],
    [172, 16, 31],
    [192, 168, 168],
    [100, 64, 127],
    [198, 18, 19],
];

const MULTICAST_IPV4_FROM = 224;
const NON_PUBLIC_IPV6 = /^(::|fc|fd|fe[89ab]|ff)/i;
const DOCUMENTATION_IPV6 = '2001:db8:';

export function publicAddress(address: string): boolean {
    const version = isIP(address);

    if (version === 4) {
        const [first, second] = address.split('.').map(Number);

        return (
            first < MULTICAST_IPV4_FROM &&
            !NON_PUBLIC_IPV4.some(([octet, from, to]) => first === octet && second >= from && second <= to)
        );
    }

    if (version === 6) {
        return !NON_PUBLIC_IPV6.test(address) && !address.toLowerCase().startsWith(DOCUMENTATION_IPV6);
    }

    return false;
}

export async function mediaFetch(
    raw: string,
    allowedHosts: string[],
    init: RequestInit = {},
    ca?: string[],
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

    ensure(addresses.length && addresses.every((entry) => publicAddress(entry.address)), 'media_address_denied', 422);
    const selected = addresses[0];

    const dispatcher = new Agent({
        connect: {
            lookup: ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
                if ((options as { all?: boolean }).all) {
                    callback(null, [selected]);
                } else {
                    callback(null, selected.address, selected.family);
                }
            }) as never,
            ca,
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
