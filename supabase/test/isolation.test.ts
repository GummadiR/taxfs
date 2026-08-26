/**
 * Subject: tenant isolation — guardrails G1 (cross-workspace writes are
 * refused by Postgres itself) and G2 (cross-user reads return zero rows),
 * plus the FORCE-RLS and no-identity-columns catalog guards. Blueprint §9.1:
 * these tests attempt the forbidden thing and pass only on refusal.
 *
 * Requires TAXFS_TEST_DATABASE_URL (CI provides a postgres service
 * container). Skipping is loud, and CI always runs it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { bootRig, TEST_DB_URL, type Rig } from './rig.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

if (!TEST_DB_URL) {
  console.warn('[isolation.test] TAXFS_TEST_DATABASE_URL not set — G1/G2 suite SKIPPED here. CI always runs it.');
}

describe.skipIf(!TEST_DB_URL)('tenant isolation (G1/G2)', () => {
  let rig: Rig;
  let a: pg.Client;
  let b: pg.Client;
  let wsA: string;

  beforeAll(async () => {
    rig = await bootRig();
    a = await rig.actAs(USER_A);
    b = await rig.actAs(USER_B);
    // A creates a workspace and becomes its owner (the bootstrap path).
    const r = await a.query(`insert into workspaces (display_name) values ('A workspace') returning workspace_id`);
    wsA = r.rows[0].workspace_id;
    await a.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [wsA, USER_A]);
    await a.query(`insert into settings (workspace_id, tax_year, key, value) values ($1, 2025, 'filing_status', '"mfj"')`, [wsA]);
    await a.query(
      `insert into sources (workspace_id, source_id, tax_year, type, fields, ocr_confidence, raw_ref)
       values ($1, 'src-1', 2025, 'w2', '{}', 0.99, 'x')`,
      [wsA],
    );
    await a.query(`insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${wsA}/2025/w2.pdf`]);
  }, 60_000);

  afterAll(async () => {
    await rig?.close();
  });

  // ---- catalog guards (Way 2: bind tables added later, by anyone) ----

  it('every public table has RLS enabled AND forced (catalog guard)', async () => {
    const r = await rig.admin.query(`
      select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and not (c.relrowsecurity and c.relforcerowsecurity)`);
    expect(r.rows).toEqual([]);
  });

  it('no identity columns exist anywhere (G9, schema level)', async () => {
    const r = await rig.admin.query(`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and (column_name ~* 'ssn|social_sec|birth|dob|first_name|last_name|middle_name|street|address')`);
    expect(r.rows).toEqual([]);
  });

  // ---- G2: cross-user reads ----

  it('B sees ZERO rows of A data in every workspace-scoped table', async () => {
    const tables = ['workspaces', 'workspace_members', 'settings', 'sources', 'tax_facts',
      'filing_contexts', 'gate_runs', 'findings', 'packages', 'registers',
      'history_lines', 'agent_traces', 'audit_log'];
    for (const t of tables) {
      const r = await b.query(`select * from ${t}`);
      expect(r.rows, `table ${t} leaked rows to B`).toEqual([]);
    }
  });

  it('B sees zero rows through the nav_status view (security_invoker holds)', async () => {
    const r = await b.query('select * from nav_status');
    expect(r.rows).toEqual([]);
    const ra = await a.query('select * from nav_status');
    expect(ra.rows.map((x) => x.workspace_id)).toEqual([wsA]);
    expect(ra.rows[0].started).toBe(true);
  });

  it("B cannot see A's storage objects", async () => {
    const r = await b.query(`select * from storage.objects`);
    expect(r.rows).toEqual([]);
  });

  // ---- G1: cross-workspace writes ----

  it("B cannot INSERT into A's workspace (refused by Postgres, not app code)", async () => {
    await expect(
      b.query(`insert into settings (workspace_id, tax_year, key, value) values ($1, 2025, 'filing_status', '"single"')`, [wsA]),
    ).rejects.toThrow(/row-level security/);
  });

  it("B cannot UPDATE or DELETE A's rows (0 rows affected — invisible)", async () => {
    const u = await b.query(`update settings set value = '"single"' where workspace_id = $1`, [wsA]);
    expect(u.rowCount).toBe(0);
    const d = await b.query(`delete from sources where workspace_id = $1`, [wsA]);
    expect(d.rowCount).toBe(0);
    // A's data is intact.
    const check = await a.query(`select value from settings where workspace_id = $1 and key = 'filing_status'`, [wsA]);
    expect(check.rows[0].value).toBe('mfj');
  });

  it("B cannot claim ownership of A's workspace (the bootstrap wall)", async () => {
    await expect(
      b.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [wsA, USER_B]),
    ).rejects.toThrow(/row-level security/);
  });

  it("B cannot write into A's storage folder", async () => {
    await expect(
      b.query(`insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${wsA}/2025/evil.pdf`]),
    ).rejects.toThrow(/row-level security/);
  });

  it('B cannot escalate roles on the connection', async () => {
    await expect(b.query('set role postgres')).rejects.toThrow(/permission denied/);
  });

  // ---- the P91 class is unrepresentable ----

  it('the same source_id coexists in two workspaces (composite PK — P91 unrepresentable)', async () => {
    const r = await b.query(`insert into workspaces (display_name) values ('B workspace') returning workspace_id`);
    const wsB = r.rows[0].workspace_id;
    await b.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [wsB, USER_B]);
    await b.query(
      `insert into sources (workspace_id, source_id, tax_year, type, fields, ocr_confidence, raw_ref)
       values ($1, 'src-1', 2025, 'w2', '{}', 0.9, 'x')`, [wsB]);
    const mine = await b.query(`select workspace_id from sources where source_id = 'src-1'`);
    expect(mine.rows.map((x) => x.workspace_id)).toEqual([wsB]); // still only its own
  });

  // ---- roles: reviewer reads, never writes ----

  it('a reviewer can read but not write; promotion to editor unlocks writes', async () => {
    await a.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'reviewer')`, [wsA, USER_B]);
    const read = await b.query(`select key, value from settings where workspace_id = $1`, [wsA]);
    expect(read.rows.length).toBeGreaterThan(0);
    await expect(
      b.query(`insert into settings (workspace_id, tax_year, key, value) values ($1, 2025, 'il_exemptions', '2')`, [wsA]),
    ).rejects.toThrow(/row-level security/);
    const u = await b.query(`update settings set value = '"single"' where workspace_id = $1 and key = 'filing_status'`, [wsA]);
    expect(u.rowCount).toBe(0);

    await a.query(`update workspace_members set role = 'editor' where workspace_id = $1 and user_id = $2`, [wsA, USER_B]);
    const ok = await b.query(`insert into settings (workspace_id, tax_year, key, value) values ($1, 2025, 'il_exemptions', '2')`, [wsA]);
    expect(ok.rowCount).toBe(1);
  });

  // ---- audit log: written by triggers, append-only for everyone ----

  it('mutations landed in the audit log with the acting user recorded', async () => {
    const r = await a.query(`select actor, action from audit_log where workspace_id = $1 order by seq`, [wsA]);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.map((x) => x.action)).toContain('insert settings');
    expect(r.rows[0].actor).toBe(USER_A);
  });

  it('the audit log refuses UPDATE and DELETE even from the workspace owner', async () => {
    await expect(a.query(`update audit_log set action = 'forged' where workspace_id = $1`, [wsA]))
      .rejects.toThrow(/permission denied/);
    await expect(a.query(`delete from audit_log where workspace_id = $1`, [wsA]))
      .rejects.toThrow(/permission denied/);
  });
});
