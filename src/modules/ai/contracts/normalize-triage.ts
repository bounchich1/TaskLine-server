import type { Row } from '../../../shared/types/entities.js';

const MAX_STEPS = 5;
const MAX_CAUTIONS = 3;
const MAX_MISSING = 4;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMPTY_BRACKETS = /[[(]\s*[\])]/g;

function isRow(value: unknown): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function uniqueHead(value: unknown, limit: number): unknown {
  return Array.isArray(value) ? [...new Set(value)].slice(0, limit) : value;
}

function normalizeStep(step: unknown, cited: string[]): unknown {
  if (!isRow(step) || !Array.isArray(step.case_refs)) {
    return step;
  }

  return { ...step, case_refs: [...new Set(strings(step.case_refs))].filter((ref) => cited.includes(ref)) };
}

function normalizeTip(tip: unknown, cited: string[]): unknown {
  if (!isRow(tip)) {
    return tip;
  }

  const steps = Array.isArray(tip.steps)
    ? tip.steps.slice(0, MAX_STEPS).map((step) => normalizeStep(step, cited))
    : tip.steps;

  return { ...tip, steps, cautions: uniqueHead(tip.cautions, MAX_CAUTIONS) };
}

function scrubReply(reply: unknown, ids: string[]): unknown {
  if (typeof reply !== 'string') {
    return reply;
  }

  const scrubbed = ids
    .reduce((text, id) => text.split(id).join(''), reply.replace(UUID, ''))
    .replace(EMPTY_BRACKETS, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,!?;:])/g, '$1')
    .trim();

  return scrubbed || null;
}

export function normalizeTriage(value: unknown, memoryIds: string[]): unknown {
  if (!isRow(value)) {
    return value;
  }

  const cited = strings(value.evidence_memory_ids);

  return {
    ...value,
    tip: normalizeTip(value.tip, cited),
    customer_reply: scrubReply(value.customer_reply, [...new Set([...memoryIds, ...cited])]),
    missing_information: uniqueHead(value.missing_information, MAX_MISSING),
  };
}
