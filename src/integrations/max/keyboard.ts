import { Keyboard } from '@maxhub/max-bot-api';

export const consentKeyboard = (buttons: { text: string; payload: string }[]) =>
    Keyboard.inlineKeyboard([buttons.map((button) => Keyboard.button.callback(button.text, button.payload))]);
