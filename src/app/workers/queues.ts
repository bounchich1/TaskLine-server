import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const QUEUE_NAMES = ['ai-execution', 'memory-io', 'file-processing', 'maintenance'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
export type Queues = Record<QueueName, Queue>;

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

    producer.on('error', () => undefined);
    consumer.on('error', () => undefined);

    return { producer, consumer };
}

export function createQueues(connection: Redis): Queues {
    return Object.fromEntries(QUEUE_NAMES.map((name) => [name, new Queue(name, { connection })])) as Queues;
}
