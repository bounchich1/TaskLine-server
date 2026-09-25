import { decrypt, encrypt } from '../../../shared/crypto.js';
import { one, type Database, type Sql } from '../../../shared/db.js';
import type { Job, Row } from '../../../shared/types/entities.js';

export class CheckpointStore {
  constructor(
    private readonly db: Database,
    private readonly job: Job,
    private readonly encryptionKey: string,
  ) {}

  async get(stepKey: string): Promise<Row | undefined> {
    const row = await one(
      this.db,
      'SELECT output FROM ai_checkpoints WHERE job_id=$1 AND step_key=$2',
      [this.job.id, stepKey],
    );
    return row ? decrypt<Row>(String(row.output), this.encryptionKey) : undefined;
  }

  async save(
    stepKey: string,
    { value, coveredIds, inputHash }: { value: unknown; coveredIds: string[]; inputHash: string },
  ): Promise<void> {
    await insertCheckpoint(this.db, {
      jobId: this.job.id,
      stepKey,
      output: encrypt(value, this.encryptionKey),
      inputHash,
      coveredIds: [...new Set(coveredIds)],
    });
  }
}

export async function insertCheckpoint(
  sql: Sql,
  checkpoint: {
    jobId: string;
    stepKey: string;
    output: string;
    inputHash: string;
    coveredIds: string[];
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO ai_checkpoints(job_id,step_key,output,input_hash,covered_ids)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [
      checkpoint.jobId,
      checkpoint.stepKey,
      checkpoint.output,
      checkpoint.inputHash,
      JSON.stringify(checkpoint.coveredIds),
    ],
  );
}
