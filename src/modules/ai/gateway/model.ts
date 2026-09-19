import type { Job, Row } from '../../../shared/types/entities.js';

// The chat-completions shapes shared by the workflows, the gateway and its providers.

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Row[];
};

export type ModelRequest = {
  messages: ModelMessage[];
  tools?: Row[];
  /** Require a call of this tool instead of a text answer. */
  forceTool?: string;
  /** Ask for a JSON object answer. */
  json?: boolean;
  /** What the mock model answers (AI_MODE=mock). */
  mock?: Row;
};

export type ModelReply = {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: Row;
  providerRef?: string;
};

/** One model call, identified by job and step so that a retried job never calls twice. */
export interface Model {
  complete(job: Job, step: string, request: ModelRequest): Promise<ModelReply>;
}

/** Performs the network call; injected in tests. */
export type ModelProvider = (request: ModelRequest, timeoutMs: number) => Promise<ModelReply>;

/** An OpenAI-style function tool definition. */
export function functionTool(name: string, description: string, parameters: unknown): Row {
  return { type: 'function', function: { name, description, parameters } };
}
