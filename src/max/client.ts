import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';

import { Keyboard } from '@maxhub/max-bot-api';
import { fetch, FormData } from 'undici';

import type { Config } from '../config.js';
import { object, strictJson } from '../json.js';
import { boundedText, mediaFetch } from '../network.js';
import type { Row } from '../types.js';

export class TransportFailure extends Error {
  constructor(
    public outcome: 'unknown' | 'retry' | 'failed',
    public reason: string,
    public retryAfter = 2,
  ) {
    super(reason);
  }
}
export interface MaxTransport {
  send(chatId: string, body: Row): Promise<string>;
  answer(callbackId: string, text: string): Promise<void>;
  upload(kind: string, path: string, name: string, mime: string): Promise<Row>;
}
export const consentKeyboard = (buttons: { text: string; payload: string }[]) =>
  Keyboard.inlineKeyboard([buttons.map((b) => Keyboard.button.callback(b.text, b.payload))]);

export class MaxClient implements MaxTransport {
  constructor(
    private c: Config,
    private rate: () => Promise<void> = async () => {},
  ) {}
  async request(path: string, body: Row, query: Record<string, string> = {}): Promise<Row> {
    await this.rate();
    const url = new URL(path, this.c.MAX_API_URL);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: this.c.MAX_BOT_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new TransportFailure('unknown', 'max_transport_uncertain');
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new TransportFailure(
        'retry',
        'max_rate_limited',
        Math.min(3600, Math.max(2, Number(response.headers.get('retry-after')) || 2)),
      );
    }
    if (response.status >= 500) {
      await response.body?.cancel();
      throw new TransportFailure('unknown', 'max_server_uncertain');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TransportFailure('failed', `max_rejected_${response.status}`);
    }
    try {
      const result = object(strictJson(await boundedText(response), true, 1024 * 1024));
      if (result.success === false) {
        throw new TransportFailure(
          result.code === 'attachment.not.ready' ? 'retry' : 'failed',
          String(result.code ?? 'max_rejected'),
        );
      }
      return result;
    } catch (error) {
      if (error instanceof TransportFailure) {
        throw error;
      }
      throw new TransportFailure('unknown', 'max_invalid_response');
    }
  }
  async send(chatId: string, body: Row) {
    if (this.c.MAX_MODE === 'mock') {
      return `mock-${randomUUID()}`;
    }
    const result = await this.request(
      '/messages',
      { ...body, notify: true },
      { chat_id: chatId, disable_link_preview: 'true' },
    );
    const message = object(result.message);
    const responseBody = object(message.body);
    if (typeof responseBody.mid !== 'string') {
      throw new TransportFailure('unknown', 'max_missing_message_id');
    }
    return responseBody.mid;
  }
  async answer(callbackId: string, text: string) {
    if (this.c.MAX_MODE === 'mock') {
      return;
    }
    await this.request('/answers', { notification: text }, { callback_id: callbackId });
  }
  async upload(kind: string, path: string, name: string, mime: string): Promise<Row> {
    if (this.c.MAX_MODE === 'mock') {
      return { type: kind, payload: { token: `mock-${randomUUID()}` } };
    }
    const allocation = await this.request('/uploads', {}, { type: kind });
    if (typeof allocation.url !== 'string') {
      throw new TransportFailure('failed', 'invalid_upload_url');
    }
    const form = new FormData();
    form.set('data', await openAsBlob(path, { type: mime }), name);
    const media = await mediaFetch(
      allocation.url,
      this.c.MAX_MEDIA_HOSTS.split(',')
        .map((h) => h.trim())
        .filter(Boolean),
      { method: 'POST', body: form },
    );
    try {
      if (!media.response.ok) {
        throw new TransportFailure('retry', 'upload_failed');
      }
      const result = object(strictJson(await boundedText(media.response), true, 1024 * 1024));
      if (kind === 'video') {
        if (typeof allocation.token !== 'string') {
          throw new TransportFailure('failed', 'video_token_missing');
        }
        return { type: kind, payload: { token: allocation.token } };
      }
      if (kind === 'image') {
        const photos = object(result.photos);
        const photo = object(Object.values(photos)[0]);
        if (typeof photo.token !== 'string') {
          throw new TransportFailure('failed', 'image_token_missing');
        }
        return { type: 'image', payload: { token: photo.token } };
      }
      if (typeof result.token !== 'string') {
        throw new TransportFailure('failed', 'file_token_missing');
      }
      return { type: 'file', payload: { token: result.token } };
    } finally {
      await media.close();
    }
  }
}
