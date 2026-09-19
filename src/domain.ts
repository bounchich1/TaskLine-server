import { randomUUID } from 'node:crypto';

import type { Config } from './config.js';
import { decrypt, encrypt, hash, token } from './crypto.js';
import { one, type Database, type Sql } from './db.js';
import { ensure } from './errors.js';
import { audit, emit, enqueue } from './events.js';
import { consentKeyboard } from './max/client.js';
import { parseRating } from './rating.js';
import { render } from './templates.js';
import type { Client, ClientInput, Closure, Employee, Message, Row, Ticket } from './types.js';

export class Domain {
  constructor(
    readonly db: Database,
    readonly config: Config,
  ) {}
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
    if (await one(tx, 'SELECT id FROM deliveries WHERE logical_key=$1', [key])) {
      return;
    }
    const text = await render(tx, this.org, code, {
      ticket_number: ticket?.ticket_number.toString().padStart(6, '0') ?? '',
      policy_url: this.config.POLICY_URL,
      alternative_contact: this.config.ALTERNATIVE_CONTACT,
    });
    const message = ticket
      ? await this.addMessage(tx, ticket, 'bot', null, text, null, 'queued')
      : undefined;
    await tx.query(
      'INSERT INTO deliveries(org_id,client_id,ticket_id,message_id,cycle_id,logical_key,kind,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        this.org,
        client.id,
        ticket?.id ?? null,
        message?.id ?? null,
        cycleId ?? null,
        key,
        code,
        JSON.stringify({ text, ...extra }),
      ],
    );
  }

  async consentPrompt(tx: Sql, client: Client, sourceKey: string) {
    const buttons = [];
    for (const [action, label] of [
      ['accept', 'Согласен'],
      ['decline', 'Отказаться'],
    ]) {
      const nonce = token();
      await tx.query(
        'INSERT INTO callback_actions(nonce,org_id,client_id,action,policy_version) VALUES($1,$2,$3,$4,$5)',
        [nonce, this.org, client.id, action, this.config.POLICY_VERSION],
      );
      buttons.push({ type: 'callback', text: label, payload: nonce });
    }
    await this.bot(tx, client, 'consent_request', `consent:${sourceKey}`, undefined, undefined, {
      attachments: [consentKeyboard(buttons)],
    });
  }

  async route(tx: Sql, client: Client, input: ClientInput, receivedAt: string) {
    if (input.kind === 'callback') {
      const action = await one(
        tx,
        'SELECT * FROM callback_actions WHERE nonce=$1 AND org_id=$2 AND client_id=$3 AND expires_at>now() FOR UPDATE',
        [input.callbackPayload ?? '', this.org, client.id],
      );
      await tx.query(
        `INSERT INTO deliveries(org_id,client_id,logical_key,kind,body) VALUES($1,$2,$3,'callback_answer',$4) ON CONFLICT DO NOTHING`,
        [
          this.org,
          client.id,
          `answer:${input.sourceKey}`,
          JSON.stringify({
            callback_id: input.callbackId,
            notification: action ? 'Принято' : 'Кнопка устарела',
          }),
        ],
      );
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
        if (
          client.consent_state === 'granted' &&
          client.consent_version === this.config.POLICY_VERSION
        ) {
          return;
        }
        client = (await one<Client>(
          tx,
          "UPDATE clients SET consent_state='granted',consent_version=$2,consent_at=now(),consent_revision=consent_revision+1 WHERE id=$1 RETURNING *",
          [client.id, this.config.POLICY_VERSION],
        ))!;
        await tx.query(
          "INSERT INTO consent_events(org_id,client_id,action,policy_version) VALUES($1,$2,'grant',$3)",
          [this.org, client.id, this.config.POLICY_VERSION],
        );
        await this.bot(tx, client, 'consent_accepted', `accepted:${input.sourceKey}`);
        const buffers = (
          await tx.query<Row & { payload: string; expires_at: string; created_at: string }>(
            'SELECT * FROM preconsent_buffers WHERE client_id=$1 ORDER BY created_at,id',
            [client.id],
          )
        ).rows;
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
        await tx.query('DELETE FROM preconsent_buffers WHERE client_id=$1', [client.id]);
        if (expired) {
          await this.bot(tx, client, 'buffer_expired', `expired:${input.sourceKey}`);
        }
      } else if (action.action === 'decline') {
        // An old decline button cannot revoke a consent already granted by a newer action.
        if (client.consent_state === 'granted') {
          return;
        }
        await tx.query("UPDATE clients SET consent_state='declined' WHERE id=$1", [client.id]);
        await tx.query('DELETE FROM preconsent_buffers WHERE client_id=$1', [client.id]);
        await tx.query(
          "INSERT INTO consent_events(org_id,client_id,action,policy_version) VALUES($1,$2,'decline',$3)",
          [this.org, client.id, this.config.POLICY_VERSION],
        );
        await this.bot(tx, client, 'consent_declined', `declined:${input.sourceKey}`);
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
      const tickets = (
        await tx.query<Ticket>(
          'SELECT * FROM tickets WHERE org_id=$1 AND client_id=$2 ORDER BY created_at DESC LIMIT 20',
          [this.org, client.id],
        )
      ).rows;
      const status = {
        open: 'Открыта',
        in_progress: 'В работе',
        awaiting_rating: 'Ожидает оценки',
        closed: 'Закрыта',
      };
      const text = tickets.length
        ? tickets
            .map((t) => `№${String(t.ticket_number).padStart(6, '0')} — ${status[t.status]}`)
            .join('\n')
        : 'У вас пока нет обращений.';
      await tx.query(
        "INSERT INTO deliveries(org_id,client_id,logical_key,kind,body) VALUES($1,$2,$3,'history_page',$4) ON CONFLICT DO NOTHING",
        [this.org, client.id, `history:${input.sourceKey}`, JSON.stringify({ text })],
      );
      return;
    }
    const slot = await one<Ticket>(
      tx,
      "SELECT * FROM tickets WHERE org_id=$1 AND client_id=$2 AND status<>'closed'",
      [this.org, client.id],
    );
    const consent =
      client.consent_state === 'granted' &&
      (slot || client.consent_version === this.config.POLICY_VERSION);
    if (!consent) {
      if (input.kind === 'message' && command !== '/start') {
        const bytes = Buffer.byteLength(JSON.stringify(input));
        const size = await one(
          tx,
          'SELECT count(*)::int AS n,coalesce(sum(byte_count),0)::int AS bytes FROM preconsent_buffers WHERE client_id=$1',
          [client.id],
        );
        if (Number(size!.n) < 5 && Number(size!.bytes) + bytes <= 65536) {
          await tx.query(
            'INSERT INTO preconsent_buffers(org_id,client_id,source_key,payload,byte_count) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
            [
              this.org,
              client.id,
              input.sourceKey,
              encrypt(input, this.config.ENCRYPTION_KEY),
              bytes,
            ],
          );
        } else {
          await this.bot(tx, client, 'buffer_full', `bufferfull:${input.sourceKey}`);
        }
      }
      await this.consentPrompt(tx, client, input.sourceKey);
      return;
    }
    if (input.kind === 'started' || command === '/start') {
      await this.bot(tx, client, 'consent_accepted', `ready:${input.sourceKey}`);
      return;
    }
    await this.content(tx, client, input, receivedAt);
  }

  async content(tx: Sql, client: Client, input: ClientInput, receivedAt: string) {
    let ticket = await one<Ticket>(
      tx,
      "SELECT * FROM tickets WHERE org_id=$1 AND client_id=$2 AND status<>'closed' FOR UPDATE",
      [this.org, client.id],
    );
    if (ticket?.status === 'awaiting_rating') {
      await this.rate(tx, client, ticket, input, receivedAt);
      return;
    }
    const text = input.text?.trim() ?? '';
    const attachments = input.attachments ?? [];
    if (text.length > 16000) {
      await this.bot(tx, client, 'input_too_long', `toolong:${input.sourceKey}`);
      return;
    }
    if (attachments.length > 10) {
      await this.bot(tx, client, 'attachment_rejected', `toomany:${input.sourceKey}`);
      return;
    }
    if (!text && !attachments.length) {
      await this.bot(tx, client, 'unsupported_input', `unsupported:${input.sourceKey}`);
      return;
    }
    const created = !ticket;
    if (!ticket) {
      ticket = (await one<Ticket>(
        tx,
        'INSERT INTO tickets(org_id,client_id,description,consent_version,consent_revision,ai_status,review_required) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [
          this.org,
          client.id,
          text || `Вложение: ${attachments.map((a) => a.filename).join(', ')}`,
          client.consent_version,
          client.consent_revision,
          this.config.AI_ENABLED ? 'pending' : 'failed',
          !this.config.AI_ENABLED,
        ],
      ))!;
    }
    const message = await this.addMessage(
      tx,
      ticket,
      'client',
      null,
      text,
      input.messageId ?? null,
      'received',
      input.timestamp,
    );
    for (const file of attachments) {
      const attachment = await one(
        tx,
        'INSERT INTO attachments(org_id,ticket_id,message_id,filename,kind,source_ref,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [
          this.org,
          ticket.id,
          message.id,
          file.filename.slice(0, 200),
          file.kind,
          encrypt(file, this.config.ENCRYPTION_KEY),
          'pending',
        ],
      );
      await enqueue(tx, this.org, `file:${attachment!.id}`, 'file', String(attachment!.id));
    }
    if (created) {
      await this.bot(tx, client, 'ticket_created', `created:${ticket.id}`, ticket);
      const dictionaries = (
        await tx.query(
          'SELECT dimension,code,label,rank,version FROM dictionaries WHERE org_id=$1 AND active ORDER BY dimension,code',
          [this.org],
        )
      ).rows;
      if (this.config.AI_ENABLED) {
        await enqueue(tx, this.org, `triage:${ticket.id}`, 'triage', ticket.id, {
          message_id: message.id,
          revision: 1,
          lifecycle: ticket.lifecycle,
          consent_revision: client.consent_revision,
          dictionaries,
          dictionary_version: hash(JSON.stringify(dictionaries)),
          field_revisions: { tag: 0, urgency: 0, complexity: 0 },
        });
      }
      await emit(tx, this.org, 'ticket.created', ticket.id, { version: ticket.version });
    } else {
      await emit(
        tx,
        this.org,
        'message.from_client',
        ticket.id,
        { message_id: message.id },
        ticket.assignee_id,
      );
    }
  }

  async addMessage(
    tx: Sql,
    ticket: Ticket,
    author: string,
    authorId: string | null,
    text: string,
    providerRef: string | null,
    state: string,
    timestamp?: number,
  ): Promise<Message> {
    const row = await one(
      tx,
      'UPDATE tickets SET last_message_seq=last_message_seq+1,updated_at=now(),version=version+1 WHERE id=$1 RETURNING last_message_seq,version',
      [ticket.id],
    );
    ticket.last_message_seq = Number(row!.last_message_seq);
    ticket.version = Number(row!.version);
    return (await one<Message>(
      tx,
      'INSERT INTO messages(org_id,ticket_id,seq,author_type,author_id,text,provider_ref,delivery_state,provider_sent_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [
        this.org,
        ticket.id,
        ticket.last_message_seq,
        author,
        authorId,
        text,
        providerRef,
        state,
        timestamp && Number.isFinite(timestamp) ? new Date(timestamp) : null,
      ],
    ))!;
  }

  async rate(tx: Sql, client: Client, ticket: Ticket, input: ClientInput, receivedAt: string) {
    const cycle = (await one<Closure>(tx, 'SELECT * FROM closures WHERE id=$1 FOR UPDATE', [
      ticket.current_cycle_id,
    ]))!;
    if (new Date(receivedAt).getTime() > new Date(cycle.expires_at).getTime()) {
      await this.finishRating(tx, client, ticket, cycle, 'expired', input.sourceKey);
      return;
    }
    const value = parseRating(input.text ?? '');
    if (value !== null && !input.attachments?.length) {
      await tx.query(
        "UPDATE closures SET rating=$2,rated_at=now(),finished_reason='rated' WHERE id=$1 AND rating IS NULL",
        [cycle.id, value],
      );
      await tx.query("UPDATE tickets SET status='closed',version=version+1 WHERE id=$1", [
        ticket.id,
      ]);
      await this.cancelRatingPrompts(tx, cycle.id);
      await this.bot(tx, client, 'rating_accepted', `rated:${cycle.id}`, ticket);
      await emit(tx, this.org, 'rating.received', ticket.id, { value }, String(cycle.closed_by));
    } else {
      await tx.query('UPDATE closures SET invalid_attempts=invalid_attempts+1 WHERE id=$1', [
        cycle.id,
      ]);
      if (cycle.invalid_attempts + 1 >= 3) {
        await this.finishRating(tx, client, ticket, cycle, 'attempts_exhausted', input.sourceKey);
      } else {
        await this.bot(
          tx,
          client,
          'rating_invalid',
          `invalid:${input.sourceKey}`,
          ticket,
          cycle.id,
        );
      }
    }
  }

  async cancelRatingPrompts(tx: Sql, cycleId: string) {
    await tx.query(
      "UPDATE messages SET delivery_state='canceled' WHERE id IN (SELECT message_id FROM deliveries WHERE cycle_id=$1 AND state IN ('queued','retry_wait'))",
      [cycleId],
    );
    await tx.query(
      "UPDATE deliveries SET state='canceled' WHERE cycle_id=$1 AND state IN ('queued','retry_wait')",
      [cycleId],
    );
  }
  async finishRating(
    tx: Sql,
    client: Client,
    ticket: Ticket,
    cycle: Closure,
    reason: string,
    key: string,
  ) {
    await tx.query('UPDATE closures SET finished_reason=$2 WHERE id=$1', [cycle.id, reason]);
    await tx.query("UPDATE tickets SET status='closed',version=version+1 WHERE id=$1", [ticket.id]);
    await this.cancelRatingPrompts(tx, cycle.id);
    await this.bot(
      tx,
      client,
      reason === 'attempts_exhausted' ? 'rating_attempts_exhausted' : 'rating_expired',
      `final:${key}`,
      ticket,
    );
    await emit(tx, this.org, 'rating.expired', ticket.id, { reason });
  }

  async withdraw(tx: Sql, client: Client, key: string) {
    if (client.consent_state !== 'withdrawn') {
      await tx.query(
        "UPDATE clients SET consent_state='withdrawn',consent_revision=consent_revision+1 WHERE id=$1",
        [client.id],
      );
      await tx.query(
        'INSERT INTO deletion_tombstones(org_id,client_id,consent_revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [this.org, client.id, client.consent_revision],
      );
      await tx.query(
        "INSERT INTO consent_events(org_id,client_id,action,policy_version) VALUES($1,$2,'withdraw',$3)",
        [this.org, client.id, client.consent_version ?? this.config.POLICY_VERSION],
      );
    }
    await tx.query('DELETE FROM preconsent_buffers WHERE client_id=$1', [client.id]);
    await tx.query('DELETE FROM callback_actions WHERE client_id=$1', [client.id]);
    await tx.query(
      "UPDATE deliveries SET state='canceled' WHERE client_id=$1 AND state IN ('queued','retry_wait')",
      [client.id],
    );
    await tx.query(
      "UPDATE messages SET delivery_state='canceled' WHERE id IN(SELECT message_id FROM deliveries WHERE client_id=$1 AND state='canceled')",
      [client.id],
    );
    const tickets = (
      await tx.query<Ticket>('SELECT * FROM tickets WHERE org_id=$1 AND client_id=$2 FOR UPDATE', [
        this.org,
        client.id,
      ])
    ).rows;
    for (const ticket of tickets) {
      await tx.query(
        "UPDATE tickets SET status='closed',closed_at=coalesce(closed_at,now()),version=version+1,lifecycle=lifecycle+1,suggestion=NULL,ai_status=CASE WHEN ai_status='pending' THEN 'failed' ELSE ai_status END WHERE id=$1",
        [ticket.id],
      );
      await this.invalidateLearning(tx, ticket.id, 'withdrawn');
      await emit(tx, this.org, 'consent.withdrawn', ticket.id);
    }
    await this.bot(tx, client, 'consent_withdrawn', `withdrawn:${key}`);
    await audit(tx, this.org, null, 'consent.withdrawn', client.id);
  }

  async invalidateLearning(tx: Sql, ticketId: string, reason: string) {
    await tx.query(
      "UPDATE closures SET invalidated=true,learning_status='invalidated' WHERE ticket_id=$1",
      [ticketId],
    );
    const records = (
      await tx.query(
        'UPDATE memory_records SET eligible=false,reason=$2 WHERE ticket_id=$1 RETURNING id',
        [ticketId, reason],
      )
    ).rows;
    for (const record of records) {
      await enqueue(
        tx,
        this.org,
        `memory-delete:${record.id}:${reason}`,
        'memory_delete',
        String(record.id),
      );
    }
    await tx.query(
      "UPDATE jobs SET state='canceled',reason=$2 WHERE (ref_id=$1 OR ref_id IN(SELECT id FROM closures WHERE ticket_id=$1)) AND kind IN('triage','learning') AND state IN('pending','running')",
      [ticketId, reason],
    );
  }

  async reviseMessage(tx: Sql, client: Client, input: ClientInput) {
    if (client.consent_state !== 'granted') {
      return;
    }
    const message = await one<Message>(
      tx,
      "SELECT m.* FROM messages m JOIN tickets t ON t.id=m.ticket_id WHERE m.org_id=$1 AND t.client_id=$2 AND m.provider_ref=$3 AND m.author_type='client' FOR UPDATE OF m",
      [this.org, client.id, input.messageId],
    );
    if (!message) {
      await audit(tx, this.org, null, 'message.deferred_revision', client.id, {
        provider_ref: input.messageId,
        source_key: input.sourceKey,
      });
      await enqueue(tx, this.org, `revision:${input.sourceKey}`, 'message_revision', client.id, {
        input: encrypt(input, this.config.ENCRYPTION_KEY),
      });
      return;
    }
    await tx.query(
      'INSERT INTO message_revisions(message_id,revision,encrypted_previous,source_key,deleted) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [
        message.id,
        message.revision,
        encrypt({ text: message.text }, this.config.ENCRYPTION_KEY),
        input.sourceKey,
        input.kind === 'delete',
      ],
    );
    await tx.query('UPDATE messages SET text=$2,revision=revision+1,deleted=$3 WHERE id=$1', [
      message.id,
      input.kind === 'delete' ? '' : (input.text ?? '').slice(0, 16000),
      input.kind === 'delete',
    ]);
    await tx.query(
      'UPDATE tickets SET suggestion_stale=true,version=version+1,description=CASE WHEN $2=1 THEN $3 ELSE description END WHERE id=$1',
      [
        message.ticket_id,
        message.seq,
        input.kind === 'delete' ? 'Сообщение удалено клиентом' : (input.text ?? ''),
      ],
    );
    await this.invalidateLearning(tx, message.ticket_id, 'message_changed');
    await emit(tx, this.org, 'message.changed', message.ticket_id, { message_id: message.id });
  }

  async command(
    employee: Employee,
    ticketId: string,
    name: string,
    body: Row,
    expected: number,
    key: string,
  ) {
    ensure(key.length >= 8 && key.length <= 128, 'idempotency_required', 422);
    const requestHash = hash(JSON.stringify({ body, expected }));
    const route = `${ticketId}:${name}`;
    return this.db.tx(async (tx) => {
      await tx.query(
        'INSERT INTO command_keys(principal,route,key,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [employee.id, route, key, requestHash],
      );
      const previous = (await one(
        tx,
        'SELECT * FROM command_keys WHERE principal=$1 AND route=$2 AND key=$3 FOR UPDATE',
        [employee.id, route, key],
      ))!;
      ensure(previous.request_hash === requestHash, 'idempotency_conflict');
      const actor = await one<Employee>(
        tx,
        'SELECT * FROM employees WHERE org_id=$1 AND id=$2 AND NOT blocked',
        [this.org, employee.id],
      );
      ensure(actor && actor.version === employee.version, 'access_denied', 403);
      if (previous.response) {
        return previous.response as Ticket;
      }
      const ref = await one(tx, 'SELECT client_id FROM tickets WHERE org_id=$1 AND id=$2', [
        this.org,
        ticketId,
      ]);
      ensure(ref, 'not_found', 404);
      const client = (await one<Client>(
        tx,
        'SELECT * FROM clients WHERE org_id=$1 AND id=$2 FOR UPDATE',
        [this.org, ref.client_id],
      ))!;
      const ticket = (await one<Ticket>(
        tx,
        'SELECT * FROM tickets WHERE org_id=$1 AND id=$2 FOR UPDATE',
        [this.org, ticketId],
      ))!;
      ensure(
        ticket.version === expected,
        'ticket_version_conflict',
        409,
        'Обращение изменилось. Обновите карточку.',
      );
      ensure(
        client.consent_state === 'granted' && client.consent_revision === ticket.consent_revision,
        'consent_required',
        409,
        'Согласие клиента недействительно.',
      );
      const own = () =>
        ensure(
          ticket.assignee_id === actor.id || actor.role !== 'support',
          'forbidden',
          403,
          'Недостаточно прав для действия.',
        );
      if (name === 'assign') {
        ensure(ticket.status === 'open', 'already_assigned');
        await tx.query(
          "UPDATE tickets SET status='in_progress',assignee_id=$2,taken_at=coalesce(taken_at,now()) WHERE id=$1",
          [ticket.id, actor.id],
        );
      } else if (name === 'classification') {
        ensure(['open', 'in_progress'].includes(ticket.status), 'ticket_closed');
        for (const field of ['tag', 'urgency', 'complexity'] as const) {
          if (body[field] !== undefined) {
            const value = await one(
              tx,
              'SELECT * FROM dictionaries WHERE org_id=$1 AND dimension=$2 AND code=$3 AND active',
              [this.org, field, body[field]],
            );
            ensure(value, 'invalid_dictionary', 422);
            const revisions = body.revisions as Row | undefined;
            ensure(revisions?.[field] === ticket[`${field}_revision`], 'classification_conflict');
            await tx.query(
              `UPDATE tickets SET ${field}=$2,${field}_revision=${field}_revision+1,classification_labels=jsonb_set(classification_labels,ARRAY[$3],$4::jsonb) WHERE id=$1`,
              [
                ticket.id,
                body[field],
                field,
                JSON.stringify({ label: value.label, version: value.version }),
              ],
            );
          }
        }
      } else if (name === 'transfer') {
        own();
        ensure(ticket.status === 'in_progress', 'ticket_closed');
        const target = await one<Employee>(
          tx,
          'SELECT * FROM employees WHERE org_id=$1 AND id=$2 AND NOT blocked',
          [this.org, body.employee_id],
        );
        ensure(target, 'invalid_employee', 422);
        ensure(
          typeof body.comment === 'string' && body.comment.trim().length > 0,
          'comment_required',
          422,
        );
        await tx.query('UPDATE tickets SET assignee_id=$2 WHERE id=$1', [ticket.id, target.id]);
        await this.addMessage(
          tx,
          ticket,
          'system',
          actor.id,
          `Передано сотруднику ${target.name}. ${body.comment}`,
          null,
          'internal',
        );
        await emit(tx, this.org, 'ticket.transferred', ticket.id, {}, target.id);
      } else if (name === 'messages') {
        own();
        ensure(ticket.status === 'in_progress', 'ticket_closed');
        const text = String(body.text ?? '').trim();
        const ids = (body.attachment_ids ?? []) as string[];
        ensure(text.length <= 4000 && (text.length > 0 || ids.length > 0), 'invalid_message', 422);
        ensure(ids.length <= 10 && new Set(ids).size === ids.length, 'invalid_attachments', 422);
        for (const id of ids) {
          const a = await one(
            tx,
            "SELECT * FROM attachments WHERE org_id=$1 AND id=$2 AND ticket_id=$3 AND owner_id=$4 AND message_id IS NULL AND status='clean' AND expires_at>now() FOR UPDATE",
            [this.org, id, ticket.id, actor.id],
          );
          ensure(a, 'attachment_not_ready', 422);
        }
        const message = await this.addMessage(tx, ticket, 'staff', actor.id, text, null, 'queued');
        for (const id of ids) {
          await tx.query('UPDATE attachments SET message_id=$2 WHERE id=$1', [id, message.id]);
        }
        await tx.query(
          "INSERT INTO deliveries(org_id,client_id,ticket_id,message_id,logical_key,kind,body,staff_id,staff_version) VALUES($1,$2,$3,$4,$5,'staff',$6,$7,$8)",
          [
            this.org,
            client.id,
            ticket.id,
            message.id,
            `staff:${message.id}`,
            JSON.stringify({ text, attachment_ids: ids }),
            actor.id,
            actor.version,
          ],
        );
      } else if (name === 'close') {
        own();
        ensure(ticket.status === 'in_progress', 'ticket_closed');
        ensure(
          !(await one(
            tx,
            "SELECT id FROM deliveries WHERE ticket_id=$1 AND kind='staff' AND state IN('queued','retry_wait','sending','unknown') LIMIT 1",
            [ticket.id],
          )),
          'delivery_pending',
          409,
          'Дождитесь доставки ответов или отмените отправку.',
        );
        ensure(
          !(await one(tx, "SELECT id FROM inbox WHERE client_id=$1 AND state='pending' LIMIT 1", [
            client.id,
          ])),
          'input_pending',
          409,
          'Обрабатывается новое сообщение клиента. Повторите закрытие.',
        );
        const cycle = (await one<Closure>(
          tx,
          'INSERT INTO closures(org_id,ticket_id,cycle_no,lifecycle,cutoff_seq,closed_by,note) SELECT $1,$2,coalesce(max(cycle_no),0)+1,$3,$4,$5,$6 FROM closures WHERE ticket_id=$2 RETURNING *',
          [
            this.org,
            ticket.id,
            ticket.lifecycle,
            ticket.last_message_seq,
            actor.id,
            body.note ?? '',
          ],
        ))!;
        await tx.query(
          "UPDATE tickets SET status='awaiting_rating',closed_at=now(),closed_by=$2,current_cycle_id=$3 WHERE id=$1",
          [ticket.id, actor.id, cycle.id],
        );
        await this.bot(tx, client, 'ticket_closed', `closed:${cycle.id}`, ticket, cycle.id);
        await enqueue(tx, this.org, `learning:${cycle.id}`, 'learning', cycle.id, {
          lifecycle: ticket.lifecycle,
          consent_revision: client.consent_revision,
        });
      } else if (name === 'reopen') {
        own();
        ensure(['awaiting_rating', 'closed'].includes(ticket.status), 'already_open');
        ensure(
          typeof body.reason === 'string' && body.reason.trim().length > 0,
          'reason_required',
          422,
        );
        const conflict = await one<Ticket>(
          tx,
          "SELECT * FROM tickets WHERE client_id=$1 AND id<>$2 AND status<>'closed'",
          [client.id, ticket.id],
        );
        ensure(
          !conflict,
          'conversation_slot_conflict',
          409,
          `У клиента уже есть обращение №${String(conflict?.ticket_number ?? '').padStart(6, '0')}.`,
        );
        if (ticket.current_cycle_id) {
          await this.cancelRatingPrompts(tx, ticket.current_cycle_id);
        }
        await this.invalidateLearning(tx, ticket.id, 'reopened');
        const targetId = typeof body.employee_id === 'string' ? body.employee_id : actor.id;
        if (actor.role === 'support') {
          ensure(targetId === actor.id, 'forbidden', 403);
        }
        ensure(
          await one(tx, 'SELECT id FROM employees WHERE org_id=$1 AND id=$2 AND NOT blocked', [
            this.org,
            targetId,
          ]),
          'invalid_employee',
          422,
        );
        await tx.query(
          "UPDATE tickets SET status='in_progress',assignee_id=$2,closed_at=NULL,closed_by=NULL,current_cycle_id=NULL,lifecycle=lifecycle+1,suggestion_stale=true WHERE id=$1",
          [ticket.id, targetId],
        );
        await this.addMessage(
          tx,
          ticket,
          'system',
          actor.id,
          `Переоткрыто: ${body.reason}`,
          null,
          'internal',
        );
        await this.bot(
          tx,
          client,
          'ticket_reopened',
          `reopened:${ticket.id}:${ticket.lifecycle + 1}`,
          ticket,
        );
      } else {
        ensure(false, 'unknown_command', 404);
      }
      const result = (await one<Ticket>(
        tx,
        'UPDATE tickets SET version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
        [ticket.id],
      ))!;
      await audit(
        tx,
        this.org,
        actor.id,
        `ticket.${name}`,
        ticket.id,
        name === 'classification'
          ? {
              before: { tag: ticket.tag, urgency: ticket.urgency, complexity: ticket.complexity },
              after: body,
            }
          : { version: result.version },
      );
      const event = (
        {
          assign: 'ticket.assigned',
          classification: 'ticket.classified',
          messages: 'message.from_agent',
          close: 'ticket.closed',
          reopen: 'ticket.reopened',
          transfer: 'ticket.updated',
        } as Record<string, string>
      )[name];
      await emit(tx, this.org, event, ticket.id, { version: result.version });
      await tx.query(
        'UPDATE command_keys SET response=$4 WHERE principal=$1 AND route=$2 AND key=$3',
        [employee.id, route, key, JSON.stringify(result)],
      );
      return result;
    });
  }

  async timers() {
    const due = (
      await this.db.query<Row & { client_id: string }>(
        `SELECT DISTINCT t.client_id FROM tickets t JOIN closures c ON c.id=t.current_cycle_id
      WHERE t.org_id=$1 AND t.status='awaiting_rating' AND (c.expires_at<=now() OR (c.reminder_at<=now() AND NOT c.reminder_created)) LIMIT 100`,
        [this.org],
      )
    ).rows;
    for (const item of due) {
      await this.db.tx(async (tx) => {
        const client = (await one<Client>(
          tx,
          'SELECT * FROM clients WHERE org_id=$1 AND id=$2 FOR UPDATE',
          [this.org, item.client_id],
        ))!;
        const ticket = await one<Ticket>(
          tx,
          "SELECT * FROM tickets WHERE client_id=$1 AND status='awaiting_rating' FOR UPDATE",
          [client.id],
        );
        if (!ticket) {
          return;
        }
        const cycle = (await one<Closure>(tx, 'SELECT * FROM closures WHERE id=$1 FOR UPDATE', [
          ticket.current_cycle_id,
        ]))!;
        const times = (await one(tx, 'SELECT now() >= $1::timestamptz AS expired', [
          cycle.expires_at,
        ]))!;
        if (times.expired) {
          if (
            await one(
              tx,
              "SELECT id FROM inbox WHERE client_id=$1 AND state='pending' AND received_at<=$2 LIMIT 1",
              [client.id, cycle.expires_at],
            )
          ) {
            return;
          }
          const prompt = await one(
            tx,
            "SELECT state FROM deliveries WHERE cycle_id=$1 AND kind='ticket_closed'",
            [cycle.id],
          );
          await this.finishRating(
            tx,
            client,
            ticket,
            cycle,
            prompt?.state === 'delivered' ? 'expired' : 'notification_not_delivered',
            cycle.id,
          );
        } else if (!cycle.reminder_created) {
          await tx.query('UPDATE closures SET reminder_created=true WHERE id=$1', [cycle.id]);
          await this.bot(tx, client, 'rating_reminder', `reminder:${cycle.id}`, ticket, cycle.id);
        }
      });
    }
    const expiredBuffers = (
      await this.db.query<{ client_id: string }>(
        'SELECT DISTINCT client_id FROM preconsent_buffers WHERE expires_at<=now() LIMIT 100',
      )
    ).rows;
    for (const item of expiredBuffers) {
      await this.db.tx(async (tx) => {
        const client = await one<Client>(
          tx,
          'SELECT * FROM clients WHERE org_id=$1 AND id=$2 FOR UPDATE',
          [this.org, item.client_id],
        );
        if (!client) {
          return;
        }
        const removed = await tx.query(
          'DELETE FROM preconsent_buffers WHERE client_id=$1 AND expires_at<=now() RETURNING id',
          [client.id],
        );
        if (removed.rows.length) {
          await this.bot(tx, client, 'buffer_expired', `buffer-expired:${randomUUID()}`);
        }
      });
    }
  }
}
