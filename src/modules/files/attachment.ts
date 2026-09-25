import type { Ctx } from '../../shared/context.js';
import type { Database } from '../../shared/db.js';
import type { Row } from '../../shared/types/entities.js';

import type { ObjectStorage } from './storage.js';

export type Attachment = Row & {
    id: string;
    ticket_id: string;
    message_id: string | null;
    owner_id: string | null;
    kind: string;
    filename: string;
    status: string;
    object_key: string | null;
    source_ref: string | null;
    mime: string | null;
    bytes: string;
    sha256: string | null;
};

export interface FileDeps {
    db: Database;
    ctx: Ctx;
    storage: ObjectStorage;
}
