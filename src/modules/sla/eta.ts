import { dateKey, localDate } from './business-time.js';

const DAY_MS = 86400000;

function clock(moment: Date, timezone: string): string {
    return new Intl.DateTimeFormat('ru', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(moment);
}

function dayAndMonth(moment: Date, timezone: string): string {
    return new Intl.DateTimeFormat('ru', { timeZone: timezone, day: 'numeric', month: 'long' }).format(moment);
}

export function formatEta(due: Date, now: Date, timezone: string): string {
    const dueDay = dateKey(localDate(due.getTime(), timezone));

    if (dueDay === dateKey(localDate(now.getTime(), timezone))) {
        return `сегодня до ${clock(due, timezone)}`;
    }

    if (dueDay === dateKey(localDate(now.getTime() + DAY_MS, timezone))) {
        return `завтра до ${clock(due, timezone)}`;
    }

    return `${dayAndMonth(due, timezone)} до ${clock(due, timezone)}`;
}

export function formatDue(due: Date, now: Date, timezone: string): string {
    const sameDay = dateKey(localDate(due.getTime(), timezone)) === dateKey(localDate(now.getTime(), timezone));

    return sameDay ? clock(due, timezone) : `${dayAndMonth(due, timezone)}, ${clock(due, timezone)}`;
}
