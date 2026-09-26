import { one, type Sql } from '../../../shared/db.js';
import { AppError, ensure } from '../../../shared/errors.js';
import { audit } from '../../../shared/events.js';
import type { Row } from '../../../shared/types/entities.js';

import { citedMemoryIds, loadSourceRows, sourceState, uuids, type SourceRow } from './suggestion-sources.js';

const CONTEXT = 2;
const MAX_MESSAGES = 40;
const FALLBACK_TAIL = 20;

export interface SourceRequest {
    ticketId: string;
    memoryId: string;
    actorId: string;
}

function evidenceIds(content: Row): string[] {
    const steps = Array.isArray(content.steps) ? (content.steps as Row[]) : [];

    return [
        ...new Set([
            ...uuids(content.evidence_message_ids),
            ...steps.flatMap((step) => uuids(step.evidence_message_ids)),
        ]),
    ];
}

function windowSeqs(anchors: number[], start: number, end: number): number[] {
    const seqs = new Set<number>();
    const clamp = (seq: number) => seq > start && seq <= end;

    if (!anchors.length) {
        for (let seq = Math.max(start + 1, end - FALLBACK_TAIL + 1); seq <= end; seq++) {
            seqs.add(seq);
        }
    }

    for (const anchor of anchors) {
        for (let seq = anchor - CONTEXT; seq <= anchor + CONTEXT; seq++) {
            if (clamp(seq)) {
                seqs.add(seq);
            }
        }
    }

    return [...seqs].sort((left, right) => left - right).slice(0, MAX_MESSAGES);
}

async function citedSource(db: Sql, org: string, { ticketId, memoryId }: SourceRequest): Promise<SourceRow> {
    const ticket = await one(db, 'SELECT suggestion FROM tickets WHERE org_id=$1 AND id=$2', [org, ticketId]);

    ensure(ticket, 'not_found', 404);
    ensure(citedMemoryIds(ticket.suggestion).includes(memoryId), 'source_not_found', 404);
    const row = (await loadSourceRows(db, org, [memoryId])).get(memoryId);

    if (!row || sourceState(row) === 'gone') {
        throw new AppError('source_unavailable', 410, 'Источник подсказки больше недоступен.');
    }

    return row;
}

async function cycleWindow(db: Sql, org: string, source: SourceRow, evidence: string[]) {
    const previous = await one<{ start: number }>(
        db,
        `SELECT coalesce(max(cutoff_seq),0)::int AS start FROM closures
     WHERE org_id=$1 AND ticket_id=$2 AND cycle_no<$3`,
        [org, source.ticket_id, source.cycle_no],
    );

    const start = previous?.start ?? 0;

    const { rows: anchors } = await db.query<{ seq: number }>(
        'SELECT seq FROM messages WHERE org_id=$1 AND ticket_id=$2 AND id=ANY($3::uuid[]) AND seq>$4 AND seq<=$5',
        [org, source.ticket_id, evidence, start, source.cutoff_seq],
    );

    const seqs = windowSeqs(
        anchors.map((anchor) => anchor.seq),
        start,
        source.cutoff_seq,
    );

    return { seqs, truncated: seqs.length < source.cutoff_seq - start };
}

export async function sourceExcerpt(db: Sql, org: string, request: SourceRequest) {
    const source = await citedSource(db, org, request);
    const evidence = evidenceIds(source.content);
    const { seqs, truncated } = await cycleWindow(db, org, source, evidence);

    const { rows: messages } = await db.query(
        `SELECT m.*,e.name AS author_name FROM messages m
     LEFT JOIN employees e ON e.id=m.author_id AND e.org_id=m.org_id
     WHERE m.org_id=$1 AND m.ticket_id=$2 AND m.seq=ANY($3::int[]) ORDER BY m.seq`,
        [org, source.ticket_id, seqs],
    );

    const { rows: attachments } = await db.query(
        `SELECT id,message_id,filename,kind,status,mime,bytes,extraction_status
     FROM attachments WHERE org_id=$1 AND ticket_id=$2 AND message_id=ANY($3::uuid[]) ORDER BY created_at`,
        [org, source.ticket_id, messages.map((message) => message.id)],
    );

    await audit(db, org, {
        actor: request.actorId,
        action: 'ticket.source_opened',
        objectId: source.ticket_id,
        detail: { from_ticket_id: request.ticketId, memory_id: request.memoryId },
    });

    const solution = source.content.solution_summary;

    return {
        source: {
            memory_id: source.memory_id,
            state: sourceState(source),
            ticket_id: source.ticket_id,
            number: source.number,
            cycle_no: source.cycle_no,
            closed_at: source.closed_at,
            problem: source.content.problem_summary,
            solution: typeof solution === 'string' ? solution : null,
        },
        messages,
        attachments,
        highlight: evidence.filter((id) => messages.some((message) => message.id === id)),
        truncated,
    };
}
