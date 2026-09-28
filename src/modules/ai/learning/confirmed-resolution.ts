import type { Resolution, SnapshotEntry } from '../../../shared/types/ai.js';

const CONFIRMS_FIX = new RegExp(
    [
        '(?:теперь|снова|опять|уже)\\s+(?:вс[её]\\s+)?работает',
        'вс[её]\\s+(?:работает|получилось|наладилось|в\\s+порядке)',
        'заработал[аио]?',
        '(?:проблема|ошибка|неисправность)\\s+(?:решена|исчезла|пропала|ушла|устранена)',
        '(?:интернет|связь|сеть|сигнал)\\s+(?:появил|вернул|восстановил)(?:ся|ась|ось)',
        'без\\s+обрывов',
        'помогло',
    ].join('|'),
    'i',
);

const DENIES_FIX = /(?:не\s+работает|не\s+решена|не\s+помог)/i;

export function confirmedResolution(resolution: Resolution, entries: SnapshotEntry[]): boolean {
    if (resolution.outcome !== 'resolved') {
        return false;
    }

    const staffSteps = entries.filter(
        (entry) =>
            entry.role === 'staff' &&
            entry.delivery === 'delivered' &&
            resolution.steps.some((step) => step.evidence_message_ids.includes(entry.id)),
    );

    return (
        staffSteps.length > 0 &&
        entries.some(
            (entry) =>
                entry.role === 'client' &&
                resolution.evidence_message_ids.includes(entry.id) &&
                staffSteps.some((step) => step.seq < entry.seq) &&
                CONFIRMS_FIX.test(entry.text) &&
                !DENIES_FIX.test(entry.text),
        )
    );
}
