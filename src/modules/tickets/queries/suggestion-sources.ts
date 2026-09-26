import type { Sql } from '../../../shared/db.js';
import type { Row } from '../../../shared/types/entities.js';

export type SourceState = 'ok' | 'reopened' | 'outdated' | 'gone';

export type SuggestionSource = {
    memory_id: string;
    state: SourceState;
    ticket_id: string | null;
    number: string | null;
    problem: string | null;
    closed_at: string | null;
};

export type SourceRow = Row & {
    memory_id: string;
    ticket_id: string;
    closure_id: string;
    current_cycle_id: string | null;
    number: string;
    cycle_no: number;
    cutoff_seq: number;
    closed_at: string;
    invalidated: boolean;
    consented: boolean;
    content: Row;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOURCE_ROWS = `SELECT r.id AS memory_id,r.ticket_id,r.closure_id,r.content,t.current_cycle_id,
  lpad(t.ticket_number::text,6,'0') AS number,cl.cycle_no,cl.cutoff_seq,cl.closed_at,cl.invalidated,
  (c.consent_state='granted' AND c.consent_revision=t.consent_revision) AS consented
  FROM memory_records r JOIN closures cl ON cl.id=r.closure_id
  JOIN tickets t ON t.id=r.ticket_id JOIN clients c ON c.id=t.client_id
  WHERE r.org_id=$1 AND r.id=ANY($2::uuid[])`;

export function uuids(values: unknown): string[] {
    return Array.isArray(values)
        ? values.filter((value): value is string => typeof value === 'string' && UUID.test(value))
        : [];
}

export function citedMemoryIds(suggestion: unknown): string[] {
    const cited = (suggestion as Row | null)?.evidence_memory_ids;

    return Array.isArray(cited) ? cited.filter((id): id is string => typeof id === 'string') : [];
}

export function sourceState(row: SourceRow | undefined): SourceState {
    if (!row?.consented) {
        return 'gone';
    }

    if (row.current_cycle_id !== row.closure_id) {
        return 'reopened';
    }

    return row.invalidated ? 'outdated' : 'ok';
}

export async function loadSourceRows(db: Sql, org: string, ids: string[]): Promise<Map<string, SourceRow>> {
    const valid = uuids(ids);

    if (!valid.length) {
        return new Map();
    }

    const { rows } = await db.query<SourceRow>(SOURCE_ROWS, [org, valid]);

    return new Map(rows.map((row) => [row.memory_id, row]));
}

function describe(memoryId: string, row: SourceRow | undefined): SuggestionSource {
    const state = sourceState(row);

    if (!row || state === 'gone') {
        return { memory_id: memoryId, state: 'gone', ticket_id: null, number: null, problem: null, closed_at: null };
    }

    const problem = row.content.problem_summary;

    return {
        memory_id: memoryId,
        state,
        ticket_id: row.ticket_id,
        number: row.number,
        problem: typeof problem === 'string' ? problem : null,
        closed_at: row.closed_at,
    };
}

export async function suggestionSources(db: Sql, org: string, suggestion: unknown): Promise<SuggestionSource[]> {
    const ids = citedMemoryIds(suggestion);

    if (!ids.length) {
        return [];
    }

    const rows = await loadSourceRows(db, org, ids);

    return ids.map((id) => describe(id, rows.get(id)));
}
