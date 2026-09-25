import type { TriageResult } from './ai.js';

export type Row = Record<string, unknown>;

export type Employee = Row & {
    id: string;
    org_id: string;
    max_user_id: string;
    name: string;
    role: 'support' | 'supervisor' | 'admin';
    blocked: boolean;
    version: number;
};

export type Client = Row & {
    id: string;
    org_id: string;
    max_user_id: string;
    chat_id: string;
    consent_state: string;
    consent_version: string | null;
    consent_revision: number;
    next_ingress: string;
};

export type Ticket = Row & {
    id: string;
    org_id: string;
    client_id: string;
    ticket_number: number;
    status: 'open' | 'in_progress' | 'awaiting_rating' | 'closed';
    description: string;
    assignee_id: string | null;
    version: number;
    lifecycle: number;
    last_message_seq: number;
    current_cycle_id: string | null;
    tag: string;
    urgency: string;
    complexity: string;
    tag_revision: number;
    urgency_revision: number;
    complexity_revision: number;
    ai_status: string;
    suggestion: TriageResult | null;
    consent_revision: number;
};

export type Message = Row & {
    id: string;
    ticket_id: string;
    seq: number;
    author_type: string;
    text: string;
    delivery_state: string;
    deleted: boolean;
    revision: number;
};

export type Closure = Row & {
    id: string;
    ticket_id: string;
    lifecycle: number;
    cutoff_seq: number;
    expires_at: string;
    closed_at: string;
    invalid_attempts: number;
    invalidated: boolean;
    snapshot: string | null;
    coverage: Row | null;
    note: string | null;
};

export type Job = Row & {
    id: string;
    org_id: string;
    kind: string;
    ref_id: string;
    payload: Row;
    generation: number;
    state: string;
    attempts: number;
    created_at: string;
};
