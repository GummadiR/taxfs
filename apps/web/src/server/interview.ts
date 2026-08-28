/**
 * The gap interview (TaxOS E.2/P37, ported): the deterministic gap report
 * decides WHAT is needed; the interview agent only phrases and orders it —
 * never free-styling tax advice (N5). Answers land as attested USER_ENTRY
 * sources with one stable source per question concept (the P37 fix: a
 * session-counter id reset across restarts while the database remembered
 * the old row forever; keying by concept makes re-answering an amend).
 */
import { Money } from '@taxfs/shared';
import { buildGapReport, runInterview } from '@taxfs/agents';
import { withSpine, withUserClient } from './db';
import { filingContext } from './filing';
import { makeAgentDeps } from './agent-deps';
import { releases } from './rules';
import { TAX_YEAR } from './env';

export interface InterviewQuestionDto {
  question_id: string;
  text: string;
  answer_type: string;
  maps_to_concept: string;
  why_asked: string;
  why_detail: string;
  attestation: boolean;
}

export async function getInterview(
  userId: string,
  ws: string,
): Promise<{ questions: InterviewQuestionDto[]; gaps_open: number; needs_setup: boolean }> {
  const filing = await withUserClient(userId, (client) => filingContext(client, ws));
  if (!filing) return { questions: [], gaps_open: 0, needs_setup: true };
  const templates = releases().questionTemplates;
  const { facts, sources } = await withSpine({ userId, workspaceId: ws }, async (spine) => ({
    facts: await spine.getFacts({ taxpayer_id: ws, tax_year: TAX_YEAR }),
    sources: await spine.getSources(ws, TAX_YEAR),
  }));
  const gaps = buildGapReport({ facts, sources, filing, templates });
  if (gaps.length === 0) return { questions: [], gaps_open: 0, needs_setup: false };
  const confirmed = facts.filter((f) => f.derivation === undefined && f.status === 'confirmed').map((f) => f.concept);
  const run = await runInterview(makeAgentDeps(), { gaps, templates, confirmed_concepts: confirmed });
  if (run.status !== 'ok') return { questions: [], gaps_open: gaps.length, needs_setup: false };
  const byId = new Map(gaps.map((g) => [g.gap_id, g]));
  return {
    needs_setup: false,
    gaps_open: gaps.length,
    questions: run.output.questions.map((q) => ({
      question_id: q.question_id,
      text: q.text,
      answer_type: q.answer_type,
      maps_to_concept: q.maps_to_concept,
      why_asked: q.why_asked,
      why_detail: byId.get(q.why_asked)?.detail ?? q.why_asked,
      attestation: q.attestation,
    })),
  };
}

/** Record a yes/no attestation answer as its stable wizard source + fact. */
export async function recordAttestation(userId: string, ws: string, concept: string, answer: 'yes' | 'no'): Promise<void> {
  await withSpine({ userId, workspaceId: ws }, async (spine) => {
    const sources = await spine.getSources(ws, TAX_YEAR);
    const prior = sources.find((x) => x.raw_ref === `wizard://${concept}`);
    const sourceId = prior?.source_id ?? `wizard-${concept}`;
    if (!prior) {
      await spine.registerSource({
        source_id: sourceId,
        taxpayer_id: ws,
        type: 'USER_ENTRY',
        tax_year: TAX_YEAR,
        fields: { attestation: answer },
        ocr_confidence: 1,
        raw_ref: `wizard://${concept}`,
      });
      await spine.confirmSource(sourceId);
    } else {
      await spine.amendSourceField(sourceId, 'attestation', answer);
    }
    await spine.putSourceFact({
      fact_id: `f:${sourceId}:${concept}`,
      taxpayer_id: ws,
      concept,
      tax_year: TAX_YEAR,
      jurisdiction: ['IL'],
      taxpayer_scope: 'primary',
      value: Money.fromString(answer === 'yes' ? '1' : '0'),
      confidence: 1,
      provenance: [{ source_id: sourceId, source_field: 'attestation' }],
      confirmed: true,
    });
  });
}
