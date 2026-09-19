import type { Config } from './config.js';

/** What transaction-scoped domain functions need besides the transaction itself. */
export interface Ctx {
  readonly org: string;
  readonly config: Config;
}

export function createCtx(config: Config): Ctx {
  return { org: config.ORG_ID, config };
}
