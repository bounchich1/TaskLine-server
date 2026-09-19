import type { Ctx } from '../../shared/context.js';
import type { Database } from '../../shared/db.js';
import type { Row } from '../../shared/types/entities.js';

/** A queued outbound message to one client (bot text, staff reply or callback answer). */
export type Delivery = Row & {
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

/** Dependencies shared by the delivery steps that run outside a single transaction. */
export interface DeliveryDeps {
  db: Database;
  ctx: Ctx;
}
