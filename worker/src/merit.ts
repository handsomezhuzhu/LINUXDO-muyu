import type { D1Database, D1Result, MeritState, UserScope, Wish } from "./types";
import type { SyncInput, WishInput } from "./validation";

const STATE_QUERIES = {
  account: `
    SELECT total, revision
    FROM merit_accounts
    WHERE iss = ?1 AND sub = ?2
  `,
  day: `
    SELECT merit
    FROM merit_days
    WHERE iss = ?1 AND sub = ?2 AND day = ?3
  `,
  active: `
    SELECT id, content, target, progress, created_at, completed_at
    FROM wishes
    WHERE iss = ?1 AND sub = ?2 AND completed_at IS NULL
  `,
  completed: `
    SELECT id, content, target, progress, created_at, completed_at
    FROM wishes
    WHERE iss = ?1 AND sub = ?2 AND completed_at IS NOT NULL
    ORDER BY completed_at DESC, id DESC
    LIMIT 5
  `,
} as const;

interface AccountRow {
  total: number;
  revision: number;
}

interface DayRow {
  merit: number;
}

interface WishRow {
  id: string;
  content: string;
  target: number;
  progress: number;
  created_at: string;
  completed_at: string | null;
}

function stateStatements(db: D1Database, user: UserScope, day: string) {
  return [
    db.prepare(STATE_QUERIES.account).bind(user.iss, user.sub),
    db.prepare(STATE_QUERIES.day).bind(user.iss, user.sub, day),
    db.prepare(STATE_QUERIES.active).bind(user.iss, user.sub),
    db.prepare(STATE_QUERIES.completed).bind(user.iss, user.sub),
  ];
}

function resultRows<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as T[];
}

function wishFromRow(row: WishRow): Wish {
  return {
    id: row.id,
    content: row.content,
    target: row.target,
    progress: row.progress,
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function stateFromResults(results: D1Result[]): MeritState {
  const account = resultRows<AccountRow>(results[0])[0];
  const day = resultRows<DayRow>(results[1])[0];
  const active = resultRows<WishRow>(results[2])[0];
  const completed = resultRows<WishRow>(results[3]);
  return {
    revision: account?.revision ?? 0,
    total: account?.total ?? 0,
    today: day?.merit ?? 0,
    activeWish: active ? wishFromRow(active) : null,
    wishes: completed.map(wishFromRow),
  };
}

export async function readState(db: D1Database, user: UserScope, day: string): Promise<MeritState> {
  return stateFromResults(await db.batch(stateStatements(db, user, day)));
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "";
  const candidate = error as { message?: unknown; cause?: unknown };
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const cause = candidate.cause && candidate.cause !== error ? errorText(candidate.cause) : "";
  return `${message}\n${cause}`;
}

function isMeritBatchConflict(error: unknown): boolean {
  const text = errorText(error);
  return /unique constraint/i.test(text) && /merit_batches/.test(text);
}

function isActiveWishConflict(error: unknown): boolean {
  const text = errorText(error);
  return (
    /unique constraint/i.test(text) &&
    (/wishes\.(iss|sub)/.test(text) || /wishes_one_active_per_user/.test(text))
  );
}

/**
 * The unique merit_batches insert deliberately has no OR IGNORE. D1 batches are
 * transactional: a duplicate throws here and rolls back every preceding write.
 */
export async function syncMerit(
  db: D1Database,
  user: UserScope,
  input: SyncInput,
  now = new Date().toISOString(),
): Promise<MeritState> {
  const reads = stateStatements(db, user, input.day);
  try {
    const results = await db.batch([
      db.prepare(`
        INSERT OR IGNORE INTO merit_accounts (iss, sub, total, revision, created_at, updated_at)
        VALUES (?1, ?2, 0, 0, ?3, ?3)
      `).bind(user.iss, user.sub, now),
      db.prepare(`
        INSERT INTO merit_batches (iss, sub, batch_id, day, delta, wish_id, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `).bind(user.iss, user.sub, input.batchId, input.day, input.delta, input.wishId, now),
      db.prepare(`
        UPDATE merit_accounts
        SET total = total + ?3, revision = revision + 1, updated_at = ?4
        WHERE iss = ?1 AND sub = ?2
      `).bind(user.iss, user.sub, input.delta, now),
      db.prepare(`
        INSERT INTO merit_days (iss, sub, day, merit, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT (iss, sub, day) DO UPDATE SET
          merit = merit_days.merit + excluded.merit,
          updated_at = excluded.updated_at
      `).bind(user.iss, user.sub, input.day, input.delta, now),
      db.prepare(`
        UPDATE wishes
        SET
          progress = MIN(target, progress + ?3),
          completed_at = CASE
            WHEN progress + ?3 >= target THEN ?4
            ELSE completed_at
          END
        WHERE iss = ?1 AND sub = ?2 AND id = ?5 AND completed_at IS NULL
      `).bind(user.iss, user.sub, input.delta, now, input.wishId),
      ...reads,
    ]);

    // The final four results are exactly the final four stateStatements above.
    return stateFromResults(results.slice(-4));
  } catch (error) {
    if (!isMeritBatchConflict(error)) throw error;
    return readState(db, user, input.day);
  }
}

export async function createWish(
  db: D1Database,
  user: UserScope,
  input: WishInput,
  day: string,
  id = crypto.randomUUID(),
  now = new Date().toISOString(),
): Promise<MeritState> {
  try {
    const results = await db.batch([
      db.prepare(`
        INSERT OR IGNORE INTO merit_accounts (iss, sub, total, revision, created_at, updated_at)
        VALUES (?1, ?2, 0, 0, ?3, ?3)
      `).bind(user.iss, user.sub, now),
      db.prepare(`
        INSERT INTO wishes (id, iss, sub, content, target, progress, created_at, completed_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, NULL)
      `).bind(id, user.iss, user.sub, input.content, input.target, now),
      ...stateStatements(db, user, day),
    ]);
    return stateFromResults(results.slice(-4));
  } catch (error) {
    if (isActiveWishConflict(error)) {
      throw new ActiveWishConflictError();
    }
    throw error;
  }
}

export class ActiveWishConflictError extends Error {
  readonly code = "ACTIVE_WISH_EXISTS";

  constructor() {
    super("An active wish already exists");
    this.name = "ActiveWishConflictError";
  }
}
