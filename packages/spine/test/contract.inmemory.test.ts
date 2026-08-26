import type { Clock } from '@taxfs/shared';
import { InMemorySpine } from '@taxfs/spine';
import { runSpineContractSuite } from './contract.suite.js';

const clock: Clock = { nowIso: () => '2026-07-02T00:00:00.000Z' };

runSpineContractSuite('in-memory', async () => {
  const spine = new InMemorySpine(clock, 'contract-test');
  // The in-memory reference is one store per tenant; a different tenant is a
  // different instance (Postgres achieves the same isolation via RLS).
  const otherSpine = new InMemorySpine(clock, 'contract-test-other');
  return {
    spine,
    taxpayerId: 'tp-a',
    otherSpine,
    otherTaxpayerId: 'tp-b',
    auditCount: async () => (await spine.inspect()).auditLog.length,
    close: async () => {},
  };
});
