/**
 * Subject: Phase-8 hardening — DB-backed rate budgets and the persistent
 * agent-trace sink, on the real migrations with RLS binding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { bootRig, TEST_DB_URL, type Rig } from './rig';

const USER_A = '41111111-1111-4111-8111-111111111111';
const USER_B = '42222222-2222-4222-8222-222222222222';

if (!TEST_DB_URL) {
  console.warn('[hardening.test] TAXFS_TEST_DATABASE_URL not set — suite SKIPPED here. CI always runs it.');
}

describe.skipIf(!TEST_DB_URL)('hardening (rate budgets + agent traces)', () => {
  let rig: Rig;
  let a: pg.Client;
  let ws: string;

  beforeAll(async () => {
    rig = await bootRig();
    a = await rig.actAs(USER_A);
    const r = await a.query(`insert into workspaces (display_name) values ('Hardening') returning workspace_id`);
    ws = r.rows[0].workspace_id;
    await a.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws, USER_A]);
  }, 60_000);

  afterAll(async () => {
    await rig?.close();
  });

  it('takeBudget refuses past the cap and names the wait', async () => {
    const { takeBudget, BUDGETS, RateLimitError } = await import('../../apps/web/src/server/limits');
    const cap = BUDGETS['build_package']!.limit;
    for (let i = 0; i < cap; i = i + 1) {
      await takeBudget(a, ws, USER_A, 'build_package');
    }
    await expect(takeBudget(a, ws, USER_A, 'build_package')).rejects.toThrow(RateLimitError);
    await expect(takeBudget(a, ws, USER_A, 'build_package')).rejects.toThrow(/capped at/);
  });

  it("one user's exhausted budget never throttles another action or user", async () => {
    const { takeBudget } = await import('../../apps/web/src/server/limits');
    await takeBudget(a, ws, USER_A, 'run_gates'); // different action: fine
    const b = await rig.actAs(USER_B);
    const r = await b.query(`insert into workspaces (display_name) values ('B') returning workspace_id`);
    const wsB = r.rows[0].workspace_id;
    await b.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [wsB, USER_B]);
    await takeBudget(b, wsB, USER_B, 'build_package'); // different user: fine
  });

  it('PgAgentLog lands hash-only rows readable by the trace viewer', async () => {
    const { PgAgentLog, listTraces } = await import('../../apps/web/src/server/agent-log');
    const log = new PgAgentLog(a, ws);
    log.record({
      agent_id: 'extraction', attempt: 1, input_hash: 'fnv-abc123', model: 'claude-fable-5',
      provider_id: 'anthropic', output_hash: 'fnv-def456', output_chars: 512,
      validation_result: 'ok', issues: [],
    });
    await log.flush();
    const rows = await listTraces(a, ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent).toBe('extraction');
    expect(rows[0]!.validation).toBe('accepted');
    expect(JSON.stringify(rows[0])).not.toMatch(/prompt|content|text/i); // hashes only
  });

  it("a reviewer cannot write budget rows into a workspace (RLS, not UI)", async () => {
    const b = await rig.actAs(USER_B);
    await a.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'reviewer')`, [ws, USER_B]);
    // B may take budget for THEMSELVES in a workspace they can review…
    const { takeBudget } = await import('../../apps/web/src/server/limits');
    await takeBudget(b, ws, USER_B, 'artifact');
    // …but can never touch A's budget row.
    const u = await b.query(`update request_budgets set count = 0 where workspace_id = $1 and user_id = $2`, [ws, USER_A]);
    expect(u.rowCount).toBe(0);
  });
});
