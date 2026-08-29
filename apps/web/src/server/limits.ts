/**
 * Rate limiting (Blueprint §7.8): expensive actions (gates, packaging,
 * artifact regeneration, intake) are budgeted per (workspace, user, action)
 * in a rolling window, in the DATABASE — lambdas share no memory, so an
 * in-process bucket would be a per-instance illusion. Refusal is loud and
 * names the wait.
 */
import type pg from 'pg';

export interface Budget {
  limit: number;
  windowSeconds: number;
}

export const BUDGETS: Record<string, Budget> = {
  run_gates: { limit: 30, windowSeconds: 600 },
  build_package: { limit: 10, windowSeconds: 600 },
  artifact: { limit: 60, windowSeconds: 600 },
  intake: { limit: 120, windowSeconds: 600 },
  // Real uploads: scrub + vision per file — the P-series upload cap.
  upload: { limit: 40, windowSeconds: 600 },
};

export class RateLimitError extends Error {
  constructor(action: string, budget: Budget) {
    super(
      `Rate limit: "${action}" is capped at ${budget.limit} per ${Math.round(budget.windowSeconds / 60)} minutes — try again shortly.`,
    );
  }
}

/** Take one unit of budget or throw RateLimitError. One round trip: reset
 *  the window when it lapsed, else increment; refuse past the cap. */
export async function takeBudget(client: pg.Client, ws: string, userId: string, action: string): Promise<void> {
  const budget = BUDGETS[action];
  if (!budget) throw new Error(`unknown budget action ${action}`);
  const r = await client.query(
    `insert into request_budgets (workspace_id, user_id, action, window_start, count)
     values ($1, $2, $3, now(), 1)
     on conflict (workspace_id, user_id, action) do update set
       count = case when request_budgets.window_start < now() - make_interval(secs => $4)
                    then 1 else request_budgets.count + 1 end,
       window_start = case when request_budgets.window_start < now() - make_interval(secs => $4)
                    then now() else request_budgets.window_start end
     returning count`,
    [ws, userId, action, budget.windowSeconds],
  );
  if ((r.rows[0]?.count ?? 0) > budget.limit) throw new RateLimitError(action, budget);
}
