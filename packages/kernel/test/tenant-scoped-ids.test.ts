import { describe, expect, it } from 'vitest';
import { derivedFactId, makeEmitter } from '../src/emit.js';
import { Money } from '@taxfs/shared';

/**
 * P38 — derived fact/calc ids MUST carry the taxpayer. fact_id and calc_id
 * are global primary keys in the Postgres spine, and one operator owns many
 * client workspaces: un-scoped ids made client B's compute upsert onto
 * client A's rows (caught live — client A's computed lines were overwritten
 * while client B's boards showed them as missing).
 */
describe('tenant-scoped derived ids', () => {
  it('two taxpayers never share a derived fact or calc id', () => {
    expect(derivedFactId('client-a', 2025, 'fed.total_income')).not.toBe(
      derivedFactId('client-b', 2025, 'fed.total_income'),
    );
    const emit = (tp: string) => {
      const em = makeEmitter({ taxpayer_id: tp, tax_year: 2025, facts: [] });
      return em.emit({
        concept: 'fed.total_income', jurisdiction: ['FED'], inputs: [],
        formula_ref: 'X', rule_version: 'v', steps: [], value: Money.fromString('1'),
      });
    };
    const a = emit('client-a');
    const b = emit('client-b');
    expect(a.fact_id).not.toBe(b.fact_id);
    expect(a.derivation).not.toBe(b.derivation);
    expect(a.fact_id).toContain('client-a');
  });
});
