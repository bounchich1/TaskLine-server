import { readFileSync } from 'node:fs';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { ensure } from '../../../shared/errors.js';
import { strictJson } from '../../../shared/json.js';
import { serverFile } from '../../../shared/paths.js';
import type { Resolution, TriageResult } from '../../../shared/types/ai.js';
import type { Row } from '../../../shared/types/entities.js';

import { normalizeTriage } from './normalize-triage.js';


const ajv = new Ajv2020({ allErrors: true, strict: true });

function loadSchema(path: string): Row {
  return JSON.parse(readFileSync(serverFile(path), 'utf8')) as Row;
}

export const triageSchema = loadSchema('contracts/triage-result.schema.json');
export const resolutionSchema = loadSchema('contracts/memorize-resolution.schema.json');
const validateTriage = ajv.compile(triageSchema as AnySchema);
const validateResolution = ajv.compile(resolutionSchema as AnySchema);

export interface TriageExpectations {
  dictionaryVersion: string;
  dictionaries: Row[];
  messageIds: string[];
  memoryIds: string[];
  cautionedMemoryIds: string[];
}

function unwrapEnvelope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const fields = Object.values(value);

  if (fields.length !== 1) {
    return value;
  }

  return typeof fields[0] === 'string' ? strictJson(fields[0]) : fields[0];
}

function parseModelJson(raw: string): unknown {
  return unwrapEnvelope(strictJson(raw));
}

export function parseTriage(raw: string, expected: TriageExpectations): TriageResult {
  const result = normalizeTriage(parseModelJson(raw), expected.memoryIds);

  ensure(validateTriage(result), 'invalid_ai_schema', 422);
  const value = result as TriageResult;

  ensure(
    value.dictionary_version === expected.dictionaryVersion,
    'invalid_dictionary_version',
    422,
  );

  for (const field of ['tag', 'urgency', 'complexity'] as const) {
    ensure(
      expected.dictionaries.some(
        (entry) => entry.dimension === field && entry.code === value.tags[field],
      ),
      'unknown_ai_code',
      422,
    );
  }

  ensure(
    value.evidence_message_ids.every((id) => expected.messageIds.includes(id)) &&
      value.evidence_memory_ids.every((id) => expected.memoryIds.includes(id)),
    'forged_ai_evidence',
    422,
  );

  return flagDroppedCautions(value, expected.cautionedMemoryIds);
}

function flagDroppedCautions(value: TriageResult, cautioned: string[]): TriageResult {
  const dropped =
    value.tip !== null &&
    value.tip.cautions.length === 0 &&
    value.evidence_memory_ids.some((id) => cautioned.includes(id));

  return dropped ? { ...value, needs_review: true } : value;
}

export function parseResolution(raw: string, evidenceIds: string[]): Resolution {
  const result = parseModelJson(raw);

  ensure(validateResolution(result), 'invalid_memory_schema', 422);
  const value = result as Resolution;

  const cited = [
    ...value.evidence_message_ids,
    ...value.steps.flatMap((step) => step.evidence_message_ids),
  ];

  ensure(
    cited.every((id) => evidenceIds.includes(id)),
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
