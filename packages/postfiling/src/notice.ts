/**
 * I.3 — Notice response (CP2000 focus).
 * Upload → E.1-variant extraction (stub provider; no live LLM) → items
 * matched to TaxFacts → agree path (recompute delta + §10.21-posture
 * non-skippable alert) or disagree path (indexed claim→exhibit packet
 * assembled from Defense File sections; records + citations, never
 * argument). NOTHING is auto-sent — the user files/mails everything.
 */
import {
  Money,
  runAgent,
  type AgentDefinition,
  type AgentRunDeps,
  type SemanticIssue,
  type TaxFact,
} from '@taxfs/shared';
import { compute, type KernelInput } from '@taxfs/kernel';
import type { DefenseFile } from '@taxfs/defense';
import { C } from '@taxfs/shared';
import type { NoticeItem, NoticeType } from './cases';
import { checkNeutralLanguage, type PostFilingRules } from './rules';

export const NOTICE_AGENT_ID = 'notice_extraction';

export interface NoticeStub {
  notice_id: string;
  ocr_text: string;
}

export interface ExtractedNotice {
  notice_type: NoticeType;
  notice_date: string;
  response_deadline: string;
  items: { form: string; payer: string; concept: string; amount: string; claim_kind: string }[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const noticeExtractionAgent: AgentDefinition<NoticeStub, ExtractedNotice> = {
  id: NOTICE_AGENT_ID,
  buildMessages: (input) => [
    {
      role: 'system',
      content:
        'Extract the IRS notice as JSON {notice_type, notice_date, response_deadline, items:[{form,payer,concept,amount,claim_kind}]}. Never guess a notice type; use "other" when unclear.',
    },
    { role: 'user', content: `notice ${input.notice_id}\n${input.ocr_text}` },
  ],
  validateSchema: (candidate) => {
    if (!isRecord(candidate) || !Array.isArray(candidate['items'])) {
      return { ok: false, issues: [{ message: 'expected { notice_type, dates, items[] }' }] };
    }
    const types: NoticeType[] = ['CP2000', 'math_error', 'correspondence', 'other'];
    if (!types.includes(candidate['notice_type'] as NoticeType)) {
      return { ok: false, issues: [{ message: 'notice_type outside the closed set' }] };
    }
    return { ok: true, value: candidate as unknown as ExtractedNotice };
  },
  validateSemantic: (out) => {
    const issues: SemanticIssue[] = [];
    if (!ISO_DATE.test(out.notice_date)) issues.push({ message: `notice_date "${out.notice_date}" does not parse` });
    if (!ISO_DATE.test(out.response_deadline)) issues.push({ message: `response_deadline "${out.response_deadline}" does not parse` });
    for (const item of out.items) {
      try {
        Money.fromString(item.amount);
      } catch {
        issues.push({ message: `item amount "${item.amount}" is not a decimal string` });
      }
    }
    return issues;
  },
};

export async function extractNotice(
  deps: AgentRunDeps,
  stub: NoticeStub,
): Promise<{ status: 'ok'; notice: ExtractedNotice } | { status: 'rejected'; issues: SemanticIssue[] }> {
  const run = await runAgent(noticeExtractionAgent, stub, deps);
  return run.status === 'ok'
    ? { status: 'ok', notice: run.output }
    : { status: 'rejected', issues: run.issues };
}

// ---------- matching (deterministic — the agent only extracted) ----------

export interface MatchedItem {
  claim: ExtractedNotice['items'][number];
  our_fact_refs: string[];
  /** Suggested only — the user decides; nothing responds automatically. */
  suggested_path: 'agree' | 'disagree';
  rationale: string;
}

export function matchNoticeItems(notice: ExtractedNotice, facts: TaxFact[]): MatchedItem[] {
  const confirmed = facts.filter((f) => f.derivation === undefined && f.status === 'confirmed');
  return notice.items.map((claim) => {
    const sameConcept = confirmed.filter((f) => f.concept === claim.concept);
    const exact = sameConcept.filter((f) => f.value.eq(Money.fromString(claim.amount)));
    if (sameConcept.length === 0) {
      return {
        claim,
        our_fact_refs: [],
        suggested_path: 'agree',
        rationale: 'No record of this income exists in the return — the notice appears to report an omitted document.',
      };
    }
    if (exact.length > 0) {
      return {
        claim,
        our_fact_refs: exact.map((f) => f.fact_id),
        suggested_path: 'disagree',
        rationale: 'A confirmed record matching this amount is already on the return.',
      };
    }
    return {
      claim,
      our_fact_refs: sameConcept.map((f) => f.fact_id),
      suggested_path: 'disagree',
      rationale: 'Records exist for this item with a different amount — the attached documents show the reported figure.',
    };
  });
}

// ---------- agree path: recompute delta + non-skippable alert ----------

export interface AgreeOutcome {
  original_tax: string;
  corrected_tax: string;
  delta: string;
  /** §10.21-posture, non-skippable in the UI; template is rule-data. */
  alert: string;
  dismissible: false;
}

export function agreeDelta(input: {
  kernelInput: Omit<KernelInput, 'facts'>;
  facts: TaxFact[];
  claim: ExtractedNotice['items'][number];
  rules: PostFilingRules;
}): AgreeOutcome {
  const sourced = input.facts.filter((f) => f.derivation === undefined && f.status === 'confirmed');
  const original = compute({ ...input.kernelInput, facts: sourced });
  const hypothetical: TaxFact = {
    fact_id: `hypo:${input.claim.concept}:${input.claim.amount}`,
    taxpayer_id: input.kernelInput.taxpayer_id,
    concept: input.claim.concept,
    tax_year: input.kernelInput.tax_year,
    jurisdiction: ['FED', 'IL'],
    taxpayer_scope: 'primary',
    value: Money.fromString(input.claim.amount),
    unit: 'USD',
    status: 'confirmed',
    confidence: 1,
    provenance: [{ source_id: 'notice-hypothetical', source_field: 'amount' }],
  };
  const corrected = compute({ ...input.kernelInput, facts: [...sourced, hypothetical] });
  const taxOf = (run: { computedFacts: TaxFact[] }): Money =>
    run.computedFacts.find((f) => f.concept === C.FED_TAX_AFTER_CREDITS)?.value ?? Money.zero();
  const originalTax = taxOf(original);
  const correctedTax = taxOf(corrected);
  const delta = correctedTax.sub(originalTax);
  const alert = input.rules.agree_alert_template
    .replace('{summary}', `${input.claim.form} from ${input.claim.payer} ($${input.claim.amount}) not on the filed return`)
    .replace('{delta}', delta.toString());
  return {
    original_tax: originalTax.toString(),
    corrected_tax: correctedTax.toString(),
    delta: delta.toString(),
    alert,
    dismissible: false,
  };
}

// ---------- disagree path: indexed claim→exhibit packet ----------

export interface ResponsePacket {
  packet_id: string;
  /** Claim-by-claim summary table FIRST — AUR reviewers work fast. */
  claim_table: { claim_no: number; irs_claim: string; our_records: string; exhibit_refs: string[] }[];
  exhibits: { exhibit_no: string; name: string; content: string }[];
  cover_note: string;
}

/** Defense-File sections relevant to a disputed concept. */
const DISAGREE_SECTIONS = ['returns', 'substantiation-index', 'reconciliation', 'contemporaneous'];

export function buildDisagreePacket(input: {
  case_id: string;
  items: { item: NoticeItem; matched: MatchedItem }[];
  defense: DefenseFile;
}): ResponsePacket {
  const exhibits: ResponsePacket['exhibits'] = [];
  const exhibitNoByName = new Map<string, string>();
  const addExhibit = (name: string, content: string): string => {
    const existing = exhibitNoByName.get(name);
    if (existing) return existing;
    const no = `EX-${String(exhibits.length + 1).padStart(2, '0')}`;
    exhibits.push({ exhibit_no: no, name, content });
    exhibitNoByName.set(name, no);
    return no;
  };

  const claimTable = input.items.map(({ item, matched }, i) => {
    const refs: string[] = [];
    for (const section of input.defense.sections) {
      if (!DISAGREE_SECTIONS.includes(section.section_id)) continue;
      for (const file of section.files) {
        // Include the file when it references the disputed concept/facts.
        const relevant =
          file.content.includes(item.irs_claim.concept) ||
          matched.our_fact_refs.some((ref) => file.content.includes(ref)) ||
          section.section_id === 'reconciliation';
        if (relevant) refs.push(addExhibit(`${section.section_id}/${file.name}`, file.content));
      }
    }
    return {
      claim_no: i + 1,
      irs_claim: `${item.irs_claim.form} · ${item.irs_claim.payer} · $${item.irs_claim.amount} (${item.irs_claim.claim_kind})`,
      our_records: `Confirmed records: ${matched.our_fact_refs.join(', ') || 'see exhibits'}. ${matched.rationale}`,
      exhibit_refs: [...new Set(refs)],
    };
  });

  const packet: ResponsePacket = {
    packet_id: `packet-${input.case_id}`,
    claim_table: claimTable,
    exhibits,
    cover_note:
      'Enclosed records respond to each item on the notice, indexed claim-by-claim to numbered exhibits. Prepared for the taxpayer to review and send with the response form included in the notice; nothing has been transmitted.',
  };
  const neutral = checkNeutralLanguage(JSON.stringify(packet));
  if (neutral.length > 0) {
    throw new Error(`disagree packet violates neutral-language rules: ${neutral.map((v) => v.reason).join('; ')}`);
  }
  return packet;
}

// ---------- DUT-style packaging ----------

export interface DutPart {
  part_name: string;
  files: { name: string; bytes: number }[];
  total_bytes: number;
}

/**
 * Split a packet across the IRS Document Upload Tool size limit
 * (fixture PLACEHOLDER — verify the real limit; mail remains the fallback).
 * Compression is a stub: sizes are byte lengths of the text stand-ins.
 */
export function splitForDut(
  files: { name: string; content: string }[],
  size_limit_bytes: number,
): DutPart[] {
  const parts: DutPart[] = [];
  let current: { name: string; bytes: number }[] = [];
  let currentBytes = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    parts.push({ part_name: `upload-part-${String(parts.length + 1).padStart(2, '0')}`, files: current, total_bytes: currentBytes });
    current = [];
    currentBytes = 0;
  };
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > size_limit_bytes) {
      throw new Error(`file ${file.name} alone exceeds the upload limit — use the mail fallback for this exhibit`);
    }
    if (currentBytes + bytes > size_limit_bytes) flush();
    current.push({ name: file.name, bytes });
    currentBytes += bytes;
  }
  flush();
  return parts.map((p, i) => ({ ...p, part_name: `upload-part-${String(i + 1).padStart(2, '0')}-of-${String(parts.length).padStart(2, '0')}` }));
}
