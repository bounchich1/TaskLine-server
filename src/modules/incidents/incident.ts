import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Row } from '../../shared/types/entities.js';

export type IncidentStatus = 'suggested' | 'open' | 'resolved' | 'dismissed';

export type Incident = Row & {
    id: string;
    org_id: string;
    title: string;
    tag: string;
    status: IncidentStatus;
    public_message: string;
    final_message: string;
    eta: Date | string | null;
    match_terms: string[];
    request_rating: boolean;
    detection: Row | null;
    learning_ticket_id: string | null;
    version: number;
};

export const LINKED_TO_OPEN_INCIDENT = `EXISTS(SELECT 1 FROM incident_tickets lnk JOIN incidents inc ON inc.id=lnk.incident_id
  WHERE lnk.ticket_id=t.id AND inc.status='open')`;

export async function lockIncident(
    tx: Sql,
    org: string,
    { id, expectedVersion }: { id: string; expectedVersion?: number },
): Promise<Incident> {
    const incident = await one<Incident>(tx, 'SELECT * FROM incidents WHERE org_id=$1 AND id=$2 FOR UPDATE', [org, id]);

    ensure(incident, 'not_found', 404, 'Инцидент не найден.');

    if (expectedVersion !== undefined) {
        ensure(
            incident.version === expectedVersion,
            'incident_version_conflict',
            409,
            'Инцидент изменился. Обновите страницу.',
        );
    }

    return incident;
}

export function ensureStatus(incident: Incident, allowed: IncidentStatus[]): void {
    ensure(
        allowed.includes(incident.status),
        'incident_state',
        409,
        'Действие недоступно для инцидента в этом статусе.',
    );
}
