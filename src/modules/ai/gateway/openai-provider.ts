import { fetch } from 'undici';

import type { Config } from '../../../shared/config.js';
import { AppError, ensure } from '../../../shared/errors.js';
import { object, strictJson } from '../../../shared/json.js';
import { boundedText } from '../../../shared/network.js';
import type { Row } from '../../../shared/types/entities.js';

import type { ModelReply, ModelRequest } from './model.js';

const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_COMPLETION_TOKENS = 6000;

/**
 * Calls an OpenAI-compatible chat-completions endpoint. A 4xx means the request was rejected
 * (`provider_rejected`); a 5xx or network error leaves the outcome unknown (plain Error).
 */
export async function callOpenAi(
  config: Config,
  request: ModelRequest,
  timeoutMs: number,
): Promise<ModelReply> {
  ensure(config.AI_API_KEY && config.AI_MODEL, 'provider_rejected', 503);
  const response = await fetch(config.AI_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(completionBody(config.AI_MODEL, request)),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 400 && response.status < 500) {
    await response.body?.cancel();
    throw new AppError('provider_rejected', 503);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('provider_unknown');
  }
  const result = object(
    strictJson(await boundedText(response, MAX_RESPONSE_BYTES), false, MAX_RESPONSE_BYTES),
  );
  return {
    ...parseCompletion(result),
    providerRef: response.headers.get('x-request-id') ?? undefined,
  };
}

function completionBody(model: string, request: ModelRequest): Row {
  const body: Row = {
    model,
    messages: request.messages,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    store: false,
  };
  if (request.tools?.length) {
    body.tools = request.tools;
    body.parallel_tool_calls = false;
    body.tool_choice = request.forceTool
      ? { type: 'function', function: { name: request.forceTool } }
      : 'auto';
  }
  if (request.json) {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

/** Accepts only a finished answer (text or tool calls), never a truncated one. */
function parseCompletion(result: Row): Omit<ModelReply, 'providerRef'> {
  const choice = object((result.choices as unknown[] | undefined)?.[0]);
  const message = object(choice.message);
  ensure(['stop', 'tool_calls'].includes(String(choice.finish_reason)), 'provider_rejected', 503);
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
