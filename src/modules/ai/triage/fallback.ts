import type { TriageResult } from '../../../shared/types/ai.js';

export function fallbackTriage(dictionaryVersion: string, messageId: string): TriageResult {
    return {
        schema_version: '1.0',
        dictionary_version: dictionaryVersion,
        tags: { tag: 'undefined', urgency: 'medium', complexity: 'medium' },
        suggested_solution: null,
        evidence_message_ids: [messageId],
        evidence_memory_ids: [],
        missing_information: ['Необходима проверка сотрудником'],
        confidence: 0,
        needs_review: true,
    };
}
