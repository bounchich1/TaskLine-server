import { describe, expect, it } from 'vitest';

import { selectDueJobs } from '../src/app/workers/scheduler.js';
import type { Job } from '../src/shared/types/entities.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const clock = () => NOW;

function jobs(kind: string, count: number, ageMinutes = 0): Job[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${kind}-${i}`,
    org_id: 'org',
    kind,
    ref_id: `ref-${i}`,
    payload: {},
    generation: 1,
    state: 'pending',
    attempts: 0,
    created_at: new Date(NOW - ageMinutes * 60000).toISOString(),
  }));
}

const kinds = (selected: Job[]) => selected.map((job) => job.kind[0]).join('');

describe('selectDueJobs', () => {
  it('interleaves four triage jobs with one learning job, then adds other work', () => {
    const due = [...jobs('triage', 10), ...jobs('learning', 3), ...jobs('scan', 50)];
    const selected = selectDueJobs(due, 10, clock);
    expect(kinds(selected.slice(0, 13))).toBe('ttttlttttlttl');
    expect(selected.slice(13)).toHaveLength(40);
  });

  it('lets learning that waited over ten minutes go first', () => {
    const due = [...jobs('triage', 8), ...jobs('learning', 2, 11)];
    expect(kinds(selectDueJobs(due, 10, clock))).toBe('lttttltttt');
  });

  it('stops adding AI work once two jobs per permit are selected', () => {
    const due = [...jobs('triage', 20), ...jobs('learning', 5)];
    expect(selectDueJobs(due, 1, clock)).toHaveLength(5);
  });
});
