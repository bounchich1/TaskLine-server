import { z } from 'zod';

import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

export const templateBody = z.object({ body: z.string().max(3000) }).strict();

export const settingsBody = z
  .object({ name: z.string().min(1).max(120), timezone: z.string().min(1).max(80) })
  .strict();

export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('ru', { timeZone: timezone });
  } catch {
    ensure(false, 'invalid_timezone', 422);
  }
}

export async function updateTemplate(
  tx: Sql,
  org: string,
  { code, body, expectedVersion }: { code: string; body: string; expectedVersion: number },
) {
  const row = await one(
    tx,
    'UPDATE templates SET body=$3,version=version+1 WHERE org_id=$1 AND code=$2 AND version=$4 RETURNING *',
    [org, code, body, expectedVersion],
  );
  ensure(row, 'version_conflict');
  return row;
}

export async function updateSettings(
  tx: Sql,
  org: string,
  {
    settings,
    expectedVersion,
  }: { settings: z.infer<typeof settingsBody>; expectedVersion: number },
) {
  const row = await one(
    tx,
    `UPDATE organizations SET name=$2,timezone=$3,version=version+1
     WHERE id=$1 AND version=$4 RETURNING name,timezone,version`,
    [org, settings.name, settings.timezone, expectedVersion],
  );
  ensure(row, 'version_conflict');
  return row;
}
