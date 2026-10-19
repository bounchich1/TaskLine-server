import { z } from 'zod';

import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import { one, type Database } from '../../shared/db.js';
import { loadBusinessCalendar } from '../sla/index.js';

import { aiQuality } from './ai-quality.js';
import { aiUsage } from './ai-usage.js';
import { aiTable, overviewTable, qualityTable, teamTable, topicsTable } from './export-tables.js';
import { refreshFacts } from './facts-refresh.js';
import { overviewReport } from './overview.js';
import { periodBody, resolvePeriod, type Period, type PeriodInput } from './period.js';
import { qualityReport } from './quality.js';
import { toCsv, toXlsx, type Table } from './spreadsheet.js';
import { teamReport } from './team.js';
import { topicsReport } from './topics.js';

export const reportName = z.enum(['overview', 'team', 'topics', 'ai', 'quality']);
export const exportFormat = z.enum(['csv', 'xlsx']);

export type ReportName = z.infer<typeof reportName>;
export type ExportFormat = z.infer<typeof exportFormat>;

const ON_DEMAND_MAX_AGE_SECONDS = 60;

const CONTENT_TYPES: Record<ExportFormat, string> = {
    csv: 'text/csv; charset=utf-8',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export interface ExportFile {
    filename: string;
    contentType: string;
    body: string | Buffer;
}

export function exportFilename(name: ReportName, format: ExportFormat, input: PeriodInput): string {
    return `taskline-${name}-${input.from}_${input.to}.${format}`;
}

export class Reports {
    readonly ctx: Ctx;
    private readonly org: string;

    constructor(
        private readonly db: Database,
        private readonly config: Config,
    ) {
        this.ctx = createCtx(config);
        this.org = config.ORG_ID;
    }

    async report(name: ReportName, input: PeriodInput) {
        const { period, businessHours } = await this.prepare(input);

        const state = await one<{ ran_at: string | null }>(
            this.db,
            'SELECT ran_at FROM facts_refresh WHERE org_id=$1',
            [this.org],
        );

        return {
            report: name,
            period: periodBody(period),
            refreshed_at: state?.ran_at ?? null,
            ...(await this.build(name, period, businessHours)),
        };
    }

    async export(name: ReportName, format: ExportFormat, input: PeriodInput): Promise<ExportFile> {
        const table = await this.table(name, input);

        return {
            filename: exportFilename(name, format, input),
            contentType: CONTENT_TYPES[format],
            body: format === 'csv' ? toCsv(table) : toXlsx(table),
        };
    }

    private async prepare(input: PeriodInput): Promise<{ period: Period; businessHours: boolean }> {
        await refreshFacts(this.db, this.org, ON_DEMAND_MAX_AGE_SECONDS);
        const period = await resolvePeriod(this.db, this.org, input);
        const businessHours = (await loadBusinessCalendar(this.db, this.org)) !== undefined;

        return { period, businessHours };
    }

    private async aiReport(period: Period) {
        return {
            ...(await aiQuality(this.db, this.org, period)),
            ...(await aiUsage(this.db, this.org, period, this.config)),
        };
    }

    private async table(name: ReportName, input: PeriodInput): Promise<Table> {
        const { period, businessHours } = await this.prepare(input);
        const { db, org } = this;

        switch (name) {
            case 'overview':
                return overviewTable(await overviewReport(db, org, period, businessHours));
            case 'team':
                return teamTable(await teamReport(db, org, period, businessHours));
            case 'topics':
                return topicsTable(await topicsReport(db, org, period, businessHours));
            case 'ai':
                return aiTable(await this.aiReport(period));
            case 'quality':
                return qualityTable(await qualityReport(db, org, period), period.timezone);
        }
    }

    private async build(name: ReportName, period: Period, businessHours: boolean): Promise<object> {
        const { db, org } = this;

        switch (name) {
            case 'overview':
                return overviewReport(db, org, period, businessHours);
            case 'team':
                return teamReport(db, org, period, businessHours);
            case 'topics':
                return topicsReport(db, org, period, businessHours);
            case 'ai':
                return this.aiReport(period);
            case 'quality':
                return qualityReport(db, org, period);
        }
    }
}
