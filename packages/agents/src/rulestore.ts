/**
 * Loaders for the two new rule-data content types the agents consume:
 * question templates (E.2 — suggested wording for attestation questions
 * since the personal-use pivot) and authority records (E.4 verbatim rule
 * text + machine-checked citations). Both refuse entries missing the
 * PLACEHOLDER marker, same as the parameter loader.
 */
import { PLACEHOLDER } from '@taxfs/shared';

export interface QuestionTemplate {
  template_id: string;
  determination: string | null;
  text: string;
  answer_type: 'bool' | 'choice' | 'amount' | 'date' | 'text';
  attestation: boolean;
  maps_to: string;
}

export interface AuthorityRecord {
  rule_id: string;
  citation: string;
  verbatim_text: string;
  authority_tier: 'statute' | 'regulation' | 'case_or_ruling' | 'admin_guidance';
  formula_refs: string[];
  finding_critics?: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireMarker(row: Record<string, unknown>, path: string): void {
  if (row['status'] !== PLACEHOLDER) {
    throw new Error(`${path}: missing "${PLACEHOLDER}" marker — unverified content cannot load`);
  }
}

export function loadQuestionTemplates(json: unknown): QuestionTemplate[] {
  if (!isRecord(json) || !Array.isArray(json['templates'])) {
    throw new Error('question templates: expected { templates: [...] }');
  }
  return json['templates'].map((raw, i) => {
    if (!isRecord(raw)) throw new Error(`templates[${i}]: expected object`);
    requireMarker(raw, `templates[${i}]`);
    const answerTypes = ['bool', 'choice', 'amount', 'date', 'text'] as const;
    const answerType = answerTypes.find((a) => a === raw['answer_type']);
    if (!answerType) throw new Error(`templates[${i}]: invalid answer_type`);
    return {
      template_id: String(raw['template_id']),
      determination: raw['determination'] === null ? null : String(raw['determination']),
      text: String(raw['text']),
      answer_type: answerType,
      attestation: raw['attestation'] === true,
      maps_to: String(raw['maps_to']),
    };
  });
}

export class AuthorityStore {
  private readonly byId = new Map<string, AuthorityRecord>();

  constructor(records: AuthorityRecord[]) {
    for (const r of records) this.byId.set(r.rule_id, r);
  }

  has(rule_id: string): boolean {
    return this.byId.has(rule_id);
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  /** Records whose formula_refs / finding_critics touch the given refs. */
  candidatesFor(refs: string[]): AuthorityRecord[] {
    return [...this.byId.values()].filter(
      (r) =>
        r.formula_refs.some((f) => refs.includes(f)) ||
        (r.finding_critics ?? []).some((c) => refs.includes(c)),
    );
  }

  /** Verbatim rule-store text + citation, shown alongside every AI paraphrase (E.4 / OPR 2026-19). */
  verbatim(rule_ids: string[]): { rule_id: string; citation: string; verbatim_text: string }[] {
    return rule_ids.map((id) => {
      const r = this.byId.get(id);
      if (!r) throw new Error(`authority store: unknown rule_id ${id}`);
      return { rule_id: r.rule_id, citation: r.citation, verbatim_text: r.verbatim_text };
    });
  }
}

export function loadAuthorityStore(json: unknown): AuthorityStore {
  if (!isRecord(json) || !Array.isArray(json['records'])) {
    throw new Error('authority records: expected { records: [...] }');
  }
  const records = json['records'].map((raw, i) => {
    if (!isRecord(raw)) throw new Error(`records[${i}]: expected object`);
    requireMarker(raw, `records[${i}]`);
    const tiers = ['statute', 'regulation', 'case_or_ruling', 'admin_guidance'] as const;
    const tier = tiers.find((t) => t === raw['authority_tier']);
    if (!tier) throw new Error(`records[${i}]: invalid authority_tier`);
    return {
      rule_id: String(raw['rule_id']),
      citation: String(raw['citation']),
      verbatim_text: String(raw['verbatim_text']),
      authority_tier: tier,
      formula_refs: Array.isArray(raw['formula_refs']) ? raw['formula_refs'].map(String) : [],
      ...(Array.isArray(raw['finding_critics'])
        ? { finding_critics: raw['finding_critics'].map(String) }
        : {}),
    };
  });
  return new AuthorityStore(records);
}
