import type { Row } from '../../shared/types/entities.js';

export function publicAttachment(row: Row) {
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    mime: row.mime,
    bytes: row.bytes,
  };
}
