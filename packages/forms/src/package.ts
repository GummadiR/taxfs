/**
 * D.5 — Multi-target packaging: one PackageManifest, three renderings
 * (paper placeholder-PDFs · MeF-shaped XML · workpapers). Locked =
 * immutable; post-lock edits require an explicit unlock → staleness
 * cascade → gates re-run → NEW package version (scoped, never a gate
 * bypass). The locked manifest freezes rule-set + form-def + kernel
 * version refs (runtime-state archival). Version history retained.
 */
import type { Clock, GateRun, Jurisdiction, TaxFact } from '@taxfs/shared';
import type { SpineContracts } from '@taxfs/spine';
import type { FormDefRelease } from './defs';
import { crossFormCheck, populateInstances, resolveFormSet } from './mapping';
import { generateXml, roundTripDiff } from './xml';
import { loadPdfTemplates, renderPdfPlaceholder, type PdfTemplateConfig } from './pdf';
import { fillPdfForm, type FieldMapRelease } from './pdffill';
import { buildWorkpapers } from './workpapers';
import {
  StubSchemaValidator,
  checkCompleteness,
  runBusinessRules,
  type BusinessRule,
  type StubXsdConfig,
} from './validate';
import type {
  FormInstance,
  MappingDefect,
  PackageArtifact,
  PackageManifest,
  PackageTarget,
  ValidationReport,
} from './types';

export interface ExtendedValidationReport extends ValidationReport {
  mapping_defects: MappingDefect[];
}

export interface BuildInput {
  taxpayer_id: string;
  tax_year: number;
  /** All confirmed facts (sourced + derived) for the filing context. */
  facts: TaxFact[];
  gate_runs: readonly GateRun[];
  /** Caller attests gates 0–4 and 6 passed (orchestrator state) — packaging never bypasses gates. */
  hard_gates_passed: boolean;
  rule_versions: Record<Jurisdiction, string>;
  kernel_version: string;
  releases: { fed: FormDefRelease; il: FormDefRelease };
  stub_xsd: { fed: StubXsdConfig; il: StubXsdConfig };
  business_rules: BusinessRule[];
  pdf_templates: unknown;
  /** P11.1 — when the OFFICIAL template PDFs + verified field maps exist for
   *  a form, the paper artifact is a real filled AcroForm PDF; forms without
   *  them keep the loud placeholder rendering. Never silent, never partial:
   *  a value with no field mapping is a mapping defect that blocks clean. */
  pdf_fill?: { maps: FieldMapRelease; templates: Record<string, Uint8Array> };
  /** P80 — the filer's status, so the 1040's status checkbox gets ticked. A
   *  return with no status box ticked is not a valid return. */
  filing_status?: string;
  spine: Pick<SpineContracts, 'getLineage'>;
  clock: Clock;
}

export interface BuiltPackage {
  manifest: PackageManifest;
  artifacts: PackageArtifact[];
  instances: FormInstance[];
  report: ExtendedValidationReport;
}

const TARGETS: PackageTarget[] = ['paper', 'mef_xml', 'workpapers'];

export async function buildPackage(input: BuildInput): Promise<BuiltPackage> {
  const pdfConfig: PdfTemplateConfig = loadPdfTemplates(input.pdf_templates);

  // D.2 — resolve + populate + artifact check.
  const fedDefs = resolveFormSet(input.releases.fed, input.facts);
  const ilDefs = resolveFormSet(input.releases.il, input.facts);
  const fed = populateInstances(fedDefs, input.facts, input.taxpayer_id, input.tax_year);
  const il = populateInstances(ilDefs, input.facts, input.taxpayer_id, input.tax_year);
  const instances = [...fed.instances, ...il.instances];
  const allDefs = [...input.releases.fed.forms, ...input.releases.il.forms];
  const mappingDefects = [
    ...fed.defects,
    ...il.defects,
    ...crossFormCheck(allDefs, instances),
  ];

  // D.3 — renderings (all generated, never hand-built/edited).
  const artifacts: PackageArtifact[] = [];
  const fedXml = generateXml(input.releases.fed.forms, fed.instances, {
    jurisdiction: 'FED',
    tax_year: input.tax_year,
    rule_version: input.rule_versions.FED,
    form_def_release: input.releases.fed.release,
    kernel_version: input.kernel_version,
  });
  const ilXml = generateXml(input.releases.il.forms, il.instances, {
    jurisdiction: 'IL',
    tax_year: input.tax_year,
    rule_version: input.rule_versions.IL,
    form_def_release: input.releases.il.release,
    kernel_version: input.kernel_version,
  });
  artifacts.push(
    { artifact_id: 'xml:FED', target: 'mef_xml', jurisdiction: 'FED', content_type: 'application/xml', content: fedXml },
    { artifact_id: 'xml:IL', target: 'mef_xml', jurisdiction: 'IL', content_type: 'application/xml', content: ilXml },
  );
  const defById = new Map(allDefs.map((d) => [d.form_id, d]));
  for (const instance of instances) {
    const def = defById.get(instance.form_id);
    if (!def) continue;
    const map = input.pdf_fill?.maps.forms[instance.form_id];
    const template = input.pdf_fill?.templates[instance.form_id];
    if (map && template) {
      const result = await fillPdfForm(template, def, instance, map, input.filing_status);
      for (const o of result.overflow_line_ids) {
        mappingDefects.push({
          form_id: instance.form_id,
          line_id: o.line_id,
          kind: 'value_exceeds_field',
          message: `${instance.form_id} ${o.line_id} = ${o.value} does not fit its box on the official form (${o.field} holds ${o.max_length} characters) — the amount was NOT written; printing a truncated figure would be a wrong filing`,
        });
      }
      for (const lineId of result.unmapped_line_ids) {
        mappingDefects.push({
          form_id: instance.form_id,
          line_id: lineId,
          kind: 'unmapped_pdf_line',
          message: `${instance.form_id} ${lineId} has a value but no PDF field mapping — a mailed form with a missing amount is a wrong filing`,
        });
      }
      artifacts.push({
        artifact_id: `pdf:${instance.form_id}`,
        target: 'paper',
        jurisdiction: instance.jurisdiction,
        content_type: 'application/pdf',
        content: Buffer.from(result.bytes).toString('base64'),
      });
      continue;
    }
    artifacts.push({
      artifact_id: `pdf:${instance.form_id}`,
      target: 'paper',
      jurisdiction: instance.jurisdiction,
      content_type: 'text/x-pdf-placeholder',
      content: renderPdfPlaceholder(def, instance, pdfConfig),
    });
  }
  const workpapers = await buildWorkpapers(
    input.spine,
    allDefs,
    instances,
    input.gate_runs,
    input.taxpayer_id,
    input.tax_year,
  );
  artifacts.push({
    artifact_id: 'workpapers:index',
    target: 'workpapers',
    jurisdiction: 'ALL',
    content_type: 'application/json',
    content: `${JSON.stringify(workpapers, null, 2)}\n`,
  });

  // D.4 — validation before release.
  const schemaViolations = [
    ...new StubSchemaValidator(input.stub_xsd.fed).validate(fedXml, input.releases.fed.forms),
    ...new StubSchemaValidator(input.stub_xsd.il).validate(ilXml, input.releases.il.forms),
  ];
  const businessRuleErrors = runBusinessRules(input.business_rules, instances);
  const roundTrip = [
    ...roundTripDiff(fedXml, input.releases.fed.forms, fed.instances),
    ...roundTripDiff(ilXml, input.releases.il.forms, il.instances),
  ];
  const completenessErrors = checkCompleteness(TARGETS, artifacts, instances);
  if (!input.hard_gates_passed) {
    completenessErrors.push('hard gates (0–4, 6) are not all passed — packaging never bypasses gates');
  }

  const report: ExtendedValidationReport = {
    schema_violations: schemaViolations,
    business_rule_errors: businessRuleErrors,
    round_trip_mismatches: roundTrip,
    completeness_errors: completenessErrors,
    mapping_defects: mappingDefects,
    clean:
      schemaViolations.length === 0 &&
      businessRuleErrors.length === 0 &&
      roundTrip.length === 0 &&
      completenessErrors.length === 0 &&
      mappingDefects.length === 0,
  };

  const manifest: PackageManifest = {
    package_id: '', // assigned by the store on commit
    taxpayer_id: input.taxpayer_id,
    tax_year: input.tax_year,
    version: 0, // assigned by the store on commit
    targets: TARGETS,
    forms: instances.map((i) => i.instance_id),
    generated_at: input.clock.nowIso(),
    status: 'draft',
    rule_versions: input.rule_versions,
    form_def_versions: Object.fromEntries(instances.map((i) => [i.form_id, i.revision])),
    form_def_releases: { FED: input.releases.fed.release, IL: input.releases.il.release },
    kernel_version: input.kernel_version,
    schema_validation_report: report,
    unlock_history: [],
  };
  return { manifest, artifacts, instances, report };
}

// ---------- store: lock / unlock / version history ----------

export interface StoredVersion {
  manifest: PackageManifest;
  artifacts: PackageArtifact[];
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    for (const value of Object.values(obj)) deepFreeze(value);
    Object.freeze(obj);
  }
  return obj;
}

export class PackageStore {
  private readonly byId = new Map<string, StoredVersion>();
  private readonly historyByKey = new Map<string, string[]>(); // key → package_ids in version order
  private readonly pendingUnlock = new Map<string, { unlocked_at: string; reason: string }[]>();
  private seq = 0;

  constructor(private readonly clock: Clock) {}

  private key(taxpayer_id: string, tax_year: number): string {
    return `${taxpayer_id}:${tax_year}`;
  }

  private head(key: string): StoredVersion | undefined {
    const ids = this.historyByKey.get(key) ?? [];
    const lastId = ids[ids.length - 1];
    return lastId !== undefined ? this.byId.get(lastId) : undefined;
  }

  /** Register a freshly built package as the next version (draft). */
  commit(built: BuiltPackage): PackageManifest {
    const key = this.key(built.manifest.taxpayer_id, built.manifest.tax_year);
    const head = this.head(key);
    if (head && head.manifest.status === 'locked' && !(this.pendingUnlock.get(key)?.length)) {
      throw new Error(
        `package ${head.manifest.package_id} is LOCKED — post-lock edits require an explicit unlock (D.5)`,
      );
    }
    this.seq = this.seq + 1;
    const version = head ? head.manifest.version + 1 : 1;
    const manifest: PackageManifest = {
      ...built.manifest,
      package_id: `pkg-${String(this.seq).padStart(4, '0')}`,
      version,
      ...(head && head.manifest.status === 'locked' ? { supersedes: head.manifest.package_id } : {}),
      unlock_history: [...(this.pendingUnlock.get(key) ?? [])],
    };
    this.pendingUnlock.delete(key);
    this.byId.set(manifest.package_id, { manifest, artifacts: built.artifacts });
    this.historyByKey.set(key, [...(this.historyByKey.get(key) ?? []), manifest.package_id]);
    return manifest;
  }

  /**
   * Lock = immutable. Refuses anything less than a clean validation report —
   * "shipping a package with schema warnings to be fixed later" is a
   * rejected pattern (D.8).
   */
  lock(package_id: string): PackageManifest {
    const stored = this.byId.get(package_id);
    if (!stored) throw new Error(`package ${package_id} not found`);
    if (stored.manifest.status === 'locked') return stored.manifest;
    const report = stored.manifest.schema_validation_report as ExtendedValidationReport;
    if (!report.clean) {
      const counts = [
        `${report.schema_violations.length} schema`,
        `${report.business_rule_errors.length} business-rule`,
        `${report.round_trip_mismatches.length} round-trip`,
        `${report.completeness_errors.length} completeness`,
        `${report.mapping_defects?.length ?? 0} mapping`,
      ].join(', ');
      throw new Error(`cannot lock ${package_id}: validation not clean (${counts})`);
    }
    stored.manifest.status = 'locked';
    deepFreeze(stored.manifest);
    deepFreeze(stored.artifacts);
    return stored.manifest;
  }

  /** Explicit unlock: recorded, and the NEXT commit becomes version n+1. */
  unlock(package_id: string, reason: string): void {
    const stored = this.byId.get(package_id);
    if (!stored) throw new Error(`package ${package_id} not found`);
    if (stored.manifest.status !== 'locked') throw new Error(`package ${package_id} is not locked`);
    const key = this.key(stored.manifest.taxpayer_id, stored.manifest.tax_year);
    const events = this.pendingUnlock.get(key) ?? [];
    events.push({ unlocked_at: this.clock.nowIso(), reason });
    this.pendingUnlock.set(key, events);
  }

  get(package_id: string): StoredVersion | undefined {
    return this.byId.get(package_id);
  }

  /**
   * True when the head is locked and no unlock has been recorded — i.e.
   * corrections must go through an explicit unlock first. (The locked
   * manifest itself never flips back to draft; unlock authorizes the NEXT
   * version, it does not mutate history.)
   */
  editingBlocked(taxpayer_id: string, tax_year: number): boolean {
    const key = this.key(taxpayer_id, tax_year);
    const head = this.head(key);
    return head?.manifest.status === 'locked' && !(this.pendingUnlock.get(key)?.length ?? 0);
  }

  /** Full version history (retained ≥7 yrs in production — D.5). */
  history(taxpayer_id: string, tax_year: number): PackageManifest[] {
    return (this.historyByKey.get(this.key(taxpayer_id, tax_year)) ?? []).map(
      (id) => this.byId.get(id)!.manifest,
    );
  }

  // ---------- persistence hooks (P30) ----------
  // The store itself is memory-only; the caller saves/loads snapshots. A
  // built (especially LOCKED) package is the filing artifact of record — it
  // must survive a server restart.

  /** Rehydrate persisted versions. Ids are preserved, version order is
   *  restored per taxpayer/year, and the id sequence advances past the
   *  highest restored id so new commits never collide. */
  restore(versions: StoredVersion[]): void {
    const ordered = [...versions].sort((a, b) => a.manifest.version - b.manifest.version);
    for (const v of ordered) {
      if (this.byId.has(v.manifest.package_id)) continue;
      const stored: StoredVersion =
        v.manifest.status === 'locked'
          ? { manifest: deepFreeze(v.manifest), artifacts: deepFreeze(v.artifacts) }
          : v;
      this.byId.set(v.manifest.package_id, stored);
      const key = this.key(v.manifest.taxpayer_id, v.manifest.tax_year);
      this.historyByKey.set(key, [...(this.historyByKey.get(key) ?? []), v.manifest.package_id]);
      const n = Number(v.manifest.package_id.replace(/\D/g, ''));
      if (Number.isFinite(n) && n > this.seq) this.seq = n;
    }
  }

  /** Drop DRAFT versions for a filing (they are derived state — a document
   *  change invalidates them; a rebuild recreates them). Locked versions are
   *  immutable history and always survive. Returns the dropped ids so the
   *  caller can delete their persisted snapshots too. */
  discardDrafts(taxpayer_id: string, tax_year: number): string[] {
    const key = this.key(taxpayer_id, tax_year);
    const ids = this.historyByKey.get(key) ?? [];
    const kept: string[] = [];
    const dropped: string[] = [];
    const reclaimedUnlocks: { unlocked_at: string; reason: string }[] = [];
    for (const id of ids) {
      const v = this.byId.get(id);
      if (v && v.manifest.status === 'draft') {
        this.byId.delete(id);
        dropped.push(id);
        // P90 — a draft that was authorized by an unlock CARRIES that
        // authorization (commit moved it out of pendingUnlock and onto the
        // manifest). Discarding the draft must hand it back, or the very
        // next rebuild is refused as a post-lock edit and the operator is
        // forced to unlock a second time for the same correction.
        reclaimedUnlocks.push(...v.manifest.unlock_history);
      } else {
        kept.push(id);
      }
    }
    this.historyByKey.set(key, kept);
    if (reclaimedUnlocks.length > 0) {
      this.pendingUnlock.set(key, [...reclaimedUnlocks, ...(this.pendingUnlock.get(key) ?? [])]);
    }
    return dropped;
  }
}
