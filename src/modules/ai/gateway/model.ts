import type { Job, Row } from '../../../shared/types/entities.js';

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Row[];
};

export type ModelRequest = {
  messages: ModelMessage[];
  tools?: Row[];
  forceTool?: string;
  json?: boolean;
  mock?: Row;
};

export type ModelReply = {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: Row;
  providerRef?: string;
};

export interface Model {
  complete(job: Job, step: string, request: ModelRequest): Promise<ModelReply>;
}

export type ModelProvider = (request: ModelRequest, timeoutMs: number) => Promise<ModelReply>;

export function functionTool(name: string, description: string, parameters: unknown): Row {
  return { type: 'function', function: { name, description, parameters } };
}
