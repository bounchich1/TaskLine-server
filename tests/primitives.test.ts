import { createHmac } from 'node:crypto';

import { describe, it, expect } from 'vitest';

import { normalizeUpdate } from '../src/integrations/max/index.js';
import { planChunks, confirmedResolution } from '../src/modules/ai/index.js';
import { parseRating } from '../src/modules/ratings/index.js';
import { verifyLaunch } from '../src/modules/staff/index.js';
import { readConfig } from '../src/shared/config.js';
import { strictJson } from '../src/shared/json.js';
import { publicAddress } from '../src/shared/network.js';
import type { Resolution, SnapshotEntry } from '../src/shared/types/ai.js';

import { testConfig } from './helpers.js';
describe('rating grammar', () => {
  for (const [text, n] of [
    ['1', 1],
    ['10', 10],
    ['оценка 10, спасибо', 10],
    [' 7 ', 7],
    ['👍 9!', 9],
  ] as const) {
    it(`accepts ${text}`, () => expect(parseRating(text)).toBe(n));
  }
  for (const text of [
    '',
    '0',
    '11',
    '01',
    '1,5',
    '1.0',
    '+7',
    '-7',
    '−7',
    '1e1',
    '7/10',
    '2026-09-18',
    '7 и 8',
    'abc7',
    '7abc',
    '７',
    '٧',
    '7-8',
    '1 / 2',
    '1 . 0',
    'номер7',
    '7_',
    '10, 8',
  ]) {
    it(`rejects ${text}`, () => expect(parseRating(text)).toBeNull());
  }
});
describe('strict JSON and MAX identifiers', () => {
  it('rejects duplicate object keys and trailing content', () => {
    expect(() => strictJson('{"a":1,"a":2}')).toThrow('duplicate');
    expect(() => strictJson('{}text')).toThrow();
    expect(() => strictJson('{"n":1e999}')).toThrow();
  });
  it('preserves int64 IDs', () =>
    expect((strictJson('{"id":9223372036854775807}', true) as { id: string }).id).toBe(
      '9223372036854775807',
    ));
  it('does not create tickets for groups or bot echoes', () => {
    const raw = JSON.stringify({
      update_type: 'message_created',
      message: {
        sender: { user_id: 5, is_bot: true },
        recipient: { chat_type: 'dialog', chat_id: 4 },
        body: { mid: 'm', text: 'hello' },
      },
    });
    expect(normalizeUpdate(raw).kind).toBe('unknown');
  });
  it('normalizes lossless direct messages', () => {
    const raw =
      '{"update_type":"message_created","message":{"sender":{"user_id":9223372036854775807},"recipient":{"chat_id":9223372036854775806,"chat_type":"dialog"},"body":{"mid":"a","text":"test"}}}';
    expect(normalizeUpdate(raw).userId).toBe('9223372036854775807');
  });
});
function sign(fields: Record<string, string>, token = 'bot-token') {
  const canonical = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  return new URLSearchParams({
    ...fields,
    hash: createHmac('sha256', key).update(canonical).digest('hex'),
  }).toString();
}
describe('MAX launch authentication', () => {
  const now = 1800000000000;
  const fields = {
    auth_date: String(now / 1000),
    user: '{"id":9223372036854775807,"first_name":"Иван + = %"}',
    extra: 'signed\nUnicode Ω',
  };
  it('verifies raw, outer-wrapped and reordered fields', () => {
    const raw = sign(fields);
    expect(verifyLaunch(raw, 'bot-token', now).userId).toBe('9223372036854775807');
    expect(
      verifyLaunch(`WebAppData=${encodeURIComponent(raw)}&WebAppPlatform=web`, 'bot-token', now)
        .userId,
    ).toBe('9223372036854775807');
  });
  it('rejects tampered, expired, future and duplicate fields', () => {
    const raw = sign(fields);
    expect(() => verifyLaunch(raw.replace('signed', 'evil'), 'bot-token', now)).toThrow();
    expect(() => verifyLaunch(raw, 'bot-token', now + 301000)).toThrow();
    expect(() => verifyLaunch(raw, 'bot-token', now - 31000)).toThrow();
    expect(() => verifyLaunch(`${raw}&hash=aa`, 'bot-token', now)).toThrow();
    expect(() => verifyLaunch(`${raw}&user=foo`, 'bot-token', now)).toThrow();
  });
});
describe('security and coverage', () => {
  it('blocks non-public media addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      '198.18.0.1',
    ]) {
      expect(publicAddress(ip)).toBe(false);
    }
    expect(publicAddress('8.8.8.8')).toBe(true);
  });
  it('enforces global concurrency bounds and production modes', () => {
    const c = testConfig();
    expect(() => readConfig({ ...process.env, AI_MAX_CONCURRENCY: '16' })).toThrow();
    expect(c.AI_MAX_CONCURRENCY).toBe(12);
    expect(() => readConfig({ ...process.env, NODE_ENV: 'production' })).toThrow();
  });
  it('covers every part of long messages without truncation', () => {
    const entries: Array<SnapshotEntry> = Array.from({ length: 7 }, (_, i) => ({
      id: `m${i}`,
      seq: i,
      role: 'client',
      text: 'слово '.repeat(i ? 500 : 10000),
      delivery: 'received',
      revision: 1,
      attachments: [],
      revisions: [],
    }));
    const chunks = planChunks(entries, 4000);
    const parts = chunks.flat();
    for (const entry of entries) {
      const data = parts
        .filter((p) => p.id === entry.id)
        .sort((a, b) => a.part - b.part)
        .map((p) => p.data)
        .join('');
      expect(JSON.parse(data)).toEqual(entry);
    }
    expect(chunks.length).toBeGreaterThan(10);
  });
  it('does not infer success from closure or undelivered advice', () => {
    const resolution = {
      outcome: 'resolved',
      steps: [{ action: 'restart', evidence_message_ids: ['s'] }],
      evidence_message_ids: ['s', 'c'],
    } as Resolution;
    const entries = [
      { id: 's', role: 'staff', delivery: 'unknown', seq: 1, text: 'restart' },
      {
        id: 'c',
        role: 'client',
        delivery: 'received',
        seq: 2,
        text: 'Спасибо, теперь всё работает',
      },
    ] as SnapshotEntry[];
    expect(confirmedResolution(resolution, entries)).toBe(false);
    entries[0].delivery = 'delivered';
    expect(confirmedResolution(resolution, entries)).toBe(true);
    entries[1].text = 'Всё ещё не работает';
    expect(confirmedResolution(resolution, entries)).toBe(false);
  });
});
