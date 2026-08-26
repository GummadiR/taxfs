/**
 * Spine contract suite — runs unchanged against BOTH backends
 * (InMemorySpine and PgSpine). Assertions are behavior-level: exact audit
 * action strings differ between the app-level log (in-memory) and the
 * trigger-written log (Postgres), but the invariants are identical.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Money, type Calculation, type TaxFact } from '@taxfs/shared';
import type { SpineBackend } from '@taxfs/spine';

export interface ContractFixture {
  /** Spine acting as the primary tenant. */
  spine: SpineBackend;
  taxpayerId: string;
  /** Spine acting as a DIFFERENT tenant (isolation tests). */
  otherSpine: SpineBackend;
  otherTaxpayerId: string;
  /** Total audit rows visible for the primary tenant's data. */
  auditCount(): Promise<number>;
  close(): Promise<void>;
}

const YEAR = 2025;

export function runSpineContractSuite(label: string, make: () => Promise<ContractFixture>): void {
  describe(`spine contract [${label}]`, () => {
    let fx: ContractFixture;
    let tp: string;

    beforeEach(async () => {
      fx = await make();
      tp = fx.taxpayerId;
    });

    afterEach(async () => {
      await fx.close();
    });

    async function seedSourcedFact(factId = 'f-wages', value = '60000'): Promise<void> {
      await fx.spine.registerSource({
        source_id: `src-${factId}`,
        taxpayer_id: tp,
        type: 'W-2',
        tax_year: YEAR,
        fields: { box1: value },
        ocr_confidence: 0.99,
        raw_ref: `blob://${factId}`,
      });
      await fx.spine.putSourceFact({
        fact_id: factId,
        taxpayer_id: tp,
        concept: 'income.wages',
        tax_year: YEAR,
        jurisdiction: ['FED', 'IL'],
        taxpayer_scope: 'primary',
        value: Money.fromString(value),
        confidence: 0.99,
        provenance: [{ source_id: `src-${factId}`, source_field: 'box1' }],
      });
    }

    function derived(factId: string, concept: string, value: string): TaxFact {
      return {
        fact_id: factId,
        taxpayer_id: tp,
        concept,
        tax_year: YEAR,
        jurisdiction: ['FED'],
        taxpayer_scope: 'primary',
        value: Money.fromString(value),
        unit: 'USD',
        status: 'confirmed',
        confidence: 1,
      };
    }

    function calc(calcId: string, concept: string, out: string, inputs: string[], value: string): Calculation {
      return {
        calc_id: calcId,
        taxpayer_id: tp,
        concept,
        output_fact_id: out,
        rule_version: '2025.FED.0.0.1-PLACEHOLDER',
        inputs,
        formula_ref: `test.${concept}`,
        steps: [`${concept} = f(${inputs.join(', ')})`],
        value: Money.fromString(value),
      };
    }

    /** f-wages → d-total → d-tax */
    async function seedTwoLevelGraph(): Promise<void> {
      await seedSourcedFact();
      await fx.spine.confirmFact('f-wages');
      await fx.spine.commitComputation({
        computedFacts: [derived('d-total', 'fed.total_income', '60000'), derived('d-tax', 'fed.tax.total', '5700')],
        calculations: [
          calc('c-total', 'fed.total_income', 'd-total', ['f-wages'], '60000'),
          calc('c-tax', 'fed.tax.total', 'd-tax', ['d-total'], '5700'),
        ],
      });
    }

    it('putSourceFact + getFacts roundtrip preserves value, provenance, status', async () => {
      await seedSourcedFact();
      const facts = await fx.spine.getFacts({ taxpayer_id: tp, tax_year: YEAR });
      expect(facts).toHaveLength(1);
      const f = facts[0]!;
      expect(f.concept).toBe('income.wages');
      expect(f.value.eq(Money.fromString('60000'))).toBe(true);
      expect(f.status).toBe('unconfirmed');
      expect(f.derivation).toBeUndefined();
      expect(f.provenance).toEqual([{ source_id: 'src-f-wages', source_field: 'box1' }]);
      await fx.spine.confirmFact('f-wages');
      const confirmed = await fx.spine.getFacts({ taxpayer_id: tp, tax_year: YEAR });
      expect(confirmed[0]!.status).toBe('confirmed');
    });

    it('every mutation appends audit rows; reads do not', async () => {
      const c0 = await fx.auditCount();
      await seedSourcedFact();
      const c1 = await fx.auditCount();
      expect(c1).toBeGreaterThan(c0);
      await fx.spine.confirmFact('f-wages');
      const c2 = await fx.auditCount();
      expect(c2).toBeGreaterThan(c1);
      await fx.spine.getFacts({ taxpayer_id: tp, tax_year: YEAR });
      await fx.spine.getSources(tp, YEAR);
      expect(await fx.auditCount()).toBe(c2);
      await fx.spine.appendGateRun({
        taxpayer_id: tp,
        gate: 2,
        jurisdiction: 'FED',
        rule_version: 'rv',
        result: 'pass',
        findings: [],
        consumed_fact_ids: ['f-wages'],
      });
      expect(await fx.auditCount()).toBeGreaterThan(c2);
    });

    it('idempotency: identical putSourceFact and clean recompute add zero audit rows', async () => {
      await seedTwoLevelGraph();
      const before = await fx.auditCount();
      await fx.spine.putSourceFact({
        fact_id: 'f-wages',
        taxpayer_id: tp,
        concept: 'income.wages',
        tax_year: YEAR,
        jurisdiction: ['FED', 'IL'],
        taxpayer_scope: 'primary',
        value: Money.fromString('60000'),
        confidence: 0.99,
        provenance: [{ source_id: 'src-f-wages', source_field: 'box1' }],
      });
      const changed = await fx.spine.commitComputation({
        computedFacts: [derived('d-total', 'fed.total_income', '60000'), derived('d-tax', 'fed.tax.total', '5700')],
        calculations: [
          calc('c-total', 'fed.total_income', 'd-total', ['f-wages'], '60000'),
          calc('c-tax', 'fed.tax.total', 'd-tax', ['d-total'], '5700'),
        ],
      });
      expect(changed).toEqual([]);
      expect(await fx.auditCount()).toBe(before);
    });

    it('deleteSource removes the source and its sourced facts, and audits the removal', async () => {
      await seedSourcedFact();
      await fx.spine.confirmFact('f-wages');
      const before = await fx.auditCount();
      const { deleted_fact_ids } = await fx.spine.deleteSource('src-f-wages');
      expect(deleted_fact_ids).toEqual(['f-wages']);
      expect(await fx.spine.getFacts({ taxpayer_id: tp, tax_year: YEAR })).toEqual([]);
      expect(await fx.spine.getSources(tp, YEAR)).toEqual([]);
      // The deletion is not silent — it appends audit rows (DELETE trigger / app log).
      expect(await fx.auditCount()).toBeGreaterThan(before);
    });

    it('deleteSource refuses when a sourced fact was already consumed into a computed result', async () => {
      await seedTwoLevelGraph(); // f-wages → d-total → d-tax
      await expect(fx.spine.deleteSource('src-f-wages')).rejects.toThrow(/already used in computed results/);
      // Nothing was torn down.
      const facts = await fx.spine.getFacts({ taxpayer_id: tp, tax_year: YEAR });
      expect(facts.map((f) => f.fact_id).sort()).toEqual(['d-tax', 'd-total', 'f-wages']);
      expect(await fx.spine.getSources(tp, YEAR)).toHaveLength(1);
    });

    it('deleteSource(cascade) removes the source AND the whole derived layer, leaving no orphans', async () => {
      await seedTwoLevelGraph(); // f-wages → d-total → d-tax
      const { deleted_fact_ids } = await fx.spine.deleteSource('src-f-wages', { cascade: true });
      // The sourced fact and every derived fact are gone (order-independent).
      expect(deleted_fact_ids.sort()).toEqual(['d-tax', 'd-total', 'f-wages']);
      expect(await fx.spine.getFacts({ taxpayer_id: tp, tax_year: YEAR })).toEqual([]);
      expect(await fx.spine.getSources(tp, YEAR)).toEqual([]);
    });

    it('deleteSource on an unknown source throws', async () => {
      await expect(fx.spine.deleteSource('nope')).rejects.toThrow(/not found/);
    });

    it('sourced XOR derived is enforced', async () => {
      await seedSourcedFact();
      await expect(
        fx.spine.putSourceFact({
          fact_id: 'f-x',
          taxpayer_id: tp,
          concept: 'income.wages',
          tax_year: YEAR,
          jurisdiction: ['FED'],
          taxpayer_scope: 'primary',
          value: Money.fromString('1'),
          confidence: 1,
          provenance: [],
        }),
      ).rejects.toThrow();
      await expect(
        fx.spine.commitComputation({
          computedFacts: [derived('f-wages', 'income.wages', '1')],
          calculations: [calc('c-bad', 'income.wages', 'f-wages', [], '1')],
        }),
      ).rejects.toThrow();
      const withProv: TaxFact = {
        ...derived('d-bad', 'x', '1'),
        provenance: [{ source_id: 'src-f-wages', source_field: 'box1' }],
      };
      await expect(
        fx.spine.commitComputation({
          computedFacts: [withProv],
          calculations: [calc('c-bad2', 'x', 'd-bad', ['f-wages'], '1')],
        }),
      ).rejects.toThrow();
    });

    it('getLineage walks a derived fact back to its source document', async () => {
      await seedTwoLevelGraph();
      const lineage = await fx.spine.getLineage('d-tax');
      expect(lineage.calculation?.calc_id).toBe('c-tax');
      expect(lineage.calculation?.inputs).toEqual(['d-total']);
      const level2 = lineage.inputs?.[0];
      expect(level2?.fact.fact_id).toBe('d-total');
      const level3 = level2?.inputs?.[0];
      expect(level3?.fact.fact_id).toBe('f-wages');
      expect(level3?.sources?.[0]?.source_id).toBe('src-f-wages');
    });

    it('staleness cascade marks transitive dependents and reopens only consuming gates', async () => {
      await seedTwoLevelGraph();
      await seedSourcedFact('f-unrelated', '100');
      await fx.spine.appendGateRun({
        taxpayer_id: tp, gate: 2, jurisdiction: 'FED', rule_version: 'rv',
        result: 'pass', findings: [], consumed_fact_ids: ['f-wages', 'd-total'],
      });
      await fx.spine.appendGateRun({
        taxpayer_id: tp, gate: 4, jurisdiction: 'FED', rule_version: 'rv',
        result: 'pass', findings: [], consumed_fact_ids: ['d-tax'],
      });
      await fx.spine.appendGateRun({
        taxpayer_id: tp, gate: 2, jurisdiction: 'IL', rule_version: 'rv',
        result: 'pass', findings: [], consumed_fact_ids: ['f-unrelated'],
      });

      await fx.spine.putSourceFact({
        fact_id: 'f-wages',
        taxpayer_id: tp,
        concept: 'income.wages',
        tax_year: YEAR,
        jurisdiction: ['FED', 'IL'],
        taxpayer_scope: 'primary',
        value: Money.fromString('65000'),
        confidence: 1,
        provenance: [{ source_id: 'src-f-wages', source_field: 'box1' }],
        confirmed: true,
      });
      const impact = await fx.spine.markStale('f-wages');
      expect(impact.stale_fact_ids).toEqual(['d-tax', 'd-total']);
      expect(impact.reopened_gates).toEqual([
        { gate: 2, jurisdiction: 'FED' },
        { gate: 4, jurisdiction: 'FED' },
      ]);
      const facts = await fx.spine.getFacts({ taxpayer_id: tp, tax_year: YEAR });
      const statusOf = (id: string) => facts.find((f) => f.fact_id === id)?.status;
      expect(statusOf('d-total')).toBe('stale');
      expect(statusOf('d-tax')).toBe('stale');
      expect(statusOf('f-wages')).toBe('confirmed');
    });

    it('F1 regression: mutating a source fact marks dependents stale WITHOUT an explicit markStale call', async () => {
      await seedTwoLevelGraph();
      await fx.spine.putSourceFact({
        fact_id: 'f-wages',
        taxpayer_id: tp,
        concept: 'income.wages',
        tax_year: YEAR,
        jurisdiction: ['FED', 'IL'],
        taxpayer_scope: 'primary',
        value: Money.fromString('72000'),
        confidence: 1,
        provenance: [{ source_id: 'src-f-wages', source_field: 'box1' }],
        confirmed: true,
      });
      // No markStale() — the mutation alone must have cascaded (A.2).
      const facts = await fx.spine.getFacts({ taxpayer_id: tp, tax_year: YEAR });
      const statusOf = (id: string) => facts.find((f) => f.fact_id === id)?.status;
      expect(statusOf('d-total')).toBe('stale');
      expect(statusOf('d-tax')).toBe('stale');
      expect(statusOf('f-wages')).toBe('confirmed');
    });

    it('amendSourceField corrects the capture with an audit row (E.6 correction path)', async () => {
      await seedSourcedFact();
      const before = await fx.auditCount();
      await fx.spine.amendSourceField('src-f-wages', 'box1', '61000');
      const sources = await fx.spine.getSources(tp, YEAR);
      expect(sources[0]?.fields['box1']).toBe('61000');
      expect(await fx.auditCount()).toBeGreaterThan(before);
      // idempotent: same value again → no new audit rows
      const after = await fx.auditCount();
      await fx.spine.amendSourceField('src-f-wages', 'box1', '61000');
      expect(await fx.auditCount()).toBe(after);
      await expect(fx.spine.amendSourceField('nope', 'x', '1')).rejects.toThrow();
    });

    it('gate runs roundtrip with embedded findings', async () => {
      await seedSourcedFact();
      const run = await fx.spine.appendGateRun({
        taxpayer_id: tp,
        gate: 5,
        jurisdiction: 'FED',
        rule_version: 'rv',
        result: 'warn',
        findings: [
          {
            finding_id: 'fnd-0001',
            critic_id: 'IRS-ROUNDNUM',
            lens: 'IRS',
            severity: 'Audit-Risk',
            affected: ['f-wages'],
            message: 'round numbers',
            gate: 5,
          },
        ],
        consumed_fact_ids: ['f-wages'],
      });
      expect(run.run_id.length).toBeGreaterThan(0);
      expect(run.result).toBe('warn');
      expect(run.findings).toHaveLength(1);
      expect(run.findings[0]?.critic_id).toBe('IRS-ROUNDNUM');
      expect(run.consumed_fact_ids).toEqual(['f-wages']);
    });

    it('registers: upsert/close/roll roundtrip with closed-immutability (P0)', async () => {
      const regId = `reg:capital_loss:primary:y${YEAR}`;
      await fx.spine.upsertRegister({
        register_id: regId,
        taxpayer_id: tp,
        scope_ref: 'primary',
        kind: 'capital_loss',
        tax_year: YEAR,
        opening: {},
        activity: { realized_loss: '-5000' },
        opening_source_ref: null,
      });
      const open = await fx.spine.getRegisters(tp, YEAR, 'capital_loss');
      expect(open).toHaveLength(1);
      expect(open[0]?.status).toBe('open');

      const closed = await fx.spine.closeRegister(regId, { carryover: '-2000' }, 'pkg-v1');
      expect(closed.status).toBe('closed');
      expect(closed.closing).toEqual({ carryover: '-2000' });

      // closed registers are immutable, in both backends
      await expect(
        fx.spine.upsertRegister({
          register_id: regId, taxpayer_id: tp, scope_ref: 'primary', kind: 'capital_loss',
          tax_year: YEAR, opening: {}, activity: {}, opening_source_ref: null,
        }),
      ).rejects.toThrow(/immutable|closed/);
      await expect(fx.spine.closeRegister(regId, {}, 'pkg-v2')).rejects.toThrow(/closed/);

      // the roll: next year opened with opening = closing, traceable source
      const next = await fx.spine.getRegisters(tp, YEAR + 1, 'capital_loss');
      expect(next).toHaveLength(1);
      expect(next[0]?.opening).toEqual({ carryover: '-2000' });
      expect(next[0]?.opening_source_ref).toBe(`register://${regId}`);
    });

    it('registers: tenant isolation (P0)', async () => {
      await fx.spine.upsertRegister({
        register_id: `reg:nol:primary:y${YEAR}`,
        taxpayer_id: tp,
        scope_ref: 'primary',
        kind: 'nol',
        tax_year: YEAR,
        opening: {},
        activity: { loss: '-1000' },
        opening_source_ref: null,
      });
      expect(await fx.spine.getRegisters(tp, YEAR, 'nol')).toHaveLength(1);
      // the OTHER tenant must see nothing — their own id (empty) and,
      // critically, the primary tenant's id (blocked/empty under RLS)
      expect(await fx.otherSpine.getRegisters(fx.otherTaxpayerId, YEAR, 'nol')).toEqual([]);
      expect(await fx.otherSpine.getRegisters(tp, YEAR, 'nol')).toEqual([]);
    });

    it('tenant isolation: another tenant sees nothing', async () => {
      await seedSourcedFact();
      const mine = await fx.spine.getFacts({ taxpayer_id: tp, tax_year: YEAR });
      expect(mine).toHaveLength(1);
      // Query as the OTHER tenant — both for their own id (empty data) and,
      // critically, for the primary tenant's id (must be blocked/empty).
      expect(await fx.otherSpine.getFacts({ taxpayer_id: fx.otherTaxpayerId, tax_year: YEAR })).toEqual([]);
      expect(await fx.otherSpine.getFacts({ taxpayer_id: tp, tax_year: YEAR })).toEqual([]);
      expect(await fx.otherSpine.getSources(tp, YEAR)).toEqual([]);
    });
  });
}
