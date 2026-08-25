/**
 * D1-backed index of pairing rooms.
 *
 * Rooms are Durable Objects addressed by `idFromName(code)`, and a Durable
 * Object's storage is private to that instance, so the set of live rooms cannot
 * be derived by querying them. Every room reports itself here instead, and the
 * admin dashboard reads this table.
 *
 * Every write is best-effort and never throws: a room that fails to report is a
 * reporting bug, but a room that fails to start is an outage. Callers pass these
 * to `waitUntil` so a slow D1 never adds latency to the pairing path.
 */

export interface RoomRow {
  code: string;
  created_at: number;
  expires_at: number;
  participants: number;
  last_seen_at: number;
  ended_at: number | null;
}

const DEFAULT_HISTORY_SECONDS = 604800; // 7 days

function reportFailure(operation: string, error: unknown): void {
  console.error(`[registry] ${operation} failed:`, error);
}

/** Records a newly created room. Ignores replays of a code already indexed. */
export async function recordRoomCreated(
  db: D1Database,
  code: string,
  createdAt: number,
  expiresAt: number
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO rooms (code, created_at, expires_at, participants, last_seen_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT (code) DO NOTHING`
      )
      .bind(code, createdAt, expiresAt, createdAt)
      .run();
  } catch (error) {
    reportFailure('recordRoomCreated', error);
  }
}

/**
 * Records how many sockets a room currently holds.
 *
 * The count is absolute rather than a delta, so a Durable Object that restarts
 * mid-session self-heals on the next connect instead of drifting forever.
 */
export async function recordPresence(
  db: D1Database,
  code: string,
  participants: number,
  seenAt: number
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE rooms SET participants = ?, last_seen_at = ? WHERE code = ?`
      )
      .bind(participants, seenAt, code)
      .run();
  } catch (error) {
    reportFailure('recordPresence', error);
  }
}

/** Marks a room as ended, whether it expired on its alarm or was ended by an admin. */
export async function recordRoomEnded(
  db: D1Database,
  code: string,
  endedAt: number
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE rooms SET ended_at = ?, participants = 0, last_seen_at = ?
         WHERE code = ? AND ended_at IS NULL`
      )
      .bind(endedAt, endedAt, code)
      .run();
  } catch (error) {
    reportFailure('recordRoomEnded', error);
  }
}

/**
 * Returns every indexed room, newest first, pruning rows that aged out of the
 * retention window. Unlike the writes above this is allowed to throw — the
 * dashboard should show an error rather than silently render an empty list.
 */
export async function listRooms(
  db: D1Database,
  historySeconds = DEFAULT_HISTORY_SECONDS
): Promise<RoomRow[]> {
  const cutoff = Date.now() - historySeconds * 1000;
  try {
    await db
      .prepare(`DELETE FROM rooms WHERE COALESCE(ended_at, expires_at) < ?`)
      .bind(cutoff)
      .run();
  } catch (error) {
    // Pruning is housekeeping; a failure here should not hide the listing.
    reportFailure('listRooms/prune', error);
  }

  const { results } = await db
    .prepare(`SELECT * FROM rooms ORDER BY created_at DESC`)
    .all<RoomRow>();
  return results ?? [];
}
