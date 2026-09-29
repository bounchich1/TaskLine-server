import { AppError } from '../../../shared/errors.js';
import type { TriageResult } from '../../../shared/types/ai.js';
import type { Job, Row } from '../../../shared/types/entities.js';
import { parseTriage } from '../contracts/contracts.js';
import type { Model, ModelMessage, ModelReply } from '../gateway/model.js';
import type { Recall } from '../memory/memory-record.js';

import { RECALL_TOOLS, RecallSession } from './recall-session.js';

const MAX_TURNS = 3;
const RETRY_LATER_CODES = ['ai_busy', 'gateway_unavailable', 'provider_busy', 'provider_unavailable'];
const FINAL_ANSWER_RESERVE_MS = 45000;
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
    fallback: TriageResult;
    deadline: number;
}

export interface TriageOutcome {
    result: TriageResult;
    success: boolean;
    failure: string;
}

export async function converse(
    deps: { model: Model; memory: Recall },
    conversation: Conversation,
): Promise<TriageOutcome> {
    const session = new RecallSession(deps.memory);

    try {
        const result = await askForTriage(deps.model, conversation, session);

        if (result) {
            return { result, success: true, failure: 'ai_failed' };
        }

        return { result: conversation.fallback, success: false, failure: 'ai_failed' };
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

async function askForTriage(
    model: Model,
    conversation: Conversation,
    session: RecallSession,
): Promise<TriageResult | undefined> {
    const { job, messages, fallback, deadline } = conversation;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
        const outOfTime = session.canCallTools && deadline - Date.now() <= FINAL_ANSWER_RESERVE_MS;

        const reply = await model.complete(job, outOfTime ? `triage-${turn}-late` : `triage-${turn}`, {
            messages,
            tools: session.canCallTools && !outOfTime ? RECALL_TOOLS : undefined,
            json: true,
            mock: fallback,
        });

        if (reply.toolCalls.length) {
            await session.answer(reply, messages);
            continue;
        }

        return parseOrRepair(model, { conversation, session, reply });
    }

    return undefined;
}

async function parseOrRepair(
    model: Model,
    {
        conversation,
        session,
        reply,
    }: {
        conversation: Conversation;
        session: RecallSession;
        reply: ModelReply;
    },
): Promise<TriageResult> {
    const { job, messages, messageId, dictionaryVersion, dictionaries, fallback, deadline } = conversation;

    const parse = (content: string | null) =>
        parseTriage(content ?? '', {
            dictionaryVersion,
            dictionaries,
            messageIds: [messageId],
            memoryIds: session.caseIds,
            cautionedMemoryIds: session.cautionedCaseIds,
        });

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

        const repair = await model.complete(job, 'triage-repair', {
            messages,
            json: true,
            mock: fallback,
        });

        return parse(repair.content);
    }
}
