import { AppError } from '../../../shared/errors.js';
import type { TriageResult } from '../../../shared/types/ai.js';
import type { Job, Row } from '../../../shared/types/entities.js';
import { parseTriage } from '../contracts/contracts.js';
import type { Model, ModelMessage } from '../gateway/model.js';
import type { CaseEvidence } from '../memory/memory-record.js';

const RETRY_LATER_CODES = ['ai_busy', 'gateway_unavailable', 'provider_busy', 'provider_unavailable'];
const REPAIR_RESERVE_MS = 20000;

const REPAIR_PROMPT =
    'Invalid schema or evidence. Return one corrected JSON object using only the supplied ' +
    'dictionary and evidence. This is the only repair.';

export interface Conversation {
    job: Job;
    messages: ModelMessage[];
    messageId: string;
    dictionaryVersion: string;
    dictionaries: Row[];
    cases: CaseEvidence[];
    fallback: TriageResult;
    deadline: number;
}

export interface TriageOutcome {
    result: TriageResult;
    success: boolean;
    failure: string;
}

export async function converse(model: Model, conversation: Conversation): Promise<TriageOutcome> {
    try {
        return { result: await askForTriage(model, conversation), success: true, failure: 'ai_failed' };
    } catch (error) {
        if (error instanceof AppError && RETRY_LATER_CODES.includes(error.code)) {
            throw error;
        }

        return {
            result: conversation.fallback,
            success: false,
            failure: error instanceof AppError ? error.code : 'ai_failed',
        };
    }
}

async function askForTriage(model: Model, conversation: Conversation): Promise<TriageResult> {
    const { job, messages, messageId, dictionaryVersion, dictionaries, cases, fallback, deadline } = conversation;

    const parse = (content: string | null) =>
        parseTriage(content ?? '', {
            dictionaryVersion,
            dictionaries,
            messageIds: [messageId],
            memoryIds: cases.map((evidence) => evidence.id),
            cautionedMemoryIds: cases.filter((evidence) => evidence.cautions.length > 0).map((evidence) => evidence.id),
        });

    const reply = await model.complete(job, 'triage', { messages, json: true, mock: fallback });

    try {
        return parse(reply.content);
    } catch (error) {
        if (deadline - Date.now() < REPAIR_RESERVE_MS) {
            throw error;
        }

        messages.push(
            { role: 'assistant', content: reply.content?.slice(0, 32768) ?? '' },
            { role: 'user', content: REPAIR_PROMPT },
        );

        const repair = await model.complete(job, 'triage-repair', { messages, json: true, mock: fallback });

        return parse(repair.content);
    }
}
