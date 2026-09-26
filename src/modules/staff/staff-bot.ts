import { copyKeyboard, normalizeUpdate, type MaxTransport } from '../../integrations/max/index.js';
import type { ClientInput } from '../../shared/types/client-input.js';

const ANSWERED_KINDS = new Set<ClientInput['kind']>(['started', 'message']);

export class StaffBot {
    constructor(private transport: Pick<MaxTransport, 'send'>) {}

    async answer(raw: string): Promise<void> {
        const input = parseUpdate(raw);

        if (!ANSWERED_KINDS.has(input.kind) || !input.userId || !input.chatId) {
            return;
        }

        await this.transport.send(input.chatId, {
            text: idMessage(input.userId),
            attachments: [copyKeyboard('Скопировать ID', input.userId)],
        });
    }
}

function parseUpdate(raw: string): ClientInput {
    try {
        return normalizeUpdate(raw);
    } catch {
        return { kind: 'unknown', sourceKey: 'malformed' };
    }
}

function idMessage(userId: string): string {
    return (
        `Ваш MAX ID: ${userId}\n\n` +
        'Чтобы получить доступ к приложению службы поддержки, передайте этот номер администратору. ' +
        'После добавления откройте приложение кнопкой в этом чате.'
    );
}
