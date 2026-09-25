import type { Readable } from 'node:stream';

import type { Config } from '../../shared/config.js';
import { createCtx } from '../../shared/context.js';
import type { Database } from '../../shared/db.js';
import type { Employee } from '../../shared/types/entities.js';
import type { Session } from '../../shared/types/session.js';

import type { Attachment, FileDeps } from './attachment.js';
import { findSentAttachment, grantDownload, redeemDownloadGrant } from './downloads.js';
import { cancelDraftUpload, draftUploadStatus } from './draft-uploads.js';
import { downloadInbound } from './inbound-download.js';
import { materialize, type MaterializedFile } from './materialize.js';
import { scanAttachment } from './scan.js';
import { ObjectStorage } from './storage.js';
import { prepareUpload, receiveUpload } from './uploads.js';

export class Files {
  private readonly deps: FileDeps;

  constructor(db: Database, config: Config) {
    this.deps = { db, ctx: createCtx(config), storage: new ObjectStorage(config) };
  }

  async read(key: string): Promise<Readable> {
    return this.deps.storage.read(key);
  }

  async prepare(employee: Employee, upload: { ticketId: string; filename: string; kind: string }) {
    return prepareUpload(this.deps, employee, upload);
  }

  async receive(
    employee: Employee,
    upload: { id: string; stream: Readable; isTruncated?: () => boolean },
  ) {
    return receiveUpload(this.deps, employee, upload);
  }

  async draftStatus(employee: Employee, id: string) {
    return draftUploadStatus(this.deps, { employeeId: employee.id, id });
  }

  async cancelDraft(employee: Employee, id: string): Promise<void> {
    await cancelDraftUpload(this.deps, { employeeId: employee.id, id });
  }

  async sentAttachment(id: string): Promise<Attachment> {
    return findSentAttachment(this.deps, id);
  }

  async grantDownload(session: Session, attachmentId: string) {
    return grantDownload(this.deps, { attachmentId, session });
  }

  async redeemGrant(grant: string): Promise<Attachment> {
    return redeemDownloadGrant(this.deps, grant);
  }

  async downloadInbound(id: string): Promise<void> {
    await downloadInbound(this.deps, id);
  }

  async scan(id: string): Promise<void> {
    await scanAttachment(this.deps, id);
  }

  async materialize(id: string): Promise<MaterializedFile> {
    return materialize(this.deps, id);
  }
}
