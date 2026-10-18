import type { Ctx } from '../../../shared/context.js';
import { hash } from '../../../shared/crypto.js';
import { one, type Sql } from '../../../shared/db.js';
import { audit, emit } from '../../../shared/events.js';
import type { TriageResult } from '../../../shared/types/ai.js';
import type { Job, Message, Row, Ticket } from '../../../shared/types/entities.js';
import { findActiveDictionaryLabel } from '../../dictionaries/index.js';
import { reclassifySla } from '../../sla/index.js';
import { eligibleJob } from '../gateway/job-eligibility.js';
import { TRIAGE_SKILL } from '../skills.js';

import type { TriageOutcome } from './converse.js';

const FIELDS = ['tag', 'urgency', 'complexity'] as const;

interface TriageApplication {
    job: Job;
    messageId: string;
    outcome: TriageOutcome;
    businessVersion: number;
}

const DEFAULT_CODES = { tag: 'undefined', urgency: 'medium', complexity: 'medium' };

export async function applyTriage(
    tx: Sql,
    ctx: Ctx,
    { job, messageId, outcome, businessVersion }: TriageApplication,
): Promise<string | null> {
    const ticket = await lockTicket(tx, ctx, job);

    if (!ticket) {
        return 'result_ignored';
    }

    if (!(await eligibleJob(tx, ctx, job))) {
        await auditTriage(tx, ctx, { ticket, success: false, reason: 'result_ignored', businessVersion });

        return 'result_ignored';
    }

    const current = await one<Message>(tx, 'SELECT * FROM messages WHERE id=$1', [messageId]);

    if (current?.revision !== job.payload.revision) {
        await tx.query(
            `UPDATE tickets SET ai_status='failed',suggestion_stale=true,review_required=true
       WHERE id=$1`,
            [ticket.id],
        );

        return 'message_revised';
    }

    const { result } = outcome;
    const codesActive = await applyClassification(tx, ctx, { job, ticket, result });

    await reclassifySla(tx, ctx.org, ticket.id);
    const success = outcome.success && codesActive;
    const failure = outcome.success ? 'dictionary_value_retired' : outcome.failure;

    await tx.query('UPDATE tickets SET ai_status=$2,suggestion=$3,review_required=$4,version=version+1 WHERE id=$1', [
        ticket.id,
        success ? 'done' : 'failed',
        JSON.stringify(result),
        !success || result.needs_review,
    ]);

    await auditTriage(tx, ctx, { ticket, success, reason: success ? null : failure, businessVersion });
    await emit(tx, ctx.org, { type: 'ticket.classified', ticketId: ticket.id });

    return success ? null : failure;
}

interface TriageAudit {
    ticket: Ticket;
    success: boolean;
    reason: string | null;
    businessVersion: number;
}

async function auditTriage(
    tx: Sql,
    ctx: Ctx,
    { ticket, success, reason, businessVersion }: TriageAudit,
): Promise<void> {
    await audit(tx, ctx.org, {
        actor: null,
        action: 'ai.triage',
        objectId: ticket.id,
        detail: { success, reason, skill_hash: hash(TRIAGE_SKILL), business_version: businessVersion },
    });
}

async function lockTicket(tx: Sql, ctx: Ctx, job: Job): Promise<Ticket | undefined> {
    const ref = await one(tx, 'SELECT client_id FROM tickets WHERE id=$1', [job.ref_id]);

    if (!ref) {
        return undefined;
    }

    await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [ref.client_id]);

    return one<Ticket>(tx, 'SELECT * FROM tickets WHERE id=$1 AND org_id=$2 FOR UPDATE', [job.ref_id, ctx.org]);
}

async function applyClassification(
    tx: Sql,
    ctx: Ctx,
    { job, ticket, result }: { job: Job; ticket: Ticket; result: TriageResult },
): Promise<boolean> {
    let allActive = true;
    const startRevisions = job.payload.field_revisions as Row;

    for (const field of FIELDS) {
        const active = await findActiveDictionaryLabel(tx, ctx.org, field, result.tags[field]);

        if (!active) {
            result.tags[field] = DEFAULT_CODES[field];
            allActive = false;
        }

        if (ticket[`${field}_revision`] === Number(startRevisions[field])) {
            await tx.query(
                `UPDATE tickets SET ${field}=$2,
         classification_labels=jsonb_set(classification_labels,ARRAY[$3],$4::jsonb) WHERE id=$1`,
                [ticket.id, result.tags[field], field, JSON.stringify(active ?? {})],
            );
        }
    }

    return allActive;
}
