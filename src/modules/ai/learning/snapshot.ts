import type { Ctx } from '../../../shared/context.js';
import { decrypt, encrypt, hash } from '../../../shared/crypto.js';
import { one, requireOne, type Sql } from '../../../shared/db.js';
import { AppError, ensure } from '../../../shared/errors.js';
import type { SnapshotEntry } from '../../../shared/types/ai.js';
import type { Closure, Job, Message, Row, Ticket } from '../../../shared/types/entities.js';
import { redact } from '../contracts/redact.js';
import { eligibleJob } from '../gateway/job-eligibility.js';

const FILE_WAIT_MS = 60000;
const UNFINISHED_FILE_STATES = ['pending', 'quarantined', 'receiving'];

export interface Snapshot {
  cycle: Closure;
  entries: SnapshotEntry[];
  missing: string[];
}

export async function takeSnapshot(tx: Sql, ctx: Ctx, job: Job): Promise<Snapshot> {
  const { cycle, ticket } = await lockCycle(tx, ctx, job);
  ensure(await eligibleJob(tx, ctx.org, job), 'job_ineligible');
  if (cycle.snapshot) {
    const frozen = decrypt<Omit<Snapshot, 'cycle'>>(cycle.snapshot, ctx.config.ENCRYPTION_KEY);
    return { cycle, ...frozen };
  }
  const entries = await readEntries(tx, ctx, { ticket, cycle });
  const missing = entries.flatMap((entry) =>
    entry.attachments
      .filter((file) => file.status !== 'clean' || file.coverage !== 'complete')
      .map((file) => `${file.id}:${file.status}:${file.coverage}`),
  );
  await freeze(tx, ctx, { cycle, entries, missing });
  return { cycle, entries, missing };
}

async function lockCycle(tx: Sql, ctx: Ctx, job: Job): Promise<{ cycle: Closure; ticket: Ticket }> {
  const initial = await one<Closure>(tx, 'SELECT * FROM closures WHERE id=$1 AND org_id=$2', [
    job.ref_id,
    ctx.org,
  ]);
  ensure(initial, 'not_found', 404);
  const ticket = await one<Ticket>(tx, 'SELECT * FROM tickets WHERE id=$1', [initial.ticket_id]);
  ensure(ticket, 'not_found', 404);
  await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [ticket.client_id]);
  await tx.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE', [ticket.id]);
  const cycle = await requireOne<Closure>(tx, 'SELECT * FROM closures WHERE id=$1 FOR UPDATE', [
    initial.id,
  ]);
  return { cycle, ticket };
}

async function readEntries(
  tx: Sql,
  ctx: Ctx,
  { ticket, cycle }: { ticket: Ticket; cycle: Closure },
): Promise<SnapshotEntry[]> {
  const { rows: messages } = await tx.query<Message>(
    'SELECT * FROM messages WHERE org_id=$1 AND ticket_id=$2 AND seq<=$3 ORDER BY seq',
    [ctx.org, ticket.id, cycle.cutoff_seq],
  );
  const { rows: files } = await tx.query(
    `SELECT id,message_id,status,extraction,extraction_status FROM attachments
     WHERE org_id=$1 AND ticket_id=$2 AND message_id IS NOT NULL`,
    [ctx.org, ticket.id],
  );
  const pending = files.some((file) => UNFINISHED_FILE_STATES.includes(String(file.status)));
  if (pending && Date.now() - new Date(cycle.closed_at).getTime() < FILE_WAIT_MS) {
    throw new AppError('snapshot_waiting_files', 429);
  }
  const { rows: revisions } = await tx.query(
    `SELECT r.* FROM message_revisions r JOIN messages m ON m.id=r.message_id
     WHERE m.ticket_id=$1 AND m.seq<=$2 ORDER BY m.seq,r.revision`,
    [ticket.id, cycle.cutoff_seq],
  );
  const key = ctx.config.ENCRYPTION_KEY;
  return messages.map((message) => toEntry(message, { files, revisions, key }));
}

function toEntry(
  message: Message,
  { files, revisions, key }: { files: Row[]; revisions: Row[]; key: string },
): SnapshotEntry {
  return {
    id: message.id,
    seq: message.seq,
    role: message.author_type,
    text: redact(message.text),
    delivery: message.delivery_state,
    revision: message.revision,
    attachments: files
      .filter((file) => file.message_id === message.id)
      .map((file) => ({
        id: String(file.id),
        status: String(file.status),
        extraction: typeof file.extraction === 'string' ? redact(file.extraction) : null,
        coverage: String(file.extraction_status),
      })),
    revisions: revisions
      .filter((revision) => revision.message_id === message.id)
      .map((revision) => ({
        revision: Number(revision.revision),
        text: redact(decrypt<{ text: string }>(String(revision.encrypted_previous), key).text),
        deleted: !!revision.deleted,
      })),
  };
}

async function freeze(tx: Sql, ctx: Ctx, { cycle, entries, missing }: Snapshot): Promise<void> {
  const data = { entries, missing };
  await tx.query(
    `UPDATE closures SET snapshot=$2,snapshot_hash=$3,coverage=$4,learning_status='analyzing'
     WHERE id=$1`,
    [
      cycle.id,
      encrypt(data, ctx.config.ENCRYPTION_KEY),
      hash(JSON.stringify(data)),
      JSON.stringify({
        expected_messages: entries.map((entry) => entry.id),
        message_count: entries.length,
        missing_attachments: missing,
        builder: '1.0',
      }),
    ],
  );
}
