import { monitorEventLoopDelay } from 'node:perf_hooks';

import type { Sql } from '../../shared/db.js';
import type { Row } from '../../shared/types/entities.js';

type Labels = Record<string, string>;

interface Family {
    name: string;
    help: string;
    samples: { labels?: Labels; value: number }[];
}

const loopDelay = monitorEventLoopDelay({ resolution: 20 });

loopDelay.enable();

const QUERIES: Record<string, string> = {
    inbox: `SELECT count(*)::int AS pending,coalesce(extract(epoch FROM now()-min(received_at)),0)::float AS oldest
     FROM inbox WHERE org_id=$1 AND state='pending'`,
    jobs: `SELECT kind,state,count(*)::int AS n FROM jobs
     WHERE org_id=$1 AND state IN('pending','running','failed') GROUP BY kind,state`,
    overdue: `SELECT kind,extract(epoch FROM now()-min(due_at))::float AS age FROM jobs
     WHERE org_id=$1 AND state='pending' AND due_at<now() GROUP BY kind`,
    deliveries: `SELECT state,count(*)::int AS n,extract(epoch FROM now()-min(created_at))::float AS oldest
     FROM deliveries WHERE org_id=$1 AND state IN('queued','sending','retry_wait','unknown','failed') GROUP BY state`,
    permits: 'SELECT state,count(*)::int AS n FROM ai_permits GROUP BY state',
    aiCalls: `SELECT state,count(*)::int AS n FROM ai_calls
     WHERE org_id=$1 AND started_at>now()-interval '1 hour' GROUP BY state`,
    aiLatency: `SELECT coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at-started_at)),0)::float AS p50,
       coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at-started_at)),0)::float AS p95
     FROM ai_calls WHERE org_id=$1 AND finished_at IS NOT NULL AND started_at>now()-interval '1 hour'`,
    triage: `SELECT ai_status,count(*)::int AS n FROM tickets
     WHERE org_id=$1 AND created_at>now()-interval '1 hour' GROUP BY ai_status`,
    tickets: `SELECT status,count(*)::int AS n FROM tickets
     WHERE org_id=$1 AND status<>'closed' GROUP BY status`,
    waiting: `SELECT coalesce(extract(epoch FROM now()-min(created_at)),0)::float AS age FROM tickets
     WHERE org_id=$1 AND status='open'`,
    learning: 'SELECT learning_status,count(*)::int AS n FROM closures WHERE org_id=$1 GROUP BY learning_status',
    memory: 'SELECT state,count(*)::int AS n FROM memory_records WHERE org_id=$1 GROUP BY state',
    backups: 'SELECT kind,extract(epoch FROM max(finished_at))::float AS at FROM backup_runs GROUP BY kind',
};

const DATABASE_QUERIES: Record<string, string> = {
    archiver: `SELECT archived_count::float AS archived,failed_count::float AS failed,
       coalesce(extract(epoch FROM last_archived_time),0)::float AS last_archived FROM pg_stat_archiver`,
    replication: `SELECT count(*)::int AS replicas,coalesce(max(extract(epoch FROM replay_lag)),0)::float AS lag
     FROM pg_stat_replication`,
    size: 'SELECT pg_database_size(current_database())::float AS bytes',
};

type Results = Map<string, Row[]>;

interface GroupSpec {
    query: string;
    name: string;
    help: string;
    labels: string[];
    value?: string;
}

const GROUPS: GroupSpec[] = [
    { query: 'jobs', name: 'taskline_jobs', help: 'Background jobs by kind and state', labels: ['kind', 'state'] },
    {
        query: 'overdue',
        name: 'taskline_job_overdue_seconds',
        help: 'Age of the oldest overdue pending job',
        labels: ['kind'],
        value: 'age',
    },
    { query: 'deliveries', name: 'taskline_deliveries', help: 'Undelivered MAX messages', labels: ['state'] },
    {
        query: 'deliveries',
        name: 'taskline_delivery_oldest_seconds',
        help: 'Age of the oldest undelivered message',
        labels: ['state'],
        value: 'oldest',
    },
    { query: 'permits', name: 'taskline_ai_permits', help: 'AI concurrency permits by state', labels: ['state'] },
    { query: 'aiCalls', name: 'taskline_ai_calls_last_hour', help: 'Model calls in the last hour', labels: ['state'] },
    { query: 'triage', name: 'taskline_triage_last_hour', help: 'New tickets by AI status', labels: ['ai_status'] },
    { query: 'tickets', name: 'taskline_tickets_active', help: 'Tickets not closed, by status', labels: ['status'] },
    { query: 'learning', name: 'taskline_closures', help: 'Closure learning by status', labels: ['learning_status'] },
    { query: 'memory', name: 'taskline_memory_records', help: 'Knowledge base records by state', labels: ['state'] },
    {
        query: 'backups',
        name: 'taskline_backup_last_success_timestamp',
        help: 'Last successful backup by kind',
        labels: ['kind'],
        value: 'at',
    },
];

export async function collectMetrics(db: Sql, org: string, version: string): Promise<string> {
    const results: Results = new Map();

    for (const [name, sql] of Object.entries(QUERIES)) {
        results.set(name, (await db.query(sql, sql.includes('$1') ? [org] : [])).rows);
    }

    for (const [name, sql] of Object.entries(DATABASE_QUERIES)) {
        results.set(
            name,
            await db.query(sql).then(
                (result) => result.rows,
                () => [],
            ),
        );
    }

    return render([...domainFamilies(results), ...databaseFamilies(results), ...processFamilies(version)]);
}

const all = (results: Results, name: string): Row[] => results.get(name) ?? [];
const first = (results: Results, name: string): Row | undefined => all(results, name).at(0);

function grouped(spec: GroupSpec, rows: Row[]): Family {
    const value = spec.value ?? 'n';

    return {
        name: spec.name,
        help: spec.help,
        samples: rows.map((row) => ({
            labels: Object.fromEntries(spec.labels.map((label) => [label, String(row[label])])),
            value: Number(row[value]),
        })),
    };
}

function single(name: string, help: string, value: unknown): Family {
    return { name, help, samples: [{ value: Number(value ?? 0) }] };
}

function domainFamilies(results: Results): Family[] {
    const inbox = first(results, 'inbox');
    const latency = first(results, 'aiLatency');

    return [
        single('taskline_inbox_pending', 'Client updates waiting to be processed', inbox?.pending),
        single('taskline_inbox_oldest_pending_seconds', 'Age of the oldest unprocessed update', inbox?.oldest),
        single('taskline_ai_call_p50_seconds', 'Median model call duration, last hour', latency?.p50),
        single('taskline_ai_call_p95_seconds', '95th percentile model call duration, last hour', latency?.p95),
        single(
            'taskline_ticket_oldest_unassigned_seconds',
            'Wait of the oldest open ticket',
            first(results, 'waiting')?.age,
        ),
        ...GROUPS.map((spec) => grouped(spec, all(results, spec.query))),
    ];
}

function databaseFamilies(results: Results): Family[] {
    const archiver = first(results, 'archiver');
    const replication = first(results, 'replication');
    const families = [single('taskline_pg_database_bytes', 'Database size', first(results, 'size')?.bytes)];

    if (archiver) {
        families.push(
            single('taskline_pg_wal_archived_total', 'WAL segments archived', archiver.archived),
            single('taskline_pg_wal_archive_failed_total', 'WAL archive failures', archiver.failed),
            single('taskline_pg_wal_last_archived_timestamp', 'Last archived WAL segment', archiver.last_archived),
        );
    }

    if (replication) {
        families.push(
            single('taskline_pg_replicas', 'Connected streaming replicas', replication.replicas),
            single('taskline_pg_replica_lag_seconds', 'Largest replica replay lag', replication.lag),
        );
    }

    return families;
}

function processFamilies(version: string): Family[] {
    const memory = process.memoryUsage();

    return [
        { name: 'taskline_build_info', help: 'Running server version', samples: [{ labels: { version }, value: 1 }] },
        single('process_uptime_seconds', 'Process uptime', process.uptime()),
        single('process_resident_memory_bytes', 'Resident memory', memory.rss),
        single('nodejs_heap_used_bytes', 'V8 heap in use', memory.heapUsed),
        single(
            'nodejs_eventloop_delay_p99_seconds',
            'Event loop delay, 99th percentile',
            loopDelay.percentile(99) / 1e9,
        ),
    ];
}

function render(families: Family[]): string {
    const lines: string[] = [];

    for (const family of families) {
        const type = family.name.endsWith('_total') ? 'counter' : 'gauge';

        lines.push(`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} ${type}`);

        for (const sample of family.samples) {
            lines.push(`${family.name}${labelText(sample.labels)} ${Number.isFinite(sample.value) ? sample.value : 0}`);
        }
    }

    return `${lines.join('\n')}\n`;
}

function labelText(labels: Labels | undefined): string {
    if (!labels) {
        return '';
    }

    const pairs = Object.entries(labels).map(([key, value]) => `${key}="${value.replaceAll(/["\\\n]/g, '_')}"`);

    return `{${pairs.join(',')}}`;
}
