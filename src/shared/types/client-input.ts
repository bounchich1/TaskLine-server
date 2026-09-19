// A normalized inbound update from a client in MAX (produced by integrations/max).
export type InputAttachment = {
  kind: 'image' | 'video' | 'file';
  filename: string;
  url?: string;
  token?: string;
  mime?: string;
};
export type ClientInput = {
  kind: 'message' | 'edit' | 'delete' | 'callback' | 'started' | 'unknown';
  userId?: string;
  chatId?: string;
  sourceKey: string;
  messageId?: string;
  text?: string;
  timestamp?: number;
  attachments?: InputAttachment[];
  callbackId?: string;
  callbackPayload?: string;
};
