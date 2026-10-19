import { one, type Sql } from '../../shared/db.js';
import { emit, recordTicketEvent } from '../../shared/events.js';

const NO_EMPLOYEE = '00000000-0000-0000-0000-000000000000';

interface OfferTarget extends Record<string, unknown> {
    id: string;
    status: string;
    assignee_id: string | null;
    offered_to: string | null;
    offer_skipped: string[];
    tag: string;
    complexity: string;
    team_id: string;
    strategy: 'round_robin' | 'least_loaded' | 'skills';
    capacity: number;
    offer_timeout_seconds: number;
    last_offered_to: string | null;
}

const ORDER: Record<OfferTarget['strategy'], string> = {
    least_loaded: 'c.load,c.online_since NULLS LAST,c.id',
    skills: 'c.skill_score DESC,c.load,c.id',
    round_robin: 'c.after_last DESC,c.id',
};

const candidates = (strategy: OfferTarget['strategy']) => `SELECT c.id FROM (
  SELECT e.id,e.presence_at AS online_since,e.id>$7::uuid AS after_last,
    CASE WHEN ('tag:'||$3)=ANY(m.skills) THEN 2 ELSE 0 END+CASE WHEN ('complexity:'||$4)=ANY(m.skills) THEN 1 ELSE 0 END
      AS skill_score,
    (SELECT count(*) FROM tickets x WHERE x.org_id=$1 AND x.status='in_progress' AND x.assignee_id=e.id)::int
      +(SELECT count(*) FROM tickets x WHERE x.org_id=$1 AND x.offered_to=e.id)::int AS load
  FROM team_members m JOIN employees e ON e.org_id=m.org_id AND e.id=m.employee_id
  WHERE m.org_id=$1 AND m.team_id=$2 AND e.presence='online' AND NOT e.blocked AND e.activated_at IS NOT NULL
) c WHERE c.load<$6 AND NOT c.id=ANY($5::uuid[]) ORDER BY ${ORDER[strategy]} LIMIT 1`;

async function pickCandidate(
    tx: Sql,
    org: string,
    target: OfferTarget,
    skipped: string[],
): Promise<string | undefined> {
    const row = await one<{ id: string }>(tx, candidates(target.strategy), [
        org,
        target.team_id,
        target.tag,
        target.complexity,
        skipped,
        target.capacity,
        target.last_offered_to ?? NO_EMPLOYEE,
    ]);

    return row?.id;
}

export async function offerTicket(tx: Sql, org: string, ticketId: string): Promise<string | null> {
    const target = await one<OfferTarget>(
        tx,
        `SELECT t.id,t.status,t.assignee_id,t.offered_to,t.offer_skipped,t.tag,t.complexity,t.team_id,
       tm.strategy,tm.capacity,tm.offer_timeout_seconds,tm.last_offered_to
     FROM tickets t JOIN teams tm ON tm.org_id=t.org_id AND tm.id=t.team_id AND tm.auto_assign AND tm.archived_at IS NULL
     WHERE t.org_id=$1 AND t.id=$2`,
        [org, ticketId],
    );

    if (target?.status !== 'open' || target.assignee_id || target.offered_to) {
        return null;
    }

    let candidate = await pickCandidate(tx, org, target, target.offer_skipped);

    if (!candidate && target.offer_skipped.length) {
        candidate = await pickCandidate(tx, org, target, []);
        await tx.query("UPDATE tickets SET offer_skipped='{}' WHERE id=$1", [ticketId]);
    }

    if (!candidate) {
        return null;
    }

    await tx.query(
        `UPDATE tickets SET offered_to=$2,offered_at=now(),offer_due_at=now()+$3*interval '1 second',
       version=version+1,updated_at=now() WHERE id=$1`,
        [ticketId, candidate, target.offer_timeout_seconds],
    );

    await tx.query('UPDATE teams SET last_offered_to=$2 WHERE id=$1', [target.team_id, candidate]);

    await recordTicketEvent(tx, org, {
        ticketId,
        employeeId: candidate,
        kind: 'offered',
        detail: { team_id: target.team_id },
    });

    await emit(tx, org, { type: 'ticket.offered', ticketId, employeeId: candidate });

    return candidate;
}

export async function expireOffer(tx: Sql, org: string, ticketId: string): Promise<boolean> {
    const expired = await one<{ offered_to: string }>(
        tx,
        `UPDATE tickets t SET offered_to=NULL,offered_at=NULL,offer_due_at=NULL,
       offer_skipped=array_append(t.offer_skipped,t.offered_to),version=version+1,updated_at=now()
     FROM (SELECT offered_to AS previous FROM tickets WHERE id=$2) p
     WHERE t.org_id=$1 AND t.id=$2 AND t.offer_due_at<=now() AND t.offered_to IS NOT NULL
     RETURNING p.previous AS offered_to`,
        [org, ticketId],
    );

    if (!expired) {
        return false;
    }

    await recordTicketEvent(tx, org, { ticketId, employeeId: expired.offered_to, kind: 'offer_expired' });
    await emit(tx, org, { type: 'ticket.updated', ticketId });

    return true;
}
