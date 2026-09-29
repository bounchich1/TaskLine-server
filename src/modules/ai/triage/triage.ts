import type { Ctx } from '../../../shared/context.js';
import { one, type Database } from '../../../shared/db.js';
import { AppError, ensure } from '../../../shared/errors.js';
import type { Job, Message, Row } from '../../../shared/types/entities.js';
import { triageSchema } from '../contracts/contracts.js';
import { redact } from '../contracts/redact.js';
import { eligibleJob, triageTimeLeftMs } from '../gateway/job-eligibility.js';
import type { Model, ModelMessage } from '../gateway/model.js';
import type { Recall } from '../memory/memory-record.js';
import { TRIAGE_SKILL } from '../skills.js';

import { applyTriage } from './apply-triage.js';
import { converse, type Conversation, type TriageOutcome } from './converse.js';
import { fallbackTriage } from './fallback.js';

export interface TriageDeps {
    db: Database;
    ctx: Ctx;
    model: Model;
    memory: Recall;
}

export async function runTriage(deps: TriageDeps, job: Job): Promise<void> {
    const conversation = await startConversation(deps, job);

    const outcome = await dropStaleMemoryEvidence(deps.memory, {
        outcome: await converse(deps, conversation),
        conversation,
    });

    const { messageId } = conversation;

    const failure = await deps.db.tx(async (tx) => applyTriage(tx, deps.ctx, { job, messageId, outcome }));

    if (failure) {
        throw new AppError(failure, 422, 'ИИ-разбор не выполнен.');
    }
}

async function startConversation({ db, ctx }: TriageDeps, job: Job): Promise<Conversation> {
    const message = await one<Message>(db, 'SELECT * FROM messages WHERE org_id=$1 AND id=$2', [
        ctx.org,
        job.payload.message_id,
    ]);

    ensure(message && (await eligibleJob(db, ctx, job)), 'job_ineligible');
    const deadline = Date.now() + (await triageTimeLeftMs(db, ctx, job.ref_id));

    const { rows: attachments } = await db.query(
        `SELECT id,status,extraction,extraction_status FROM attachments
     WHERE message_id=$1 ORDER BY id`,
        [message.id],
    );

    const dictionaries = job.payload.dictionaries as Row[];
    const dictionaryVersion = String(job.payload.dictionary_version);

    const input = {
        first_message: {
            id: message.id,
            text: redact(message.text),
            attachments: attachments.map((attachment) => ({
                ...attachment,
                extraction: typeof attachment.extraction === 'string' ? redact(attachment.extraction) : null,
            })),
        },
        dictionary_version: dictionaryVersion,
        dictionaries,
    };

    const messages: ModelMessage[] = [
        {
            role: 'system',
            content: `${TRIAGE_SKILL}\nOutput JSON schema:\n${JSON.stringify(triageSchema)}`,
        },
        { role: 'user', content: JSON.stringify(input) },
    ];

    const fallback = fallbackTriage(dictionaryVersion, message.id);

    return { job, messages, messageId: message.id, dictionaryVersion, dictionaries, fallback, deadline };
}

async function dropStaleMemoryEvidence(
    memory: Recall,
    { outcome, conversation }: { outcome: TriageOutcome; conversation: Conversation },
): Promise<TriageOutcome> {
    const cited = outcome.result.evidence_memory_ids;
    const stillEligible = await memory.expand(cited).catch(() => []);

    if (stillEligible.length === cited.length) {
        return outcome;
    }

    const { dictionaryVersion, messageId } = conversation;

    return {
        result: fallbackTriage(dictionaryVersion, messageId),
        success: false,
        failure: 'stale_memory',
    };
}
