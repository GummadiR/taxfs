/**
 * Subject: workspace wiring — a package imports across the pnpm workspace
 * and the unit gate actually executes it. Exists so the unit gate is never
 * green by vacuity in Phase 1.
 */
import { describe, expect, it } from 'vitest';
import { WORKSPACE } from '@taxfs/shared';

describe('workspace wiring', () => {
  it('resolves the workspace package through pnpm', () => {
    expect(WORKSPACE).toBe('taxfs');
  });
});
