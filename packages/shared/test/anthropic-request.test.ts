/**
 * The `thinking` parameter must match the model (§9.1 negative test).
 *
 * Found on the operator's machine, on every single extraction:
 *
 *   400 {"type":"invalid_request_error",
 *        "message":"adaptive thinking is not supported on this model"}
 *
 * The provider hardcoded `thinking: {type:'adaptive'}` for every request while
 * the web app pinned an older vision model that predates it. Nothing caught it
 * because no test asserted the wire shape per model, and the app's own tests
 * run with extraction stubbed out — so the only place the mismatch could
 * surface was a live call on a real machine, which is where it did.
 */
import { describe, expect, it } from 'vitest';
import { buildAnthropicRequest, supportsAdaptiveThinking } from '../src/ahc/anthropic-provider';

const req = (model: string) => ({
  model,
  temperature: 0,
  messages: [{ role: 'user' as const, content: 'read this' }],
});

describe('adaptive thinking is sent only where the model accepts it', () => {
  it('OMITS thinking for models that reject it (the 400 the operator hit)', () => {
    for (const model of ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-sonnet-20241022']) {
      expect(supportsAdaptiveThinking(model), model).toBe(false);
      expect(buildAnthropicRequest(req(model)), model).not.toHaveProperty('thinking');
    }
  });

  it('SENDS adaptive thinking for models that support it', () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5']) {
      expect(supportsAdaptiveThinking(model), model).toBe(true);
      expect(buildAnthropicRequest(req(model)).thinking, model).toEqual({ type: 'adaptive' });
    }
  });

  it('matches by family, so a pinned dated snapshot still gets thinking', () => {
    expect(supportsAdaptiveThinking('claude-opus-4-8-20260101')).toBe(true);
  });

  it('the app pins NO vision model of its own — one source of truth', async () => {
    // The actual defect: the web app declared a SECOND default that
    // disagreed with the provider's. TaxOS never did this — it uses the
    // shared default directly, which is why it never hit the 400.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../apps/web/src/server/agent-deps.ts', import.meta.url), 'utf8');
    expect(
      /const\s+DEFAULT_VISION_MODEL\s*=/.test(src),
      'the web app re-declared DEFAULT_VISION_MODEL — import the shared one instead',
    ).toBe(false);
    // And the shared default must accept the parameter the provider sends.
    const { DEFAULT_VISION_MODEL } = await import('../src/ahc/anthropic-provider');
    expect(supportsAdaptiveThinking(DEFAULT_VISION_MODEL)).toBe(true);
  });
});
