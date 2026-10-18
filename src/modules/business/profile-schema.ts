import { z } from 'zod';

export const toneSchema = z.enum(['formal', 'friendly']);
export const ruleText = z.string().trim().min(1).max(120);

export const glossaryEntry = z
    .object({ term: z.string().trim().min(1).max(40), meaning: z.string().trim().min(1).max(120) })
    .strict();

export type GlossaryEntry = z.infer<typeof glossaryEntry>;

export const profileBody = z
    .object({
        description: z.string().trim().max(500),
        offerings: z.string().trim().max(500),
        tone: toneSchema,
        rules: z.array(ruleText).max(8),
        glossary: z.array(glossaryEntry).max(20),
        configured: z.boolean(),
    })
    .strict();

export type ProfileBody = z.infer<typeof profileBody>;
