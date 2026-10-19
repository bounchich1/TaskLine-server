import { one, type Sql } from '../../shared/db.js';
import type { AlertSender } from '../staff/index.js';

interface AlertRow extends Record<string, unknown> {
    type: string;
    payload: { value?: number; topic?: boolean };
    max_user_id: string;
    number: string;
    tag_label: string | null;
    actor_name: string | null;
}

const SLA_TEXT: Record<string, string> = {
    'sla.response_warning': 'первый ответ под угрозой',
    'sla.response_breached': 'первый ответ просрочен',
    'sla.response_escalated': 'первый ответ просрочен вдвое',
    'sla.resolution_warning': 'решение под угрозой',
    'sla.resolution_breached': 'решение просрочено',
    'sla.resolution_escalated': 'решение просрочено вдвое',
};

function slaText(type: string, ticket: string): string {
    return SLA_TEXT[type] ? `SLA · ${ticket}: ${SLA_TEXT[type]}` : `Изменение · ${ticket}`;
}

function routingText({ type, tag_label: tag, actor_name: actor }: AlertRow, ticket: string): string | null {
    switch (type) {
        case 'ticket.offered':
            return `Вам предложено ${ticket}${tag ? ` · ${tag}` : ''}. Откройте его, чтобы взять в работу`;
        case 'note.mention':
            return `${actor ?? 'Коллега'} упомянул(а) вас в заметке · ${ticket}`;
        case 'ticket.close_failed':
            return `Не удалось закрыть ${ticket}: ответ клиенту не доставлен`;
        default:
            return null;
    }
}

function alertText(row: AlertRow): string {
    const { type, payload, number, tag_label: tag, actor_name: actor } = row;
    const ticket = `обращение №${number}`;

    switch (type) {
        case 'ticket.created':
            return `Новое ${ticket}${tag ? ` · ${tag}` : ''}`;
        case 'message.from_client':
            return `Новое сообщение клиента · ${ticket}`;
        case 'ticket.transferred':
            return `Вам передано ${ticket}${actor ? ` от ${actor}` : ''}`;
        case 'rating.received':
            return `Оценка ${String(payload.value ?? '—')}/10 · ${ticket}`;
        case 'ticket.auto_closed':
            return `Закрыто ${ticket}: клиент не ответил`;
        default:
            return routingText(row, ticket) ?? slaText(type, ticket);
    }
}

export class NotificationAlerts {
    constructor(
        private readonly db: Sql,
        private readonly org: string,
        private readonly sender: AlertSender,
    ) {}

    async send(notificationId: string): Promise<void> {
        const row = await one<AlertRow>(
            this.db,
            `SELECT n.type,n.payload,e.max_user_id,lpad(t.ticket_number::text,greatest(6,length(t.ticket_number::text)),'0') AS number,
         CASE WHEN t.ai_status<>'pending' AND t.tag<>'undefined' THEN coalesce(d.label,t.tag) END AS tag_label,
         a.name AS actor_name
       FROM notifications n
       LEFT JOIN notification_settings s ON s.org_id=n.org_id AND s.employee_id=n.employee_id
       JOIN employees e ON e.org_id=n.org_id AND e.id=n.employee_id AND NOT e.blocked AND e.activated_at IS NOT NULL
       JOIN tickets t ON t.org_id=n.org_id AND t.id=n.ticket_id
       LEFT JOIN dictionaries d ON d.org_id=t.org_id AND d.dimension='tag' AND d.code=t.tag
       LEFT JOIN employees a ON a.org_id=n.org_id AND a.id=(n.payload->>'from')::uuid
       WHERE n.org_id=$1 AND n.id=$2 AND n.read_at IS NULL AND (s.max_alerts OR n.type='note.mention')`,
            [this.org, notificationId],
        );

        if (row) {
            await this.sender.sendToUser(row.max_user_id, alertText(row));
        }
    }
}
