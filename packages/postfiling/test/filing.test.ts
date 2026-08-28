/** I.2 acceptance: Filed is a one-way, frozen handoff — no post-filed mutation. */
import { describe, expect, it } from 'vitest';
import { PostFilingStore } from '@taxfs/postfiling';
import { baselineLines, filedScenario, fixedClock } from './helpers';

describe('FilingRecord (I.2)', () => {
  it('marking Filed binds the locked package version and captures the column-A baseline', async () => {
    const { filing, manifest } = await filedScenario();
    expect(filing.package_id).toBe(manifest.package_id);
    expect(filing.package_version).toBe(1);
    expect(filing.status).toBe('filed');
    // Gates-harness scenario: wages 50000 + interest 1200 → tax 4144, refund 856
    expect(filing.baseline_lines['fed.tax_after_credits']).toBe('4144');
    expect(filing.baseline_lines['fed.refund_or_due']).toBe('856');
  });

  it('refuses an unlocked package and double-filing', async () => {
    const { packages, manifest, facts } = await filedScenario();
    const pf2 = new PostFilingStore(fixedClock);
    const draftLike = { ...packages.get(manifest.package_id)!.manifest, status: 'draft' as const };
    expect(() =>
      pf2.markFiled({ manifest: draftLike, channel: 'paper', filed_date: '2026-04-10', baseline_lines: {} }),
    ).toThrow(/locked/);
    pf2.markFiled({
      manifest: packages.get(manifest.package_id)!.manifest,
      channel: 'paper',
      filed_date: '2026-04-10',
      baseline_lines: baselineLines(facts),
    });
    expect(() =>
      pf2.markFiled({
        manifest: packages.get(manifest.package_id)!.manifest,
        channel: 'mef_xml',
        filed_date: '2026-04-11',
        baseline_lines: {},
      }),
    ).toThrow(/already marked Filed/);
  });

  it('the FilingRecord is deep-frozen: no post-filed mutation is possible', async () => {
    const { filing } = await filedScenario();
    expect(() => {
      (filing as { status: string }).status = 'unfiled';
    }).toThrow();
    expect(() => {
      (filing.baseline_lines as Record<string, string>)['fed.tax_after_credits'] = '0';
    }).toThrow();
    expect(Object.isFrozen(filing)).toBe(true);
    expect(Object.isFrozen(filing.baseline_lines)).toBe(true);
  });
});
