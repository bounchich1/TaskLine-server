import type { MaxTransport } from '../../integrations/max/index.js';
import type { Role } from '../../shared/access.js';
import type { Config } from '../../shared/config.js';
import type { Database } from '../../shared/db.js';

import { readCodeCommand, type CodeCommand } from './code-command.js';
import { parseRoleCodes, roleFor, type RoleCode } from './role-codes.js';
import { grantRole, type GrantOutcome } from './role-grant.js';

const ROLE_LABELS: Record<Role, string> = {
    support: 'Сотрудник поддержки',
    supervisor: 'Руководитель',
    admin: 'Администратор',
};

const WRONG_CODE = 'Код не подошёл. Отправьте его одним сообщением: /code ВАШ-КОД';

export class DemoRoles {
    private readonly codes: RoleCode[];

    constructor(
        private readonly db: Database,
        private readonly config: Config,
        private readonly transport: Pick<MaxTransport, 'send'>,
    ) {
        this.codes = parseRoleCodes(config.DEMO_ROLE_CODES);
    }

    read(raw: string): CodeCommand | undefined {
        return readCodeCommand(raw);
    }

    async apply(command: CodeCommand): Promise<string | undefined> {
        if (command.edited) {
            return undefined;
        }

        const role = roleFor(this.codes, command.code);

        if (!role) {
            return WRONG_CODE;
        }

        const outcome = await this.db.tx((tx) => grantRole(tx, this.config.ORG_ID, { ...command, role }));

        return outcomeText(outcome, ROLE_LABELS[role]);
    }

    async reply(chatId: string, text: string): Promise<void> {
        await this.transport.send(chatId, { text });
    }
}

function outcomeText(outcome: GrantOutcome, label: string): string {
    switch (outcome) {
        case 'blocked':
            return 'Ваша учётная запись сотрудника заблокирована администратором, код не применён.';
        case 'unchanged':
            return `У вас уже роль «${label}». Откройте приложение кнопкой в этом чате.`;
        default:
            return (
                `Роль «${label}» выдана. Откройте приложение кнопкой в этом чате. ` +
                'Если приложение уже открыто, закройте его и откройте снова.'
            );
    }
}
