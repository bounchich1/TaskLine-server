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

export const menuKeyboard = () =>
    Keyboard.inlineKeyboard([
        [Keyboard.button.message(MENU_LABELS.tickets), Keyboard.button.message(MENU_LABELS.help)],
        [Keyboard.button.message(MENU_LABELS.withdraw)],
    ]);
