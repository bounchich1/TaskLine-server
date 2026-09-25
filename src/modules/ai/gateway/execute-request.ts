import { z } from 'zod';

const messageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(200000).nullable(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

export const executeRequestSchema = z
  .object({
    job_id: z.uuid(),
    generation: z.number().int().positive(),
    step: z.string().min(1).max(128),
    request: z
      .object({
        messages: z.array(messageSchema).max(12),
        tools: z.array(z.record(z.string(), z.unknown())).max(2).optional(),
        forceTool: z.enum(['memorize_ticket_resolution']).optional(),
        json: z.boolean().optional(),
        mock: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

export type ExecuteRequest = z.infer<typeof executeRequestSchema>;
