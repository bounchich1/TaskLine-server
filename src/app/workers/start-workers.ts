import { Worker } from 'bullmq';

import { MaxClient } from '../../integrations/max/index.js';
import { DeliveryWorker } from '../../modules/delivery/index.js';
import { Inbox } from '../../modules/inbox/index.js';
import type { Config } from '../../shared/config.js';
import type { Database } from '../../shared/db.js';

import { JobRunner } from './job-runner.js';
import { pollOnce } from './poll-loop.js';
import { createQueues, createRedisConnections, QUEUE_CONCURRENCY, QUEUE_NAMES } from './queues.js';

const POLL_INTERVAL_MS = 250;
const LOCK_DURATION_MS = 180000;

export function startWorkers(db: Database, config: Config): () => Promise<void> {
  const { producer, consumer } = createRedisConnections(config.REDIS_URL);
  const queues = createQueues(producer);
  const runner = new JobRunner(db, config);
  const deliveries: DeliveryWorker = new DeliveryWorker(
    db,
    config,
    new MaxClient(config, async (): Promise<void> => deliveries.rate()),
    runner.files,
  );
  const workers = QUEUE_NAMES.map((name) => {
    const worker = new Worker<{ id: string }>(name, async (job) => runner.run(job.data.id), {
      connection: consumer,
      concurrency: QUEUE_CONCURRENCY[name],
      lockDuration: LOCK_DURATION_MS,
    });
    worker.on('error', () => undefined);
    return worker;
  });
  const deps = { db, org: config.ORG_ID, inbox: new Inbox(db, config), deliveries, runner, queues };
  const stop = new AbortController();
  const loop = (async () => {
    for (let poll = 0; !stop.signal.aborted; poll++) {
      await pollOnce(deps, poll);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  })();
  return async () => {
    stop.abort();
    await loop;
    await Promise.all(workers.map(async (worker) => worker.close()));
    await Promise.all(Object.values(queues).map(async (queue) => queue.close()));
    await producer.quit();
    await consumer.quit();
  };
}
