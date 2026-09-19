import {
  clearPreconsentBuffers,
  declineConsent,
  grantConsent,
  listPreconsentBuffers,
  passesConsentGate,
  PreconsentExpiry,
  sendConsentPrompt,
  withdrawConsent,
} from './modules/consent/index.js';
import { reviseClientMessage } from './modules/messages/index.js';
import { queueBotMessage, queueCallbackAnswer } from './modules/outbox/index.js';
import { RatingTimers } from './modules/ratings/index.js';
import { handleClientContent, sendTicketHistory, TicketCommands } from './modules/tickets/index.js';
import type { Config } from './shared/config.js';
import { createCtx } from './shared/context.js';
import { decrypt, encrypt } from './shared/crypto.js';
import { one, type Database, type Sql } from './shared/db.js';
import type { ClientInput } from './shared/types/client-input.js';
import type { Client, Employee, Row, Ticket } from './shared/types/entities.js';

export class Domain {
  constructor(
    readonly db: Database,
    readonly config: Config,
  ) {}
  get ctx() {
    return createCtx(this.config);
  }
  get org() {
    return this.config.ORG_ID;
  }

  async ingest(input: ClientInput): Promise<void> {
    await this.db.tx(async (tx) => {
      if (
        await one(tx, 'SELECT id FROM inbox WHERE org_id=$1 AND source_key=$2', [
          this.org,
          input.sourceKey,
        ])
      ) {
        return;
      }
      if (!input.userId || !input.chatId || input.kind === 'unknown') {
        await tx.query(
          "INSERT INTO inbox(org_id,source_key,kind,state,reason) VALUES($1,$2,$3,'quarantined','unsupported_update') ON CONFLICT DO NOTHING",
          [this.org, input.sourceKey, input.kind],
        );
        return;
      }
      await tx.query(
        'INSERT INTO clients(org_id,max_user_id,chat_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [this.org, input.userId, input.chatId],
      );
      const client = await one<Client>(
        tx,
        'SELECT * FROM clients WHERE org_id=$1 AND max_user_id=$2 FOR UPDATE',
        [this.org, input.userId],
      );
      // A MAX direct user has one dialog; unexpected changes are quarantined for review.
      if (client!.chat_id !== input.chatId) {
        await tx.query(
          "INSERT INTO inbox(org_id,source_key,client_id,kind,state,reason) VALUES($1,$2,$3,$4,'quarantined','chat_mismatch') ON CONFLICT DO NOTHING",
          [this.org, input.sourceKey, client!.id, input.kind],
        );
        return;
      }
      if (
        await one(tx, 'SELECT id FROM inbox WHERE org_id=$1 AND source_key=$2', [
          this.org,
          input.sourceKey,
        ])
      ) {
        return;
      }
      const seq = await one(
        tx,
        'UPDATE clients SET next_ingress=next_ingress+1 WHERE id=$1 RETURNING next_ingress',
        [client!.id],
      );
      await tx.query(
        'INSERT INTO inbox(org_id,source_key,client_id,ingress_seq,kind,payload) VALUES($1,$2,$3,$4,$5,$6)',
        [
          this.org,
          input.sourceKey,
          client!.id,
          seq!.next_ingress,
          input.kind,
          encrypt(input, this.config.ENCRYPTION_KEY),
        ],
      );
    });
  }

  async processClient(clientId: string): Promise<boolean> {
    return this.db.tx(async (tx) => {
      const client = await one<Client>(
        tx,
        'SELECT * FROM clients WHERE org_id=$1 AND id=$2 FOR UPDATE',
        [this.org, clientId],
      );
      if (!client) {
        return false;
      }
      const receipt = await one<
        Row & { id: string; payload: string; source_key: string; received_at: string }
      >(
        tx,
        "SELECT * FROM inbox WHERE org_id=$1 AND client_id=$2 AND state='pending' ORDER BY ingress_seq LIMIT 1 FOR UPDATE",
        [this.org, client.id],
      );
      if (!receipt) {
        return false;
      }
      const input = decrypt<ClientInput>(receipt.payload, this.config.ENCRYPTION_KEY);
      await this.route(tx, client, input, receipt.received_at);
      await tx.query("UPDATE inbox SET state='done',payload=NULL,processed_at=now() WHERE id=$1", [
        receipt.id,
      ]);
      return true;
    });
  }

  async bot(
    tx: Sql,
    client: Client,
    code: string,
    key: string,
    ticket?: Ticket,
    cycleId?: string,
    extra: Row = {},
  ) {
    await queueBotMessage(tx, this.ctx, { client, template: code, key, ticket, cycleId, extra });
  }

  async consentPrompt(tx: Sql, client: Client, sourceKey: string) {
    await sendConsentPrompt(tx, this.ctx, client, sourceKey);
  }

  async route(tx: Sql, client: Client, input: ClientInput, receivedAt: string) {
    if (input.kind === 'callback') {
      const action = await one(
        tx,
        'SELECT * FROM callback_actions WHERE nonce=$1 AND org_id=$2 AND client_id=$3 AND expires_at>now() FOR UPDATE',
        [input.callbackPayload ?? '', this.org, client.id],
      );
      await queueCallbackAnswer(tx, this.ctx, client, {
        sourceKey: input.sourceKey,
        callbackId: input.callbackId,
        notification: action ? 'Принято' : 'Кнопка устарела',
      });
      if (!action || action.used_at) {
        return;
      }
      await tx.query('UPDATE callback_actions SET used_at=now() WHERE nonce=$1', [
        input.callbackPayload,
      ]);
      if (action.policy_version !== this.config.POLICY_VERSION) {
        await this.consentPrompt(tx, client, input.sourceKey);
        return;
      }
      if (action.action === 'accept') {
        const granted = await grantConsent(tx, this.ctx, client, input.sourceKey);
        if (!granted) {
          return;
        }
        client = granted;
        const buffers = await listPreconsentBuffers(tx, client.id);
        const now = await one(tx, 'SELECT now() AS now');
        let expired = false;
        for (const buffer of buffers) {
          if (new Date(buffer.expires_at).getTime() <= new Date(String(now!.now)).getTime()) {
            expired = true;
            continue;
          }
          await this.content(
            tx,
            client,
            decrypt<ClientInput>(buffer.payload, this.config.ENCRYPTION_KEY),
            buffer.created_at,
          );
        }
        await clearPreconsentBuffers(tx, client.id);
        if (expired) {
          await this.bot(tx, client, 'buffer_expired', `expired:${input.sourceKey}`);
        }
      } else if (action.action === 'decline') {
        await declineConsent(tx, this.ctx, client, input.sourceKey);
      }
      return;
    }
    if (input.kind === 'edit' || input.kind === 'delete') {
      await this.reviseMessage(tx, client, input);
      return;
    }
    const command = input.text?.trim().toLowerCase();
    if (command === '/withdraw' || command === 'отозвать согласие') {
      await this.withdraw(tx, client, input.sourceKey);
      return;
    }
    if (command === '/tickets' || command === 'мои обращения') {
      await sendTicketHistory(tx, this.ctx, client, input.sourceKey);
      return;
    }
    if (!(await passesConsentGate(tx, this.ctx, client, input))) {
      return;
    }
    if (input.kind === 'started' || command === '/start') {
      await this.bot(tx, client, 'consent_accepted', `ready:${input.sourceKey}`);
      return;
    }
    await this.content(tx, client, input, receivedAt);
  }

  async content(tx: Sql, client: Client, input: ClientInput, receivedAt: string) {
    await handleClientContent(tx, this.ctx, { client, input, receivedAt });
  }

  async withdraw(tx: Sql, client: Client, key: string) {
    await withdrawConsent(tx, this.ctx, client, key);
  }

  async reviseMessage(tx: Sql, client: Client, input: ClientInput) {
    await reviseClientMessage(tx, this.ctx, client, input);
  }

  async command(
    employee: Employee,
    ticketId: string,
    name: string,
    body: Row,
    expected: number,
    key: string,
  ) {
    return new TicketCommands(this.db, this.config).run({
      actor: employee,
      ticketId,
      name,
      body,
      expectedVersion: expected,
      idempotencyKey: key,
    });
  }

  async timers() {
    await new RatingTimers(this.db, this.config).run();
    await new PreconsentExpiry(this.db, this.config).run();
  }
}
