/**
 * E.7 LIVE eval — real document through the real Anthropic vision API:
 * sample W-2 PDF (dummy numbers, committed fixture) → vision extraction →
 * review-pending → confirm → kernel on the SOURCE-VERIFIED 2025 rule-data →
 * gates → PackageReady. Also proves the PII guarantees hold against a real
 * model response (tokenized EIN, no raw identifiers anywhere downstream).
 *
 * GATED (repo convention, like TAXOS_LIVE_DATABASE_URL): runs only when
 * TAXOS_LIVE_EXTRACTION=1 is set AND ANTHROPIC_API_KEY is resolvable from
 * the environment or .env.local / .env at the repo root — a routine
 * `pnpm vitest run` never spends API calls. Costs a few cents per run
 * (one vision call, retries ≤ 3). Run it with:
 *
 *   TAXOS_LIVE_EXTRACTION=1 pnpm vitest run packages/agents/test/extraction.live.test.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  C,
  DEFAULT_VISION_MODEL,
  EventBus,
  InMemoryAgentLog,
  LlmClient,
  ModelRouter,
  Money,
  loadVerifiedRuleSet,
  type AgentRunDeps,
  type Clock,
  type FilingContext,
} from '@taxfs/shared';
import { InMemorySpine } from '@taxfs/spine';
import { CriticRegistry, Orchestrator, createF7RemainingCritics, createStep1Critics } from '@taxfs/gates';
import { ReviewPendingStore, runExtraction } from '@taxfs/agents';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

/** Minimal .env reader for the gated key — mirrors apps/web/src/server/env.ts. */
function liveApiKey(): string | null {
  if (process.env['ANTHROPIC_API_KEY']) return process.env['ANTHROPIC_API_KEY'];
  for (const file of ['.env.local', '.env']) {
    const path = root(file);
    if (!existsSync(path)) continue;
    const m = /^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/m.exec(readFileSync(path, 'utf8'));
    if (m && m[1]) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

const OPTED_IN = process.env['TAXOS_LIVE_EXTRACTION'] === '1';
const KEY = OPTED_IN ? liveApiKey() : null;
const SAMPLE_PDF = root('rules/fixtures/sample-docs/2025.SAMPLE.w2.pdf');
const TP = 'tp-live-eval';
const clock: Clock = { nowIso: () => '2026-07-08T00:00:00.000Z' };

function makeLiveDeps(key: string): AgentRunDeps {
  const router = new ModelRouter({
    routes: {
      extraction: { provider: 'anthropic', model: DEFAULT_VISION_MODEL, temperature: 0, max_retries: 2 },
    },
  }).registerProvider(new AnthropicProvider(key));
  return { client: new LlmClient(router), log: new InMemoryAgentLog() };
}

describe.skipIf(!KEY)('LIVE: sample W-2 PDF → vision extraction → confirm → verified kernel → gates', () => {
  it(
    'runs the full journey with the PII wall intact end to end',
    { timeout: 240_000 },
    async () => {
      const fed = loadVerifiedRuleSet(
        JSON.parse(readFileSync(root('rules/fixtures/2025.FED.1.0.json'), 'utf8')),
        JSON.parse(readFileSync(root('rules/fixtures/2025.SYSTEM.FED.json'), 'utf8')),
      );
      const il = loadVerifiedRuleSet(
        JSON.parse(readFileSync(root('rules/fixtures/2025.IL.1.0.json'), 'utf8')),
        JSON.parse(readFileSync(root('rules/fixtures/2025.SYSTEM.IL.json'), 'utf8')),
      );
      const deps = makeLiveDeps(KEY!);

      // --- vision extraction on the real API ---
      const pdfB64 = readFileSync(SAMPLE_PDF).toString('base64');
      const run = await runExtraction(
        deps,
        {
          doc_id: 'doc-live-w2',
          image_ref: 'fixture://2025.SAMPLE.w2.pdf',
          media: { kind: 'pdf', media_type: 'application/pdf', data_base64: pdfB64 },
          expected_tax_year: 2025,
        },
        TP,
      );
      expect(run.status, JSON.stringify(run)).toBe('ok');
      if (run.status !== 'ok') return;
      expect(run.output.doc_type).toBe('W-2');
      expect(run.flags.wrong_year).toBe(false);

      // Field accuracy on the dummy numbers printed in the fixture.
      const byName = new Map(run.output.fields.map((f) => [f.name, f]));
      expect(Money.fromString(byName.get('box1_wages')!.normalized.value).eq(Money.fromString('52000'))).toBe(true);
      expect(Money.fromString(byName.get('box2_fed_withholding')!.normalized.value).eq(Money.fromString('5200'))).toBe(true);
      expect(Money.fromString(byName.get('box17_il_withholding')!.normalized.value).eq(Money.fromString('2600'))).toBe(true);

      // PII guarantees against a REAL model response: EIN tokenized, no raw
      // identifiers in output, proposals, or the private call log.
      if (run.output.payer.ein_token !== null) {
        expect(run.output.payer.ein_token).toMatch(/^tok_ein_[a-z0-9]+$/);
      }
      const serialized = JSON.stringify(run.output) + JSON.stringify(run.proposals) + JSON.stringify((deps.log as InMemoryAgentLog).entries);
      expect(serialized).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
      expect(serialized).not.toMatch(/\b\d{2}-\d{7}\b/);

      // --- the wall: confirm is the only door into the spine ---
      const spine = new InMemorySpine(clock, 'live-eval');
      const bus = new EventBus();
      await spine.registerSource({
        source_id: 'doc-live-w2',
        taxpayer_id: TP,
        type: 'W-2',
        tax_year: 2025,
        fields: Object.fromEntries(run.output.fields.map((f) => [f.name, f.normalized.value])),
        ocr_confidence: Math.min(...run.output.fields.map((f) => f.confidence)),
        raw_ref: 'fixture://2025.SAMPLE.w2.pdf',
      });
      await spine.confirmSource('doc-live-w2');
      // Transcript source matching the documented amounts keeps gate inputs complete.
      await spine.registerSource({
        source_id: 's-transcript',
        taxpayer_id: TP,
        type: 'IRS_WI_TRANSCRIPT',
        tax_year: 2025,
        fields: {
          records: JSON.stringify([{ form: 'W-2', payer: run.output.payer.name, concept: C.WAGES, amount: '52000' }]),
        },
        ocr_confidence: 1,
        raw_ref: 'blob://s-transcript',
      });
      await spine.confirmSource('s-transcript');

      const store = new ReviewPendingStore(spine, bus);
      const proposals = store.submit(run.proposals);
      expect(await spine.getFacts({ taxpayer_id: TP, tax_year: 2025 })).toEqual([]); // nothing before confirm
      for (const p of proposals) {
        if (p.value !== null) await store.confirm(p.proposal_id);
        else await store.confirm(p.proposal_id, p.suggestion ?? '');
      }

      // --- kernel on verified 2025 rule-data + gates ---
      const filing: FilingContext = {
        taxpayer_id: TP,
        tax_year: 2025,
        filing_status: 'single',
        il_exemption_count: 1,
        addl_std_boxes: 0,
        rule_versions: { FED: fed.rule_version, IL: il.rule_version },
      };
      const registry = new CriticRegistry();
      for (const critic of [...createStep1Critics(), ...createF7RemainingCritics()]) registry.register(critic);
      const orchestrator = new Orchestrator(spine, registry, bus, filing, { fed, il }, clock);
      const runs = await orchestrator.runAll();
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((r) => r.result !== 'fail'), JSON.stringify(runs.filter((r) => r.result === 'fail'))).toBe(true);
      expect(bus.history().at(-1)?.kind).toBe('PackageReady');

      const derived = async (concept: string) =>
        (await spine.getFacts({ taxpayer_id: TP, tax_year: 2025, concepts: [concept] })).find(
          (f) => f.derivation !== undefined,
        )!.value;
      // Verified 2025 figures: std deduction (single) 15750 → taxable 36250.
      expect((await derived(C.FED_TAXABLE)).eq(Money.fromString('36250'))).toBe(true);
      expect((await derived(C.FED_TAX)).gt(Money.fromString('0'))).toBe(true);
      expect((await derived(C.IL_TAX)).gt(Money.fromString('0'))).toBe(true);
    },
  );
});
