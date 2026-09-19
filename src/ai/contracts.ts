import { readFileSync } from 'node:fs';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { ensure } from '../shared/errors.js';
import { strictJson } from '../shared/json.js';
import { serverFile } from '../shared/paths.js';
import type { Resolution, TriageResult } from '../shared/types/ai.js';
import type { Row } from '../shared/types/entities.js';
const ajv = new Ajv2020({ allErrors: true, strict: true });
export const triageSchema = JSON.parse(
  readFileSync(serverFile('contracts/triage-result.schema.json'), 'utf8'),
) as Row;
export const resolutionSchema = JSON.parse(
  readFileSync(serverFile('contracts/memorize-resolution.schema.json'), 'utf8'),
) as Row;
const validateTriage = ajv.compile(triageSchema as AnySchema);
const validateResolution = ajv.compile(resolutionSchema as AnySchema);
export function parseTriage(
  raw: string,
  dictionaryVersion: string,
  dictionaries: Row[],
  messageIds: string[],
  memoryIds: string[],
): TriageResult {
  const result = strictJson(raw);
  ensure(validateTriage(result), 'invalid_ai_schema', 422);
  const value = result as TriageResult;
  ensure(value.dictionary_version === dictionaryVersion, 'invalid_dictionary_version', 422);
  for (const field of ['tag', 'urgency', 'complexity'] as const) {
    ensure(
      dictionaries.some((d) => d.dimension === field && d.code === value.tags[field]),
      'unknown_ai_code',
      422,
    );
  }
  ensure(
    value.evidence_message_ids.every((id) => messageIds.includes(id)) &&
      value.evidence_memory_ids.every((id) => memoryIds.includes(id)),
    'forged_ai_evidence',
    422,
  );
  return value;
}
export function parseResolution(raw: string, evidenceIds: string[]): Resolution {
  const result = strictJson(raw);
  ensure(validateResolution(result), 'invalid_memory_schema', 422);
  const value = result as Resolution;
  ensure(
    [...value.evidence_message_ids, ...value.steps.flatMap((s) => s.evidence_message_ids)].every(
      (id) => evidenceIds.includes(id),
    ),
    'forged_memory_evidence',
    422,
  );
  if (value.outcome === 'resolved') {
    ensure(
      value.steps.length > 0 && !!value.observed_result && !!value.solution_summary,
      'unsupported_resolution',
      422,
    );
  }
  return value;
}
export function redact(text: string): string {
  return text
    .replace(/\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_.-]{20,})\b/g, '[СЕКРЕТ]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g, '[ТЕЛЕФОН]')
    .replace(/((?:пароль|password|token|api[_ -]?key|secret)\s*[:=]\s*)\S+/gi, '$1[СЕКРЕТ]');
}
