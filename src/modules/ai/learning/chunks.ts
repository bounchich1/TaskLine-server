import type { SnapshotEntry } from '../../../shared/types/ai.js';

export type Part = { id: string; part: number; parts: number; data: string };

export function planChunks(entries: SnapshotEntry[], budget: number): Part[][] {
  const partSize = Math.max(500, Math.floor(budget / 2) - 200);
  const chunks: Part[][] = [];
  let current: Part[] = [];
  let used = 2;
  for (const part of splitEntries(entries, partSize)) {
    const length = JSON.stringify(part).length + 1;
    if (current.length && used + length > budget) {
      chunks.push(current);
      current = [];
      used = 2;
    }
    current.push(part);
    used += length;
  }
  if (current.length) {
    chunks.push(current);
  }
  return chunks;
}

function splitEntries(entries: SnapshotEntry[], size: number): Part[] {
  const parts: Part[] = [];
  for (const entry of entries) {
    const data = JSON.stringify(entry);
    const count = Math.max(1, Math.ceil(data.length / size));
    for (let i = 0; i < count; i++) {
      parts.push({
        id: entry.id,
        part: i,
        parts: count,
        data: data.slice(i * size, (i + 1) * size),
      });
    }
  }
  return parts;
}
