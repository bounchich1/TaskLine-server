import type { Config } from '../../shared/config.js';
import { requireOne, type Sql } from '../../shared/db.js';
import type { Row } from '../../shared/types/entities.js';

import { numberOrNull, percentile, seconds, share, within, type Period } from './period.js';

const MILLION = 1_000_000;

const tokens = (path: string) =>
    `coalesce(sum(CASE WHEN jsonb_typeof(c.usage${path})='number' THEN (c.usage${path.replace(/->'(\w+)'$/, "->>'$1'")})::numeric END),0)`;

const TRIAGE_LATENCY = `SELECT
  ${percentile(0.5, seconds('triaged_at-started_at'), within('triaged_at'))} AS p50,
  ${percentile(0.95, seconds('triaged_at-started_at'), within('triaged_at'))} AS p95,
  count(*) FILTER (WHERE ${within('triaged_at')})::int AS triaged
FROM ticket_facts WHERE org_id=$1 AND lifecycle=1 AND triaged_at>=$2 AND started_at<$3`;

const TRIAGE_OUTCOMES = `SELECT coalesce((detail->>'success')::boolean,false) AS success,
  coalesce(detail->>'reason','unknown') AS reason,count(*)::int AS count
FROM ticket_events WHERE org_id=$1 AND kind='triaged' AND ${within('created_at')} GROUP BY 1,2 ORDER BY 3 DESC`;

const CALLS = `SELECT j.kind,count(*)::int AS calls,count(*) FILTER (WHERE c.state='completed')::int AS completed,
  ${percentile(0.5, seconds('c.finished_at-c.started_at'), "c.state='completed'")} AS p50,
  ${percentile(0.95, seconds('c.finished_at-c.started_at'), "c.state='completed'")} AS p95,
  ${tokens("->'prompt_tokens'")} AS prompt_tokens,
  ${tokens("->'completion_tokens'")} AS completion_tokens,
  ${tokens("->'completion_tokens_details'->'reasoning_tokens'")} AS reasoning_tokens,
  ${tokens("->'prompt_tokens_details'->'cached_tokens'")} AS cached_tokens
FROM ai_calls c JOIN jobs j ON j.id=c.job_id WHERE c.org_id=$1 AND ${within('c.started_at')}
GROUP BY j.kind ORDER BY j.kind`;

const CALL_FAILURES = `SELECT coalesce(reason,state) AS reason,count(*)::int AS count FROM ai_calls
WHERE org_id=$1 AND ${within('started_at')} AND state NOT IN('completed','running') GROUP BY 1 ORDER BY 2 DESC`;

function callRow(row: Row) {
    return {
        kind: String(row.kind),
        calls: Number(row.calls),
        success_rate: share(row.completed, row.calls),
        p50: numberOrNull(row.p50),
        p95: numberOrNull(row.p95),
        prompt_tokens: Number(row.prompt_tokens),
        completion_tokens: Number(row.completion_tokens),
        reasoning_tokens: Number(row.reasoning_tokens),
        cached_tokens: Number(row.cached_tokens),
    };
}

type CallRow = ReturnType<typeof callRow>;

function cost(calls: CallRow[], config: Config) {
    const prompt = calls.reduce((sum, call) => sum + call.prompt_tokens, 0);
    const completion = calls.reduce((sum, call) => sum + call.completion_tokens, 0);
    const priced = config.AI_PRICE_INPUT_PER_MTOK > 0 || config.AI_PRICE_OUTPUT_PER_MTOK > 0;

    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        currency: config.AI_PRICE_CURRENCY,
        amount: priced
            ? (prompt / MILLION) * config.AI_PRICE_INPUT_PER_MTOK +
              (completion / MILLION) * config.AI_PRICE_OUTPUT_PER_MTOK
            : null,
    };
}

export async function aiUsage(db: Sql, org: string, period: Period, config: Config) {
    const params = [org, period.start, period.end];
    const latency = await requireOne(db, TRIAGE_LATENCY, params);
    const { rows: outcomes } = await db.query(TRIAGE_OUTCOMES, params);
    const calls = (await db.query(CALLS, params)).rows.map(callRow);
    const { rows: failures } = await db.query(CALL_FAILURES, params);
    const succeeded = outcomes.filter((row) => row.success).reduce((sum, row) => sum + Number(row.count), 0);
    const total = outcomes.reduce((sum, row) => sum + Number(row.count), 0);

    return {
        triage: {
            p50: numberOrNull(latency.p50),
            p95: numberOrNull(latency.p95),
            runs: total,
            success_rate: share(succeeded, total),
            failures: outcomes
                .filter((row) => !row.success)
                .map((row) => ({ reason: String(row.reason), count: Number(row.count) })),
        },
        calls,
        call_failures: failures.map((row) => ({ reason: String(row.reason), count: Number(row.count) })),
        cost: cost(calls, config),
    };
}
