/**
 * D.3 — Workpapers target: per-line substantiation index (line → fact →
 * calc → source docs), auto-assembled from lineage — the same structure
 * that powers the UI drill-down. Gate log entries are NEUTRAL only
 * (gate/jurisdiction/result/version/timestamp; no findings text, no
 * "proceeded despite warning" editorializing — S2 discipline).
 */
import type { GateRun } from '@taxfs/shared';
import type { LineageNode, SpineContracts } from '@taxfs/spine';
import type { FormDefinition, FormInstance } from './types';

export interface WorkpaperLine {
  form_id: string;
  line_id: string;
  label: string;
  value: string;
  fact_id: string;
  calc_id?: string;
  formula_ref?: string;
  calculation_steps?: string[];
  source_docs: string[];
}

export interface Workpapers {
  taxpayer_id: string;
  tax_year: number;
  lines: WorkpaperLine[];
  gate_log: { gate: number; jurisdiction: string; result: string; rule_version: string; timestamp: string }[];
}

function collectSources(node: LineageNode, into: Set<string>): void {
  for (const src of node.sources ?? []) into.add(src.source_id);
  for (const input of node.inputs ?? []) collectSources(input, into);
}

export async function buildWorkpapers(
  spine: Pick<SpineContracts, 'getLineage'>,
  defs: FormDefinition[],
  instances: FormInstance[],
  gateRuns: readonly GateRun[],
  taxpayer_id: string,
  tax_year: number,
): Promise<Workpapers> {
  const defById = new Map(defs.map((d) => [d.form_id, d]));
  const lines: WorkpaperLine[] = [];
  for (const instance of instances) {
    const def = defById.get(instance.form_id);
    if (!def) continue;
    for (const lineDef of def.lines) {
      const value = instance.values[lineDef.line_id];
      const ref = instance.lineage[lineDef.line_id];
      if (value === undefined || ref === undefined) continue;
      const lineage = await spine.getLineage(ref.fact_id);
      const sources = new Set<string>();
      collectSources(lineage, sources);
      const entry: WorkpaperLine = {
        form_id: instance.form_id,
        line_id: lineDef.line_id,
        label: lineDef.label,
        value: value.toString(),
        fact_id: ref.fact_id,
        source_docs: [...sources].sort(),
      };
      if (ref.calc_id !== undefined) entry.calc_id = ref.calc_id;
      if (lineage.calculation) {
        entry.formula_ref = lineage.calculation.formula_ref;
        entry.calculation_steps = lineage.calculation.steps;
      }
      lines.push(entry);
    }
  }
  return {
    taxpayer_id,
    tax_year,
    lines,
    gate_log: gateRuns.map((r) => ({
      gate: r.gate,
      jurisdiction: r.jurisdiction,
      result: r.result,
      rule_version: r.rule_version,
      timestamp: r.timestamp,
    })),
  };
}
