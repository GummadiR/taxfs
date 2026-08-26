/**
 * P13 — business-package coverage over the two entity back-test goldens:
 * form-set resolution per entity type, per-member K-1 replication, line
 * values straight from kernel facts (no math in mapping), placeholder
 * artifacts, and cross-form Sch K tie-out.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Money, type TaxFact } from '@taxfs/shared';
import { computeEntities } from '@taxfs/kernel';
import {
  buildEntityPackages,
  instantiateEntityForms,
  loadBizFormRelease,
  type EntityPackage,
} from '@taxfs/forms';
import { TP, ctxOf, factsOf, loadFedRules, loadGolden, loadIlRules } from '../../kernel/test/helpers.js';

const fed = loadFedRules();
const il = loadIlRules();

const fixture = (rel: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8'));

const bizRelease = loadBizFormRelease(fixture('rules/fixtures/forms/2025.FORMS.BIZ.json'));
const pdfTemplates = fixture('rules/fixtures/pdf/2025.PDF-TEMPLATES.json');

async function buildFor(goldenName: string): Promise<EntityPackage[]> {
  const golden = loadGolden(goldenName);
  const sourced = factsOf(golden);
  const derived = computeEntities({
    taxpayer_id: TP,
    tax_year: 2025,
    ctx: ctxOf(golden, fed, il),
    facts: sourced,
    fed_rules: fed,
    il_rules: il,
  });
  const facts: TaxFact[] = [...sourced, ...derived.computedFacts];
  return buildEntityPackages({ tax_year: 2025, facts, release: bizRelease, pdf_templates: pdfTemplates });
}

describe('biz form-def release + instantiation', () => {
  it('refuses to load without the PLACEHOLDER marker', () => {
    const raw = fixture('rules/fixtures/forms/2025.FORMS.BIZ.json') as Record<string, unknown>;
    expect(() => loadBizFormRelease({ ...raw, status: 'looks fine' })).toThrow(/PLACEHOLDER/);
  });

  it('instantiates the S-corp form set with one K-1 + K-1-P per member', () => {
    const defs = instantiateEntityForms(bizRelease, { eid: 'sco', memberIds: ['ma', 'mb'], scorp: true });
    expect(defs.map((d) => d.form_id).sort()).toEqual(
      ['1120S', 'IL1120ST', 'K1-1120S:ma', 'K1-1120S:mb', 'K1P:ma', 'K1P:mb'].sort(),
    );
    const k1ma = defs.find((d) => d.form_id === 'K1-1120S:ma')!;
    expect(k1ma.lines.find((l) => l.line_id === 'K1-1120S.1')!.from_concept).toBe('k1.sco-ma.box1');
    expect(defs.some((d) => d.form_id.startsWith('1065'))).toBe(false);
  });

  it('instantiates the partnership form set (1065 family, no 1120-S)', () => {
    const defs = instantiateEntityForms(bizRelease, { eid: 'pt', memberIds: ['m1', 'm2'], scorp: false });
    expect(defs.map((d) => d.form_id).sort()).toEqual(
      ['1065', 'IL1065', 'K1-1065:m1', 'K1-1065:m2', 'K1P:m1', 'K1P:m2'].sort(),
    );
  });
});

describe('entity package — 1120-S back-test golden (entity1)', () => {
  it('builds a clean per-entity package whose lines match the oracle', async () => {
    const [pkg] = await buildFor('entity1-backtest-2022-scorp');
    expect(pkg).toBeDefined();
    expect(pkg!.entity_id).toBe('sco');
    expect(pkg!.scorp).toBe(true);
    expect(pkg!.defects).toEqual([]);
    expect(pkg!.clean).toBe(true);

    const inst = (fid: string) => pkg!.instances.find((i) => i.form_id === fid)!;
    expect(inst('1120S').values['1120S.21']!.toString()).toBe('-10445');
    expect(inst('1120S').values['1120S.K.18']!.toString()).toBe('25792');
    expect(inst('IL1120ST').values['IL1120ST.REPL']!.toString()).toBe('387');
    // Per-member K-1 copies: box 1 halves, box 10 other income 18119/18118.
    expect(inst('K1-1120S:ma').values['K1-1120S.1']!.toString()).toBe('-5223');
    expect(inst('K1-1120S:mb').values['K1-1120S.1']!.toString()).toBe('-5222');
    expect(inst('K1-1120S:ma').values['K1-1120S.10']!.toString()).toBe('18119');
    expect(inst('K1-1120S:mb').values['K1-1120S.10']!.toString()).toBe('18118');
    // K-1 boxes sum exactly to the entity lines (allocation law).
    const box1Sum = Money.sum([
      inst('K1-1120S:ma').values['K1-1120S.1']!,
      inst('K1-1120S:mb').values['K1-1120S.1']!,
    ]);
    expect(box1Sum.toString()).toBe('-10445');
    // IL K-1-P per member.
    expect(inst('K1P:ma').values['K1P.20']!.toString()).toBe('-5223');
    expect(inst('K1P:mb').values['K1P.31']!.toString()).toBe('18118');
  });

  it('renders one placeholder paper artifact per instance with the values printed', async () => {
    const [pkg] = await buildFor('entity1-backtest-2022-scorp');
    expect(pkg!.artifacts.length).toBe(pkg!.instances.length);
    const k1 = pkg!.artifacts.find((a) => a.artifact_id === 'pdf:sco:K1-1120S:mb')!;
    expect(k1.content_type).toBe('text/x-pdf-placeholder');
    expect(k1.content).toContain('FORM K1-1120S:mb');
    expect(k1.content).toContain('-5222');
    expect(k1.content).toContain('18118');
  });
});

describe('entity package — 1065 partnership golden (entity2)', () => {
  it('builds the 1065 package with guaranteed payments and §752 liability lines', async () => {
    const [pkg] = await buildFor('entity2-partnership-1065');
    expect(pkg!.entity_id).toBe('pt');
    expect(pkg!.scorp).toBe(false);
    expect(pkg!.defects).toEqual([]);

    const inst = (fid: string) => pkg!.instances.find((i) => i.form_id === fid)!;
    expect(inst('1065').values['1065.10']!.toString()).toBe('30000'); // guaranteed payments
    expect(inst('1065').values['1065.22']!.toString()).toBe('38000');
    expect(inst('1065').values['1065.K.RECON']!.toString()).toBe('78001');
    expect(inst('K1-1065:m1').values['K1-1065.1']!.toString()).toBe('22800');
    expect(inst('K1-1065:m1').values['K1-1065.4a']!.toString()).toBe('30000');
    expect(inst('K1-1065:m1').values['K1-1065.LIAB']!.toString()).toBe('18000');
    expect(inst('K1-1065:m2').values['K1-1065.9a']!.toString()).toBe('4000'); // LT gain share
    expect(inst('K1P:m1').values['K1P.29']!.toString()).toBe('30000');
  });

  it('every printed line carries fact lineage (compute wall: mapping did no math)', async () => {
    const [pkg] = await buildFor('entity2-partnership-1065');
    for (const instance of pkg!.instances) {
      for (const lineId of Object.keys(instance.values)) {
        expect(instance.lineage[lineId]?.fact_id, `${instance.form_id} ${lineId}`).toBeTruthy();
      }
    }
  });
});
