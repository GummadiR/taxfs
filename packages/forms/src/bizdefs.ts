/**
 * P13 — Business-return form definitions (1120-S / 1065 / outbound K-1s /
 * IL-1120-ST / IL-1065 / Schedule K-1-P).
 *
 * The release is versioned RULE-DATA like every other form definition
 * (PLACEHOLDER-marker discipline), but business forms are TEMPLATES over an
 * entity: line concepts carry `{eid}` / `{mid}` tokens and are instantiated
 * into concrete FormDefinitions per entity — and per member for `per_member`
 * forms (each owner gets their own K-1 / K-1-P copy). Code substitutes ids
 * only; every line, label, and element name stays in the fixture.
 */
import { PLACEHOLDER, type Jurisdiction } from '@taxfs/shared';
import type { FormDefinition, LineDef, SignConvention } from './types';

export type EntityFormType = 'scorp' | 'partnership' | 'both';

export interface BizFormDef {
  form_id: string;
  jurisdiction: Jurisdiction;
  /** Which entity kind this form belongs to ('both' = K-1-P style shared). */
  entity_type: EntityFormType;
  /** One instance per member (K-1 copies) vs one per entity. */
  per_member: boolean;
  revision: string;
  source_schema_ref: string;
  pdf_template_ref: string;
  attachment_order: number;
  lines: LineDef[]; // from_concept still carries {eid}/{mid} tokens
}

export interface BizFormRelease {
  release: string;
  tax_year: number;
  forms: BizFormDef[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireMarker(row: Record<string, unknown>, path: string): void {
  if (row['status'] !== PLACEHOLDER) {
    throw new Error(`biz form-def ${path}: missing "${PLACEHOLDER}" marker — unverified form content cannot load`);
  }
}

const SIGN_CONVENTIONS: SignConvention[] = ['as_is', 'positive_only', 'abs_of_negative'];

export function loadBizFormRelease(json: unknown): BizFormRelease {
  if (!isRecord(json)) throw new Error('biz form-def release: expected object');
  requireMarker(json, 'release');
  if (typeof json['release'] !== 'string' || typeof json['tax_year'] !== 'number') {
    throw new Error('biz form-def release: release (string) and tax_year (number) required');
  }
  if (!Array.isArray(json['forms']) || json['forms'].length === 0) {
    throw new Error('biz form-def release: non-empty forms[] required');
  }
  const forms = json['forms'].map((raw, fi) => {
    if (!isRecord(raw)) throw new Error(`biz form-def forms[${fi}]: expected object`);
    requireMarker(raw, `forms[${fi}]`);
    const jurisdiction: Jurisdiction = raw['jurisdiction'] === 'FED' ? 'FED' : raw['jurisdiction'] === 'IL' ? 'IL' : (() => {
      throw new Error(`biz form-def forms[${fi}]: jurisdiction must be FED or IL`);
    })();
    const entityType = raw['entity_type'];
    if (entityType !== 'scorp' && entityType !== 'partnership' && entityType !== 'both') {
      throw new Error(`biz form-def forms[${fi}]: entity_type must be scorp | partnership | both`);
    }
    if (!Array.isArray(raw['lines']) || raw['lines'].length === 0) {
      throw new Error(`biz form-def forms[${fi}]: non-empty lines[] required`);
    }
    const form_id = String(raw['form_id']);
    const lines = raw['lines'].map((l, li) => {
      const path = `forms[${fi}].lines[${li}]`;
      if (!isRecord(l)) throw new Error(`biz form-def ${path}: expected object`);
      requireMarker(l, path);
      const sign = SIGN_CONVENTIONS.find((s) => s === l['sign_convention']);
      if (!sign) throw new Error(`biz form-def ${path}: invalid sign_convention`);
      if (l['datatype'] !== 'money') throw new Error(`biz form-def ${path}: datatype "money" only`);
      const elementKey = jurisdiction === 'FED' ? 'mef_element' : 'il_field';
      if (typeof l[elementKey] !== 'string' || l[elementKey] === '') {
        throw new Error(`biz form-def ${path}: ${elementKey} required for ${jurisdiction} lines`);
      }
      const line: LineDef = {
        line_id: String(l['line_id']),
        label: String(l['label']),
        datatype: 'money',
        from_concept: String(l['from_concept']),
        sign_convention: sign,
        ...(jurisdiction === 'FED'
          ? { mef_element: String(l['mef_element']) }
          : { il_field: String(l['il_field']) }),
        ...(l['omit_when_zero'] === true ? { omit_when_zero: true } : {}),
        ...(l['optional'] === true ? { optional: true } : {}),
      };
      if (l['must_equal'] !== undefined) {
        const me = l['must_equal'];
        if (!isRecord(me) || typeof me['form_id'] !== 'string' || typeof me['line_id'] !== 'string') {
          throw new Error(`biz form-def ${path}.must_equal: { form_id, line_id } required`);
        }
        line.must_equal = { form_id: me['form_id'], line_id: me['line_id'] };
      }
      return line;
    });
    const seen = new Set<string>();
    for (const l of lines) {
      if (seen.has(l.line_id)) throw new Error(`biz form-def ${form_id}: duplicate line_id ${l.line_id}`);
      seen.add(l.line_id);
    }
    return {
      form_id,
      jurisdiction,
      entity_type: entityType,
      per_member: raw['per_member'] === true,
      revision: String(raw['revision']),
      source_schema_ref: String(raw['source_schema_ref']),
      pdf_template_ref: String(raw['pdf_template_ref']),
      attachment_order: Number(raw['attachment_order']),
      lines,
    } satisfies BizFormDef;
  });
  return { release: json['release'], tax_year: json['tax_year'], forms };
}

/** Substitute {eid}/{mid} tokens in a concept or a must_equal target id. */
function sub(text: string, eid: string, mid?: string): string {
  const withEid = text.split('{eid}').join(eid);
  return mid === undefined ? withEid : withEid.split('{mid}').join(mid);
}

/**
 * Instantiate the release for ONE entity: concrete FormDefinitions bound to
 * `entity.<eid>.*` / `k1.<eid>-<mid>.*` concepts. Per-member forms become one
 * definition per member with form_id `<form_id>:<mid>` (each owner's K-1 is
 * its own artifact). All lines are required_when: always — the entity's form
 * set is fixed by its type; absent optional lines simply don't print.
 */
export function instantiateEntityForms(
  release: BizFormRelease,
  entity: { eid: string; memberIds: readonly string[]; scorp: boolean },
): FormDefinition[] {
  const { eid, memberIds, scorp } = entity;
  const wanted = scorp ? 'scorp' : 'partnership';
  const out: FormDefinition[] = [];
  for (const def of release.forms) {
    if (def.entity_type !== 'both' && def.entity_type !== wanted) continue;
    const instantiate = (mid?: string): FormDefinition => ({
      form_id: mid === undefined ? def.form_id : `${def.form_id}:${mid}`,
      jurisdiction: def.jurisdiction,
      tax_year: release.tax_year,
      revision: def.revision,
      source_schema_ref: def.source_schema_ref,
      pdf_template_ref: def.pdf_template_ref,
      required_when: { kind: 'always' },
      attachment_order: def.attachment_order,
      lines: def.lines.map((l) => ({
        ...l,
        from_concept: sub(l.from_concept, eid, mid),
        ...(l.must_equal
          ? { must_equal: { form_id: sub(l.must_equal.form_id, eid, mid), line_id: sub(l.must_equal.line_id, eid, mid) } }
          : {}),
      })),
    });
    if (def.per_member) {
      for (const mid of memberIds) out.push(instantiate(mid));
    } else {
      out.push(instantiate());
    }
  }
  return out.sort((a, b) => a.attachment_order - b.attachment_order || a.form_id.localeCompare(b.form_id));
}
