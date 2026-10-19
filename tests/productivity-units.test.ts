import { describe, expect, it } from 'vitest';

import { ViewerRegistry } from '../src/modules/notifications/viewers.js';
import { digestText, formatDuration } from '../src/modules/reports/digest.js';
import type { OverviewMetrics } from '../src/modules/reports/overview.js';
import { toCsv, toXlsx } from '../src/modules/reports/spreadsheet.js';
import { editRatio } from '../src/modules/tickets/commands/draft-ratio.js';
import { DeferredClose } from '../src/modules/tickets/index.js';
import { requireOne } from '../src/shared/db.js';
import type { Job } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';

describe('ticket viewers', () => {
    it('tracks viewing and typing with short lifetimes', () => {
        const registry = new ViewerRegistry();
        const anna = { id: 'a', name: 'Анна' };

        registry.touch('t1', anna, 'typing', 1000);
        expect(registry.changesSince(0, 1000).tickets).toEqual(['t1']);
        expect(registry.snapshot('t1', 1000)).toEqual([{ id: 'a', name: 'Анна', typing: true }]);

        const seen = registry.changesSince(0, 1000).version;

        expect(registry.changesSince(seen, 5000).tickets).toEqual([]);
        expect(registry.changesSince(seen, 10000).tickets).toEqual(['t1']);
        expect(registry.snapshot('t1', 10000)).toEqual([{ id: 'a', name: 'Анна', typing: false }]);

        registry.touch('t1', anna, 'left', 11000);
        expect(registry.snapshot('t1', 11000)).toEqual([]);

        registry.touch('t2', anna, 'viewing', 0);
        registry.changesSince(0, 40000);
        expect(registry.snapshot('t2', 40000)).toEqual([]);
    });
});

describe('draft edit ratio', () => {
    it('measures word edits against the longer text', () => {
        expect(editRatio('Перезагрузите роутер', 'Перезагрузите роутер')).toBe(0);
        expect(editRatio('Перезагрузите роутер', 'Перезагрузите, пожалуйста, роутер')).toBeCloseTo(1 / 3);
        expect(editRatio('', '')).toBe(0);
        expect(editRatio('одно', 'совсем другое длинное')).toBe(1);
    });
});

describe('report files', () => {
    it('writes Excel-friendly CSV and a valid XLSX container', () => {
        const table = {
            title: 'Темы',
            columns: ['Тема', 'Доля'],
            rows: [
                ['Оплата; счёт', 12.5],
                ['Сеть "дом"', null],
            ],
        };

        expect(toCsv(table)).toBe('﻿Тема;Доля\r\n"Оплата; счёт";12,5\r\n"Сеть ""дом""";\r\n');

        const file = toXlsx(table);

        expect(file.subarray(0, 4).toString('hex')).toBe('504b0304');
        expect(file.includes(Buffer.from('xl/worksheets/sheet1.xml'))).toBe(true);
    });

    it('formats the weekly digest with five numbers and a link', () => {
        const base = { created: 0, closed: 0, response_p50: null, csat: null } as unknown as OverviewMetrics;
        const current = { ...base, created: 12, closed: 10, response_p50: 1080, csat: 8.64 };

        const text = digestText(
            '12.10–18.10',
            { current, previous: { ...base, created: 10 }, accuracy: 0.87 },
            'https://max.ru/bot?startapp=reports',
        );

        expect(text.split('\n')).toEqual([
            'Неделя 12.10–18.10 · TaskLine',
            'Новых обращений: 12 (↑20%)',
            'Закрыто: 10',
            'Первый ответ, медиана: 18 мин',
            'Оценка клиентов: 8,6 из 10',
            'ИИ верно определил тему: 87%',
            'Отчёты: https://max.ru/bot?startapp=reports',
        ]);

        expect(formatDuration(3 * 3600 + 300)).toBe('3 ч 05 мин');
        expect(formatDuration(3 * 86400)).toBe('3,0 дн');
    });
});

describe('closing after the reply is delivered', () => {
    it('waits for delivery, then closes the ticket as the replying employee', async () => {
        const context = await fixture();

        try {
            await context.create();
            await context.command('assign', {});
            await context.command('messages', { text: 'Готово, проверьте', close_after: true });

            const job = await requireOne<Job>(context.db, "SELECT * FROM jobs WHERE kind='deferred_close'");
            const deferred = new DeferredClose(context.db, context.c);

            await expect(deferred.run(job)).rejects.toMatchObject({ code: 'close_waiting_delivery' });

            await context.db.query("UPDATE deliveries SET state='delivered' WHERE kind='staff'");
            await context.db.query("UPDATE messages SET delivery_state='delivered' WHERE author_type='staff'");
            await deferred.run(job);

            expect(await context.ticket()).toMatchObject({ status: 'awaiting_rating', closed_by: context.staff.id });
        } finally {
            await context.db.close();
        }
    });
});
