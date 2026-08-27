/**
 * Subject: workspace lifecycle — Reset and Delete (Blueprint §9.1 negative
 * tests). Destructive operations are owner-only, and the refusal comes from
 * the database, not from the UI that happens to hide the button.
 *
 * What each test is worth is stated where it differs:
 *   reviewer  refused twice (owner check AND no delete policy anywhere) —
 *             this is the tester case and a hard wall.
 *   editor    refused by the owner check — a guard against the one-click
 *             wipe, not a new capability wall, since an editor can already
 *             delete data rows individually by design.
 *   owner     allowed, and the audit trail of the wipe survives it.
 *
 * Requires TAXFS_TEST_DATABASE_URL (CI provides a postgres service
 * container). Skipping is loud, and CI always runs it.
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import type pg from 'pg';
import { bootRig, TEST_DB_URL, type Rig } from './rig';

const OWNER = '31111111-1111-4111-8111-111111111111';
const EDITOR = '32222222-2222-4222-8222-222222222222';
const REVIEWER = '33333333-3333-4333-8333-333333333333';
const STRANGER = '34444444-4444-4444-8444-444444444444';

if (!TEST_DB_URL) {
  console.warn('[lifecycle.test] TAXFS_TEST_DATABASE_URL not set — reset/delete suite SKIPPED here. CI always runs it.');
}

describe.skipIf(!TEST_DB_URL)('workspace reset and delete', () => {
  let rig: Rig;
  let owner: pg.Client;
  let editor: pg.Client;
  let reviewer: pg.Client;
  let stranger: pg.Client;
  let ws: string;
  let other: string;

  beforeAll(async () => {
    rig = await bootRig();
    owner = await rig.actAs(OWNER);
    editor = await rig.actAs(EDITOR);
    reviewer = await rig.actAs(REVIEWER);
    stranger = await rig.actAs(STRANGER);
  }, 60_000);

  afterAll(async () => {
    await rig?.close();
  });

  /** A workspace with one row in every table reset is supposed to clear. */
  async function seed(client: pg.Client, user: string, name: string): Promise<string> {
    const r = await client.query(`insert into workspaces (display_name) values ($1) returning workspace_id`, [name]);
    const id = String(r.rows[0].workspace_id);
    await client.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [id, user]);
    await client.query(`insert into settings (workspace_id, tax_year, key, value) values ($1, 2025, 'filing_status', '"mfj"')`, [id]);
    await client.query(
      `insert into sources (workspace_id, source_id, tax_year, type, fields, ocr_confidence, raw_ref)
       values ($1, 'src-1', 2025, 'w2', '{}', 0.99, $2)`, [id, `${id}/2025/w2.pdf`]);
    await client.query(
      `insert into tax_facts (workspace_id, fact_id, concept, tax_year, jurisdictions, taxpayer_scope,
         value, status, confidence)
       values ($1, 'f-1', 'wages', 2025, array['FED'], 'primary', 1000.00, 'confirmed', 1.0)`, [id]);
    await client.query(`insert into fact_provenance (workspace_id, fact_id, source_id, source_field)
       values ($1, 'f-1', 'src-1', 'box1')`, [id]);
    await client.query(
      `insert into calculations (workspace_id, calc_id, concept, output_fact_id, rule_version, formula_ref, steps, value)
       values ($1, 'c-1', 'agi', 'f-1', 'r1', 'ref', array['step'], 1000.00)`, [id]);
    await client.query(
      `insert into gate_runs (workspace_id, run_id, tax_year, gate, jurisdiction, result)
       values ($1, 'g-1', 2025, 1, 'FED', 'pass')`, [id]);
    await client.query(
      `insert into findings (workspace_id, finding_id, gate_run_id, critic_id, severity, payload)
       values ($1, 'fi-1', 'g-1', 'critic', 'info', '{}')`, [id]);
    await client.query(
      `insert into packages (workspace_id, package_id, tax_year, version, status, manifest)
       values ($1, 'p-1', 2025, 1, 'locked', '{}')`, [id]);
    await client.query(
      `insert into registers (workspace_id, register_id, scope_ref, kind, tax_year, opening, activity)
       values ($1, 'r-1', 'personal', 'capital_loss', 2025, '{}', '{}')`, [id]);
    await client.query(`insert into history_lines (workspace_id, tax_year, line, value) values ($1, 2024, '11', 9.00)`, [id]);
    await client.query(
      `insert into filing_contexts (workspace_id, tax_year, jurisdiction, filing_status)
       values ($1, 2025, 'FED', 'mfj')`, [id]);
    await client.query(
      `insert into agent_traces (workspace_id, trace_id, agent, model, input_hash, output, validation)
       values ($1, 't-1', 'a', 'm', 'h', '{}', 'accepted')`, [id]);
    return id;
  }

  const DATA_TABLES = ['settings', 'sources', 'tax_facts', 'fact_provenance', 'calculations',
    'gate_runs', 'findings', 'packages', 'registers', 'history_lines', 'filing_contexts', 'agent_traces'];

  async function rowCount(client: pg.Client, table: string, workspace: string): Promise<number> {
    const r = await client.query(`select count(*)::int as n from ${table} where workspace_id = $1`, [workspace]);
    return r.rows[0].n as number;
  }

  beforeEach(async () => {
    ws = await seed(owner, OWNER, 'Primary');
    other = await seed(stranger, STRANGER, 'Someone else');
    await owner.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor')`, [ws, EDITOR]);
    await owner.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'reviewer')`, [ws, REVIEWER]);
  });

  // ---- Way 2: the table list cannot silently fall behind the schema ----

  // request_budgets (migration 0004) was missing from the reset list, and
  // only a foreign-key error in the browser revealed it. This makes the
  // omission impossible to repeat: add a workspace-scoped table without
  // adding it here, and this fails.
  it('reset covers EVERY workspace-scoped table in the schema (catalog guard)', async () => {
    const catalog = await rig.admin.query(`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id' and a.attnum > 0
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`);
    const expected = catalog.rows
      .map((r) => String(r.relname))
      // The three a reset deliberately keeps: the workspace itself, who can
      // reach it, and the trail proving the reset happened.
      .filter((t) => !['workspaces', 'workspace_members', 'audit_log'].includes(t));
    const covered = await rig.admin.query(`select unnest(lifecycle_tables()) as t order by t`);
    expect(covered.rows.map((r) => String(r.t)).sort()).toEqual(expected.sort());
  });

  it('a workspace with budget rows from several members still deletes', async () => {
    // The exact shape that failed: an owner cannot delete another member's
    // budget row under budgets_rw, so the foreign key blocked the delete.
    await owner.query(
      `insert into request_budgets (workspace_id, user_id, action, count) values ($1, $2, 'extract', 1)`,
      [ws, OWNER]);
    await editor.query(
      `insert into request_budgets (workspace_id, user_id, action, count) values ($1, $2, 'extract', 1)`,
      [ws, EDITOR]);
    await owner.query(`select delete_workspace($1)`, [ws]);
    const left = await rig.admin.query(`select 1 from request_budgets where workspace_id = $1`, [ws]);
    expect(left.rowCount).toBe(0);
  });

  it('the widened budget read stops at the owner — an editor still sees only their own', async () => {
    await owner.query(
      `insert into request_budgets (workspace_id, user_id, action, count) values ($1, $2, 'extract', 1)`,
      [ws, OWNER]);
    await editor.query(
      `insert into request_budgets (workspace_id, user_id, action, count) values ($1, $2, 'extract', 1)`,
      [ws, EDITOR]);
    const seen = await editor.query(`select user_id from request_budgets where workspace_id = $1`, [ws]);
    expect(seen.rows.map((r) => String(r.user_id))).toEqual([EDITOR]);
    const byOwner = await owner.query(`select user_id from request_budgets where workspace_id = $1 order by user_id`, [ws]);
    expect(byOwner.rows.map((r) => String(r.user_id))).toEqual([OWNER, EDITOR].sort());
    // And an owner of a DIFFERENT workspace sees nothing of this one.
    const outsider = await stranger.query(`select 1 from request_budgets where workspace_id = $1`, [ws]);
    expect(outsider.rowCount).toBe(0);
  });

  // ---- refusals (§9.1: these pass only on refusal) ----

  it('a REVIEWER cannot reset — the tester case, refused by the database', async () => {
    await expect(reviewer.query(`select reset_workspace($1)`, [ws]))
      .rejects.toThrow(/only a workspace owner/i);
    expect(await rowCount(owner, 'tax_facts', ws)).toBe(1);
  });

  it('a reviewer has no delete path at all, even bypassing the function', async () => {
    for (const t of DATA_TABLES) {
      const d = await reviewer.query(`delete from ${t} where workspace_id = $1`, [ws]);
      expect(d.rowCount, `reviewer deleted rows from ${t}`).toBe(0);
    }
    expect(await rowCount(owner, 'tax_facts', ws)).toBe(1);
  });

  it('an EDITOR cannot reset or delete the workspace', async () => {
    await expect(editor.query(`select reset_workspace($1)`, [ws]))
      .rejects.toThrow(/only a workspace owner/i);
    await expect(editor.query(`select delete_workspace($1)`, [ws]))
      .rejects.toThrow(/only a workspace owner/i);
    expect(await rowCount(owner, 'tax_facts', ws)).toBe(1);
  });

  it('a NON-MEMBER cannot reset or delete, and learns nothing about the workspace', async () => {
    await expect(stranger.query(`select reset_workspace($1)`, [ws]))
      .rejects.toThrow(/only a workspace owner/i);
    await expect(stranger.query(`select delete_workspace($1)`, [ws]))
      .rejects.toThrow(/only a workspace owner/i);
    expect(await rowCount(owner, 'tax_facts', ws)).toBe(1);
  });

  // ---- the permitted path ----

  it('the OWNER resets: every data table empties, workspace and members remain', async () => {
    const r = await owner.query(`select reset_workspace($1) as out`, [ws]);
    for (const t of DATA_TABLES) {
      expect(await rowCount(owner, t, ws), `${t} not cleared`).toBe(0);
    }
    const w = await owner.query(`select 1 from workspaces where workspace_id = $1`, [ws]);
    expect(w.rowCount).toBe(1);
    const m = await owner.query(`select role from workspace_members where workspace_id = $1 order by role`, [ws]);
    expect(m.rows.map((x) => x.role)).toEqual(['editor', 'owner', 'reviewer']);
    // The stored-document refs come back so the caller can clear the bucket.
    expect(r.rows[0].out.raw_refs).toEqual([`${ws}/2025/w2.pdf`]);
  });

  it('reset touches ONLY its own workspace', async () => {
    await owner.query(`select reset_workspace($1)`, [ws]);
    for (const t of DATA_TABLES) {
      expect(await rowCount(stranger, t, other), `reset leaked into another workspace via ${t}`).toBe(1);
    }
  });

  it('the audit log survives a reset and records who did it', async () => {
    await owner.query(`select reset_workspace($1)`, [ws]);
    const r = await owner.query(
      `select actor, action from audit_log where workspace_id = $1 and action = 'reset workspace'`, [ws]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].actor).toBe(OWNER);
  });

  it('the OWNER deletes: nothing of the workspace remains, not even the row', async () => {
    await owner.query(`select delete_workspace($1)`, [ws]);
    for (const t of DATA_TABLES) {
      expect(await rowCount(rig.admin, t, ws), `${t} survived delete`).toBe(0);
    }
    // Checked as admin: RLS would return zero rows either way, which is
    // exactly the false pass this assertion has to avoid.
    const w = await rig.admin.query(`select 1 from workspaces where workspace_id = $1`, [ws]);
    expect(w.rowCount).toBe(0);
    const m = await rig.admin.query(`select 1 from workspace_members where workspace_id = $1`, [ws]);
    expect(m.rowCount).toBe(0);
  });

  it('the audit trail OUTLIVES the workspace it recorded', async () => {
    await owner.query(`select delete_workspace($1)`, [ws]);
    const r = await rig.admin.query(
      `select action from audit_log where workspace_id = $1 order by seq`, [ws]);
    expect(r.rows.map((x) => x.action)).toContain('delete workspace');
    expect(r.rows.map((x) => x.action)).toContain('insert tax_facts');
  });

  it('delete touches ONLY its own workspace', async () => {
    await owner.query(`select delete_workspace($1)`, [ws]);
    const w = await rig.admin.query(`select 1 from workspaces where workspace_id = $1`, [other]);
    expect(w.rowCount).toBe(1);
    expect(await rowCount(stranger, 'tax_facts', other)).toBe(1);
  });

  it('the audit log is still append-only after a lifecycle operation', async () => {
    await owner.query(`select reset_workspace($1)`, [ws]);
    await expect(owner.query(`delete from audit_log where workspace_id = $1`, [ws]))
      .rejects.toThrow(/permission denied/);
  });
});
