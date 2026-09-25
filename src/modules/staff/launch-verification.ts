import { createHmac } from 'node:crypto';

import { equal, hash } from '../../shared/crypto.js';
import { ensure } from '../../shared/errors.js';
import { decimalId, object, strictJson } from '../../shared/json.js';

const MAX_LAUNCH_BYTES = 16384;
const MAX_LAUNCH_AGE_MS = 300_000;
const MAX_CLOCK_SKEW_MS = 30_000;

export interface VerifiedLaunch {
    userId: string;
    digest: string;
    startParam?: string;
}

export function verifyLaunch(raw: string, botToken: string, now = Date.now()): VerifiedLaunch {
    ensure(Buffer.byteLength(raw) <= MAX_LAUNCH_BYTES && raw.length > 0 && botToken.length > 0, 'invalid_launch', 401);
    let values = parseForm(raw.startsWith('#') ? raw.slice(1) : raw);
    const wrapped = values.get('WebAppData');

    if (wrapped !== undefined) {
        values = parseForm(wrapped);
    }

    const signature = values.get('hash') ?? '';

    ensure(/^[a-fA-F0-9]{64}$/.test(signature), 'invalid_launch', 401);
    values.delete('hash');

    const canonical = [...values.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = createHmac('sha256', secret).update(canonical).digest('hex');

    ensure(equal(expected, signature.toLowerCase()), 'invalid_launch', 401);
    const dateText = values.get('auth_date') ?? '';

    ensure(/^\d{10,11}$/.test(dateText), 'invalid_launch', 401);
    const date = Number(dateText) * 1000;

    ensure(
        now - date <= MAX_LAUNCH_AGE_MS && date - now <= MAX_CLOCK_SKEW_MS,
        'expired_launch',
        401,
        'Запуск устарел. Откройте приложение заново из MAX.',
    );

    const user = object(strictJson(values.get('user') ?? '', true));

    return {
        userId: decimalId(user.id),
        digest: hash(canonical),
        startParam: values.get('start_param'),
    };
}

function parseForm(raw: string): Map<string, string> {
    const result = new Map<string, string>();

    for (const part of raw.split('&')) {
        const index = part.indexOf('=');

        ensure(index >= 0, 'invalid_launch', 401);
        const [key, value] = decodePair(part.slice(0, index), part.slice(index + 1));

        ensure(!result.has(key), 'invalid_launch', 401);
        result.set(key, value);
    }

    return result;
}

function decodePair(rawKey: string, rawValue: string): [string, string] {
    try {
        return [decodeURIComponent(rawKey.replaceAll('+', ' ')), decodeURIComponent(rawValue.replaceAll('+', ' '))];
    } catch {
        throw new Error('invalid_percent_encoding');
    }
}

function compareStrings(left: string, right: string): number {
    if (left < right) {
        return -1;
    }

    return left > right ? 1 : 0;
}
