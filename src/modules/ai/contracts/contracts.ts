import { readFileSync } from 'node:fs';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { ensure } from '../../../shared/errors.js';
import { strictJson } from '../../../shared/json.js';
import { serverFile } from '../../../shared/paths.js';
import type { Resolution, TriageResult } from '../../../shared/types/ai.js';
import type { Row } from '../../../shared/types/entities.js';

// JSON contracts for model output (contracts/*.schema.json). Schema validation is followed by
// checks the schema cannot express: known dictionary codes and evidence that was actually
// supplied to the model.

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
  /** Messages the model was shown; evidence must cite only these. */
  messageIds: string[];
  /** Resolved cases the model retrieved during this triage. */
  memoryIds: string[];
}

export function parseTriage(raw: string, expected: TriageExpectations): TriageResult {
  const result = strictJson(raw);
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
  return value;
}

/** A resolved outcome must name the steps taken, the observed result and the solution. */
export function parseResolution(raw: string, evidenceIds: string[]): Resolution {
  const result = strictJson(raw);
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
