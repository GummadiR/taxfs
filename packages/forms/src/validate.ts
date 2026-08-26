/**
 * D.4 — Gate-6 validation mechanics.
 * 1. Schema validation — hard fail. Real MeF/IL XSDs are procurement
 *    artifacts; until they land, a STUB schema (fixture, PLACEHOLDER)
 *    enforces the same class of checks (required elements, integer money
 *    pattern, no unknown elements) behind the same interface, so real XSD
 *    validation drops in as a new SchemaValidator implementation.
 * 2. Business-rule validation from rule-data fixtures.
 * 3. Round-trip check (xml.ts).
 * 4. Package completeness per channel.
 * Representation stays "passes published schema + business-rule
 * validation" — never "guaranteed acceptance" (S3).
 */
import { PLACEHOLDER, type Jurisdiction } from '@taxfs/shared';
import { childNamed, parseXml } from './xml';
import type { FormDefinition, FormInstance, PackageArtifact, PackageTarget, SchemaViolation } from './types';

export interface SchemaValidator {
  validate(xml: string, defs: FormDefinition[]): SchemaViolation[];
}

// ---------- stub XSD (fixture-driven stand-in) ----------

export interface StubXsdConfig {
  schema_ref: string;
  money_pattern: string;
  required_elements: Record<string, string[]>; // form_id → element names
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function loadStubXsd(json: unknown): StubXsdConfig {
  if (!isRecord(json) || typeof json['schema_ref'] !== 'string' || !isRecord(json['required_elements'])) {
    throw new Error('stub xsd: expected { schema_ref, money_pattern, required_elements }');
  }
  if (json['status'] !== PLACEHOLDER) throw new Error(`stub xsd: missing "${PLACEHOLDER}" marker`);
  const required: Record<string, string[]> = {};
  for (const [formId, els] of Object.entries(json['required_elements'])) {
    if (!Array.isArray(els)) throw new Error(`stub xsd required_elements.${formId}: array required`);
    required[formId] = els.map(String);
  }
  return {
    schema_ref: json['schema_ref'],
    money_pattern: String(json['money_pattern']),
    required_elements: required,
  };
}

export class StubSchemaValidator implements SchemaValidator {
  constructor(private readonly config: StubXsdConfig) {}

  validate(xml: string, defs: FormDefinition[]): SchemaViolation[] {
    const violations: SchemaViolation[] = [];
    const moneyRe = new RegExp(this.config.money_pattern);
    let root;
    try {
      root = parseXml(xml);
    } catch (e) {
      return [{ form_id: '<document>', element: '<root>', message: `unparseable XML: ${String(e)}` }];
    }
    const data = childNamed(root, 'ReturnData');
    if (!data) return [{ form_id: '<document>', element: 'ReturnData', message: 'missing ReturnData' }];
    const defById = new Map(defs.map((d) => [d.form_id, d]));

    for (const formNode of data.children) {
      const formId = formNode.name.replace(/^Form/, '');
      const def = defById.get(formId);
      if (!def) {
        violations.push({ form_id: formId, element: formNode.name, message: 'unknown form element' });
        continue;
      }
      const allowed = new Set(
        def.lines.map((l) => (def.jurisdiction === 'FED' ? l.mef_element : l.il_field) ?? ''),
      );
      allowed.add('FormRevision');
      for (const child of formNode.children) {
        if (!allowed.has(child.name)) {
          violations.push({ form_id: formId, element: child.name, message: 'element not in schema' });
        } else if (child.name !== 'FormRevision' && !moneyRe.test(child.text)) {
          violations.push({
            form_id: formId,
            element: child.name,
            message: `value "${child.text}" violates money pattern ${this.config.money_pattern}`,
          });
        }
      }
      for (const requiredEl of this.config.required_elements[formId] ?? []) {
        if (!childNamed(formNode, requiredEl)) {
          violations.push({ form_id: formId, element: requiredEl, message: 'required element missing' });
        }
      }
    }
    return violations;
  }
}

// ---------- business rules (rule-data) ----------

export interface BusinessRule {
  rule_id: string;
  jurisdiction: Jurisdiction;
  kind: 'lines_not_both_present';
  form_id: string;
  a: string;
  b: string;
  message: string;
}

export function loadBusinessRules(json: unknown): BusinessRule[] {
  if (!isRecord(json) || !Array.isArray(json['rules'])) throw new Error('business rules: expected { rules: [...] }');
  return json['rules'].map((raw, i) => {
    if (!isRecord(raw)) throw new Error(`business rules[${i}]: expected object`);
    if (raw['status'] !== PLACEHOLDER) throw new Error(`business rules[${i}]: missing "${PLACEHOLDER}" marker`);
    if (raw['kind'] !== 'lines_not_both_present') throw new Error(`business rules[${i}]: unknown kind`);
    const jur = raw['jurisdiction'];
    if (jur !== 'FED' && jur !== 'IL') throw new Error(`business rules[${i}]: bad jurisdiction`);
    return {
      rule_id: String(raw['rule_id']),
      jurisdiction: jur,
      kind: 'lines_not_both_present',
      form_id: String(raw['form_id']),
      a: String(raw['a']),
      b: String(raw['b']),
      message: String(raw['message']),
    };
  });
}

export function runBusinessRules(
  rules: BusinessRule[],
  instances: FormInstance[],
): { rule_id: string; message: string }[] {
  const errors: { rule_id: string; message: string }[] = [];
  const byForm = new Map(instances.map((i) => [i.form_id, i]));
  for (const rule of rules) {
    const instance = byForm.get(rule.form_id);
    if (!instance) continue;
    if (instance.values[rule.a] !== undefined && instance.values[rule.b] !== undefined) {
      errors.push({ rule_id: rule.rule_id, message: `${rule.message} (${rule.a} and ${rule.b} both populated)` });
    }
  }
  return errors;
}

// ---------- package completeness per channel (D.4.4) ----------

export function checkCompleteness(
  targets: PackageTarget[],
  artifacts: PackageArtifact[],
  instances: FormInstance[],
): string[] {
  const errors: string[] = [];
  if (targets.includes('mef_xml')) {
    for (const jur of ['FED', 'IL'] as const) {
      if (!artifacts.some((a) => a.target === 'mef_xml' && a.jurisdiction === jur)) {
        errors.push(`mef_xml channel: missing ${jur} XML rendering`);
      }
    }
  }
  if (targets.includes('paper')) {
    for (const instance of instances) {
      if (!artifacts.some((a) => a.target === 'paper' && a.artifact_id === `pdf:${instance.form_id}`)) {
        errors.push(`paper channel: missing filled form ${instance.form_id}`);
      }
    }
    if (instances.length === 0) errors.push('paper channel: no forms to assemble');
  }
  if (targets.includes('workpapers') && !artifacts.some((a) => a.target === 'workpapers')) {
    errors.push('workpapers channel: substantiation index missing');
  }
  return errors;
}
