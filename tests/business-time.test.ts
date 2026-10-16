import { describe, expect, it } from 'vitest';

import {
    addBusinessTime,
    businessMinutesBetween,
    isWorkingTime,
    type Calendar,
} from '../src/modules/sla/business-time.js';
import { formatEta } from '../src/modules/sla/eta.js';
import { calendarOf } from '../src/modules/sla/sla-settings.js';
import { evaluate } from '../src/modules/sla/sla-timers.js';

const WEEKDAYS = { 1: true, 2: true, 3: true, 4: true, 5: true, 6: false, 7: false } as const;

function officeCalendar(
    timezone: string,
    hours: [string, string][] = [['09:00', '18:00']],
    extra: { holidays?: string[]; workdays?: string[] } = {},
): Calendar {
    const week = Object.fromEntries(Object.entries(WEEKDAYS).map(([day, works]) => [day, works ? hours : []]));

    return calendarOf({ timezone, week, holidays: extra.holidays ?? [], workdays: extra.workdays ?? [] });
}

const krasnoyarsk = officeCalendar('Asia/Krasnoyarsk');
const iso = (value: Date) => value.toISOString();

describe('addBusinessTime', () => {
    it('carries a late Friday ticket over the weekend', () => {
        const due = addBusinessTime(new Date('2026-10-16T16:59:00Z'), 30, krasnoyarsk);

        expect(iso(due)).toBe('2026-10-19T02:30:00.000Z');
    });

    it('skips the lunch break', () => {
        const lunch = officeCalendar('Asia/Krasnoyarsk', [
            ['09:00', '13:00'],
            ['14:00', '18:00'],
        ]);

        expect(iso(addBusinessTime(new Date('2026-10-19T05:45:00Z'), 30, lunch))).toBe('2026-10-19T07:15:00.000Z');
    });

    it('spreads a long target over several working days', () => {
        const lunch = officeCalendar('Asia/Krasnoyarsk', [
            ['09:00', '13:00'],
            ['14:00', '18:00'],
        ]);

        expect(iso(addBusinessTime(new Date('2026-10-19T03:00:00Z'), 960, lunch))).toBe('2026-10-21T03:00:00.000Z');
    });

    it('skips holidays and works transferred Saturdays', () => {
        const start = new Date('2026-10-16T10:50:00Z');
        const holiday = officeCalendar('Asia/Krasnoyarsk', undefined, { holidays: ['2026-10-19'] });
        const saturday = officeCalendar('Asia/Krasnoyarsk', undefined, { workdays: ['2026-10-17'] });

        expect(iso(addBusinessTime(start, 30, holiday))).toBe('2026-10-20T02:20:00.000Z');
        expect(iso(addBusinessTime(start, 30, saturday))).toBe('2026-10-17T02:20:00.000Z');
    });

    it('starts the clock at opening time when created outside hours', () => {
        const night = new Date('2026-10-19T20:00:00Z');

        expect(iso(addBusinessTime(night, 0, krasnoyarsk))).toBe('2026-10-20T02:00:00.000Z');
        expect(isWorkingTime(night, krasnoyarsk)).toBe(false);
        expect(isWorkingTime(new Date('2026-10-20T02:00:00Z'), krasnoyarsk)).toBe(true);
    });

    it('uses the organisation time zone from Kaliningrad to Kamchatka', () => {
        const start = new Date('2026-10-16T06:00:00Z');

        expect(iso(addBusinessTime(start, 60, officeCalendar('Europe/Kaliningrad')))).toBe('2026-10-16T08:00:00.000Z');
        expect(iso(addBusinessTime(start, 60, officeCalendar('Asia/Kamchatka')))).toBe('2026-10-18T22:00:00.000Z');
    });

    it('counts real elapsed time across a daylight saving change', () => {
        const always = calendarOf({
            timezone: 'Europe/Berlin',
            week: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((day) => [String(day), [['00:00', '24:00']]])),
            holidays: [],
            workdays: [],
        });

        expect(iso(addBusinessTime(new Date('2026-03-28T23:30:00Z'), 180, always))).toBe('2026-03-29T02:30:00.000Z');
    });

    it('falls back to wall time when no working hours are configured', () => {
        const closed = calendarOf({ timezone: 'UTC', week: {}, holidays: [], workdays: [] });

        expect(iso(addBusinessTime(new Date('2026-10-16T00:00:00Z'), 90, closed))).toBe('2026-10-16T01:30:00.000Z');
    });
});

describe('businessMinutesBetween', () => {
    it('counts only working minutes', () => {
        const friday = new Date('2026-10-16T10:00:00Z');
        const monday = new Date('2026-10-19T03:00:00Z');

        expect(businessMinutesBetween(friday, monday, krasnoyarsk)).toBe(120);
        expect(businessMinutesBetween(monday, friday, krasnoyarsk)).toBe(0);
    });

    it('agrees with addBusinessTime', () => {
        const start = new Date('2026-10-15T09:17:00Z');
        const due = addBusinessTime(start, 1234, krasnoyarsk);

        expect(businessMinutesBetween(start, due, krasnoyarsk)).toBeCloseTo(1234, 6);
    });
});

describe('formatEta', () => {
    const now = new Date('2026-10-16T03:00:00Z');

    it('says today, tomorrow or the date in the organisation time zone', () => {
        expect(formatEta(new Date('2026-10-16T04:30:00Z'), now, 'Asia/Krasnoyarsk')).toBe('сегодня до 11:30');
        expect(formatEta(new Date('2026-10-17T02:30:00Z'), now, 'Asia/Krasnoyarsk')).toBe('завтра до 9:30');
        expect(formatEta(new Date('2026-10-19T02:30:00Z'), now, 'Asia/Krasnoyarsk')).toBe('19 октября до 9:30');
    });
});

describe('evaluate', () => {
    const clock = {
        name: 'first_response' as const,
        stage: 0,
        target: 60,
        warn: new Date('2026-10-16T03:45:00Z'),
        due: new Date('2026-10-16T04:00:00Z'),
    };

    const always = calendarOf({
        timezone: 'UTC',
        week: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((day) => [String(day), [['00:00', '24:00']]])),
        holidays: [],
        workdays: [],
    });

    it('moves through warning, breach and escalation', () => {
        expect(evaluate([clock], new Date('2026-10-16T03:00:00Z'), always)).toMatchObject({
            next: clock.warn,
            stages: { first_response: 0 },
            breached: [],
        });

        expect(evaluate([clock], new Date('2026-10-16T03:50:00Z'), always)).toMatchObject({
            next: clock.due,
            stages: { first_response: 1 },
        });

        expect(evaluate([clock], new Date('2026-10-16T04:10:00Z'), always)).toMatchObject({
            next: new Date('2026-10-16T05:00:00Z'),
            stages: { first_response: 2 },
            breached: ['first_response'],
        });

        expect(evaluate([clock], new Date('2026-10-16T05:00:00Z'), always)).toMatchObject({
            next: null,
            stages: { first_response: 3 },
        });
    });

    it('never moves a stage backwards', () => {
        expect(evaluate([{ ...clock, stage: 2 }], new Date('2026-10-16T03:00:00Z'), always).stages).toEqual({
            first_response: 2,
        });
    });
});
