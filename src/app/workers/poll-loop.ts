import type { DeliveryWorker } from '../../modules/delivery/index.js';
import type { Inbox } from '../../modules/inbox/index.js';
import type { Database } from '../../shared/db.js';

import type { JobRunner } from './job-runner.js';
import type { Queues } from './queues.js';
import { publishDueJobs } from './scheduler.js';

const MAINTENANCE_EVERY_POLLS = 20;

export interface PollDeps {
  db: Database;
  org: string;
  inbox: Inbox;
  deliveries: DeliveryWorker;
  runner: JobRunner;
  queues: Queues;
}

export async function pollOnce(deps: PollDeps, poll: number): Promise<void> {
  await sweep(deps, poll).catch(() => undefined);
}

async function sweep(deps: PollDeps, poll: number): Promise<void> {
  await processPendingInput(deps);
  await sendDueDeliveries(deps);
  if (poll % MAINTENANCE_EVERY_POLLS === 0) {
    await deps.runner.maintenance();
    await deps.deliveries.markStaleUnknown();
  }
  await publishDueJobs(deps.db, deps.org, deps.queues).catch(() => undefined);
}

async function processPendingInput({ db, org, inbox }: PollDeps): Promise<void> {
  const { rows: clients } = await db.query<{ client_id: string }>(
    `SELECT DISTINCT client_id FROM inbox
     WHERE org_id=$1 AND state='pending' AND client_id IS NOT NULL LIMIT 50`,
    [org],
  );
  for (const client of clients) {
    await inbox.processClient(client.client_id);
  }
}

async function sendDueDeliveries({ db, org, deliveries }: PollDeps): Promise<void> {
  const { rows: clients } = await db.query<{ client_id: string }>(
    `SELECT DISTINCT client_id FROM deliveries
     WHERE org_id=$1 AND state IN('queued','retry_wait') AND due_at<=now() LIMIT 20`,
    [org],
  );
  await Promise.allSettled(clients.map((client) => deliveries.deliver(client.client_id)));
}
