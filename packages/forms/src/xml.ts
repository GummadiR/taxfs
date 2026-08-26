/**
 * D.3 — XML generator + minimal parser (round-trip check, D.4.3).
 * XML is generated from FormInstances + FormDefinitions, never hand-built
 * per return. Output is byte-stable for identical inputs (no timestamps in
 * the body — archival metadata lives in the manifest and header refs only).
 * Element names come from LineDefs (PLACEHOLDER until real MeF/IL schemas
 * are procured); the shape is "MeF-shaped", not MeF-valid, until then.
 */
import type { Jurisdiction, Money } from '@taxfs/shared';
import type { FormDefinition, FormInstance } from './types';

export interface XmlMeta {
  jurisdiction: Jurisdiction;
  tax_year: number;
  rule_version: string;
  form_def_release: string;
  kernel_version: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function elementNameOf(def: FormDefinition, line_id: string): string {
  const line = def.lines.find((l) => l.line_id === line_id);
  if (!line) throw new Error(`xml: unknown line ${def.form_id}.${line_id}`);
  const name = def.jurisdiction === 'FED' ? line.mef_element : line.il_field;
  if (!name) throw new Error(`xml: line ${line_id} has no element name`);
  return name;
}

export function generateXml(
  defs: FormDefinition[],
  instances: FormInstance[],
  meta: XmlMeta,
): string {
  const defById = new Map(defs.map((d) => [d.form_id, d]));
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<TaxOSReturn>');
  lines.push('  <ReturnHeader>');
  lines.push(`    <Jurisdiction>${escapeXml(meta.jurisdiction)}</Jurisdiction>`);
  lines.push(`    <TaxYear>${meta.tax_year}</TaxYear>`);
  lines.push(`    <RuleVersion>${escapeXml(meta.rule_version)}</RuleVersion>`);
  lines.push(`    <FormDefRelease>${escapeXml(meta.form_def_release)}</FormDefRelease>`);
  lines.push(`    <KernelVersion>${escapeXml(meta.kernel_version)}</KernelVersion>`);
  lines.push('  </ReturnHeader>');
  lines.push('  <ReturnData>');
  const ordered = [...instances].sort((a, b) => {
    const da = defById.get(a.form_id);
    const db = defById.get(b.form_id);
    return (da?.attachment_order ?? 0) - (db?.attachment_order ?? 0);
  });
  for (const instance of ordered) {
    const def = defById.get(instance.form_id);
    if (!def) throw new Error(`xml: no FormDefinition for ${instance.form_id}`);
    lines.push(`    <Form${def.form_id}>`);
    lines.push(`      <FormRevision>${escapeXml(def.revision)}</FormRevision>`);
    for (const line of def.lines) {
      const value: Money | undefined = instance.values[line.line_id];
      if (value === undefined) continue; // sparse output: omitted lines absent
      const el = elementNameOf(def, line.line_id);
      lines.push(`      <${el}>${escapeXml(value.toString())}</${el}>`);
    }
    lines.push(`    </Form${def.form_id}>`);
  }
  lines.push('  </ReturnData>');
  lines.push('</TaxOSReturn>');
  return `${lines.join('\n')}\n`;
}

// ---------- minimal parser (for our own generated subset) ----------

export interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

/** Parses elements-only XML (no attributes/self-closing — our own output). */
export function parseXml(xml: string): XmlNode {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  let pos = 0;

  function skipWs(): void {
    while (pos < body.length && /\s/.test(body[pos]!)) pos = pos + 1;
  }

  function parseNode(): XmlNode {
    skipWs();
    if (body[pos] !== '<') throw new Error(`xml parse: expected '<' at ${pos}`);
    const close = body.indexOf('>', pos);
    const name = body.slice(pos + 1, close);
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`xml parse: bad element name "${name}"`);
    pos = close + 1;
    const node: XmlNode = { name, children: [], text: '' };
    for (;;) {
      const nextOpen = body.indexOf('<', pos);
      if (nextOpen === -1) throw new Error(`xml parse: unterminated <${name}>`);
      const chunk = body.slice(pos, nextOpen);
      if (body[nextOpen + 1] === '/') {
        node.text = node.text + chunk;
        const endClose = body.indexOf('>', nextOpen);
        const closing = body.slice(nextOpen + 2, endClose);
        if (closing !== name) throw new Error(`xml parse: expected </${name}>, got </${closing}>`);
        pos = endClose + 1;
        break;
      }
      pos = nextOpen;
      node.children.push(parseNode());
    }
    node.text = node.text
      .trim()
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    return node;
  }

  const root = parseNode();
  return root;
}

export function childNamed(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

/** D.4.3 round-trip: parse the generated XML and diff against FormInstance values. */
export function roundTripDiff(
  xml: string,
  defs: FormDefinition[],
  instances: FormInstance[],
): { form_id: string; line_id: string; expected: string; parsed: string }[] {
  const mismatches: { form_id: string; line_id: string; expected: string; parsed: string }[] = [];
  const root = parseXml(xml);
  const data = childNamed(root, 'ReturnData');
  const defById = new Map(defs.map((d) => [d.form_id, d]));
  for (const instance of instances) {
    const def = defById.get(instance.form_id);
    if (!def) continue;
    const formNode = data ? childNamed(data, `Form${instance.form_id}`) : undefined;
    for (const [line_id, value] of Object.entries(instance.values)) {
      const el = elementNameOf(def, line_id);
      const parsed = formNode ? childNamed(formNode, el)?.text ?? '<absent>' : '<form absent>';
      if (parsed !== value.toString()) {
        mismatches.push({ form_id: instance.form_id, line_id, expected: value.toString(), parsed });
      }
    }
    // reverse direction: elements present in XML but not in the instance
    if (formNode) {
      for (const child of formNode.children) {
        if (child.name === 'FormRevision') continue;
        const line = def.lines.find((l) => (def.jurisdiction === 'FED' ? l.mef_element : l.il_field) === child.name);
        if (!line || instance.values[line.line_id] === undefined) {
          mismatches.push({
            form_id: instance.form_id,
            line_id: line?.line_id ?? child.name,
            expected: '<absent>',
            parsed: child.text,
          });
        }
      }
    }
  }
  return mismatches;
}
