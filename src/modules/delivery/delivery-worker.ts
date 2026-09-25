import type { MaxTransport } from '../../integrations/max/index.js';
import type { Config } from '../../shared/config.js';
import { createCtx } from '../../shared/context.js';
import type { Database } from '../../shared/db.js';
import type { Employee } from '../../shared/types/entities.js';
import type { Files } from '../files/index.js';

import { claimNextDelivery } from './claim.js';
import type { DeliveryDeps } from './delivery.js';
import { recordOutcome } from './record-outcome.js';
import { resolveDelivery } from './resolve.js';
import { waitForSendSlot } from './send-rate.js';
import { sendDelivery } from './send.js';
import { markStaleSendsUnknown } from './stale-sends.js';

export class DeliveryWorker {
  private readonly deps: DeliveryDeps;

  constructor(
    db: Database,
    config: Config,
    private readonly max: MaxTransport,
    private readonly files?: Files,
  ) {
    this.deps = { db, ctx: createCtx(config) };
  }

  async rate(): Promise<void> {
    await waitForSendSlot(this.deps.db);
  }

  async deliver(clientId: string): Promise<boolean> {
    const { db, ctx } = this.deps;
    const claimed = await db.tx(async (tx) => claimNextDelivery(tx, ctx, clientId));
    if (!claimed) {
      return false;
    }
    const outcome = await sendDelivery({ db, max: this.max, files: this.files }, claimed);
    await recordOutcome(this.deps, claimed, outcome);
    return true;
  }

  async resolve(
    employee: Employee,
    messageId: string,
    action: 'cancel' | 'retry',
    evidence?: string,
  ): Promise<{ state: string }> {
    const request = { employee, messageId, action, evidence };
    return this.deps.db.tx(async (tx) => resolveDelivery(tx, this.deps.ctx, request));
  }

  async markStaleUnknown(): Promise<void> {
    await markStaleSendsUnknown(this.deps);
  }
}
