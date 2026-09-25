import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import type { Database } from '../../shared/db.js';
import type { Job } from '../../shared/types/entities.js';

import type { Model } from './gateway/model.js';
import { runClosureLearning } from './learning/closure-learning.js';
import type { Recall } from './memory/memory-record.js';
import { runTriage } from './triage/triage.js';

export class Workflows {
  private readonly ctx: Ctx;

  constructor(
    private readonly db: Database,
    config: Config,
    private readonly model: Model,
    private readonly memory: Recall,
  ) {
    this.ctx = createCtx(config);
  }

  async triage(job: Job): Promise<void> {
    await runTriage({ db: this.db, ctx: this.ctx, model: this.model, memory: this.memory }, job);
  }

  async learning(job: Job): Promise<boolean> {
    return runClosureLearning({ db: this.db, ctx: this.ctx, model: this.model }, job);
  }
}
