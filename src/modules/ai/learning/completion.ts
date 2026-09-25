import { z } from 'zod';

import { hash } from '../../../shared/crypto.js';
import { ensure } from '../../../shared/errors.js';
import { strictJson } from '../../../shared/json.js';
import type { Row } from '../../../shared/types/entities.js';
import { LEARNING_SKILL } from '../skills.js';

import type { LearningStep } from './evidence-reduction.js';

export async function acknowledgeReceipt(
    { model, job, checkpoints }: LearningStep,
    { record, coveredIds }: { record: Row; coveredIds: string[] },
): Promise<void> {
    const receiptId = String(record.receipt_id);

    const receipt = {
        schema_version: '1.0',
        tool_receipt_id: receiptId,
        status: 'accepted_pending_persistence',
    };

    const call = await checkpoints.get('memorize-call');

    ensure(call, 'missing_tool_receipt');

    const response = await model.complete(job, 'learning-completion', {
        messages: [
            { role: 'system', content: LEARNING_SKILL },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: call.call_id,
                        type: 'function',
                        function: { name: 'memorize_ticket_resolution', arguments: call.arguments },
                    },
                ],
            },
            { role: 'tool', tool_call_id: String(call.call_id), content: JSON.stringify(receipt) },
        ],
        json: true,
        mock: receipt,
    });

    const acknowledgement = z
        .object({
            schema_version: z.literal('1.0'),
            tool_receipt_id: z.literal(receiptId),
            status: z.literal('accepted_pending_persistence'),
        })
        .strict()
        .parse(strictJson(response.content ?? ''));

    await checkpoints.save('completion', {
        value: acknowledgement,
        coveredIds,
        inputHash: hash(JSON.stringify(receipt)),
    });
}
