/**
 * ORIGIN: AHC (SCP repo) §13 — `llm_client`.
 * Clean-room TS implementation per spec E.0 (see provider.ts header for the
 * shared-import caveat).
 *
 * Responsibilities: route via ModelRouter, enforce the PII wall (no
 * plaintext SSN/EIN ever reaches a provider payload), retry provider
 * errors, and return raw text. Validation-driven retries + call logging
 * live in the agent harness.
 */
import type { LlmMessage } from './provider';
import { ModelRouter } from './model-router';

// LIMITATION (documented, auditor finding F6): these patterns catch
// FORMATTED identifiers only; an unformatted 9-digit SSN/EIN passes (a bare
// \d{9} rule would false-positive on ordinary amounts). This wall is the
// last line, not the first: real protection is tokenization at intake
// (E.0 context minimization), which workstream K owns.
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;
const EIN_PATTERN = /\b\d{2}-\d{7}\b/;

/**
 * The PII wall (E.0 context minimization): identifiers must be tokenized
 * (e.g. `tok_ssn_ab12`, `tok_ein_cd34`) before they can appear in any agent
 * payload. Plaintext SSN/EIN anywhere in a prompt is a defect.
 */
export function assertNoPlaintextPii(text: string): void {
  if (SSN_PATTERN.test(text)) {
    throw new Error('PII wall: plaintext SSN pattern in agent payload — tokenize identifiers (tok_ssn_*)');
  }
  if (EIN_PATTERN.test(text)) {
    throw new Error('PII wall: plaintext EIN pattern in agent payload — tokenize identifiers (tok_ein_*)');
  }
}

/** Deterministic FNV-1a 64-bit hash (hex) for input logging — not cryptographic. */
export function inputHash(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i = i + 1) {
    h = h ^ BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export interface LlmCallResult {
  text: string;
  model: string;
  provider_id: string;
  input_hash: string;
}

export class LlmClient {
  constructor(private readonly router: ModelRouter) {}

  async call(agent_id: string, messages: LlmMessage[]): Promise<LlmCallResult> {
    const { provider, route } = this.router.resolve(agent_id);
    const joined = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
    assertNoPlaintextPii(joined);
    const hash = inputHash(joined);

    let lastError: unknown;
    for (let attempt = 0; attempt <= route.max_retries; attempt = attempt + 1) {
      try {
        const res = await provider.complete({
          model: route.model,
          temperature: provider.supports_temperature ? 0 : route.temperature,
          messages,
        });
        return { text: res.text, model: res.model, provider_id: provider.provider_id, input_hash: hash };
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(
      `LlmClient: provider "${provider.provider_id}" failed after ${route.max_retries + 1} attempts for agent "${agent_id}": ${String(lastError)}`,
    );
  }

  maxRetries(agent_id: string): number {
    return this.router.resolve(agent_id).route.max_retries;
  }
}
