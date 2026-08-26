/** P8.1 — year-close roll: kernel .out facts -> closed registers -> next-year openings. */
import { describe, expect, it } from 'vitest';
import { Money, type TaxFact } from '@taxfs/shared';
import { InMemorySpine } from '../src/memory';

const clock = { nowIso: () => '2026-01-01T00:00:00Z' };
import { executeYearClose, planYearClose } from '../src/yearclose';

const TP = 'tp-yc';
function fact(concept: string, value: string, derived = true): TaxFact {
  return {
    fact_id: `f:${concept}`, taxpayer_id: TP, concept, tax_year: 2025,
    jurisdiction: ['FED'], taxpayer_scope: 'primary',
    value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
    ...(derived ? { derivation: `calc:${concept}` } : { provenance: [{ source_id: 's1', source_field: 'v' }] }),
  } as TaxFact;
}

describe('planYearClose', () => {
  it('maps every recognized carryforward to exactly one register balance', () => {
    const rows = planYearClose([
      fact('carryover.capital_loss.st.out', '3000'),
      fact('carryover.capital_loss.lt.out', '1000'),
      fact('fed.qbi.loss_carryforward.out', '17256'),
      fact('k1.s2.passive_suspended.out', '1143'),
      fact('k1.s2.is_scorp', '1', false),
      fact('k1.p1.basis_suspended.out', '6000'),
      fact('k1.p1.is_scorp', '0', false),
      fact('schc.aantic.homeoffice.carryover_out', '250'),
    ], 2025);
    const byReg = Object.fromEntries(rows.map((r) => [`${r.kind}:${r.scope_ref}:${r.balance}`, r.amount]));
    expect(byReg).toEqual({
      'capital_loss:primary:st': '3000',
      'capital_loss:primary:lt': '1000',
      'qbi_loss:primary:carryforward': '17256',
      'passive_loss:k1:s2:suspended': '1143',
      'basis_outside:k1:p1:suspended_loss': '6000',
      'home_office_carryover:schc:aantic:carryover': '250',
    });
  });

  it('an unrecognized .out concept is a HARD error, never silently dropped', () => {
    expect(() => planYearClose([fact('fed.mystery.thing.out', '5')], 2025)).toThrow(/unrecognized carryforward/);
  });
});

describe('executeYearClose', () => {
  it('closes registers and the store rolls next-year openings (Gate 3 feed)', async () => {
    const spine = new InMemorySpine(clock);
    const closed = await executeYearClose(spine, TP, 2025, 'pkg-v1', [
      fact('carryover.capital_loss.st.out', '3000'),
      fact('k1.s2.passive_suspended.out', '1143'),
      fact('k1.s2.is_scorp', '1', false),
    ]);
    expect(closed).toHaveLength(2);
    expect(closed.every((r) => r.status === 'closed')).toBe(true);
    const next = await spine.getRegisters(TP, 2026);
    const opening = Object.fromEntries(next.map((r) => [`${r.kind}:${r.scope_ref}`, r.opening]));
    expect(opening['capital_loss:primary']).toEqual({ st: '3000' });
    expect(opening['passive_loss:k1:s2']).toEqual({ suspended: '1143' });
    // closed registers are immutable
    await expect(spine.closeRegister(closed[0]!.register_id, {}, 'pkg-v2')).rejects.toThrow(/already closed/);
  });
});
