// Ticket row as the mini-app sees it: padded number, assignee name, current rating cycle and
// classification labels (frozen label if the dictionary entry changed since, else current).

export const TICKET_PROJECTION = `t.*,lpad(t.ticket_number::text,6,'0') AS number,e.name AS assignee_name,c.rating,c.rated_at,c.learning_status,
  coalesce(t.classification_labels->'tag'->>'label',dt.label,t.tag) AS tag_label,
  coalesce(t.classification_labels->'urgency'->>'label',du.label,t.urgency) AS urgency_label,
  coalesce(t.classification_labels->'complexity'->>'label',dc.label,t.complexity) AS complexity_label`;

export const TICKET_JOINS = `FROM tickets t LEFT JOIN employees e ON e.id=t.assignee_id AND e.org_id=t.org_id
  LEFT JOIN closures c ON c.id=t.current_cycle_id
  LEFT JOIN dictionaries dt ON dt.org_id=t.org_id AND dt.dimension='tag' AND dt.code=t.tag
  LEFT JOIN dictionaries du ON du.org_id=t.org_id AND du.dimension='urgency' AND du.code=t.urgency
  LEFT JOIN dictionaries dc ON dc.org_id=t.org_id AND dc.dimension='complexity' AND dc.code=t.complexity`;
