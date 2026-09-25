import { readFile } from 'node:fs/promises';

import { fileTypeFromFile } from 'file-type';

import { ensure } from '../../shared/errors.js';

const MEBIBYTE = 1024 * 1024;

const ALLOWED_DOCUMENT_TYPES = [
  'application/pdf',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.ms-excel',
];

export function sizeLimitFor(kind: string): number {
  if (kind === 'video') {
    return 100 * MEBIBYTE;
  }
  return (kind === 'image' ? 20 : 25) * MEBIBYTE;
}

export function safeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
  return name.replace(/[\\/\r\n\x00-\x1f"<>:|?*]/g, '_').slice(0, 160) || 'attachment';
}

export async function detectContentType(path: string, filename: string): Promise<string> {
  const detected = await fileTypeFromFile(path);
  if (!detected && filename.toLowerCase().endsWith('.txt')) {
    const sample = await readFile(path);
    ensure(!sample.includes(0), 'unsupported_file', 422);
    return 'text/plain';
  }
  return detected?.mime ?? '';
}

export function isAllowedContent(contentType: string, kind: string): boolean {
  const isImage = contentType.startsWith('image/') && contentType !== 'image/svg+xml';
  const isVideo = contentType.startsWith('video/');
  const allowed = isImage || isVideo || ALLOWED_DOCUMENT_TYPES.includes(contentType);
  if (!allowed) {
    return false;
  }
  if (kind === 'image') {
    return contentType.startsWith('image/');
  }
  return kind !== 'video' || isVideo;
}
