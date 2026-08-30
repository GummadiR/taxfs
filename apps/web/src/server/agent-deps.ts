/**
 * Agent deps for app-server calls (TaxOS session.makeAgentDeps, ported to
 * the stateless model — built per request, no module-scope mutable state).
 *
 * Interview and explanation always run on the DETERMINISTIC stub: their
 * outputs are template/context assembly, and a nondeterministic model adds
 * nothing but risk there (N5: no LLM makes tax determinations). Extraction
 * routes to the real Anthropic vision API only when ANTHROPIC_API_KEY is
 * configured — the router swap point; agents never change.
 */
import { loadRootEnv } from './load-env';
import {
  AnthropicProvider,
  DEFAULT_VISION_MODEL,
  InMemoryAgentLog,
  LlmClient,
  ModelRouter,
  StubProvider,
  stubRouterConfig,
  type AgentLogSink,
  type AgentRunDeps,
} from '@taxfs/shared';

const AGENT_IDS = ['extraction', 'extraction_simple', 'interview', 'explanation', 'discovery'];

export function anthropicApiKey(): string | null {
  loadRootEnv();
  return process.env.ANTHROPIC_API_KEY ?? null;
}

export function makeAgentDeps(log?: AgentLogSink): AgentRunDeps {
  const stub = new StubProvider();
  stub.on('stub:interview', (req) => {
    const payload = JSON.parse(req.messages.find((m) => m.role === 'user')?.content ?? '{}') as {
      gaps: { gap_id: string; kind: string; concept: string | null; detail: string; attestation_template_id?: string }[];
      templates: { template_id: string; text: string; answer_type: string; attestation: boolean; maps_to: string }[];
    };
    const questions = payload.gaps.map((gap, i) => {
      const template = payload.templates.find((t) => t.template_id === gap.attestation_template_id);
      if (template) {
        return {
          question_id: `q${i + 1}`,
          text: template.text,
          answer_type: template.answer_type,
          maps_to_concept: template.maps_to,
          why_asked: gap.gap_id,
          attestation: template.attestation,
        };
      }
      return {
        question_id: `q${i + 1}`,
        text: `${gap.detail}. Can you take care of this now?`,
        answer_type: 'bool',
        maps_to_concept: gap.concept ?? 'unknown',
        why_asked: gap.gap_id,
        attestation: false,
      };
    });
    return JSON.stringify({ questions });
  });
  stub.on('stub:explanation', (req) => {
    const input = JSON.parse(req.messages.find((m) => m.role === 'user')?.content ?? '{}') as {
      subject_ref: string;
      context_lines: string[];
      candidate_rules: { rule_id: string }[];
    };
    return JSON.stringify({
      subject_ref: input.subject_ref,
      explanation_text: `In plain terms: ${input.context_lines[0] ?? 'this value'} — every figure here traces to your documents or a calculation step you can open.`,
      cited_rule_ids: input.candidate_rules.slice(0, 1).map((r) => r.rule_id),
      reading_level: 'plain',
    });
  });
  const config = stubRouterConfig(AGENT_IDS);
  const key = anthropicApiKey();
  if (key) {
    config.routes['extraction'] = {
      provider: 'anthropic',
      model: process.env.TAXFS_VISION_MODEL ?? DEFAULT_VISION_MODEL /* from the provider */,
      temperature: 0,
      max_retries: 2,
    };
  }
  const router = new ModelRouter(config).registerProvider(stub);
  if (key) router.registerProvider(new AnthropicProvider(key));
  return { client: new LlmClient(router), log: log ?? new InMemoryAgentLog() };
}
