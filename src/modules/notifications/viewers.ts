const VIEW_TTL_MS = 30000;
const TYPING_TTL_MS = 8000;
const CHANGE_RETENTION_MS = 300000;

export type ViewerState = 'viewing' | 'typing' | 'left';

interface Viewer {
    id: string;
    name: string;
    seenAt: number;
    typingAt: number | null;
}

export interface ViewerSnapshot {
    id: string;
    name: string;
    typing: boolean;
}

export class ViewerRegistry {
    private readonly tickets = new Map<string, Map<string, Viewer>>();
    private readonly changed = new Map<string, { version: number; at: number }>();
    private version = 0;

    touch(ticketId: string, employee: { id: string; name: string }, state: ViewerState, now = Date.now()): void {
        const viewers = this.tickets.get(ticketId) ?? new Map<string, Viewer>();
        const previous = viewers.get(employee.id);

        if (state === 'left') {
            if (previous) {
                viewers.delete(employee.id);
                this.markChanged(ticketId);
            }
        } else {
            const typingAt = state === 'typing' ? now : (previous?.typingAt ?? null);

            viewers.set(employee.id, { id: employee.id, name: employee.name, seenAt: now, typingAt });

            if (!previous || (state === 'typing') !== this.isTyping(previous, now)) {
                this.markChanged(ticketId);
            }
        }

        this.store(ticketId, viewers);
    }

    snapshot(ticketId: string, now = Date.now()): ViewerSnapshot[] {
        return [...(this.tickets.get(ticketId)?.values() ?? [])].map((viewer) => ({
            id: viewer.id,
            name: viewer.name,
            typing: this.isTyping(viewer, now),
        }));
    }

    changesSince(version: number, now = Date.now()): { version: number; tickets: string[] } {
        this.prune(now);

        const tickets = [...this.changed.entries()]
            .filter(([, change]) => change.version > version)
            .map(([ticketId]) => ticketId);

        return { version: this.version, tickets };
    }

    private isTyping(viewer: Viewer, now: number): boolean {
        return viewer.typingAt !== null && now - viewer.typingAt < TYPING_TTL_MS;
    }

    private prune(now: number): void {
        for (const [ticketId, viewers] of this.tickets) {
            for (const viewer of viewers.values()) {
                if (now - viewer.seenAt > VIEW_TTL_MS) {
                    viewers.delete(viewer.id);
                    this.markChanged(ticketId);
                } else if (viewer.typingAt !== null && !this.isTyping(viewer, now)) {
                    viewer.typingAt = null;
                    this.markChanged(ticketId);
                }
            }

            this.store(ticketId, viewers);
        }

        for (const [ticketId, change] of this.changed) {
            if (now - change.at > CHANGE_RETENTION_MS && !this.tickets.has(ticketId)) {
                this.changed.delete(ticketId);
            }
        }
    }

    private store(ticketId: string, viewers: Map<string, Viewer>): void {
        if (viewers.size) {
            this.tickets.set(ticketId, viewers);
        } else {
            this.tickets.delete(ticketId);
        }
    }

    private markChanged(ticketId: string, now = Date.now()): void {
        this.changed.set(ticketId, { version: ++this.version, at: now });
    }
}

export const ticketViewers = new ViewerRegistry();
