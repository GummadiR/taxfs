/**
 * I.4/I.6 acceptance: amendment from two kernel runs — filed baseline
 * column A, corrected column C, B = C − A asserted per line; full gate
 * re-run on the corrected return; neutral template statement; federal
 * finalization auto-opens the IL companion with the statutory countdown.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { editSourceFact } from '@taxfs/gates';
import {
  assertColumnConsistency,
  buildAmendedReturn,
  finalizeFederalAmendment,
  generateIlCompanion,
  type AmendedReturn,
  type AmendmentCase,
} from '@taxfs/postfiling';
import { filedScenario, pfRules, type FiledRig } from './helpers';
import type { TaxFact } from '@taxfs/shared';

let rig: FiledRig;
let amend: AmendmentCase;
let amended: AmendedReturn;
let correctedFacts: TaxFact[];

beforeAll(async () => {
  rig = await filedScenario();
  // Corrected 1099-INT arrives after filing: 1000 → 1350. The IRS
  // transcript would eventually reflect it; the demo transcript capture is
  // amended the same way (E.6 correction path) so reconciliation holds.
  const records = [
    { form: 'W-2', payer: 'Acme Corp', concept: 'income.wages', amount: '50000' },
    { form: '1099-INT', payer: 'First Bank', concept: 'income.interest', amount: '1350' },
  ];
  // scenario wages are 50000 in the gates harness seed
  await rig.s.spine.amendSourceField('s-transcript', 'records', JSON.stringify(records));
  await editSourceFact(rig.s, 'f:int-1:interest', '1350');
  const { reruns } = await rig.s.orchestrator.handleFactMutation('f:int-1:interest');
  // Full gate re-run on the corrected return: everything passes (gate 5 warns)
  expect(reruns.filter((r) => r.gate !== 5).every((r) => r.result === 'pass')).toBe(true);

  correctedFacts = await rig.s.spine.getFacts({ taxpayer_id: 'tp-e2e', tax_year: 2025 });
  amend = rig.pf.openAmendmentCase({
    filing: rig.filing,
    reason: 'late_doc',
    correction_concepts: ['income.interest'],
  });
  amended = buildAmendedReturn({
    amend,
    filing: rig.filing,
    corrected_facts: correctedFacts,
    rules: pfRules,
    slots: { doc: 'a corrected 1099-INT', concept_summary: 'interest income' },
  });
});

describe('1040-X column structure (I.4)', () => {
  it('columns come from the two kernel runs with per-line B = C − A', () => {
    const row = (concept: string) => amended.fed_rows.find((r) => r.concept === concept)!;
    // Filed baseline: wages 50000 + interest 1200 → tax 4144, refund 856.
    // Corrected 1099-INT: interest 1200 → 1350 (+150).
    expect(row('fed.total_income').col_a_original).toBe('51200');
    expect(row('fed.total_income').col_c_corrected).toBe('51350');
    expect(row('fed.total_income').col_b_change).toBe('150');
    expect(row('fed.tax_after_credits').col_a_original).toBe('4144');
    expect(row('fed.tax_after_credits').col_c_corrected).toBe('4162');
    expect(row('fed.tax_after_credits').col_b_change).toBe('18');
    expect(row('fed.refund_or_due').col_a_original).toBe('856');
    expect(row('fed.refund_or_due').col_b_change).toBe('-18');
    assertColumnConsistency(amended.fed_rows);
  });

  it('a tampered row fails the assertion — inconsistent columns never ship', () => {
    const tampered = amended.fed_rows.map((r) =>
      r.concept === 'fed.total_income' ? { ...r, col_b_change: '999' } : r,
    );
    expect(() => assertColumnConsistency(tampered)).toThrow(/B=999 but C−A=150/);
  });

  it('the explanation statement comes from the pre-approved template, filled and neutral', () => {
    expect(amended.explanation_statement).toContain('filed solely to incorporate a corrected 1099-INT');
    expect(amended.explanation_statement).toContain('interest income adjusted by $18');
    expect(amend.explanation_statement).toBe(amended.explanation_statement);
  });
});

describe('federal → IL sync (I.4)', () => {
  it('finalizing the federal amendment auto-opens the IL companion with the statutory countdown', () => {
    finalizeFederalAmendment({
      amend,
      new_package_ref: 'pkg-0002',
      final_determination_date: '2026-08-01',
      rules: pfRules,
    });
    expect(amend.status).toBe('finalized');
    expect(amend.il_companion?.generated).toBe(false); // alert persists…
    expect(amend.il_companion?.due_date).toBe('2026-11-29'); // +120 days (PLACEHOLDER — verify 35 ILCS 5/506)
    expect(amend.il_companion?.alert).toContain('120 days');
    expect(amend.il_companion?.alert).toContain('2026-11-29');

    const il = generateIlCompanion({ amend, filing: rig.filing, corrected_facts: correctedFacts });
    expect(amend.il_companion?.generated).toBe(true); // …until generated
    const ilTax = il.il_rows.find((r) => r.concept === 'il.tax')!;
    // IL: base 51200→51350, net 48425→48575, tax 2397→2404
    expect(ilTax.col_a_original).toBe('2397');
    expect(ilTax.col_c_corrected).toBe('2404');
    expect(ilTax.col_b_change).toBe('7');
    assertColumnConsistency(il.il_rows);
  });

  it('the IL companion cannot be generated before federal finalization', async () => {
    const rig2 = await filedScenario();
    const draft = rig2.pf.openAmendmentCase({
      filing: rig2.filing,
      reason: 'user_correction',
      correction_concepts: ['income.interest'],
    });
    expect(() =>
      generateIlCompanion({ amend: draft, filing: rig2.filing, corrected_facts: correctedFacts }),
    ).toThrow(/finalized federal amendment/);
  });
});
