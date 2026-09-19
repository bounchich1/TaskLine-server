import { DEFAULT_TEMPLATES } from './default-templates.js';
import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

const PLACEHOLDERS = new Set(['ticket_number', 'policy_url', 'alternative_contact']);

export function validateTemplate(body: string): void {
  ensure(body.trim().length > 0 && body.length <= 3000, 'invalid_template', 422);
  for (const match of body.matchAll(/\{([^{}]+)\}/g)) {
    ensure(PLACEHOLDERS.has(match[1]), 'invalid_placeholder', 422);
  }
}

/** Renders a bot message: the organization's override if any, else the built-in text. */
export async function render(
  db: Sql,
  org: string,
  code: string,
  values: Record<string, string>,
): Promise<string> {
  const row = await one<{ body: string }>(
    db,
    'SELECT body FROM templates WHERE org_id=$1 AND code=$2',
    [org, code],
  );
  const text = row?.body ?? DEFAULT_TEMPLATES[code] ?? '';
  const result = text.replace(/\{([^{}]+)\}/g, (_, key: string) => values[key] ?? '');
  ensure(result.length <= 4000, 'template_too_long', 422);
  return result;
}
