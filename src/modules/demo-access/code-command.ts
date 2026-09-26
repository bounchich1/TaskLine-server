import { normalizeUpdate } from '../../integrations/max/index.js';
import { object, strictJson } from '../../shared/json.js';
import type { ClientInput } from '../../shared/types/client-input.js';

const MAX_UPDATE_BYTES = 1024 * 1024;
const MAX_NAME_LENGTH = 120;
const COMMAND = /^\/code(?=\s|$)\s*([\s\S]*)$/i;

export interface CodeCommand {
    edited: boolean;
    userId: string;
    chatId: string;
    name: string;
    code: string;
}

export function readCodeCommand(raw: string): CodeCommand | undefined {
    const input = parseUpdate(raw);

    if ((input.kind !== 'message' && input.kind !== 'edit') || !input.userId || !input.chatId) {
        return undefined;
    }

    const match = COMMAND.exec(input.text?.trim() ?? '');

    if (!match) {
        return undefined;
    }

    return {
        edited: input.kind === 'edit',
        userId: input.userId,
        chatId: input.chatId,
        name: senderName(raw, input.userId),
        code: match[1].trim(),
    };
}

function parseUpdate(raw: string): ClientInput {
    try {
        return normalizeUpdate(raw);
    } catch {
        return { kind: 'unknown', sourceKey: 'malformed' };
    }
}

function senderName(raw: string, userId: string): string {
    const sender = object(object(object(strictJson(raw, true, MAX_UPDATE_BYTES)).message).sender);
    const parts = [sender.first_name, sender.last_name].filter((part) => typeof part === 'string');
    const name = parts.join(' ').trim() || (typeof sender.name === 'string' ? sender.name.trim() : '');

    return (name || `Эксперт ${userId}`).slice(0, MAX_NAME_LENGTH);
}
