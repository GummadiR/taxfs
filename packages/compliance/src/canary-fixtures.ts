/**
 * Fixed canary fixture documents + the deterministic stub used to run them
 * (shared by the baseline generator, the tests, and future cron wiring).
 * These never change casually: the committed baseline in
 * golden/canary-baseline.json is the tripwire.
 */
import {
  InMemoryAgentLog,
  LlmClient,
  ModelRouter,
  StubProvider,
  stubRouterConfig,
  type AgentRunDeps,
} from '@taxfs/shared';
import type { DocImageStub } from '@taxfs/agents';

export const CANARY_DOCS: DocImageStub[] = [
  {
    doc_id: 'canary-w2',
    image_ref: 'canary://w2',
    ocr_text: ['box1_wages|42,000.00|42000|0.98', 'box2_fed_withholding|4,200.00|4200|0.97'].join('\n'),
    expected_tax_year: 2025,
  },
  {
    doc_id: 'canary-int',
    image_ref: 'canary://int',
    ocr_text: 'box1_interest|314.00|314|0.98',
    expected_tax_year: 2025,
  },
];

/** Parses the canary pipe format exactly like the demo extraction stub. */
export function canaryExtractionHandler(req: { messages: { role: string; content: string }[] }): string {
  const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const doc = CANARY_DOCS.find((d) => user.includes(d.doc_id));
  if (!doc) {
    return JSON.stringify({ doc_type: 'UNREADABLE', tax_year: null, payer: { name: '', ein_token: null }, fields: [] });
  }
  const docType = doc.doc_id === 'canary-w2' ? 'W-2' : '1099-INT';
  const fields = (doc.ocr_text ?? '').split('\n').map((line, i) => {
    const [name, raw, value, confidence] = line.split('|');
    return {
      name,
      raw_text: raw,
      normalized: { kind: 'decimal', value },
      region: { page: 1, x: 50, y: 700 - i * 20, w: 200, h: 14 },
      confidence: Number(confidence),
    };
  });
  return JSON.stringify({
    doc_type: docType,
    tax_year: doc.expected_tax_year,
    payer: { name: 'Canary Fixture Payer', ein_token: 'tok_ein_canary' },
    fields,
  });
}

export function makeCanaryDeps(handler = canaryExtractionHandler): AgentRunDeps {
  const stub = new StubProvider().on('stub:extraction', handler);
  const router = new ModelRouter(stubRouterConfig(['extraction'])).registerProvider(stub);
  return { client: new LlmClient(router), log: new InMemoryAgentLog() };
}
