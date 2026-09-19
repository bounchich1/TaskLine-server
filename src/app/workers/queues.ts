import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/** BullMQ queues by kind of work, so slow AI calls never hold up files or maintenance. */
export const QUEUE_NAMES = ['ai-execution', 'memory-io', 'file-processing', 'maintenance'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
export type Queues = Record<QueueName, Queue>;

/** Parallel jobs per worker process. Memory writes are serialized. */
export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
  'ai-execution': 4,
  'memory-io': 1,
  'file-processing': 2,
  maintenance: 2,
};

export function queueFor(kind: string): QueueName {
  if (['triage', 'learning'].includes(kind)) {
    return 'ai-execution';
  }
  if (['memory', 'memory_delete'].includes(kind)) {
    return 'memory-io';
  }
  return ['file', 'scan'].includes(kind) ? 'file-processing' : 'maintenance';
}

/**
 * Two connections: the producer fails fast (the database stays the source of truth), the
 * worker connection retries forever as BullMQ requires. Connection errors are not logged:
 * the poll loop simply republishes on the next sweep.
 */
export function createRedisConnections(url: string): { producer: Redis; consumer: Redis } {
  const producer = new Redis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 3000,
  });
  const consumer = new Redis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    connectTimeout: 3000,
  });
  producer.on('error', () => {
    /* Not logged: the poll loop retries publishing on its next sweep. */
  });
  consumer.on('error', () => {
    /* Not logged: BullMQ reconnects on its own. */
  });
  return { producer, consumer };
}

export function createQueues(connection: Redis): Queues {
  return Object.fromEntries(
    QUEUE_NAMES.map((name) => [name, new Queue(name, { connection })]),
  ) as Queues;
}
