import { requireOne, type Sql } from '../../shared/db.js';
import type { Ticket } from '../../shared/types/entities.js';

import { addBusinessTime, businessMinutesBetween, isWorkingTime, type Calendar } from './business-time.js';
import { formatEta } from './eta.js';
import { calendarOf, findTargets, loadSlaSettings, type SlaSettings } from './sla-settings.js';

const WARNING_SHARE = 0.75;
const BREACHED = 2;

export interface SlaGreeting {
    template: 'ticket_created_eta' | 'outside_hours';
    eta: string;
}

interface ClockTimes {
    warn: Date;
    due: Date;
}

function clockTimes(start: Date, minutes: number, calendar: Calendar): ClockTimes {
    return {
        warn: addBusinessTime(start, minutes * WARNING_SHARE, calendar),
        due: addBusinessTime(start, minutes, calendar),
    };
}

async function databaseNow(tx: Sql): Promise<Date> {
    return new Date((await requireOne<{ now: Date | string }>(tx, 'SELECT now() AS now')).now);
}

async function activeSettings(tx: Sql, org: string): Promise<SlaSettings | undefined> {
    const settings = await loadSlaSettings(tx, org);

    return settings?.enabled ? settings : undefined;
}

export async function startSla(tx: Sql, org: string, ticket: Ticket): Promise<SlaGreeting | undefined> {
    await tx.query('UPDATE tickets SET resolution_started_at=created_at WHERE id=$1', [ticket.id]);
    const settings = await activeSettings(tx, org);
    const targets = settings && (await findTargets(tx, org, ticket));

    if (!settings || !targets) {
        return undefined;
    }

    const calendar = calendarOf(settings);
    const created = new Date(ticket.created_at);
    const response = clockTimes(created, targets.first_response_minutes, calendar);
    const resolution = clockTimes(created, targets.resolution_minutes, calendar);

    await tx.query(
        `UPDATE tickets SET sla_first_response_minutes=$2,sla_resolution_minutes=$3,
       first_response_warn_at=$4,first_response_due_at=$5,resolution_warn_at=$6,resolution_due_at=$7,
       sla_next_check_at=least($4::timestamptz,$6::timestamptz) WHERE id=$1`,
        [
            ticket.id,
            targets.first_response_minutes,
            targets.resolution_minutes,
            response.warn,
            response.due,
            resolution.warn,
            resolution.due,
        ],
    );

    if (!settings.client_eta) {
        return undefined;
    }

    return {
        template: isWorkingTime(created, calendar) ? 'ticket_created_eta' : 'outside_hours',
        eta: formatEta(response.due, created, settings.timezone),
    };
}

export async function reclassifySla(tx: Sql, org: string, ticketId: string): Promise<void> {
    const settings = await activeSettings(tx, org);
    const ticket = await requireOne<Ticket>(tx, 'SELECT * FROM tickets WHERE id=$1', [ticketId]);

    if (!settings || !['open', 'in_progress'].includes(ticket.status)) {
        return;
    }

    const targets = await findTargets(tx, org, ticket);
    const calendar = calendarOf(settings);

    await tx.query(
        `UPDATE tickets SET
       sla_first_response_minutes=CASE WHEN $2 THEN $4::int ELSE sla_first_response_minutes END,
       first_response_warn_at=CASE WHEN $2 THEN $5::timestamptz ELSE first_response_warn_at END,
       first_response_due_at=CASE WHEN $2 THEN $6::timestamptz ELSE first_response_due_at END,
       sla_resolution_minutes=CASE WHEN $3 THEN $7::int ELSE sla_resolution_minutes END,
       resolution_warn_at=CASE WHEN $3 THEN $8::timestamptz ELSE resolution_warn_at END,
       resolution_due_at=CASE WHEN $3 THEN $9::timestamptz ELSE resolution_due_at END,
       sla_next_check_at=now() WHERE id=$1`,
        [
            ticket.id,
            !ticket.first_responded_at && ticket.first_response_stage < BREACHED,
            ticket.resolution_stage < BREACHED,
            ...clockColumns(targets?.first_response_minutes, (minutes) =>
                clockTimes(new Date(ticket.created_at), minutes, calendar),
            ),
            ...clockColumns(targets?.resolution_minutes, (minutes) => resolutionTimes(ticket, minutes, calendar)),
        ],
    );
}

function clockColumns(minutes: number | undefined, times: (minutes: number) => ClockTimes) {
    if (minutes === undefined) {
        return [null, null, null];
    }

    const { warn, due } = times(minutes);

    return [minutes, warn, due];
}

function resolutionTimes(ticket: Ticket, minutes: number, calendar: Calendar): ClockTimes {
    const start = new Date(ticket.resolution_started_at ?? ticket.created_at);

    return clockTimes(start, minutes + ticket.sla_paused_seconds / 60, calendar);
}

export async function pauseSla(tx: Sql, ticketId: string): Promise<void> {
    await tx.query(
        'UPDATE tickets SET waiting_since=now(),waiting_reminded=false,sla_next_check_at=now() WHERE id=$1',
        [ticketId],
    );
}

export async function resumeSla(tx: Sql, org: string, ticket: Ticket): Promise<void> {
    if (!ticket.waiting_since) {
        return;
    }

    const settings = await loadSlaSettings(tx, org);
    const calendar = settings && calendarOf(settings);
    const now = await databaseNow(tx);
    const paused = calendar ? businessMinutesBetween(new Date(ticket.waiting_since), now, calendar) : 0;
    const pausedSeconds = ticket.sla_paused_seconds + Math.round(paused * 60);
    const minutes = ticket.sla_resolution_minutes;
    const shift = calendar && minutes !== null && ticket.resolution_stage < BREACHED;
    const times = shift ? resolutionTimes({ ...ticket, sla_paused_seconds: pausedSeconds }, minutes, calendar) : null;

    await tx.query(
        `UPDATE tickets SET waiting_since=NULL,waiting_reminded=false,sla_paused_seconds=$2,
       resolution_warn_at=coalesce($3,resolution_warn_at),resolution_due_at=coalesce($4,resolution_due_at),
       sla_next_check_at=now() WHERE id=$1`,
        [ticket.id, pausedSeconds, times?.warn ?? null, times?.due ?? null],
    );
}

export async function stopSla(tx: Sql, ticketId: string): Promise<void> {
    await tx.query(
        `UPDATE tickets SET waiting_since=NULL,sla_next_check_at=NULL,
       sla_breached=CASE WHEN resolution_due_at<now() AND waiting_since IS NULL
         AND NOT 'resolution'=ANY(sla_breached) THEN sla_breached||'{resolution}'::text[] ELSE sla_breached END
     WHERE id=$1`,
        [ticketId],
    );
}

export async function restartResolution(tx: Sql, org: string, ticketId: string): Promise<void> {
    const ticket = await requireOne<Ticket>(
        tx,
        `UPDATE tickets SET resolution_started_at=now(),sla_paused_seconds=0,resolution_stage=0,waiting_since=NULL,
       resolution_warn_at=NULL,resolution_due_at=NULL,sla_next_check_at=now() WHERE id=$1 RETURNING *`,
        [ticketId],
    );

    const settings = await activeSettings(tx, org);
    const targets = settings && (await findTargets(tx, org, ticket));

    if (!settings || !targets) {
        return;
    }

    const times = resolutionTimes(ticket, targets.resolution_minutes, calendarOf(settings));

    await tx.query(
        'UPDATE tickets SET sla_resolution_minutes=$2,resolution_warn_at=$3,resolution_due_at=$4 WHERE id=$1',
        [ticket.id, targets.resolution_minutes, times.warn, times.due],
    );
}

export async function markFirstResponse(tx: Sql, ticketId: string): Promise<void> {
    await tx.query(
        `UPDATE tickets SET first_responded_at=now(),sla_next_check_at=now(),
       sla_breached=CASE WHEN first_response_due_at<now() AND NOT 'first_response'=ANY(sla_breached)
         THEN sla_breached||'{first_response}'::text[] ELSE sla_breached END
     WHERE id=$1 AND first_responded_at IS NULL`,
        [ticketId],
    );
}
