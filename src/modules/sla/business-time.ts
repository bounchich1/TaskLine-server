export type WorkInterval = readonly [number, number];

export interface Calendar {
    timezone: string;
    week: ReadonlyMap<number, readonly WorkInterval[]>;
    holidays: ReadonlySet<string>;
    workdays: ReadonlySet<string>;
}

interface LocalDate {
    year: number;
    month: number;
    day: number;
}

const MINUTE_MS = 60000;
const DAY_MS = 86400000;
const MAX_SEARCH_DAYS = 3700;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
    let cached = formatters.get(timezone);

    if (!cached) {
        cached = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
        });

        formatters.set(timezone, cached);
    }

    return cached;
}

function wallClock(instant: number, timezone: string): number {
    const parts = Object.fromEntries(
        formatter(timezone)
            .formatToParts(new Date(instant))
            .map((part) => [part.type, Number(part.value)]),
    ) as Record<string, number>;

    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function offsetAt(instant: number, timezone: string): number {
    return wallClock(Math.floor(instant / 1000) * 1000, timezone) - Math.floor(instant / 1000) * 1000;
}

export function localDate(instant: number, timezone: string): LocalDate {
    const wall = new Date(wallClock(instant, timezone));

    return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

export function dateKey({ year, month, day }: LocalDate): string {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function nextDate({ year, month, day }: LocalDate): LocalDate {
    const next = new Date(Date.UTC(year, month - 1, day) + DAY_MS);

    return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function isoWeekday({ year, month, day }: LocalDate): number {
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

function zonedInstant(date: LocalDate, minuteOfDay: number, timezone: string): number {
    const wall = Date.UTC(date.year, date.month - 1, date.day) + minuteOfDay * MINUTE_MS;
    const guess = wall - offsetAt(wall, timezone);

    return wall - offsetAt(guess, timezone);
}

function regularWorkday(calendar: Calendar): readonly WorkInterval[] {
    for (let weekday = 1; weekday <= 7; weekday++) {
        const intervals = calendar.week.get(weekday) ?? [];

        if (intervals.length) {
            return intervals;
        }
    }

    return [];
}

function workIntervals(date: LocalDate, calendar: Calendar): [number, number][] {
    const key = dateKey(date);

    if (calendar.holidays.has(key)) {
        return [];
    }

    const intervals = calendar.workdays.has(key)
        ? regularWorkday(calendar)
        : (calendar.week.get(isoWeekday(date)) ?? []);

    return intervals.map(([from, to]) => [
        zonedInstant(date, from, calendar.timezone),
        zonedInstant(date, to, calendar.timezone),
    ]);
}

function hasWorkingTime(calendar: Calendar): boolean {
    return [...calendar.week.values()].some((intervals) => intervals.length > 0) || calendar.workdays.size > 0;
}

export function addBusinessTime(start: Date, minutes: number, calendar: Calendar): Date {
    const from = start.getTime();
    let remaining = Math.max(0, minutes) * MINUTE_MS;

    if (!hasWorkingTime(calendar)) {
        return new Date(from + remaining);
    }

    let date = localDate(from, calendar.timezone);

    for (let index = 0; index < MAX_SEARCH_DAYS; index++) {
        for (const [open, close] of workIntervals(date, calendar)) {
            if (close <= from) {
                continue;
            }

            const begin = Math.max(open, from);

            if (begin + remaining <= close) {
                return new Date(begin + remaining);
            }

            remaining -= close - begin;
        }

        date = nextDate(date);
    }

    return new Date(from + Math.max(0, minutes) * MINUTE_MS);
}

export function businessMinutesBetween(start: Date, end: Date, calendar: Calendar): number {
    const from = start.getTime();
    const to = end.getTime();

    if (to <= from || !hasWorkingTime(calendar)) {
        return Math.max(0, to - from) / MINUTE_MS;
    }

    let total = 0;
    let date = localDate(from, calendar.timezone);
    const last = dateKey(localDate(to, calendar.timezone));

    for (let index = 0; index < MAX_SEARCH_DAYS; index++) {
        for (const [open, close] of workIntervals(date, calendar)) {
            total += Math.max(0, Math.min(close, to) - Math.max(open, from));
        }

        if (dateKey(date) >= last) {
            break;
        }

        date = nextDate(date);
    }

    return total / MINUTE_MS;
}

export function isWorkingTime(moment: Date, calendar: Calendar): boolean {
    if (!hasWorkingTime(calendar)) {
        return true;
    }

    const instant = moment.getTime();

    return workIntervals(localDate(instant, calendar.timezone), calendar).some(
        ([open, close]) => open <= instant && instant < close,
    );
}
