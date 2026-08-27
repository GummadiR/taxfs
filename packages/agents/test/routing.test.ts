/** Subject: complexity routing (§6) — doc type picks the model tier. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTRACTION_MODELS,
  EXTRACTION_FRONTIER_AGENT_ID,
  EXTRACTION_SIMPLE_AGENT_ID,
  extractionAgentIdFor,
} from '../src/routing';

describe('extraction complexity routing', () => {
  it('simple single-form documents ride the small model', () => {
    for (const t of ['W-2', '1099-INT', '1099-DIV', 'SSA-1099', '1098'] as const) {
      expect(extractionAgentIdFor(t)).toBe(EXTRACTION_SIMPLE_AGENT_ID);
    }
  });
  it('hard reads ride the frontier model', () => {
    for (const t of ['K-1', 'CONSOLIDATED-1099', '1099-B', '1095-A', 'FOREIGN-REMITTANCE', 'UNREADABLE'] as const) {
      expect(extractionAgentIdFor(t)).toBe(EXTRACTION_FRONTIER_AGENT_ID);
    }
  });
  it('both tiers resolve to real current model ids', () => {
    expect(DEFAULT_EXTRACTION_MODELS[EXTRACTION_SIMPLE_AGENT_ID]).toMatch(/^claude-/);
    expect(DEFAULT_EXTRACTION_MODELS[EXTRACTION_FRONTIER_AGENT_ID]).toMatch(/^claude-/);
    expect(DEFAULT_EXTRACTION_MODELS[EXTRACTION_SIMPLE_AGENT_ID]).not.toBe(DEFAULT_EXTRACTION_MODELS[EXTRACTION_FRONTIER_AGENT_ID]);
  });
});
