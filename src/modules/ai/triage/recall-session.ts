import { z } from 'zod';

import { AppError, ensure } from '../../../shared/errors.js';
import { object, strictJson } from '../../../shared/json.js';
import type { Row } from '../../../shared/types/entities.js';
import { redact } from '../contracts/redact.js';
import { functionTool, type ModelMessage, type ModelReply } from '../gateway/model.js';
import type { CaseEvidence, Recall } from '../memory/memory-record.js';

const MAX_TOOL_CALLS = 2;

const BUDGET_SPENT = {
    error: 'tool_budget_spent',
    note: 'One search and one expansion only. Return the triage JSON now.',
};

export const RECALL_TOOLS: Row[] = [
    functionTool('search_resolved_cases', 'Search authorized resolved cases.', {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: { query: { type: 'string', maxLength: 2000 } },
    }),
    functionTool('get_case_evidence', 'Expand IDs from the previous search only.', {
        type: 'object',
        additionalProperties: false,
        required: ['ids'],
        properties: { ids: { type: 'array', maxItems: 3, items: { type: 'string' } } },
    }),
];

const searchArgs = z.object({ query: z.string().min(1).max(2000) }).strict();
const expandArgs = z.object({ ids: z.array(z.string()).max(3) }).strict();

export class RecallSession {
    private cases: CaseEvidence[] = [];
    private calls = 0;
    private searched = false;
    private expanded = false;

    constructor(private readonly memory: Recall) {}

    get canCallTools(): boolean {
        return this.calls < MAX_TOOL_CALLS;
    }

    get caseIds(): string[] {
        return this.cases.map((evidence) => evidence.id);
    }

    get cautionedCaseIds(): string[] {
        return this.cases.filter((evidence) => evidence.cautions.length > 0).map((evidence) => evidence.id);
    }

    async answer(reply: ModelReply, messages: ModelMessage[]): Promise<void> {
        ensure(reply.toolCalls.length > 0 && this.calls < MAX_TOOL_CALLS, 'ai_tool_budget', 422);
        this.calls++;

        messages.push({
            role: 'assistant',
            content: reply.content,
            tool_calls: reply.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
            })),
        });

        for (const [index, call] of reply.toolCalls.entries()) {
            const data = index === 0 ? await this.run(call.name, object(strictJson(call.arguments))) : BUDGET_SPENT;

            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(data) });
        }
    }

    private async run(name: string, args: Row): Promise<unknown> {
        if (name === 'search_resolved_cases') {
            return this.search(args);
        }

        if (name === 'get_case_evidence') {
            return this.expand(args);
        }

        throw new AppError('forbidden_ai_tool', 422);
    }

    private async search(args: Row): Promise<unknown> {
        if (this.searched) {
            return BUDGET_SPENT;
        }

        this.searched = true;
        const { query } = searchArgs.parse(args);

        try {
            this.cases = await this.memory.search(redact(query));

            return { cases: this.cases };
        } catch {
            return { cases: [], unavailable: true };
        }
    }

    private async expand(args: Row): Promise<unknown> {
        if (!this.searched || this.expanded) {
            return BUDGET_SPENT;
        }

        this.expanded = true;
        const { ids } = expandArgs.parse(args);

        ensure(
            ids.every((id) => this.cases.some((evidence) => evidence.id === id)),
            'forged_memory_evidence',
            422,
        );

        return { cases: await this.memory.expand(ids) };
    }
}
