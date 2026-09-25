import { requireOne, type Database } from '../../shared/db.js';
import type { Job } from '../../shared/types/entities.js';

import { queueFor, type Queues } from './queues.js';

const TRIAGE_BATCH = 4;
const LEARNING_MAX_WAIT_MS = 600000;
const OTHER_JOBS_PER_SWEEP = 40;

export async function publishDueJobs(db: Database, org: string, queues: Queues): Promise<void> {
  const cap = Number((await requireOne(db, 'SELECT cap FROM ai_settings WHERE id=1')).cap);
  const aiQueue = queues['ai-execution'];
  if ((await aiQueue.getGlobalConcurrency()) !== cap) {
    await aiQueue.setGlobalConcurrency(cap);
  }
  const { rows: due } = await db.query<Job>(
    `SELECT * FROM jobs WHERE org_id=$1 AND state='pending' AND due_at<=now()
     ORDER BY created_at LIMIT 200`,
    [org],
  );
  for (const job of selectDueJobs(due, cap)) {
    await queues[queueFor(job.kind)].add(
      job.kind,
      { id: job.id },
      { jobId: job.id, removeOnComplete: true, removeOnFail: true },
    );
    await db.query('UPDATE jobs SET published_at=now() WHERE id=$1', [job.id]);
  }
}

export function selectDueJobs(due: Job[], cap: number, clock: () => number = Date.now): Job[] {
  const triage = due.filter((job) => job.kind === 'triage');
  const learning = due.filter((job) => job.kind === 'learning');
  const chosen: Job[] = [];
  while (chosen.length < 2 * cap && (triage.length || learning.length)) {
    const oldest = learning.at(0);
    if (oldest && clock() - new Date(oldest.created_at).getTime() > LEARNING_MAX_WAIT_MS) {
      moveFirst(learning, chosen);
    }
    chosen.push(...triage.splice(0, TRIAGE_BATCH));
    moveFirst(learning, chosen);
  }
  const others = due.filter((job) => !['triage', 'learning'].includes(job.kind));
  chosen.push(...others.slice(0, OTHER_JOBS_PER_SWEEP));
  return chosen;
}

function moveFirst(from: Job[], to: Job[]): void {
  const job = from.shift();
  if (job) {
    to.push(job);
  }
}
