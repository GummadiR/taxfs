/** P0: register store (in-memory reference) + Gate 3 continuity assertions. */
import { describe, expect, it } from 'vitest';
import { InMemorySpine } from '../src/memory';
import { continuityBreaks } from '../src/registers';
import type { RegisterSnapshot } from '../src/contracts';

const clock = (() => {
  let t = 0;
  return { nowIso: () => new Date(Date.parse('2026-01-01T00:00:00Z') + ++t * 1000).toISOString() };
})();

const TENANT = 'tp-test';

function spine(): InMemorySpine {
  return new InMemorySpine(clock, 'test');
}

const capLoss2025 = {
  register_id: 'reg:cap:primary:y2025',
  taxpayer_id: TENANT,
  scope_ref: 'primary',
  kind: 'capital_loss' as const,
  tax_year: 2025,
  opening: {},
  activity: { realized_loss: '-5000' },
  opening_source_ref: null,
};

describe('RegisterStore (in-memory)', () => {
  it('upserts, reads back, and audits', async () => {
    const s = spine();
    await s.upsertRegister(capLoss2025);
    const regs = await s.getRegisters(TENANT, 2025);
    expect(regs).toHaveLength(1);
    expect(regs[0]!.status).toBe('open');
    expect(regs[0]!.activity['realized_loss']).toBe('-5000');
    const { auditLog } = await s.inspect();
    expect(auditLog.some((a) => a.action === 'register.upserted')).toBe(true);
  });

  it('close records the closing, becomes immutable, and rolls into next year', async () => {
    const s = spine();
    await s.upsertRegister(capLoss2025);
    const closed = await s.closeRegister('reg:cap:primary:y2025', { carryover: '-2000' }, 'pkg-v1');
    expect(closed.status).toBe('closed');
    expect(closed.closing).toEqual({ carryover: '-2000' });

    // immutable after close
    await expect(s.upsertRegister(capLoss2025)).rejects.toThrow(/immutable/);
    await expect(s.closeRegister('reg:cap:primary:y2025', {}, 'pkg-v2')).rejects.toThrow(/already closed/);

    // the roll: next year opened with opening = closing, traceable source
    const next = await s.getRegisters(TENANT, 2026, 'capital_loss');
    expect(next).toHaveLength(1);
    expect(next[0]!.opening).toEqual({ carryover: '-2000' });
    expect(next[0]!.opening_source_ref).toBe('register://reg:cap:primary:y2025');
  });

  it('identity fields are immutable across upserts', async () => {
    const s = spine();
    await s.upsertRegister(capLoss2025);
    await expect(
      s.upsertRegister({ ...capLoss2025, kind: 'nol' as const }),
    ).rejects.toThrow(/immutable/);
  });
});

describe('continuityBreaks (Gate 3 assertion)', () => {
  const prior: RegisterSnapshot = {
    ...capLoss2025,
    closing: { carryover: '-2000' },
    status: 'closed',
    closed_by_package_id: 'pkg-v1',
  };
  const current: RegisterSnapshot = {
    ...capLoss2025,
    register_id: 'reg:cap:primary:y2026',
    tax_year: 2026,
    opening: { carryover: '-2000' },
    activity: {},
    closing: null,
    status: 'open',
    closed_by_package_id: null,
    opening_source_ref: 'register://reg:cap:primary:y2025',
  };

  it('clean roll: opening == prior locked closing → no breaks', () => {
    expect(continuityBreaks([prior], [current])).toEqual([]);
  });

  it('opening mismatch is a named, valued break', () => {
    const tampered = { ...current, opening: { carryover: '-1500' } };
    const breaks = continuityBreaks([prior], [tampered]);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.reason).toBe('opening_mismatch');
    expect(breaks[0]!.opening).toBe('-1500');
    expect(breaks[0]!.prior_closing).toBe('-2000');
  });

  it('prior year not closed blocks', () => {
    const openPrior = { ...prior, status: 'open' as const, closing: null };
    expect(continuityBreaks([openPrior], [current])[0]!.reason).toBe('prior_not_closed');
  });

  it('first-year manual opening needs attached support', () => {
    const manual = { ...current, opening_source_ref: null };
    expect(continuityBreaks([], [manual])[0]!.reason).toBe('manual_opening_unsupported');
    // ...and is fine WITH support:
    const supported = { ...current, opening_source_ref: 'supabase://taxos-docs/2025/prior-return.pdf' };
    expect(continuityBreaks([], [supported])).toEqual([]);
  });
});
