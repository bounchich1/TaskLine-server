import type { Sql } from '../../shared/db.js';

import type { IncidentSettings } from './incident-settings.js';

export interface Spike extends Record<string, unknown> {
    topic: string;
    label: string;
    count: number;
    baseline: number;
    ids: string[];
}

const TOPIC_GUESS = `(SELECT d.code FROM dictionaries d CROSS JOIN LATERAL unnest(d.examples||ARRAY[d.label]) AS ex(text)
  WHERE d.org_id=t.org_id AND d.dimension='tag' AND d.active AND d.code<>'undefined'
    AND word_similarity(lower(ex.text),lower(t.description))>=0.6
  ORDER BY word_similarity(lower(ex.text),lower(t.description)) DESC,d.code LIMIT 1)`;

const SPIKES = `WITH recent AS (
  SELECT t.id,t.created_at,CASE WHEN t.tag<>'undefined' THEN t.tag ELSE ${TOPIC_GUESS} END AS topic
  FROM tickets t
  WHERE t.org_id=$1 AND t.created_at>now()-$2*interval '1 minute'
    AND NOT EXISTS(SELECT 1 FROM incident_tickets it WHERE it.ticket_id=t.id)
), counts AS (
  SELECT topic,count(*)::int AS n,(array_agg(id ORDER BY created_at DESC))[1:200] AS ids
  FROM recent WHERE topic IS NOT NULL GROUP BY topic
), baseline AS (
  SELECT t.tag AS topic,sum(w.weight)::float AS expected
  FROM (VALUES (1,0.5),(2,0.25),(3,0.125),(4,0.125)) AS w(week,weight)
  JOIN tickets t ON t.org_id=$1
    AND t.created_at>now()-w.week*interval '7 days'-$2*interval '1 minute'
    AND t.created_at<=now()-w.week*interval '7 days'
  GROUP BY t.tag
)
SELECT c.topic,coalesce(d.label,c.topic) AS label,c.n AS count,coalesce(b.expected,0)::float AS baseline,c.ids
FROM counts c
LEFT JOIN baseline b ON b.topic=c.topic
LEFT JOIN dictionaries d ON d.org_id=$1 AND d.dimension='tag' AND d.code=c.topic
WHERE c.n>=greatest($3,coalesce(b.expected,0)*$4)
  AND NOT EXISTS(SELECT 1 FROM incidents i WHERE i.org_id=$1 AND i.tag=c.topic AND (i.status='open'
    OR (i.status='dismissed' AND i.dismissed_at>now()-interval '1 hour')))
ORDER BY c.n DESC`;

export async function findSpikes(db: Sql, org: string, settings: IncidentSettings): Promise<Spike[]> {
    const { rows } = await db.query<Spike>(SPIKES, [
        org,
        settings.window_minutes,
        settings.min_tickets,
        settings.spike_factor,
    ]);

    return rows;
}

const SIMILAR = 0.3;
const MIN_CLUSTER = 3;

export async function densestCluster(db: Sql, org: string, ids: string[]): Promise<string[]> {
    const { rows } = await db.query<{ id: string; neighbours: string[] | null }>(
        `WITH c AS (SELECT id,lower(description) AS text FROM tickets WHERE org_id=$1 AND id=ANY($2::uuid[]))
     SELECT a.id,array_agg(b.id) FILTER(WHERE b.id IS NOT NULL) AS neighbours
     FROM c a LEFT JOIN c b ON b.id<>a.id AND similarity(a.text,b.text)>=$3
     GROUP BY a.id ORDER BY count(b.id) DESC,a.id LIMIT 1`,
        [org, ids, SIMILAR],
    );

    const center = rows.at(0);
    const cluster = center ? [center.id, ...(center.neighbours ?? [])] : [];

    return cluster.length >= MIN_CLUSTER ? cluster : ids;
}

export async function descriptions(db: Sql, org: string, ids: string[]): Promise<string[]> {
    const { rows } = await db.query<{ description: string }>(
        'SELECT description FROM tickets WHERE org_id=$1 AND id=ANY($2::uuid[])',
        [org, ids],
    );

    return rows.map((row) => row.description);
}
