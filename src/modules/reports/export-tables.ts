import type { aiQuality } from './ai-quality.js';
import type { aiUsage } from './ai-usage.js';
import type { OverviewMetrics } from './overview.js';
import type { qualityReport } from './quality.js';
import type { Cell, Table } from './spreadsheet.js';
import type { TeamRow } from './team.js';
import type { TopicRow } from './topics.js';

type AiReport = Awaited<ReturnType<typeof aiQuality>> & Awaited<ReturnType<typeof aiUsage>>;
type QualityReport = Awaited<ReturnType<typeof qualityReport>>;

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const minutes = (value: number | null): Cell => (value === null ? null : round(value / 60));
const hours = (value: number | null): Cell => (value === null ? null : round(value / 3600));
const percent = (value: number | null): Cell => (value === null ? null : round(value * 100));
const decimal = (value: number | null): Cell => (value === null ? null : round(value));

const OVERVIEW_ROWS: [string, keyof OverviewMetrics, (value: number | null) => Cell][] = [
    ['Новых обращений', 'created', decimal],
    ['Закрыто', 'closed', decimal],
    ['Открыто на конец периода', 'open_end', decimal],
    ['Первый ответ, медиана, мин', 'response_p50', minutes],
    ['Первый ответ, 90-й перцентиль, мин', 'response_p90', minutes],
    ['Решение, медиана, ч', 'resolution_p50', hours],
    ['Решение, 90-й перцентиль, ч', 'resolution_p90', hours],
    ['Время до назначения, медиана, мин', 'assignment_p50', minutes],
    ['Средняя оценка (1–10)', 'csat', decimal],
    ['Оценок получено', 'rated', decimal],
    ['Доля оценок 9–10, %', 'promoters', percent],
    ['Доля оценок 1–6, %', 'detractors', percent],
    ['Ответили на запрос оценки, %', 'rating_response', percent],
    ['Переоткрыто за 7 дней, %', 'reopen_rate', percent],
    ['SLA первого ответа, %', 'sla_response', percent],
    ['SLA решения, %', 'sla_resolution', percent],
];

export function overviewTable(report: { current: OverviewMetrics; previous: OverviewMetrics }): Table {
    return {
        title: 'Обзор',
        columns: ['Показатель', 'Период', 'Предыдущий период'],
        rows: OVERVIEW_ROWS.map(([label, key, format]) => [
            label,
            format(report.current[key]),
            format(report.previous[key]),
        ]),
    };
}

export function teamTable(report: { items: TeamRow[] }): Table {
    return {
        title: 'Команда',
        columns: [
            'Сотрудник',
            'Взято',
            'Закрыто',
            'В работе',
            'Лимит',
            'Первый ответ, мин',
            'Решение, ч',
            'Оценка',
            'Оценок',
            'Переоткрыто, %',
            'Передано',
            'На линии, ч',
            'Черновик ИИ, %',
            'Шаблоны, %',
        ],
        rows: report.items.map((row) => [
            row.name,
            row.taken,
            row.closed,
            row.active,
            row.capacity,
            minutes(row.response_p50),
            hours(row.resolution_p50),
            decimal(row.csat),
            row.rated,
            percent(row.reopen_rate),
            row.transfers_out,
            hours(row.online_seconds),
            percent(row.ai_draft_share),
            percent(row.macro_share),
        ]),
    };
}

export function topicsTable(report: { items: TopicRow[] }): Table {
    return {
        title: 'Темы',
        columns: ['Тема', 'Новых', 'Предыдущий период', 'Рост, %', 'Закрыто', 'Решение, ч', 'Оценка'],
        rows: report.items.map((row) => [
            row.label,
            row.created,
            row.previous,
            percent(row.growth),
            row.closed,
            hours(row.resolution_p50),
            decimal(row.csat),
        ]),
    };
}

export function aiTable(report: AiReport): Table {
    const rows: Cell[][] = [
        ['Классифицировано ИИ', report.accuracy.classified],
        ['Тема без правок, %', percent(report.accuracy.tag)],
        ['Срочность без правок, %', percent(report.accuracy.urgency)],
        ['Сложность без правок, %', percent(report.accuracy.complexity)],
        ['Всё без правок, %', percent(report.accuracy.all)],
        ['Требовали проверки, %', percent(report.review.rate)],
        ['Ответов из черновика ИИ, %', percent(report.drafts.ai_share)],
        ['Обращений с черновиком ИИ, %', percent(report.drafts.ticket_share)],
        ['Правки черновика, медиана, %', percent(report.drafts.edit_p50)],
        ['Ответов из шаблонов, %', percent(report.drafts.macro_share)],
        ['Подсказок со ссылкой на решённый случай, %', percent(report.grounding.share)],
        ['Решение с источником, медиана, ч', hours(report.grounding.grounded_resolution_p50)],
        ['Решение без источника, медиана, ч', hours(report.grounding.ungrounded_resolution_p50)],
        ['Выучено закрытий', report.knowledge.learned],
        ['Записей в базе знаний', report.knowledge.eligible_records],
        ['Найдено похожих случаев на обращение', decimal(report.knowledge.recall_hits)],
        ['Анализ обращения, медиана, с', decimal(report.triage.p50)],
        ['Анализ обращения, 95-й перцентиль, с', decimal(report.triage.p95)],
        ['Успешных анализов, %', percent(report.triage.success_rate)],
        ['Токенов на входе', report.cost.prompt_tokens],
        ['Токенов на выходе', report.cost.completion_tokens],
        [`Стоимость, ${report.cost.currency}`, report.cost.amount === null ? null : round(report.cost.amount, 2)],
    ];

    return { title: 'ИИ', columns: ['Показатель', 'Значение'], rows };
}

export function qualityTable(report: QualityReport, timezone: string): Table {
    const format = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' });

    return {
        title: 'Качество',
        columns: ['Обращение', 'Тема', 'Сотрудник', 'Оценка', 'Закрыто'],
        rows: report.items.map((row) => [
            `№${row.number}`,
            row.tag_label,
            row.assignee_name,
            row.rating,
            format.format(new Date(row.closed_at)),
        ]),
    };
}
