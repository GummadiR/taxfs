/**
 * Gate 7 divergence check (ARCHITECTURE §7): kernel2 recomputes the headline
 * lines for EVERY golden return; any difference from the kernel is a red
 * build. Also enforces the isolation rule: kernel2 must not import kernel.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { C } from '@taxfs/shared';
import { compute, computeEntities, type KernelInput } from '@taxfs/kernel';
import { computeEntityHeadlines, computeHeadlines } from '@taxfs/kernel2';
import { GOLDEN_NAMES, TP, ctxOf, factsOf, loadFedRules, loadGolden, loadIlRules } from '../../kernel/test/helpers.js';

const fed = loadFedRules();
const il = loadIlRules();

describe.each(GOLDEN_NAMES)('kernel2 divergence: %s', (name) => {
  const golden = loadGolden(name);
  const input: KernelInput = {
    taxpayer_id: TP,
    tax_year: 2025,
    ctx: ctxOf(golden, fed, il),
    facts: factsOf(golden),
    fed_rules: fed,
    il_rules: il,
  };
  const kernelLines = new Map(compute(input).computedFacts.map((f) => [f.concept, f.value.toString()]));
  const k2 = computeHeadlines({
    facts: golden.facts.map((f) => ({ concept: f.concept, value: f.value, taxpayer_scope: f.scope })),
    filing_status: input.ctx.filing_status,
    il_exemption_count: input.ctx.il_exemption_count,
    addl_std_boxes: input.ctx.addl_std_boxes,
    fed_rules: fed,
    il_rules: il,
  });

  it('headline lines agree exactly', () => {
    expect(k2.total_income).toBe(kernelLines.get(C.FED_TOTAL_INCOME));
    expect(k2.agi).toBe(kernelLines.get(C.FED_AGI));
    expect(k2.taxable_income).toBe(kernelLines.get(C.FED_TAXABLE));
    expect(k2.fed_tax_total).toBe(kernelLines.get(C.FED_TAX));
    expect(k2.se_tax).toBe(kernelLines.get(C.FED_SE_TAX) ?? '0');
    expect(k2.total_liability).toBe(kernelLines.get(C.FED_TOTAL_TAX_LIABILITY));
    expect(k2.fed_payments).toBe(kernelLines.get(C.FED_PAYMENTS));
    expect(k2.fed_refund_or_due).toBe(kernelLines.get(C.FED_REFUND_OR_DUE));
    expect(k2.il_tax).toBe(kernelLines.get(C.IL_TAX));
    expect(k2.il_refund_or_due).toBe(kernelLines.get(C.IL_REFUND_OR_DUE));
    // P52 — the bottom lines net of any entered underpayment penalty.
    expect(k2.fed_net_amount_due).toBe(kernelLines.get(C.FED_NET_AMOUNT_DUE));
    expect(k2.il_net_amount_due).toBe(kernelLines.get(C.IL_NET_AMOUNT_DUE));
  });
});

it('isolation: kernel2 never imports the kernel', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  expect(src.includes('@taxfs/kernel\'') || src.includes('@taxfs/kernel"') || src.includes('packages/kernel/')).toBe(false);
});

describe('kernel2 entity divergence: entity1-backtest-2022-scorp', () => {
  const golden = loadGolden('entity1-backtest-2022-scorp');
  const input: KernelInput = {
    taxpayer_id: TP,
    tax_year: 2025,
    ctx: ctxOf(golden, fed, il),
    facts: factsOf(golden),
    fed_rules: fed,
    il_rules: il,
  };
  const kernelLines = new Map(
    computeEntities(input).computedFacts.map((f) => [f.concept, f.value.toString()]),
  );
  const k2 = computeEntityHeadlines(
    golden.facts.map((f) => ({ concept: f.concept, value: f.value, taxpayer_scope: f.scope })),
    il,
  );

  it('entity headline lines agree exactly', () => {
    const e = k2['sco']!;
    expect(e.ordinary_income).toBe(kernelLines.get('entity.sco.ordinary_income'));
    expect(e.k_total).toBe(kernelLines.get('entity.sco.k_total'));
    expect(e.il_base_income).toBe(kernelLines.get('entity.sco.il.base_income'));
    expect(e.il_replacement_tax).toBe(kernelLines.get('entity.sco.il.replacement_tax'));
    expect(e.member_box1['ma']).toBe(kernelLines.get('k1.sco-ma.box1'));
    expect(e.member_box1['mb']).toBe(kernelLines.get('k1.sco-mb.box1'));
    expect(e.member_capital_gain['ma']).toBe(kernelLines.get('k1.sco-ma.capital_gain'));
    expect(e.member_capital_gain['mb']).toBe(kernelLines.get('k1.sco-mb.capital_gain'));
  });
});

describe('kernel2 entity divergence: entity2-partnership-1065', () => {
  const golden = loadGolden('entity2-partnership-1065');
  const input: KernelInput = {
    taxpayer_id: TP,
    tax_year: 2025,
    ctx: ctxOf(golden, fed, il),
    facts: factsOf(golden),
    fed_rules: fed,
    il_rules: il,
  };
  const kernelLines = new Map(
    computeEntities(input).computedFacts.map((f) => [f.concept, f.value.toString()]),
  );
  const k2 = computeEntityHeadlines(
    golden.facts.map((f) => ({ concept: f.concept, value: f.value, taxpayer_scope: f.scope })),
    il,
  );

  it('partnership entity headline lines agree exactly', () => {
    const e = k2['pt']!;
    expect(e.ordinary_income).toBe(kernelLines.get('entity.pt.ordinary_income'));
    expect(e.k_total).toBe(kernelLines.get('entity.pt.k_total'));
    expect(e.il_base_income).toBe(kernelLines.get('entity.pt.il.base_income'));
    expect(e.il_replacement_tax).toBe(kernelLines.get('entity.pt.il.replacement_tax'));
    expect(e.member_box1['m1']).toBe(kernelLines.get('k1.pt-m1.box1'));
    expect(e.member_box1['m2']).toBe(kernelLines.get('k1.pt-m2.box1'));
    expect(e.member_capital_gain['m1']).toBe(kernelLines.get('k1.pt-m1.capital_gain'));
    expect(e.member_capital_gain['m2']).toBe(kernelLines.get('k1.pt-m2.capital_gain'));
  });
});
