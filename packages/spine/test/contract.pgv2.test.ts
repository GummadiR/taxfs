/**
 * Subject: the SAME behavior-level contract suite that proves InMemorySpine,
 * run against PgSpine v2 on the real §4 migrations with FORCE RLS binding —
 * two backends, one suite (the TaxOS discipline, carried forward). Boots on
 * TAXFS_TEST_DATABASE_URL (CI: the postgres service container); skipping is
 * loud and CI always runs it.
 */
import { runSpineContractSuite, type ContractFixture } from './contract.suite';
import { PgSpine, ensureWorkspace } from '../src/pg';
import { bootRig, TEST_DB_URL } from '../../../supabase/test/rig';

const USER_A = '31111111-1111-4111-8111-111111111111';
const USER_B = '32222222-2222-4222-8222-222222222222';

if (!TEST_DB_URL) {
  console.warn('[contract.pgv2] TAXFS_TEST_DATABASE_URL not set — PgSpine contract suite SKIPPED here. CI always runs it.');
} else {
  runSpineContractSuite('PgSpine v2 (§4 schema, FORCE RLS)', async (): Promise<ContractFixture> => {
    const rig = await bootRig();
    const wsA = 'ws-contract-a';
    const wsB = 'ws-contract-b';
    await ensureWorkspace(rig.appConfig, { workspace_id: wsA, auth_user_id: USER_A, display_name: 'Contract A' });
    await ensureWorkspace(rig.appConfig, { workspace_id: wsB, auth_user_id: USER_B, display_name: 'Contract B' });
    const spine = await PgSpine.create(rig.appConfig, { authUserId: USER_A, workspaceId: wsA });
    const otherSpine = await PgSpine.create(rig.appConfig, { authUserId: USER_B, workspaceId: wsB });
    return {
      spine,
      taxpayerId: wsA,
      otherSpine,
      otherTaxpayerId: wsB,
      async auditCount() {
        const r = await rig.admin.query(
          `select count(*)::int as n from audit_log where workspace_id = $1`,
          [wsA],
        );
        return r.rows[0].n as number;
      },
      async close() {
        await spine.close();
        await otherSpine.close();
        await rig.close();
      },
    };
  });
}
