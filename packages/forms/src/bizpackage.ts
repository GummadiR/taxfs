/**
 * P13 — Per-entity business filing packages. Each owned entity (S-corp →
 * 1120-S; multi-member LLC / partnership → 1065) gets its OWN package:
 * entity return + IL return + one K-1 (and IL Schedule K-1-P) per owner.
 *
 * Filing reality: business MeF e-file goes through IRS-authorized
 * transmitters only, so the produced package is PRINT-AND-MAIL, exactly like
 * the personal channel — official-PDF filling drops in per form the moment
 * the official template + verified field map land; until then the loud
 * placeholder rendering keeps the pipeline honest. K-1 copies are handed to
 * each owner for their personal returns. No math here: every printed line is
 * a kernel-emitted fact (compute wall).
 */
import type { TaxFact } from '@taxfs/shared';
import { instantiateEntityForms, type BizFormRelease } from './bizdefs';
import { crossFormCheck, populateInstances } from './mapping';
import { loadPdfTemplates, renderPdfPlaceholder, type PdfTemplateConfig } from './pdf';
import { fillPdfForm, type FieldMapRelease } from './pdffill';
import type { FormInstance, MappingDefect, PackageArtifact } from './types';

const ENTITY_RE = /^entity\.([a-z0-9][a-z0-9_-]*)\./;
const MEMBER_SHARE_RE = /^entity\.([a-z0-9][a-z0-9_-]*)\.member\.([a-z0-9][a-z0-9_-]*)\.share$/;

export interface EntityPackageInput {
  tax_year: number;
  /** Confirmed sourced facts PLUS the entity-kernel result facts. */
  facts: TaxFact[];
  release: BizFormRelease;
  pdf_templates: unknown;
  /** Official business PDFs + verified maps, keyed by BASE form_id
   *  (per-member instances reuse their form's map/template). */
  pdf_fill?: { maps: FieldMapRelease; templates: Record<string, Uint8Array> };
}

export interface EntityPackage {
  entity_id: string;
  scorp: boolean;
  member_ids: string[];
  instances: FormInstance[];
  artifacts: PackageArtifact[];
  defects: MappingDefect[];
  clean: boolean;
}

/** Base form id for per-member instances (`K1-1120S:m1` → `K1-1120S`). */
function baseFormId(formId: string): string {
  return formId.split(':')[0]!;
}

export async function buildEntityPackages(input: EntityPackageInput): Promise<EntityPackage[]> {
  const sourced = input.facts.filter((f) => f.derivation === undefined && f.status === 'confirmed');
  const eids = [...new Set(
    sourced.map((f) => ENTITY_RE.exec(f.concept)?.[1]).filter((x): x is string => x !== undefined),
  )].sort();
  const basePdfConfig = loadPdfTemplates(input.pdf_templates);

  const packages: EntityPackage[] = [];
  for (const eid of eids) {
    const memberIds = [...new Set(
      sourced
        .map((f) => {
          const m = MEMBER_SHARE_RE.exec(f.concept);
          return m?.[1] === eid ? m[2] : undefined;
        })
        .filter((x): x is string => x !== undefined),
    )].sort();
    const scorp = sourced.some(
      (f) => f.concept === `entity.${eid}.is_scorp` && !f.value.isZero(),
    );
    const defs = instantiateEntityForms(input.release, { eid, memberIds, scorp });
    const { instances, defects } = populateInstances(defs, input.facts, `entity:${eid}`, input.tax_year);
    defects.push(...crossFormCheck(defs, instances));

    // Placeholder layouts resolve by BASE form id so per-member K-1 copies
    // share their form's layout without duplicating fixture entries.
    const pdfConfig: PdfTemplateConfig = {
      release: basePdfConfig.release,
      templates: { ...basePdfConfig.templates },
    };
    for (const def of defs) {
      const base = baseFormId(def.form_id);
      const layout = basePdfConfig.templates[base];
      if (layout && !pdfConfig.templates[def.form_id]) pdfConfig.templates[def.form_id] = layout;
    }

    const artifacts: PackageArtifact[] = [];
    const defById = new Map(defs.map((d) => [d.form_id, d]));
    for (const instance of instances) {
      const def = defById.get(instance.form_id)!;
      const base = baseFormId(instance.form_id);
      const map = input.pdf_fill?.maps.forms[base];
      const template = input.pdf_fill?.templates[base];
      if (map && template) {
        const result = await fillPdfForm(template, def, instance, map);
        for (const lineId of result.unmapped_line_ids) {
          defects.push({
            form_id: instance.form_id,
            line_id: lineId,
            kind: 'unmapped_pdf_line',
            message: `${instance.form_id} ${lineId} has a value but no PDF field mapping — a mailed form with a missing amount is a wrong filing`,
          });
        }
        artifacts.push({
          artifact_id: `pdf:${eid}:${instance.form_id}`,
          target: 'paper',
          jurisdiction: instance.jurisdiction,
          content_type: 'application/pdf',
          content: Buffer.from(result.bytes).toString('base64'),
        });
        continue;
      }
      artifacts.push({
        artifact_id: `pdf:${eid}:${instance.form_id}`,
        target: 'paper',
        jurisdiction: instance.jurisdiction,
        content_type: 'text/x-pdf-placeholder',
        content: renderPdfPlaceholder(def, instance, pdfConfig),
      });
    }

    packages.push({
      entity_id: eid,
      scorp,
      member_ids: memberIds,
      instances,
      artifacts,
      defects,
      clean: defects.length === 0,
    });
  }
  return packages;
}
