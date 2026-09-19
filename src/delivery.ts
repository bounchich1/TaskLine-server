import { TransportFailure, type MaxTransport } from './integrations/max/index.js';
import type { Files } from './modules/files/index.js';
import type { Config } from './shared/config.js';
import { one, type Database } from './shared/db.js';
import { ensure } from './shared/errors.js';
import { emit, audit } from './shared/events.js';
import type { Client, Employee, Row, Ticket } from './shared/types/entities.js';

type Delivery = Row & {
  id: string;
  client_id: string;
  ticket_id: string | null;
  message_id: string | null;
  cycle_id: string | null;
  body: Row;
  kind: string;
  generation: number;
  attempts: number;
  state: string;
  staff_id: string | null;
  staff_version: number | null;
};
export class DeliveryWorker {
  constructor(
    readonly db: Database,
    readonly c: Config,
    readonly max: MaxTransport,
    readonly files?: Files,
  ) {}
  async rate() {
    const result = await this.db.tx(async (tx) =>
      one(
        tx,
        "UPDATE max_rate_limit SET next_at=greatest(next_at,clock_timestamp())+interval '40 milliseconds' WHERE id=1 RETURNING greatest(0,extract(epoch FROM next_at-clock_timestamp())*1000)::int AS delay",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, Number(result!.delay)));
  }
  async deliver(clientId: string): Promise<boolean> {
    const claimed = await this.db.tx(async (tx) => {
      const client = await one<Client>(
        tx,
        'SELECT * FROM clients WHERE org_id=$1 AND id=$2 FOR UPDATE',
        [this.c.ORG_ID, clientId],
      );
      if (!client) {
        return null;
      }
      const head = await one<Delivery>(
        tx,
        "SELECT * FROM deliveries WHERE org_id=$1 AND client_id=$2 AND state IN('queued','retry_wait','sending','unknown') ORDER BY chat_seq LIMIT 1 FOR UPDATE",
        [this.c.ORG_ID, clientId],
      );
      if (!head || head.state === 'sending' || head.state === 'unknown') {
        return null;
      }
      if (
        !(await one(
          tx,
          "SELECT id FROM deliveries WHERE id=$1 AND due_at<=now() AND ($2::timestamptz IS NULL OR $2::timestamptz<=now()-interval '550 milliseconds')",
          [head.id, client.last_send_at ?? null],
        ))
      ) {
        return null;
      }
      let valid = true;
      if (head.kind === 'staff') {
        const ticket = await one<Ticket>(tx, 'SELECT * FROM tickets WHERE org_id=$1 AND id=$2', [
          this.c.ORG_ID,
          head.ticket_id,
        ]);
        const employee = await one<Employee>(
          tx,
          'SELECT * FROM employees WHERE org_id=$1 AND id=$2 AND NOT blocked',
          [this.c.ORG_ID, head.staff_id],
        );
        valid =
          !!ticket &&
          !!employee &&
          ticket.status === 'in_progress' &&
          client.consent_state === 'granted' &&
          employee.version === head.staff_version &&
          (ticket.assignee_id === employee.id || employee.role !== 'support');
      }
      if (head.cycle_id) {
        valid =
          valid &&
          !!(await one(
            tx,
            "SELECT t.id FROM tickets t JOIN closures c ON c.id=t.current_cycle_id WHERE t.id=$1 AND c.id=$2 AND NOT c.invalidated AND t.status='awaiting_rating' AND c.expires_at>now()",
            [head.ticket_id, head.cycle_id],
          ));
      }
      if (!valid) {
        await tx.query(
          "UPDATE deliveries SET state='canceled',reason='authorization_changed' WHERE id=$1",
          [head.id],
        );
        if (head.message_id) {
          await tx.query("UPDATE messages SET delivery_state='canceled' WHERE id=$1", [
            head.message_id,
          ]);
        }
        return null;
      }
      const delivery = (await one<Delivery>(
        tx,
        "UPDATE deliveries SET state='sending',attempts=attempts+1,generation=generation+1,started_at=now() WHERE id=$1 RETURNING *",
        [head.id],
      ))!;
      await tx.query('UPDATE clients SET last_send_at=now() WHERE id=$1', [client.id]);
      if (head.message_id) {
        await tx.query("UPDATE messages SET delivery_state='sending' WHERE id=$1", [
          head.message_id,
        ]);
      }
      return { delivery, client };
    });
    if (!claimed) {
      return false;
    }
    const { delivery, client } = claimed;
    let state = 'delivered';
    let reason: string | null = null;
    let ref: string | null = null;
    let retryAfter = 2;
    try {
      if (delivery.kind === 'callback_answer') {
        await this.max.answer(
          String(delivery.body.callback_id),
          String(delivery.body.notification),
        );
      } else {
        const { attachment_ids, ...body } = delivery.body;
        if (Array.isArray(attachment_ids) && attachment_ids.length) {
          ensure(this.files, 'file_worker_unavailable', 503);
          body.attachments = [];
          for (const id of attachment_ids) {
            const file = await this.files.materialize(String(id));
            try {
              (body.attachments as Row[]).push(
                await this.max.upload(file.kind, file.path, file.filename, file.mime),
              );
            } finally {
              await file.cleanup();
            }
          }
        }
        // Recheck cancellation after potentially slow media preparation and before the customer send.
        const current = await one(
          this.db,
          'SELECT d.state,c.consent_state FROM deliveries d JOIN clients c ON c.id=d.client_id WHERE d.id=$1',
          [delivery.id],
        );
        if (
          current?.state !== 'sending' ||
          (delivery.kind === 'staff' && current.consent_state !== 'granted')
        ) {
          state = 'canceled';
        } else {
          ref = await this.max.send(client.chat_id, body);
        }
      }
    } catch (error) {
      const failure =
        error instanceof TransportFailure
          ? error
          : new TransportFailure('unknown', 'delivery_unknown');
      state =
        failure.outcome === 'retry' && delivery.attempts <= 6
          ? 'retry_wait'
          : failure.outcome === 'retry'
            ? 'failed'
            : failure.outcome;
      reason = failure.reason;
      retryAfter = Math.max(failure.retryAfter, Math.min(1800, 2 ** delivery.attempts));
    }
    await this.db.tx(async (tx) => {
      await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [client.id]);
      const updated = await tx.query(
        "UPDATE deliveries SET state=$3,provider_ref=$4,reason=$5,due_at=now()+($6*interval '1 second') WHERE id=$1 AND generation=$2 AND state='sending' RETURNING id",
        [delivery.id, delivery.generation, state, ref, reason, retryAfter],
      );
      if (!updated.rows.length) {
        return;
      }
      if (delivery.message_id) {
        await tx.query(
          'UPDATE messages SET delivery_state=$2,provider_ref=coalesce($3,provider_ref) WHERE id=$1',
          [delivery.message_id, state, ref],
        );
      }
      if (delivery.ticket_id) {
        await emit(tx, this.c.ORG_ID, 'delivery.changed', delivery.ticket_id, {
          message_id: delivery.message_id,
          state,
        });
      }
    });
    return true;
  }
  async resolve(
    employee: Employee,
    messageId: string,
    action: 'cancel' | 'retry',
    evidence?: string,
  ) {
    return this.db.tx(async (tx) => {
      const ref = await one<Delivery>(
        tx,
        'SELECT * FROM deliveries WHERE org_id=$1 AND message_id=$2',
        [this.c.ORG_ID, messageId],
      );
      ensure(ref, 'not_found', 404);
      await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [ref.client_id]);
      const ticket = await one<Ticket>(
        tx,
        'SELECT * FROM tickets WHERE org_id=$1 AND id=$2 FOR UPDATE',
        [this.c.ORG_ID, ref.ticket_id],
      );
      ensure(ticket, 'not_found', 404);
      const actor = await one<Employee>(
        tx,
        'SELECT * FROM employees WHERE id=$1 AND org_id=$2 AND NOT blocked',
        [employee.id, this.c.ORG_ID],
      );
      ensure(actor && actor.version === employee.version, 'forbidden', 403);
      ensure(ticket.assignee_id === actor.id || actor.role !== 'support', 'forbidden', 403);
      const delivery = (await one<Delivery>(tx, 'SELECT * FROM deliveries WHERE id=$1 FOR UPDATE', [
        ref.id,
      ]))!;
      ensure(
        delivery.state !== 'sending' && delivery.state !== 'delivered',
        'delivery_not_resolvable',
      );
      if (delivery.state === 'unknown') {
        ensure(
          actor.role !== 'support' && typeof evidence === 'string' && evidence.trim().length >= 10,
          'operator_evidence_required',
          409,
          'Неизвестный результат: требуется проверка руководителем и подтверждение риска дубликата.',
        );
      }
      if (action === 'retry') {
        ensure(
          ticket.status === 'in_progress' && ['failed', 'unknown'].includes(delivery.state),
          'retry_not_allowed',
        );
      } else {
        ensure(
          ['queued', 'retry_wait', 'failed', 'unknown'].includes(delivery.state),
          'cancel_not_allowed',
        );
      }
      const state = action === 'retry' ? 'queued' : 'canceled';
      await tx.query('UPDATE deliveries SET state=$2,due_at=now(),reason=NULL WHERE id=$1', [
        delivery.id,
        state,
      ]);
      await tx.query('UPDATE messages SET delivery_state=$2 WHERE id=$1', [messageId, state]);
      await audit(tx, this.c.ORG_ID, actor.id, `delivery.${action}`, delivery.id, {
        previous: delivery.state,
        evidence: evidence ?? null,
      });
      await emit(tx, this.c.ORG_ID, 'delivery.changed', ticket.id, {
        message_id: messageId,
        state,
      });
      return { state };
    });
  }
  async markStaleUnknown() {
    await this.db.tx(async (tx) => {
      const rows = (
        await tx.query(
          "UPDATE deliveries SET state='unknown',reason='worker_lost' WHERE org_id=$1 AND state='sending' AND started_at<now()-interval '5 minutes' RETURNING message_id,ticket_id",
          [this.c.ORG_ID],
        )
      ).rows;
      for (const row of rows) {
        if (row.message_id) {
          await tx.query("UPDATE messages SET delivery_state='unknown' WHERE id=$1", [
            row.message_id,
          ]);
        }
        if (row.ticket_id) {
          await emit(tx, this.c.ORG_ID, 'delivery.changed', String(row.ticket_id), {
            state: 'unknown',
          });
        }
      }
    });
  }
}
