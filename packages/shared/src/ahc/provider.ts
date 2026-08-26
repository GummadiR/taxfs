/**
 * ORIGIN: AHC (SCP repo) §13 — `llm_client` provider surface.
 * NOTE: `./shared-import/` was not present in this session, so this file is
 * a clean-room TypeScript implementation of the AHC provider contract per
 * spec E.0 ("model-agnostic router", stub provider for tests). Diff/replace
 * against the SCP originals when the shared-import assets are provided.
 * SCP/DealerOS-specific behavior intentionally omitted.
 *
 * PROVIDERS: the deterministic StubProvider ships for tests/dev; the real
 * AnthropicProvider (anthropic-provider.ts) wires in for the personal-use
 * vision-extraction path (K 4.4 satisfied for single-user: API traffic is
 * not used for training per Anthropic's commercial terms).
 */

/**
 * Binary document payload attached to a message (vision extraction). The
 * attachment IS the user's own document, sent by explicit upload — the PII
 * wall applies to the TEXT parts of the payload (prompts must never carry
 * plaintext SSN/EIN); the document image itself is the object of the call.
 */
export interface LlmAttachment {
  kind: 'image' | 'pdf';
  /** e.g. image/png, image/jpeg, image/webp, image/gif, application/pdf */
  media_type: string;
  data_base64: string;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Optional binary attachments (vision path). Stub handlers ignore these. */
  attachments?: LlmAttachment[];
}

export interface LlmRequest {
  model: string;
  temperature: number;
  max_tokens?: number;
  messages: LlmMessage[];
}

export interface LlmResponse {
  text: string;
  model: string;
  stop_reason: 'end' | 'max_tokens';
}

export interface LlmProvider {
  readonly provider_id: string;
  /** Whether the vendor honors a temperature parameter (E.0: temp=0 where supported). */
  readonly supports_temperature: boolean;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Handler produces the raw "model output" text for a request (deterministic fixtures). */
export type StubHandler = (req: LlmRequest, callIndex: number) => string;

/**
 * Deterministic test provider: responses come from registered fixture
 * handlers keyed by model id. Unknown model ⇒ throw (fixtures are explicit;
 * the stub never improvises).
 */
export class StubProvider implements LlmProvider {
  readonly provider_id = 'stub';
  readonly supports_temperature = true;
  readonly calls: LlmRequest[] = [];
  private readonly handlers = new Map<string, StubHandler>();
  private readonly counts = new Map<string, number>();

  on(model: string, handler: StubHandler): this {
    this.handlers.set(model, handler);
    return this;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const handler = this.handlers.get(req.model);
    if (!handler) {
      throw new Error(`StubProvider: no fixture handler registered for model "${req.model}"`);
    }
    const n = this.counts.get(req.model) ?? 0;
    this.counts.set(req.model, n + 1);
    return { text: handler(req, n), model: req.model, stop_reason: 'end' };
  }
}
