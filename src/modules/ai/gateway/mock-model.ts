import { randomUUID } from 'node:crypto';

import type { ModelReply, ModelRequest } from './model.js';

/**
 * AI_MODE=mock: answers with the request's own `mock` value, as a tool call when a tool is
 * forced and as JSON text otherwise. Lets the whole pipeline run without a provider.
 */
export function mockModel(request: ModelRequest): ModelReply {
  const result = request.mock ?? { mock: true };
  if (!request.forceTool) {
    return { content: JSON.stringify(result), toolCalls: [], usage: { mock: true } };
  }
  return {
    content: null,
    toolCalls: [
      { id: `mock-${randomUUID()}`, name: request.forceTool, arguments: JSON.stringify(result) },
    ],
    usage: { mock: true },
  };
}
