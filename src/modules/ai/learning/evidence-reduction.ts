import { z } from 'zod';

import { hash } from '../../../shared/crypto.js';
import { ensure } from '../../../shared/errors.js';
import { strictJson } from '../../../shared/json.js';
import type { SnapshotEntry } from '../../../shared/types/ai.js';
import type { Job } from '../../../shared/types/entities.js';
import type { Model } from '../gateway/model.js';
import { LEARNING_SKILL } from '../skills.js';

import type { CheckpointStore } from './checkpoints.js';
import type { Part } from './chunks.js';

const MAX_REDUCTION_ROUNDS = 20;
const SUMMARY_INSTRUCTIONS =
  '\nThis is a coverage-preserving extraction step, not final memorization. Return JSON ' +
  '{summary: string (max 2000 characters), evidence_message_ids: string[]}. Preserve attempts, ' +
  'results, contradictions and delivery status. Only reference supplied IDs. Do not claim ' +
  'successful resolution without evidence.';

const summarySchema = z
  .object({
    summary: z.string().min(1).max(2000),
    evidence_message_ids: z.array(z.string()).max(20000),
  })
  .strict();
type Summary = z.infer<typeof summarySchema>;

export interface LearningStep {
  model: Model;
  job: Job;
  checkpoints: CheckpointStore;
}

/** Either the evidence for memorization, or "one model step done, yield and resume". */
export type EvidenceProgress = { ready: true; evidence: unknown } | { ready: false };

/**
 * A conversation too long for one prompt is summarized chunk by chunk, then the summaries are
 * merged pairwise until they fit. One model call per invocation; progress lives in checkpoints
 * keyed `chunk-<i>` and `reduce-<round>-<i>`.
 */
export async function gatherEvidence(
  step: LearningStep,
  { entries, chunks, limit }: { entries: SnapshotEntry[]; chunks: Part[][]; limit: number },
): Promise<EvidenceProgress> {
  if (JSON.stringify(entries).length <= limit) {
    return { ready: true, evidence: entries };
  }
  const summaries = await summarizeChunks(step, chunks);
  const reduced = summaries && (await reduceSummaries(step, summaries, limit));
  return reduced ? { ready: true, evidence: reduced } : { ready: false };
}

async function summarizeChunks(
  step: LearningStep,
  chunks: Part[][],
): Promise<Summary[] | undefined> {
  const summaries: Summary[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const key = `chunk-${i}`;
    const prior = await step.checkpoints.get(key);
    if (!prior) {
      await summarize(step, { key, input: chunk, ids: chunk.map((part) => part.id) });
      return undefined;
    }
    summaries.push(summarySchema.parse(prior));
  }
  return summaries;
}

async function reduceSummaries(
  step: LearningStep,
  initial: Summary[],
  limit: number,
): Promise<Summary[] | undefined> {
  let summaries = initial;
  let round = 0;
  while (JSON.stringify(summaries).length > limit) {
    const next = await reduceRound(step, summaries, round);
    if (!next) {
      return undefined;
    }
    summaries = next;
    round++;
    ensure(round < MAX_REDUCTION_ROUNDS, 'learning_reduction_budget');
  }
  return summaries;
}

async function reduceRound(
  step: LearningStep,
  summaries: Summary[],
  round: number,
): Promise<Summary[] | undefined> {
  const next: Summary[] = [];
  for (let i = 0; i < summaries.length; i += 2) {
    const group = summaries.slice(i, i + 2);
    const key = `reduce-${round}-${i / 2}`;
    const prior = await step.checkpoints.get(key);
    if (!prior) {
      const ids = group.flatMap((summary) => summary.evidence_message_ids);
      await summarize(step, { key, input: group, ids });
      return undefined;
    }
    next.push(summarySchema.parse(prior));
  }
  return next;
}

async function summarize(
  { model, job, checkpoints }: LearningStep,
  { key, input, ids }: { key: string; input: unknown; ids: string[] },
): Promise<void> {
  const unique = [...new Set(ids)];
  const mock = {
    summary: 'Недостаточно данных для подтверждённого решения.',
    evidence_message_ids: unique,
  };
  const response = await model.complete(job, key, {
    messages: [
      { role: 'system', content: `${LEARNING_SKILL}${SUMMARY_INSTRUCTIONS}` },
      { role: 'user', content: JSON.stringify(input) },
    ],
    json: true,
    mock,
  });
  const output = summarySchema.parse(strictJson(response.content ?? ''));
  ensure(
    output.evidence_message_ids.every((id) => unique.includes(id)),
    'forged_chunk_evidence',
    422,
  );
  // Coverage comes from the assigned input, never from the model's choice of cited messages.
  await checkpoints.save(key, {
    value: output,
    coveredIds: unique,
    inputHash: hash(JSON.stringify(input)),
  });
}
