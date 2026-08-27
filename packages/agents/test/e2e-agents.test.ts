/**
 * Extended end-to-end (Session-2 acceptance): fixture W-2 image-stub →
 * extraction → review-pending → confirm → kernel → gates → findings →
 * explanation with valid citations → audit summary 1:1. All agent traffic
 * through the stub provider; zero TaxFact writes without confirm.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { C, EventBus, type Clock, type FilingContext, type Finding, type GateRun } from '@taxfs/shared';
import { InMemorySpine } from '@taxfs/spine';
import {
  CriticRegistry,
  Orchestrator,
  createF7RemainingCritics,
  createStep1Critics,
} from '@taxfs/gates';
import {
  ReviewPendingStore,
  runDiscovery,
  runExplanation,
  runExtraction,
} from '@taxfs/agents';
import { loadFedRules, loadIlRules } from '../../kernel/test/helpers.js';
import { loadAuthority, makeRig, userContent, type AgentRig } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const authority = loadAuthority();
const clock: Clock = { nowIso: () => '2026-07-02T00:00:00.000Z' };
const TP = 'tp-agents-e2e';

const W2_JSON = JSON.stringify({
  doc_type: 'W-2',
  tax_year: 2025,
  payer: { name: 'Acme Corp', ein_token: 'tok_ein_acme1' },
  fields: [
    { name: 'box1_wages', raw_text: '60,000.00', normalized: { kind: 'decimal', value: '60000' }, region: { page: 1, x: 10, y: 20, w: 30, h: 5 }, confidence: 0.98 },
    { name: 'box2_fed_withholding', raw_text: '6,000.00', normalized: { kind: 'decimal', value: '6000' }, region: { page: 1, x: 10, y: 30, w: 30, h: 5 }, confidence: 0.97 },
    { name: 'box5_medicare_wages', raw_text: '60,000.00', normalized: { kind: 'decimal', value: '60000' }, region: { page: 1, x: 10, y: 40, w: 30, h: 5 }, confidence: 0.96 },
    { name: 'box17_il_withholding', raw_text: '3,000.00', normalized: { kind: 'decimal', value: '3000' }, region: { page: 1, x: 10, y: 50, w: 30, h: 5 }, confidence: 0.95 },
  ],
});

const INT_JSON = JSON.stringify({
  doc_type: '1099-INT',
  tax_year: 2025,
  payer: { name: 'First Bank', ein_token: 'tok_ein_bank1' },
  fields: [
    { name: 'box1_interest', raw_text: '1,000.00', normalized: { kind: 'decimal', value: '1000' }, region: { page: 1, x: 5, y: 12, w: 20, h: 4 }, confidence: 0.95 },
  ],
});

let spine: InMemorySpine;
let bus: EventBus;
let orchestrator: Orchestrator;
let store: ReviewPendingStore;
let rig: AgentRig;

beforeEach(async () => {
  spine = new InMemorySpine(clock, 'agents-e2e');
  bus = new EventBus();
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
  orchestrator = new Orchestrator(spine, registry, bus, filing, { fed, il }, clock);
  store = new ReviewPendingStore(spine, bus);

  // Deterministic intake: documents exist as Sources before any agent runs.
  await spine.registerSource({
    source_id: 's-w2', taxpayer_id: TP, type: 'W-2', tax_year: 2025,
    fields: { box1_wages: '60000', box2_fed_withholding: '6000', box17_il_withholding: '3000' },
    ocr_confidence: 0.98, raw_ref: 'blob://s-w2',
  });
  await spine.registerSource({
    source_id: 's-int', taxpayer_id: TP, type: '1099-INT', tax_year: 2025,
    fields: { box1_interest: '1000' }, ocr_confidence: 0.97, raw_ref: 'blob://s-int',
  });
  await spine.registerSource({
    source_id: 's-transcript', taxpayer_id: TP, type: 'IRS_WI_TRANSCRIPT', tax_year: 2025,
    fields: {
      records: JSON.stringify([
        { form: 'W-2', payer: 'Acme Corp', concept: C.WAGES, amount: '60000' },
        { form: '1099-INT', payer: 'First Bank', concept: C.INTEREST, amount: '1000' },
      ]),
    },
    ocr_confidence: 1, raw_ref: 'blob://s-transcript',
  });
  for (const id of ['s-w2', 's-int', 's-transcript']) await spine.confirmSource(id);

  rig = makeRig({
    extraction: (req) => (userContent(req).includes('document s-w2') ? W2_JSON : INT_JSON),
    explanation: (req) => {
      const input = JSON.parse(userContent(req)) as { subject_ref: string };
      return JSON.stringify({
        subject_ref: input.subject_ref,
        explanation_text:
          'Your federal refund is the difference between what was paid in during the year (this came from Box 2 of your W-2, plus nothing else) and the tax computed on your income.',
        cited_rule_ids: ['IRC-31-PLACEHOLDER'],
        reading_level: 'plain',
      });
    },
    discovery: (req) => {
      const input = JSON.parse(userContent(req)) as { signals: { id: string; about_concepts: string[]; detail: string }[] };
      return JSON.stringify({
        questions: input.signals.map((sig) => ({
          id: sig.id,
          text: `Heads up: ${sig.detail} — is there a document or answer to add?`,
          about_concepts: sig.about_concepts,
        })),
      });
    },
  });
});

async function extractAndConfirmAll(): Promise<void> {
  for (const doc of [
    { doc_id: 's-w2', image_ref: 'blob://s-w2', ocr_text: 'document image stub W-2', expected_tax_year: 2025 },
    { doc_id: 's-int', image_ref: 'blob://s-int', ocr_text: 'document image stub 1099-INT', expected_tax_year: 2025 },
  ]) {
    const run = await runExtraction(rig.deps, { ...doc, ocr_text: `document ${doc.doc_id} stub` }, TP);
    if (run.status !== 'ok') throw new Error(`extraction failed for ${doc.doc_id}`);
    const proposals = store.submit(run.proposals);
    for (const p of proposals) await store.confirm(p.proposal_id); // critical fields → individual confirm
  }
}

describe('extended e2e: extraction → confirm → kernel → gates → explanation → audit summary', () => {
  it('runs the whole trace with zero unconfirmed TaxFact writes', async () => {
    // Before any confirm: agents ran, spine untouched.
    const w2Run = await runExtraction(
      rig.deps,
      { doc_id: 's-w2', image_ref: 'blob://s-w2', ocr_text: 'document s-w2 stub', expected_tax_year: 2025 },
      TP,
    );
    expect(w2Run.status).toBe('ok');
    expect(await spine.getFacts({ taxpayer_id: TP, tax_year: 2025 })).toEqual([]);
    expect((await spine.inspect()).auditLog.filter((e) => e.entity_type === 'tax_fact')).toEqual([]);

    await extractAndConfirmAll();
    const sourced = await spine.getFacts({ taxpayer_id: TP, tax_year: 2025 });
    expect(sourced).toHaveLength(5); // wages, fed wh, il wh, medicare wages (P10), interest
    expect(sourced.every((f) => f.status === 'confirmed')).toBe(true);

    // Deterministic pipeline over confirmed facts.
    const runs = await orchestrator.runAll();
    expect(runs).toHaveLength(14);
    for (const run of runs) {
      if (run.gate === 5) {
        expect(run.result).toBe('warn');
      } else {
        expect(run.result, `gate ${run.gate} ${run.jurisdiction}`).toBe('pass');
      }
    }
    expect(bus.history()[bus.history().length - 1]?.kind).toBe('PackageReady');

    const factValue = async (concept: string): Promise<string> => {
      const f = (await spine.getFacts({ taxpayer_id: TP, tax_year: 2025, concepts: [concept] })).find(
        (x) => x.derivation !== undefined,
      );
      return f?.value.toString() ?? '<missing>';
    };
    expect(await factValue(C.FED_TAXABLE)).toBe('46000');
    expect(await factValue(C.FED_TAX)).toBe('5920');
    expect(await factValue(C.FED_REFUND_OR_DUE)).toBe('80');
    expect(await factValue(C.IL_TAX)).toBe('2882');
    expect(await factValue(C.IL_REFUND_OR_DUE)).toBe('118');

    // Explanation over the refund's real lineage, citations machine-checked.
    const refund = (await spine.getFacts({ taxpayer_id: TP, tax_year: 2025, concepts: [C.FED_REFUND_OR_DUE] })).find(
      (f) => f.derivation !== undefined,
    )!;
    const lineage = await spine.getLineage(refund.fact_id);
    const contextLines: string[] = [];
    const formulaRefs: string[] = [];
    const walk = (node: typeof lineage): void => {
      contextLines.push(
        `${node.fact.concept} = ${node.fact.value.toString()} ← ${node.calculation?.formula_ref ?? 'source'}`,
      );
      if (node.calculation) formulaRefs.push(node.calculation.formula_ref);
      for (const input of node.inputs ?? []) walk(input);
    };
    walk(lineage);
    const explanation = await runExplanation(rig.deps, authority, {
      subject_ref: refund.fact_id,
      context_lines: contextLines,
      candidate_rules: authority.candidatesFor(formulaRefs).map((r) => ({ rule_id: r.rule_id, citation: r.citation })),
    });
    expect(explanation.status).toBe('ok');
    if (explanation.status === 'ok') {
      for (const id of explanation.result.explanation.cited_rule_ids) {
        expect(authority.has(id)).toBe(true); // citation validity: 100%
      }
      expect(explanation.result.verbatim.length).toBeGreaterThan(0);
    }

    // Gate 5 still produces its profile deterministically (the audit-summary
    // agent is DROPPED per §6 — a template renders findings 1:1); Discovery
    // is the roster's question-only replacement, exercised over the same
    // scenario: with every document present it stays quiet.
    const gate5Findings: Finding[] = runs
      .filter((r: GateRun) => r.gate === 5)
      .flatMap((r) => r.findings);
    expect(gate5Findings.length).toBeGreaterThan(0);
    const discovery = await runDiscovery(rig.deps, {
      tax_year: 2025,
      sources: await spine.getSources(TP, 2025),
      facts: await spine.getFacts({ taxpayer_id: TP, tax_year: 2025 }),
      history: [],
    });
    expect(discovery.questions).toEqual([]); // nothing missing → no questions, no agent call

    // Every agent call was logged privately (input hash + verdict).
    expect(rig.log.entries.length).toBeGreaterThanOrEqual(4);
    expect(rig.log.entries.every((e) => e.validation_result === 'ok')).toBe(true);
  });
});
