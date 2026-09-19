import type { Row } from '../../shared/types/entities.js';

/** The attachment fields staff may see (never the storage key or source reference). */
export function publicAttachment(row: Row) {
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    mime: row.mime,
    bytes: row.bytes,
  };
}
