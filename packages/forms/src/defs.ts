/**
 * FormDefinition loader. Form definitions are VERSIONED RULE-DATA
 * (workstream-B content type "Form definitions"), never code: every form,
 * line, element name, and threshold must carry the PLACEHOLDER marker or
 * the release refuses to load — same discipline as the parameter loader.
 */
import { PLACEHOLDER, type Jurisdiction } from '@taxfs/shared';
import type { FormDefinition, LineDef, RequiredWhen, SignConvention } from './types';

export interface FormDefRelease {
  release: string;
  jurisdiction: Jurisdiction;
  tax_year: number;
  forms: FormDefinition[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireMarker(row: Record<string, unknown>, path: string): void {
  if (row['status'] !== PLACEHOLDER) {
    throw new Error(`form-def ${path}: missing "${PLACEHOLDER}" marker — unverified form content cannot load`);
  }
}

function parseRequiredWhen(raw: unknown, path: string): RequiredWhen {
  if (!isRecord(raw)) throw new Error(`form-def ${path}.required_when: expected object`);
  switch (raw['kind']) {
    case 'always':
      return { kind: 'always' };
    case 'concept_present':
      return { kind: 'concept_present', concept: String(raw['concept']) };
    case 'any_concept_present': {
      if (!Array.isArray(raw['concepts'])) throw new Error(`form-def ${path}.required_when.concepts: array required`);
      return { kind: 'any_concept_present', concepts: raw['concepts'].map((c) => String(c)) };
    }
    case 'concept_nonzero':
      return { kind: 'concept_nonzero', concept: String(raw['concept']) };
    case 'any_concept_sum_exceeds': {
      const threshold = raw['threshold'];
      if (!isRecord(threshold) || threshold['status'] !== PLACEHOLDER || typeof threshold['value'] !== 'string') {
        throw new Error(`form-def ${path}.required_when.threshold: figure with "${PLACEHOLDER}" marker required`);
      }
      if (!Array.isArray(raw['concepts'])) throw new Error(`form-def ${path}.required_when.concepts: array required`);
      return {
        kind: 'any_concept_sum_exceeds',
        concepts: raw['concepts'].map(String),
        threshold: threshold['value'],
      };
    }
    default:
      throw new Error(`form-def ${path}.required_when: unknown kind "${String(raw['kind'])}"`);
  }
}

const SIGN_CONVENTIONS: SignConvention[] = ['as_is', 'positive_only', 'abs_of_negative'];

function parseLine(raw: unknown, path: string, jurisdiction: Jurisdiction): LineDef {
  if (!isRecord(raw)) throw new Error(`form-def ${path}: expected object`);
  requireMarker(raw, path);
  const sign = SIGN_CONVENTIONS.find((s) => s === raw['sign_convention']);
  if (!sign) throw new Error(`form-def ${path}: invalid sign_convention`);
  if (raw['datatype'] !== 'money') throw new Error(`form-def ${path}: step-1 supports datatype "money" only`);
  const elementKey = jurisdiction === 'FED' ? 'mef_element' : 'il_field';
  if (typeof raw[elementKey] !== 'string' || raw[elementKey] === '') {
    throw new Error(`form-def ${path}: ${elementKey} required for ${jurisdiction} lines`);
  }
  const line: LineDef = {
    line_id: String(raw['line_id']),
    label: String(raw['label']),
    datatype: 'money',
    from_concept: String(raw['from_concept']),
    sign_convention: sign,
    ...(jurisdiction === 'FED'
      ? { mef_element: String(raw['mef_element']) }
      : { il_field: String(raw['il_field']) }),
    ...(raw['omit_when_zero'] === true ? { omit_when_zero: true } : {}),
    ...(raw['optional'] === true ? { optional: true } : {}),
  };
  if (raw['must_equal'] !== undefined) {
    const me = raw['must_equal'];
    if (!isRecord(me) || typeof me['form_id'] !== 'string' || typeof me['line_id'] !== 'string') {
      throw new Error(`form-def ${path}.must_equal: { form_id, line_id } required`);
    }
    line.must_equal = { form_id: me['form_id'], line_id: me['line_id'] };
  }
  return line;
}

export function loadFormDefRelease(json: unknown): FormDefRelease {
  if (!isRecord(json)) throw new Error('form-def release: expected object');
  const jRaw = json['jurisdiction'];
  const jurisdiction: Jurisdiction = jRaw === 'FED' ? 'FED' : jRaw === 'IL' ? 'IL' : (() => {
    throw new Error('form-def release: jurisdiction must be FED or IL');
  })();
  if (typeof json['release'] !== 'string' || typeof json['tax_year'] !== 'number') {
    throw new Error('form-def release: release (string) and tax_year (number) required');
  }
  if (!Array.isArray(json['forms']) || json['forms'].length === 0) {
    throw new Error('form-def release: non-empty forms[] required');
  }
  const forms = json['forms'].map((raw, fi) => {
    if (!isRecord(raw)) throw new Error(`form-def forms[${fi}]: expected object`);
    requireMarker(raw, `forms[${fi}]`);
    if (!Array.isArray(raw['lines']) || raw['lines'].length === 0) {
      throw new Error(`form-def forms[${fi}]: non-empty lines[] required`);
    }
    const form_id = String(raw['form_id']);
    const lines = raw['lines'].map((l, li) => parseLine(l, `forms[${fi}].lines[${li}]`, jurisdiction));
    const seen = new Set<string>();
    for (const l of lines) {
      if (seen.has(l.line_id)) throw new Error(`form-def ${form_id}: duplicate line_id ${l.line_id}`);
      seen.add(l.line_id);
    }
    return {
      form_id,
      jurisdiction,
      tax_year: json['tax_year'] as number,
      revision: String(raw['revision']),
      source_schema_ref: String(raw['source_schema_ref']),
      pdf_template_ref: String(raw['pdf_template_ref']),
      required_when: parseRequiredWhen(raw['required_when'], `forms[${fi}]`),
      attachment_order: Number(raw['attachment_order']),
      lines,
    } satisfies FormDefinition;
  });
  // Cross-form must_equal targets must resolve within the step-1 form universe
  // (cross-jurisdiction targets like IL-1040 line 1 → 1040 line 11 are checked
  // at mapping time across both releases).
  return { release: json['release'], jurisdiction, tax_year: json['tax_year'], forms };
}
