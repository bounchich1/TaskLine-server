import { decimalId, object, strictJson } from '../json.js';
import { hash } from '../crypto.js';
import type { ClientInput, InputAttachment } from '../types.js';

export function normalizeUpdate(raw: string): ClientInput {
  const update = object(strictJson(raw,true,1024*1024)); const kind = String(update.update_type);
  const unknown: ClientInput = {kind:'unknown',sourceKey:`unknown:${hash(raw)}`};
  if (kind === 'bot_started') {
    const user = object(update.user); if (user.is_bot) return unknown;
    return {kind:'started',sourceKey:`started:${decimalId(user.user_id)}:${String(update.timestamp)}`,userId:decimalId(user.user_id),chatId:decimalId(update.chat_id)};
  }
  if (kind === 'message_callback') {
    const callback = object(update.callback); const user = object(callback.user);
    const message = object(update.message); const recipient = object(message.recipient);
    if (user.is_bot || recipient.chat_type !== 'dialog') return unknown;
    return {kind:'callback',sourceKey:`callback:${String(callback.callback_id)}`,userId:decimalId(user.user_id),chatId:decimalId(recipient.chat_id),callbackId:String(callback.callback_id),callbackPayload:String(callback.payload ?? '')};
  }
  if (kind === 'message_removed') {
    if (!update.user_id || !update.chat_id || !update.message_id) return unknown;
    return {kind:'delete',sourceKey:`delete:${String(update.message_id)}:${String(update.timestamp)}`,userId:decimalId(update.user_id),chatId:decimalId(update.chat_id),messageId:String(update.message_id)};
  }
  if (!['message_created','message_edited'].includes(kind)) return unknown;
  const message = object(update.message); const sender = object(message.sender); const recipient = object(message.recipient); const body = object(message.body);
  if (sender.is_bot || recipient.chat_type !== 'dialog') return unknown;
  const attachments: InputAttachment[] = [];
  for (const item of Array.isArray(body.attachments) ? body.attachments.slice(0,11) : []) {
    const attachment = object(item); if (!['image','video','file'].includes(String(attachment.type))) continue;
    const payload = object(attachment.payload ?? {});
    attachments.push({kind:attachment.type as InputAttachment['kind'],filename:String(attachment.filename ?? `${attachment.type}`),url: typeof payload.url==='string'?payload.url:undefined,token:typeof payload.token==='string'?payload.token:undefined});
  }
  const id = String(body.mid ?? ''); if (!id || id.length>256) throw new Error('missing_message_id');
  return {kind:kind==='message_created'?'message':'edit',sourceKey:`${kind}:${id}${kind==='message_edited'?`:${hash(raw)}`:''}`,
    userId:decimalId(sender.user_id),chatId:decimalId(recipient.chat_id),messageId:id,text:typeof body.text==='string'?body.text:'',
    timestamp:typeof message.timestamp==='number'?message.timestamp:undefined,attachments};
}
