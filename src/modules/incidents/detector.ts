import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import { one, type Database, type Sql } from '../../shared/db.js';
import { emit, enqueue } from '../../shared/events.js';

import { ensureIncidentSettings, type IncidentSettings } from './incident-settings.js';
import { densestCluster, descriptions, findSpikes, type Spike } from './spikes.js';
import { commonTerms, defaultPublicMessage, pluralTickets, suggestionTitle } from './terms.js';

const RUN_EVERY = "interval '55 seconds'";

interface Recipient extends Record<string, unknown> {
    id: string;
    max_user_id: string;
    activated_at: string | null;
}

async function claimRun(db: Sql, org: string): Promise<IncidentSettings | undefined> {
    return one<IncidentSettings>(
        db,
        `UPDATE incident_settings SET detected_at=now()
     WHERE org_id=$1 AND detection AND (detected_at IS NULL OR detected_at<=now()-${RUN_EVERY})
     RETURNING detection,auto_link,window_minutes,min_tickets,spike_factor::float AS spike_factor,relink_hours,version`,
        [org],
    );
}

function alertText(spike: Spike, settings: IncidentSettings, terms: string[]): string {
    const usual = Math.round(spike.baseline);

    return [
        `Возможная авария: ${pluralTickets(spike.count)} «${spike.label}» за ${settings.window_minutes} мин ` +
            `(обычно ${usual}).`,
        terms.length ? `Общее: ${terms.join(', ')}.` : '',
        'Откройте «Инциденты» в TaskLine, чтобы создать инцидент или отклонить подсказку.',
    ]
        .filter(Boolean)
        .join('\n');
}

async function notifySupervisors(tx: Sql, ctx: Ctx, args: { incidentId: string; text: string; payload: object }) {
    const { rows } = await tx.query<Recipient>(
        `SELECT id,max_user_id,activated_at FROM employees
     WHERE org_id=$1 AND NOT blocked AND role IN('supervisor','admin') ORDER BY id`,
        [ctx.org],
    );

    await emit(tx, ctx.org, {
        type: 'incident.suggested',
        ticketId: null,
        payload: { incident_id: args.incidentId, ...args.payload },
        employeeIds: rows.map((row) => row.id),
        alerts: false,
    });

    for (const employee of rows.filter((row) => row.activated_at)) {
        await enqueue(tx, ctx.org, {
            key: `staff-alert:incident:${args.incidentId}:${employee.id}`,
            kind: 'staff_alert',
            refId: args.incidentId,
            payload: { user_id: employee.max_user_id, text: args.text },
        });
    }
}

async function suggest(tx: Sql, ctx: Ctx, { spike, settings }: { spike: Spike; settings: IncidentSettings }) {
    const cluster = await densestCluster(tx, ctx.org, spike.ids);
    const { terms, localities } = commonTerms(await descriptions(tx, ctx.org, cluster));

    const detection = {
        count: spike.count,
        baseline: Math.round(spike.baseline * 10) / 10,
        window_minutes: settings.window_minutes,
        ticket_ids: spike.ids,
        cluster_ids: cluster,
        terms,
    };

    const existing = await tx.query(
        `UPDATE incidents SET detection=$3,match_terms=$4,version=version+1,updated_at=now()
     WHERE org_id=$1 AND tag=$2 AND status='suggested' RETURNING id`,
        [ctx.org, spike.topic, JSON.stringify(detection), terms],
    );

    if (existing.rows.length) {
        await emit(tx, ctx.org, {
            type: 'incident.changed',
            ticketId: null,
            payload: { incident_id: existing.rows[0].id },
        });

        return;
    }

    const created = await one<{ id: string }>(
        tx,
        `INSERT INTO incidents(org_id,status,title,tag,public_message,match_terms,detection)
     VALUES($1,'suggested',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
        [
            ctx.org,
            suggestionTitle(spike.label, localities),
            spike.topic,
            defaultPublicMessage(spike.label),
            terms,
            JSON.stringify(detection),
        ],
    );

    if (created) {
        await notifySupervisors(tx, ctx, {
            incidentId: created.id,
            text: alertText(spike, settings, terms),
            payload: { count: spike.count, baseline: detection.baseline, label: spike.label },
        });
    }
}

export class IncidentDetector {
    private readonly ctx: Ctx;

    constructor(
        private readonly db: Database,
        config: Config,
    ) {
        this.ctx = createCtx(config);
    }

    async run(): Promise<void> {
        await ensureIncidentSettings(this.db, this.ctx.org);
        const settings = await claimRun(this.db, this.ctx.org);

        if (!settings) {
            return;
        }

        for (const spike of await findSpikes(this.db, this.ctx.org, settings)) {
            await this.db.tx(async (tx) => suggest(tx, this.ctx, { spike, settings }));
        }
    }
}
