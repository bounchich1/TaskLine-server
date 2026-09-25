import { one, type Sql } from './db.js';

export async function ticketHasValidConsent(db: Sql, ticketId: string): Promise<boolean> {
  const ticket = await one(
    db,
    `SELECT t.id FROM tickets t JOIN clients c ON c.id=t.client_id
     WHERE t.id=$1 AND c.consent_state='granted' AND c.consent_revision=t.consent_revision`,
    [ticketId],
  );
  return ticket !== undefined;
}
