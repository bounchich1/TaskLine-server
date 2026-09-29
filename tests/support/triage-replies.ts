import type { ModelReply } from '../../src/modules/ai/index.js';
import type { Job, Row } from '../../src/shared/types/entities.js';

export function scripted(replies: ModelReply[]) {
    return () => {
        const reply = replies.shift();

        return reply ? Promise.resolve(reply) : Promise.reject(new Error('unexpected model call'));
    };
}

export const text = (content: string): ModelReply => ({ content, toolCalls: [], usage: {} });

export const recalled = {
    id: 'case-1',
    problem_summary: 'Сбой подключения',
    solution_summary: 'Перезапуск роутера',
    applicability: [],
    cautions: [],
};

export const recall = {
    search: () => Promise.resolve([recalled]),
    expand: (ids: string[]) => Promise.resolve(ids.includes(recalled.id) ? [recalled] : []),
};

export function validTriage(job: Job): Row {
    const dictionaries = job.payload.dictionaries as Row[];
    const code = (dimension: string) => dictionaries.find((entry) => entry.dimension === dimension)?.code;

    return {
        schema_version: '1.1',
        dictionary_version: job.payload.dictionary_version,
        tags: { tag: code('tag'), urgency: code('urgency'), complexity: code('complexity') },
        tip: {
            summary: 'Сбой подключения → роутер.',
            steps: [{ text: 'Перезапустить роутер.', case_refs: [recalled.id] }],
            cautions: [],
        },
        customer_reply: 'Перезапустите, пожалуйста, роутер.',
        evidence_message_ids: [job.payload.message_id],
        evidence_memory_ids: [recalled.id],
        missing_information: [],
        confidence: 0.8,
        needs_review: false,
    };
}
