import { z } from 'zod';

import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Row } from '../../shared/types/entities.js';

export const listQuery = z
    .object({ status: z.enum(['suggested', 'open', 'resolved', 'dismissed']).optional() })
    .strict();

const SUMMARY = `i.id,i.title,i.tag,coalesce(d.label,i.tag) AS tag_label,i.status,i.public_message,i.final_message,i.eta,
  i.match_terms,i.request_rating,i.detection,i.created_at,i.opened_at,i.resolved_at,i.dismissed_at,i.updated_at,i.version,
  e.name AS created_by_name,
  (SELECT count(*)::int FROM incident_tickets it WHERE it.incident_id=i.id) AS linked,
  (SELECT count(*)::int FROM incident_tickets it JOIN tickets t ON t.id=it.ticket_id
    WHERE it.incident_id=i.id AND t.status IN('open','in_progress')) AS linked_open,
  (SELECT count(*)::int FROM incident_tickets it WHERE it.incident_id=i.id AND it.auto) AS linked_auto,
  (SELECT coalesce(sum(u.recipients),0)::int FROM incident_updates u WHERE u.incident_id=i.id) AS messages_sent`;

const FROM = `FROM incidents i
  LEFT JOIN dictionaries d ON d.org_id=i.org_id AND d.dimension='tag' AND d.code=i.tag
  LEFT JOIN employees e ON e.org_id=i.org_id AND e.id=i.created_by`;

const ORDER = `CASE i.status WHEN 'suggested' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
  coalesce(i.resolved_at,i.dismissed_at,i.opened_at,i.created_at) DESC`;

export async function listIncidents(db: Sql, org: string, query: z.infer<typeof listQuery>) {
    const { rows } = await db.query(
        `SELECT ${SUMMARY} ${FROM} WHERE i.org_id=$1 AND ($2::text IS NULL OR i.status=$2)
       AND (i.status IN('suggested','open') OR coalesce(i.resolved_at,i.dismissed_at)>now()-interval '30 days')
     ORDER BY ${ORDER} LIMIT 100`,
        [org, query.status ?? null],
    );

    const counts = await one(
        db,
        `SELECT count(*) FILTER(WHERE status='suggested')::int AS suggested,
       count(*) FILTER(WHERE status='open')::int AS open,
       count(*) FILTER(WHERE status='resolved' AND resolved_at>now()-interval '30 days')::int AS resolved
     FROM incidents WHERE org_id=$1`,
        [org],
    );

    return { items: rows, counts };
}

async function candidates(db: Sql, org: string, detection: Row | null) {
    const ids = Array.isArray(detection?.ticket_ids) ? (detection.ticket_ids as string[]) : [];
    const cluster = Array.isArray(detection?.cluster_ids) ? (detection.cluster_ids as string[]) : [];

    if (!ids.length) {
        return [];
    }

    const { rows } = await db.query(
        `SELECT t.id,lpad(t.ticket_number::text,greatest(6,length(t.ticket_number::text)),'0') AS number,
       left(t.description,300) AS description,t.status,t.created_at,t.id=ANY($3::uuid[]) AS in_cluster,
       EXISTS(SELECT 1 FROM incident_tickets it JOIN incidents x ON x.id=it.incident_id
         WHERE it.ticket_id=t.id AND x.status='open') AS linked_elsewhere
     FROM tickets t WHERE t.org_id=$1 AND t.id=ANY($2::uuid[]) ORDER BY t.created_at DESC`,
        [org, ids, cluster],
    );

    return rows;
}

export async function incidentDetail(db: Sql, org: string, id: string) {
    const incident = await one(db, `SELECT ${SUMMARY} ${FROM} WHERE i.org_id=$1 AND i.id=$2`, [org, id]);

    ensure(incident, 'not_found', 404, 'Инцидент не найден.');

    const { rows: updates } = await db.query(
        `SELECT u.id,u.kind,u.text,u.eta,u.broadcast,u.recipients,u.finished_at,u.created_at,e.name AS author_name
     FROM incident_updates u LEFT JOIN employees e ON e.org_id=u.org_id AND e.id=u.author_id
     WHERE u.org_id=$1 AND u.incident_id=$2 ORDER BY u.created_at DESC,u.id`,
        [org, id],
    );

    return {
        ...incident,
        updates,
        candidates: incident.status === 'suggested' ? await candidates(db, org, incident.detection as Row | null) : [],
    };
}
