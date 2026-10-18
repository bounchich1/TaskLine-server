import { Keyboard } from '@maxhub/max-bot-api';

export const MENU_LABELS = {
    tickets: 'Мои обращения',
    help: 'Помощь',
    withdraw: 'Отозвать согласие',
} as const;

export const BOT_COMMANDS = [
    { name: 'tickets', description: 'Мои обращения' },
    { name: 'help', description: 'Как пользоваться ботом' },
    { name: 'withdraw', description: 'Отозвать согласие на обработку данных' },
];

export const menuKeyboard = (labels: Record<keyof typeof MENU_LABELS, string> = MENU_LABELS) =>
    Keyboard.inlineKeyboard([
        [Keyboard.button.message(labels.tickets), Keyboard.button.message(labels.help)],
        [Keyboard.button.message(labels.withdraw)],
    ]);
