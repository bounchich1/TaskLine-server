import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import type { Config } from '../../shared/config.js';
import { ticketHasValidConsent } from '../../shared/consent.js';
import { one } from '../../shared/db.js';
import { emit } from '../../shared/events.js';

import type { Attachment, FileDeps } from './attachment.js';
import { clamScan } from './clamav.js';
import { detectContentType, isAllowedContent } from './content-policy.js';
import { createTempFile } from './temp-file.js';

const MAX_EXTRACTED_TEXT = 32000;

/**
 * Background job: checks a quarantined file's real type, scans it for malware and, for plain
 * text, extracts its content for AI triage. Only a clean file becomes usable.
 */
export async function scanAttachment(deps: FileDeps, id: string): Promise<void> {
  const { db, ctx, storage } = deps;
  const file = await one<Attachment>(db, 'SELECT * FROM attachments WHERE org_id=$1 AND id=$2', [
    ctx.org,
    id,
  ]);
  if (file?.status !== 'quarantined' || !file.object_key) {
    return;
  }
  const temp = await createTempFile('max-scan-');
  try {
    await pipeline(
      await storage.read(file.object_key),
      createWriteStream(temp.path, { mode: 0o600 }),
    );
    const contentType = await detectContentType(temp.path, file.filename);
    if (!isAllowedContent(contentType, file.kind)) {
      await db.query(
        "UPDATE attachments SET status='rejected',extraction_status='unsupported' WHERE id=$1",
        [id],
      );
      return;
    }
    if (!(await isClean(temp.path, ctx.config))) {
      await db.query("UPDATE attachments SET status='infected' WHERE id=$1", [id]);
      return;
    }
    const text = contentType === 'text/plain' ? await readFile(temp.path, 'utf8') : null;
    await markClean(deps, file, { contentType, text });
  } finally {
    await temp.cleanup();
  }
}

async function isClean(path: string, config: Config): Promise<boolean> {
  if (config.SCANNER_MODE === 'mock') {
    return !(await readFile(path)).includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE');
  }
  return clamScan(path, config.CLAMAV_HOST, config.CLAMAV_PORT);
}

async function markClean(
  { db, ctx }: FileDeps,
  file: Attachment,
  { contentType, text }: { contentType: string; text: string | null },
): Promise<void> {
  const extracted = text === null ? null : text.slice(0, MAX_EXTRACTED_TEXT);
  const coverage = extractionCoverage(text);
  await db.tx(async (tx) => {
    // Consent may have been withdrawn while the scan ran.
    if (!(await ticketHasValidConsent(tx, file.ticket_id))) {
      await tx.query("UPDATE attachments SET status='canceled' WHERE id=$1", [file.id]);
      return;
    }
    await tx.query(
      `UPDATE attachments SET status='clean',mime=$2,extraction=$3,extraction_status=$4,source_ref=NULL
       WHERE id=$1`,
      [file.id, contentType, extracted, coverage],
    );
    await emit(tx, ctx.org, {
      type: 'attachment.changed',
      ticketId: file.ticket_id,
      payload: {
        attachment_id: file.id,
        status: 'clean',
      },
    });
  });
}

function extractionCoverage(text: string | null): string {
  if (text === null) {
    return 'unsupported';
  }
  return text.length > MAX_EXTRACTED_TEXT ? 'partial' : 'complete';
}
