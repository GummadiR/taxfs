/**
 * E.0 live provider — Anthropic Claude vision, for the personal-use
 * document-extraction path (real upload + vision OCR replacing the E.1
 * fixture stub).
 *
 * Security invariants (kept OUT of this file's callers' hands):
 * - The API key is injected by the constructor; it is never logged, never
 *   serialized, and never reaches the browser (server-side construction
 *   only — see apps/web/src/server/env.ts).
 * - The PII wall (llm-client.ts) runs BEFORE any request reaches
 *   `complete()`: prompt text with plaintext SSN/EIN never gets here.
 * - Attachments are the user's own uploaded document (the object of the
 *   OCR call); text parts must stay identifier-free.
 * - Determinism: Opus 4.8 removed sampling parameters entirely, so no
 *   temperature is ever sent (`supports_temperature = false` keeps the
 *   router's temp=0 rule from applying a parameter the API would reject).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider, LlmRequest, LlmResponse } from './provider';

/** Default vision model (override per-route via the ModelRouter config). */
export const DEFAULT_VISION_MODEL = 'claude-opus-4-8';

const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

function isImageMediaType(v: string): v is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(v);
}

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  thinking: { type: 'adaptive' };
  system?: string;
  messages: Anthropic.MessageParam[];
}

/**
 * Pure mapping LlmRequest → Anthropic Messages body (exported so tests can
 * verify the wire shape — attachments become image/document blocks, system
 * messages move to the top-level `system` field — without a network call).
 */
export function buildAnthropicRequest(req: LlmRequest): AnthropicRequestBody {
  const systemText = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const messages: Anthropic.MessageParam[] = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const att of m.attachments ?? []) {
        if (att.kind === 'pdf') {
          blocks.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: att.data_base64 },
          });
        } else {
          if (!isImageMediaType(att.media_type)) {
            throw new Error(`AnthropicProvider: unsupported image media type "${att.media_type}"`);
          }
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: att.media_type, data: att.data_base64 },
          });
        }
      }
      blocks.push({ type: 'text', text: m.content });
      return { role: m.role as 'user' | 'assistant', content: blocks };
    });
  return {
    model: req.model,
    // Non-streaming default per current API guidance; extraction outputs are
    // small JSON documents, far below this ceiling.
    max_tokens: req.max_tokens ?? 16000,
    thinking: { type: 'adaptive' },
    ...(systemText.length > 0 ? { system: systemText } : {}),
    messages,
  };
}

export class AnthropicProvider implements LlmProvider {
  readonly provider_id = 'anthropic';
  /** Opus 4.8 rejects sampling params — never send temperature. */
  readonly supports_temperature = false;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        'AnthropicProvider: ANTHROPIC_API_KEY is missing. Put your key in .env.local ' +
          '(gitignored) as ANTHROPIC_API_KEY=sk-ant-... — never hardcode it and never commit it.',
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body = buildAnthropicRequest(req);
    const response = await this.client.messages.create(body);
    if (response.stop_reason === 'refusal') {
      // Content is unusable; surface a typed failure the harness can retry/report.
      throw new Error('AnthropicProvider: request declined by safety classifiers (stop_reason=refusal)');
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      text,
      model: response.model,
      stop_reason: response.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
    };
  }
}
