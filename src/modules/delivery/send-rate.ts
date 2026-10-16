import { requireOne, type Database } from '../../shared/db.js';

export async function waitForSendSlot(db: Database, org: string): Promise<void> {
    const result = await db.tx(async (tx) =>
        requireOne(
            tx,
            `INSERT INTO max_send_pacing(org_id,next_at) VALUES($1,clock_timestamp()+interval '40 milliseconds')
       ON CONFLICT(org_id) DO UPDATE
       SET next_at=greatest(max_send_pacing.next_at,clock_timestamp())+interval '40 milliseconds'
       RETURNING greatest(0,extract(epoch FROM next_at-clock_timestamp())*1000)::int AS delay`,
            [org],
        ),
    );

    await new Promise((resolve) => setTimeout(resolve, Number(result.delay)));
}
