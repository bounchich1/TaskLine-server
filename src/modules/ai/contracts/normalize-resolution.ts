import type { Row } from '../../../shared/types/entities.js';

const OUTCOMES = new Set(['resolved', 'unresolved', 'insufficient_evidence']);
const MAX_STEPS = 30;
const MAX_STEP_EVIDENCE = 20;

const TEXT_LISTS = {
  evidence_message_ids: 200,
  applicability: 20,
  cautions: 20,
  uncertainties: 20,
};

function isRow(value: unknown): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textList(value: unknown, limit: number): unknown {
  if (value === undefined || value === null) {
    return [];
  }

  const items = typeof value === 'string' ? [value] : value;

  if (!Array.isArray(items)) {
    return items;
  }

  const trimmed = items
    .map((item: unknown) => (typeof item === 'string' ? item.trim() : item))
    .filter((item) => item !== '');

  return [...new Set(trimmed)].slice(0, limit);
}

function nullableText(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }

  return typeof value === 'string' && value.trim() === '' ? null : value;
}

function normalizeStep(step: unknown): unknown {
  if (!isRow(step)) {
    return step;
  }

  const action = step.action ?? step.description ?? step.text;

  return {
    action: typeof action === 'string' ? action.trim() : action,
    evidence_message_ids: textList(step.evidence_message_ids, MAX_STEP_EVIDENCE),
  };
}

function normalizeOutcome(value: Row): unknown {
  if (typeof value.outcome === 'string') {
    return value.outcome.trim().toLowerCase();
  }

  const supported =
    typeof value.solution_summary === 'string' &&
    typeof value.observed_result === 'string' &&
    Array.isArray(value.steps) &&
    value.steps.length > 0;

  return value.outcome ?? (supported ? 'resolved' : 'insufficient_evidence');
}

export function normalizeResolution(value: unknown): unknown {
  if (!isRow(value)) {
    return value;
  }

  const steps = Array.isArray(value.steps) ? value.steps.slice(0, MAX_STEPS).map(normalizeStep) : (value.steps ?? []);
  const draft: Row = { ...value, steps, solution_summary: nullableText(value.solution_summary) };
  const outcome = normalizeOutcome(draft);
  const lists = Object.entries(TEXT_LISTS).map(([field, limit]) => [field, textList(value[field], limit)]);

  return {
    schema_version: value.schema_version ?? '1.0',
    problem_summary: value.problem_summary,
    solution_summary: OUTCOMES.has(String(outcome)) && outcome !== 'resolved' ? null : draft.solution_summary,
    outcome,
    steps,
    observed_result: nullableText(value.observed_result),
    ...Object.fromEntries(lists),
  };
}
