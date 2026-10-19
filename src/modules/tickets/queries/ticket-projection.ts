const SLA_RUNNING = "t.status IN('open','in_progress')";

const activeSla = (prefix: string) =>
    `CASE WHEN ${SLA_RUNNING} THEN least(CASE WHEN t.first_responded_at IS NULL THEN t.first_response_${prefix}_at END,` +
    `CASE WHEN t.waiting_since IS NULL THEN t.resolution_${prefix}_at END) END`;

export const SLA_DUE = activeSla('due');
export const SLA_WARN = activeSla('warn');

export const TICKET_PROJECTION = `t.*,lpad(t.ticket_number::text,greatest(6,length(t.ticket_number::text)),'0') AS number,e.name AS assignee_name,c.rating,c.rated_at,c.learning_status,
  tm.name AS team_name,oe.name AS offered_to_name,
  coalesce(t.classification_labels->'tag'->>'label',dt.label,t.tag) AS tag_label,
  coalesce(t.classification_labels->'urgency'->>'label',du.label,t.urgency) AS urgency_label,
  coalesce(t.classification_labels->'complexity'->>'label',dc.label,t.complexity) AS complexity_label,
  ${SLA_DUE} AS sla_due_at,${SLA_WARN} AS sla_warn_at,
  tinc.id AS incident_id,tinc.title AS incident_title,tinc.status AS incident_status`;

export const TICKET_JOINS = `FROM tickets t LEFT JOIN employees e ON e.id=t.assignee_id AND e.org_id=t.org_id
  LEFT JOIN closures c ON c.id=t.current_cycle_id
  LEFT JOIN teams tm ON tm.id=t.team_id AND tm.org_id=t.org_id
  LEFT JOIN employees oe ON oe.id=t.offered_to AND oe.org_id=t.org_id
  LEFT JOIN dictionaries dt ON dt.org_id=t.org_id AND dt.dimension='tag' AND dt.code=t.tag
  LEFT JOIN dictionaries du ON du.org_id=t.org_id AND du.dimension='urgency' AND du.code=t.urgency
  LEFT JOIN dictionaries dc ON dc.org_id=t.org_id AND dc.dimension='complexity' AND dc.code=t.complexity
  LEFT JOIN LATERAL (SELECT i.id,i.title,i.status FROM incident_tickets it JOIN incidents i ON i.id=it.incident_id
    WHERE it.ticket_id=t.id AND i.status IN('open','resolved') ORDER BY (i.status='open') DESC,it.linked_at DESC LIMIT 1) tinc
    ON true`;
