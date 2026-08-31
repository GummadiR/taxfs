/**
 * The parity check is the only thing in this repo that compares TaxFS to the
 * system it replaced, so it has to be trustworthy in both directions: it must
 * SEE a capability that was dropped, and it must NOT cry about one that was
 * merely reworded. Both are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { reduce, surfaceOf } from './screen-parity';

const TAXOS_CONFIRM = `
  export default function Documents() {
    return (
      <form action={confirmProposal}>
        <input type="hidden" name="proposal_id" value={p.id} />
        <input name="typed_value" data-testid="typed" />
        <label><input type="checkbox" name="override" /> my typed value is correct</label>
        <SubmitButton data-testid="confirm">Confirm this value</SubmitButton>
      </form>
    );
  }
`;

describe('extracting what an operator can do on a screen', () => {
  it('finds every form control by name, and ignores hidden plumbing', () => {
    const s = surfaceOf([TAXOS_CONFIRM]);
    expect(s.controls).toEqual(['override', 'typed_value']);
    // proposal_id is a hidden input: machinery, not something anyone enters.
    expect(s.controls).not.toContain('proposal_id');
  });

  it('finds buttons by the words on them, including SubmitButton', () => {
    expect(surfaceOf([TAXOS_CONFIRM]).buttons).toEqual(['Confirm this value']);
  });

  it('SEES a dropped capability — the whole point (negative test)', () => {
    // The rebuild that started all of this: same screen, no type-to-verify,
    // no override. It typechecks, it renders, it passes every other gate.
    const rebuilt = `
      <form action={confirmValue}>
        <input type="hidden" name="fact_id" value={f.id} />
        <SubmitButton>Confirm this value</SubmitButton>
      </form>
    `;
    const before = surfaceOf([TAXOS_CONFIRM]);
    const after = surfaceOf([rebuilt]);
    const lost = before.controls.filter((c) => !after.controls.includes(c));
    expect(lost).toEqual(['override', 'typed_value']);
  });

  it('reads a screen split across several files as one surface', () => {
    const s = surfaceOf(['<input name="a" />', '<input name="b" />']);
    expect(s.controls).toEqual(['a', 'b']);
  });

  it('skips a computed control name rather than inventing one', () => {
    expect(surfaceOf(['<input name={dynamic} />']).controls).toEqual([]);
  });
});

describe('comparing button labels', () => {
  it('treats a reworded button as the same button', () => {
    expect(reduce('Add manually')).toBe(reduce('Add Manually'));
    expect(reduce('Confirm this value')).toBe(reduce('Confirm value'));
    expect(reduce('Delete the document')).toBe(reduce('Delete document'));
  });

  it('does NOT collapse two genuinely different buttons', () => {
    expect(reduce('Unlock')).not.toBe(reduce('Lock'));
    expect(reduce('Delete selected')).not.toBe(reduce('Delete'));
    expect(reduce('Save filing context')).not.toBe(reduce('Save filing identity'));
  });
});

/**
 * The dropdown blind spot (found the hard way).
 *
 * The manual-entry picker was `kind` in TaxOS and `concept` here. Comparing
 * control NAMES made that look like a rename, and it was excused as one —
 * while the list behind it went from 61 choices to 8, leaving most of a real
 * return unenterable: itemized deductions, foreign tax paid, tax-exempt
 * interest, the estimated-tax penalty. Same control, a fraction of the
 * capability, and the checker said nothing.
 */
describe('counting what a dropdown actually offers', () => {
  it('counts options written out literally', () => {
    const s = surfaceOf([`
      <select name="kind">
        <option value="a">A</option>
        <option value="b">B</option>
        <option value="c">C</option>
      </select>
    `]);
    expect(s.choices['kind']).toBe(3);
  });

  it('counts options rendered from a mapped array — a looped list is not an empty one', () => {
    const s = surfaceOf([`
      const MANUAL = [{ concept: 'a' }, { concept: 'b' }, { concept: 'c' }, { concept: 'd' }];
      export function P() {
        return <select name="concept">{MANUAL.map((c) => <option key={c.concept}>{c.concept}</option>)}</select>;
      }
    `]);
    // Four from the array; the single literal <option> inside the loop is the
    // template for them, so it must not be added on top.
    expect(s.choices['concept']).toBe(5);
  });

  it('resolves the array through a filter, as an optgroup render does', () => {
    const s = surfaceOf([`
      const MANUAL = [{ g: 'x' }, { g: 'x' }, { g: 'y' }];
      export function P() {
        return <select name="concept">
          {GROUPS.map((g) => <optgroup key={g}>{MANUAL.filter((c) => c.g === g).map((c) => <option/>)}</optgroup>)}
        </select>;
      }
    `]);
    expect(s.choices['concept']).toBeGreaterThanOrEqual(3);
  });

  it('SEES a gutted list — the regression that shipped (negative test)', () => {
    const big = `const L = [${'{a:1},'.repeat(61)}]; <select name="kind">{L.map(() => <option/>)}</select>`;
    const small = `const L = [${'{a:1},'.repeat(8)}]; <select name="concept">{L.map(() => <option/>)}</select>`;
    const before = Math.max(...Object.values(surfaceOf([big]).choices));
    const after = Math.max(...Object.values(surfaceOf([small]).choices));
    expect(before).toBeGreaterThan(60);
    expect(after).toBeLessThan(10);
    // The comparison the checker makes: keeping under 60% of the choices fails.
    expect(after).toBeLessThan(before * 0.6);
  });

  it('a select with no name is skipped rather than counted under a wrong key', () => {
    expect(surfaceOf(['<select><option/><option/></select>']).choices).toEqual({});
  });
});
