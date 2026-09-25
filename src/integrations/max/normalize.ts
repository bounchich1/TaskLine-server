import { hash } from '../../shared/crypto.js';
import { decimalId, jsonText, object, strictJson } from '../../shared/json.js';
import type { ClientInput, InputAttachment } from '../../shared/types/client-input.js';

const MAX_UPDATE_BYTES = 1024 * 1024;
const MAX_ATTACHMENTS = 11;
const MAX_MESSAGE_ID_LENGTH = 256;
const ATTACHMENT_KINDS = ['image', 'video', 'file'];

type Update = Record<string, unknown>;

export function normalizeUpdate(raw: string): ClientInput {
    const update = object(strictJson(raw, true, MAX_UPDATE_BYTES));
    const kind = jsonText(update.update_type);
    const unknown: ClientInput = { kind: 'unknown', sourceKey: `unknown:${hash(raw)}` };

    switch (kind) {
        case 'bot_started':
            return botStarted(update) ?? unknown;
        case 'message_callback':
            return callback(update) ?? unknown;
        case 'message_removed':
            return removal(update) ?? unknown;
        case 'message_created':
        case 'message_edited':
            return message(update, { kind, raw }) ?? unknown;
        default:
            return unknown;
    }
}

function botStarted(update: Update): ClientInput | undefined {
    const user = object(update.user);

    if (user.is_bot) {
        return undefined;
    }

    return {
        kind: 'started',
        sourceKey: `started:${decimalId(user.user_id)}:${jsonText(update.timestamp)}`,
        userId: decimalId(user.user_id),
        chatId: decimalId(update.chat_id),
    };
}

function callback(update: Update): ClientInput | undefined {
    const pressed = object(update.callback);
    const user = object(pressed.user);
    const recipient = object(object(update.message).recipient);

    if (user.is_bot || recipient.chat_type !== 'dialog') {
        return undefined;
    }

    return {
        kind: 'callback',
        sourceKey: `callback:${jsonText(pressed.callback_id)}`,
        userId: decimalId(user.user_id),
        chatId: decimalId(recipient.chat_id),
        callbackId: jsonText(pressed.callback_id),
        callbackPayload: jsonText(pressed.payload ?? ''),
    };
}

function removal(update: Update): ClientInput | undefined {
    if (!update.user_id || !update.chat_id || !update.message_id) {
        return undefined;
    }

    return {
        kind: 'delete',
        sourceKey: `delete:${jsonText(update.message_id)}:${jsonText(update.timestamp)}`,
        userId: decimalId(update.user_id),
        chatId: decimalId(update.chat_id),
        messageId: jsonText(update.message_id),
    };
}

function message(
    update: Update,
    { kind, raw }: { kind: 'message_created' | 'message_edited'; raw: string },
): ClientInput | undefined {
    const sent = object(update.message);
    const sender = object(sent.sender);
    const recipient = object(sent.recipient);
    const body = object(sent.body);

    if (sender.is_bot || recipient.chat_type !== 'dialog') {
        return undefined;
    }

    const attachments = parseAttachments(body.attachments);
    const id = jsonText(body.mid ?? '');

    if (!id || id.length > MAX_MESSAGE_ID_LENGTH) {
        throw new Error('missing_message_id');
    }

    const edited = kind === 'message_edited';

    return {
        kind: edited ? 'edit' : 'message',
        sourceKey: `${kind}:${id}${edited ? `:${hash(raw)}` : ''}`,
        userId: decimalId(sender.user_id),
        chatId: decimalId(recipient.chat_id),
        messageId: id,
        text: typeof body.text === 'string' ? body.text : '',
        timestamp: typeof sent.timestamp === 'number' ? sent.timestamp : undefined,
        attachments,
    };
}

function parseAttachments(raw: unknown): InputAttachment[] {
    const items: unknown[] = Array.isArray(raw) ? raw.slice(0, MAX_ATTACHMENTS) : [];
    const attachments: InputAttachment[] = [];

    for (const item of items) {
        const attachment = object(item);
        const type = jsonText(attachment.type);

        if (!ATTACHMENT_KINDS.includes(type)) {
            continue;
        }

        const payload = object(attachment.payload ?? {});

        attachments.push({
            kind: attachment.type as InputAttachment['kind'],
            filename: jsonText(attachment.filename ?? type),
            url: typeof payload.url === 'string' ? payload.url : undefined,
            token: typeof payload.token === 'string' ? payload.token : undefined,
        });
    }

    return attachments;
}
