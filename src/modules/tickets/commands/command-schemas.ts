import { z } from 'zod';

const uuid = z.uuid();

const classificationRevisions = z
    .object({
        tag: z.number().int().optional(),
        urgency: z.number().int().optional(),
        complexity: z.number().int().optional(),
    })
    .strict();

export const COMMAND_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
    assign: z.object({ employee_id: uuid.optional() }).strict(),
    transfer: z.object({ employee_id: uuid, comment: z.string().trim().min(1).max(2000) }).strict(),
    classification: z
        .object({
            tag: z.string().max(64).optional(),
            urgency: z.string().max(64).optional(),
            complexity: z.string().max(64).optional(),
            revisions: classificationRevisions,
        })
        .strict()
        .refine((value) => value.tag !== undefined || value.urgency !== undefined || value.complexity !== undefined),
    messages: z
        .object({
            text: z.string().max(4000).default(''),
            attachment_ids: z.array(uuid).max(10).default([]),
            draft_origin: z.enum(['ai']).optional(),
            macro_id: uuid.optional(),
            confirm_collision: z.boolean().optional(),
            close_after: z.boolean().optional(),
        })
        .strict(),
    notes: z
        .object({
            text: z.string().trim().min(1).max(4000),
            mention_ids: z.array(uuid).max(20).default([]),
            learnable: z.boolean().default(false),
        })
        .strict(),
    release: z.object({}).strict(),
    team: z.object({ team_id: uuid.nullable(), release: z.boolean().default(false) }).strict(),
    close: z.object({ note: z.string().max(2000).optional() }).strict(),
    reopen: z.object({ reason: z.string().trim().min(1).max(2000), employee_id: uuid.optional() }).strict(),
    wait: z.object({}).strict(),
    resume: z.object({}).strict(),
};
