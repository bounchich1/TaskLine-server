import { Keyboard } from '@maxhub/max-bot-api';

/** Inline keyboard with one row of callback buttons (payload is an opaque nonce). */
export const consentKeyboard = (buttons: { text: string; payload: string }[]) =>
  Keyboard.inlineKeyboard([
    buttons.map((button) => Keyboard.button.callback(button.text, button.payload)),
  ]);
