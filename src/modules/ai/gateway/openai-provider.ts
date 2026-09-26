import { fetch } from 'undici';

import type { Config } from '../../../shared/config.js';
import { AppError, ensure } from '../../../shared/errors.js';
import { object, strictJson } from '../../../shared/json.js';
import { boundedText } from '../../../shared/network.js';
import type { Row } from '../../../shared/types/entities.js';

import type { ModelReply, ModelRequest } from './model.js';

const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_COMPLETION_TOKENS = 6000;

export async function callOpenAi(config: Config, request: ModelRequest, timeoutMs: number): Promise<ModelReply> {
    ensure(config.AI_API_KEY && config.AI_MODEL, 'provider_rejected', 503);

    const response = await fetch(config.AI_API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.AI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(completionBody(config, request)),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
    });

    const status = { status: response.status };

    if (response.status >= 400 && response.status < 500) {
        await response.body?.cancel();
        throw providerError('provider_rejected', status);
    }

    if (!response.ok) {
        await response.body?.cancel();
        throw new Error('provider_unknown', { cause: status });
    }

    const text = await boundedText(response, MAX_RESPONSE_BYTES);

    return {
        ...parseReply(text),
        providerRef: response.headers.get('x-request-id') ?? undefined,
    };
}

function parseReply(text: string): Omit<ModelReply, 'providerRef'> {
    try {
        return parseCompletion(object(strictJson(text, false, MAX_RESPONSE_BYTES)));
    } catch (error) {
        if (error instanceof AppError) {
            throw error;
        }

        throw providerError('provider_bad_reply', error);
    }
}

function completionBody(config: Config, request: ModelRequest): Row {
    const body: Row = {
        model: config.AI_MODEL,
        messages: request.messages,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        store: false,
    };

    if (config.AI_THINKING_BUDGET > 0) {
        body.chat_template_kwargs = { thinking_token_budget: config.AI_THINKING_BUDGET };
    }

    if (request.tools?.length) {
        body.tools = request.tools;
        body.parallel_tool_calls = false;
        body.tool_choice = request.forceTool ? { type: 'function', function: { name: request.forceTool } } : 'auto';
    }

    if (request.json) {
        body.response_format = { type: 'json_object' };
    }

    return body;
}

function parseCompletion(result: Row): Omit<ModelReply, 'providerRef'> {
    const choice = object((result.choices as unknown[] | undefined)?.[0]);
    const message = object(choice.message);

    const finishReason = String(choice.finish_reason);

    if (!['stop', 'tool_calls'].includes(finishReason)) {
        throw providerError('provider_rejected', { finish_reason: finishReason });
    }

    const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as unknown[]) : [];

    const toolCalls = rawCalls.map((raw) => {
        const call = object(raw);
        const fn = object(call.function);

        return { id: String(call.id), name: String(fn.name), arguments: String(fn.arguments) };
    });

    return {
        content: typeof message.content === 'string' ? message.content : null,
        toolCalls,
        usage: object(result.usage ?? {}),
    };
}

function providerError(code: string, cause: unknown): AppError {
    return Object.assign(new AppError(code, 503), { cause });
}
