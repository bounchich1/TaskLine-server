import { requireOne, type Database } from '../../shared/db.js';

export async function waitForSendSlot(db: Database): Promise<void> {
    const result = await db.tx(async (tx) =>
        requireOne(
            tx,
            `UPDATE max_rate_limit SET next_at=greatest(next_at,clock_timestamp())+interval '40 milliseconds'
       WHERE id=1 RETURNING greatest(0,extract(epoch FROM next_at-clock_timestamp())*1000)::int AS delay`,
        ),
    );

    await new Promise((resolve) => setTimeout(resolve, Number(result.delay)));
}
