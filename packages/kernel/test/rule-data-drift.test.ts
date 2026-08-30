/**
 * THE GOLDENS AND THE APP DO NOT RUN THE SAME RULE DATA.
 *
 * `rules/fixtures/2025.FED.json` (rule_version 2025.FED.0.0.1-PLACEHOLDER,
 * every value tagged "PLACEHOLDER — verify") is what these kernel tests load.
 * The app loads `2025.FED.1.0.json`, verified against Rev. Proc. 2024-40 and
 * Rev. Proc. 2025-32 §3.01. They disagree, and the placeholder side is
 * PRE-OBBBA — so 40 goldens certify the kernel against superseded law while
 * production computes with the current figures.
 *
 * The two files also have different SHAPES (a `{value,status}` wrapper and
 * `mfj` vs `married_filing_jointly`), so this is a migration, not a swap, and
 * regenerating golden expectations FROM the kernel would leave them proving
 * only that the kernel agrees with itself. Recorded as scope in
 * docs/PLAN_OF_RECORD.md.
 *
 * Until then this test does the one useful thing available: it pins the
 * divergence that exists today and FAILS when a new one appears, so the drift
 * can shrink but never silently grow.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(root(p), 'utf8')) as unknown;

/** Flatten to dotted paths, unwrapping the placeholder `{value,status}` form. */
function flatten(node: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const o = node as Record<string, unknown>;
    if ('value' in o && (typeof o['value'] === 'string' || typeof o['value'] === 'number')) {
      out[prefix] = String(o['value']);
      return out;
    }
    for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (typeof node === 'string' || typeof node === 'number') {
    out[prefix] = String(node);
  }
  return out;
}

/** Same parameter under either file's naming, with the container stripped. */
const canonical = (key: string): string =>
  key
    .replace(/^parameters\./, '')
    .replace(/\bmarried_filing_jointly\b/, 'mfj')
    .replace(/\bmarried_filing_separately\b/, 'mfs')
    .replace(/\bhead_of_household\b/, 'hoh')
    .replace(/\bqualifying_surviving_spouse\b/, 'qss');

/** Numeric equality, so "300" and "300.0" are not a finding. */
function sameNumber(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : a === b;
}

/**
 * Divergences that exist TODAY, each with why. Shrinking this list is the
 * goal; adding to it without a reason is the thing being prevented.
 */
const KNOWN: Record<string, string> = {
  // All four statuses are pre-OBBBA in the golden fixture. Found by this
  // test's own canonicalisation: an earlier hand comparison missed mfj, mfs
  // and hoh entirely because the two files spell them differently
  // ('mfj' vs 'married_filing_jointly'), so they never lined up to be
  // compared at all.
  'standard_deduction.single':
    'goldens run PRE-OBBBA 15000; the app runs the Rev. Proc. 2025-32 §3.01 figure 15750',
  'standard_deduction.mfj': 'goldens run PRE-OBBBA 30000; the app runs 31500',
  'standard_deduction.mfs': 'goldens run PRE-OBBBA 15000; the app runs 15750',
  'standard_deduction.hoh': 'goldens run PRE-OBBBA 22500; the app runs 23625',
  'ptc.fpl_base': 'goldens run a round 15000 stand-in; the app runs the published 15060',
  'ptc.fpl_per_additional': 'goldens run a round 5000 stand-in; the app runs the published 5380',
  'ptc.cliff_pct':
    'goldens model the pre-2021 400%-of-FPL subsidy cliff; the app carries the suspended-cliff value',
};

describe('the goldens and the app must not drift further apart', () => {
  const tests = flatten(read('rules/fixtures/2025.FED.json'));
  const app = flatten(read('rules/fixtures/2025.FED.1.0.json'));

  const byCanon = (d: Record<string, string>): Map<string, string> => {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(d)) m.set(canonical(k), v);
    return m;
  };

  it('every parameter both files define agrees, except the ones recorded here', () => {
    const a = byCanon(tests);
    const b = byCanon(app);
    const unexpected: string[] = [];
    for (const [key, tv] of a) {
      const av = b.get(key);
      if (av === undefined || sameNumber(tv, av)) continue;
      if (KNOWN[key]) continue;
      unexpected.push(`${key}: goldens=${tv} app=${av}`);
    }
    expect(
      unexpected,
      `New rule-data divergence between the golden fixture and the app's verified release.\n` +
        `The goldens would keep passing while the app computes something else.\n` +
        unexpected.map((u) => `  ${u}`).join('\n'),
    ).toEqual([]);
  });

  it('each recorded divergence is still real — a fixed one must be removed from the list', () => {
    const a = byCanon(tests);
    const b = byCanon(app);
    const stale = Object.keys(KNOWN).filter((k) => {
      const tv = a.get(k);
      const av = b.get(k);
      return tv !== undefined && av !== undefined && sameNumber(tv, av);
    });
    expect(stale, `these divergences are resolved; delete them from KNOWN: ${stale.join(', ')}`).toEqual([]);
  });

  it('names the fixture the goldens actually load, so the gap is not folklore', () => {
    const helpers = readFileSync(root('packages/kernel/test/helpers.ts'), 'utf8');
    expect(helpers).toContain('2025.FED.json');
    const placeholder = readFileSync(root('rules/fixtures/2025.FED.json'), 'utf8');
    expect(placeholder).toContain('PLACEHOLDER');
    // If someone migrates the goldens to the verified release, this test
    // fails and should be deleted along with the rest of this file.
  });
});
