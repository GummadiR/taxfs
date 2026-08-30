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
