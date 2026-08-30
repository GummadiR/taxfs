/**
 * The sidebar is the operator's map of the return. Fifteen numbered links
 * all look equally done; the badge is what says "this one is waiting on
 * you" without opening each section in turn. These pin the mapping —
 * which condition wins when several are true at once, because that
 * ordering IS the guidance.
 */
import { describe, expect, it } from 'vitest';
import { __navStatusFrom } from '../src/server/nav-status';

const EMPTY = {
  filing_set: false, sources: 0, to_confirm: 0, derived: 0, stale: 0,
  gates_cells: 0, gates_failed: 0, gates_warned: 0,
  package_status: null as string | null, package_id: null as string | null,
};

describe('sidebar status badges', () => {
  it('a brand-new return points at Get Started and says every other step is idle', () => {
    const s = __navStatusFrom(EMPTY);
    expect(s['/get-started']).toMatchObject({ badge: 'start here', tone: 'attention' });
    expect(s['/documents']!.badge).toBe('empty');
    expect(s['/review']!.badge).toBe('not computed');
    expect(s['/gates']!.badge).toBe('not run');
    expect(s['/file-it']!.badge).toBe('no package');
    // Idle is quiet on purpose — only what needs doing should pull the eye.
    for (const href of ['/documents', '/review', '/gates', '/file-it']) {
      expect(s[href]!.tone).toBe('idle');
    }
  });

  it('waiting confirmations beat the upload count — nothing counts until you confirm it', () => {
    const s = __navStatusFrom({ ...EMPTY, sources: 6, to_confirm: 3 });
    expect(s['/documents']).toMatchObject({ badge: '3 to confirm', tone: 'attention' });
    expect(s['/documents']!.hint).toContain('nothing counts until you confirm it');
  });

  it('documents with nothing pending read as done, not as "3 to confirm" with zero', () => {
    const s = __navStatusFrom({ ...EMPTY, sources: 6 });
    expect(s['/documents']).toMatchObject({ badge: '6 uploaded', tone: 'ok' });
  });

  it('a stale figure outranks a computed one — the numbers on screen are wrong', () => {
    const s = __navStatusFrom({ ...EMPTY, derived: 40, stale: 2 });
    expect(s['/review']).toMatchObject({ badge: 'stale', tone: 'attention' });
    expect(s['/review']!.hint).toContain('re-run the gates');
  });

  it('a single failing gate cell is BLOCKED, however many passed', () => {
    const s = __navStatusFrom({ ...EMPTY, gates_cells: 14, gates_failed: 1 });
    expect(s['/gates']).toMatchObject({ badge: '1 failing', tone: 'blocked' });
    expect(s['/gates']!.hint).toContain('packaging is blocked');
  });

  it('a half-run board says how far it got, and asks for a re-run', () => {
    expect(__navStatusFrom({ ...EMPTY, gates_cells: 8 })['/gates'])
      .toMatchObject({ badge: '8/14 run', tone: 'attention' });
  });

  it('a gate-5 advisory is NOT an alarm — it never blocks a lawful return', () => {
    // The bug this pins: gate 5 warns on a perfectly filable return, so
    // counting warns as "not passed" painted a clean board amber 13/14.
    const s = __navStatusFrom({ ...EMPTY, gates_cells: 14, gates_warned: 1 });
    expect(s['/gates']!.tone).toBe('ok');
    expect(s['/gates']!.badge).toBe('passed · 1 advisory');
    expect(s['/gates']!.hint).toContain('never blocks a lawful return');
  });

  it('a clean board with nothing to note is plainly "all passed"', () => {
    expect(__navStatusFrom({ ...EMPTY, gates_cells: 14 })['/gates'])
      .toMatchObject({ badge: 'all passed', tone: 'ok' });
  });

  it('a draft package is not the filing artifact of record, and says so', () => {
    const draft = __navStatusFrom({ ...EMPTY, package_status: 'draft', package_id: 'pkg-1' });
    expect(draft['/file-it']).toMatchObject({ badge: 'draft', tone: 'attention' });
    const locked = __navStatusFrom({ ...EMPTY, package_status: 'locked', package_id: 'pkg-1' });
    expect(locked['/file-it']).toMatchObject({ badge: 'locked', tone: 'ok' });
    expect(locked['/file-it']!.hint).toContain('artifact of record');
  });
});
