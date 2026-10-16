import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

import { DEFAULT_TEMPLATES } from './default-templates.js';

const PLACEHOLDERS = new Set(['ticket_number', 'policy_url', 'alternative_contact']);
const ETA_TEMPLATES = new Set(['ticket_created_eta', 'outside_hours']);

export function validateTemplate(body: string, code = ''): void {
    ensure(body.trim().length > 0 && body.length <= 3000, 'invalid_template', 422);

    for (const match of body.matchAll(/\{([^{}]+)\}/g)) {
        const name = match[1];

        ensure(PLACEHOLDERS.has(name) || (name === 'eta' && ETA_TEMPLATES.has(code)), 'invalid_placeholder', 422);
    }
}

export async function render(db: Sql, org: string, code: string, values: Record<string, string>): Promise<string> {
    const row = await one<{ body: string }>(db, 'SELECT body FROM templates WHERE org_id=$1 AND code=$2', [org, code]);
    const text = row?.body ?? DEFAULT_TEMPLATES[code] ?? '';
    const result = text.replace(/\{([^{}]+)\}/g, (_, key: string) => values[key] ?? '');

    ensure(result.length <= 4000, 'template_too_long', 422);

    return result;
}
