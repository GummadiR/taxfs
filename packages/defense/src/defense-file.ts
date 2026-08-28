/**
 * G.3 — Defense File builder (Cap 18.4 mechanics).
 * Assembled ENTIRELY from existing structures — zero manual entry. The
 * acknowledgment ledger is EXCLUDED by default (S2): this builder does not
 * even accept it as input, so bundling it is a type error, not a code
 * path. The bundle carries a user-visible note stating the exclusion and
 * §7602 compellability — the ledger is not hidden, it is simply not
 * IRS-facing. Nothing anywhere is deleted or sanitized: the complete
 * GateRun/audit history is retained immutably in the platform (A.4); this
 * file presents the factual run record without ack commentary.
 */
import { Money, type GateRun, type SourceDoc, type TaxFact } from '@taxfs/shared';
import type { PackageArtifact, PackageManifest } from '@taxfs/forms';
import type { CaptureRecord } from './capture';
import type { CompMemo } from './benchmarks';

export interface DefenseSection {
  section_id: string;
  title: string;
  source_ref: string; // which existing structure produced it
  files: { name: string; content: string }[];
}

export interface DefenseFile {
  defense_file_id: string;
  package_id: string;
  package_version: number;
  generated_at: string;
  sections: DefenseSection[];
  /** Shown to the user with the bundle — never the word "private". */
  exclusion_note: string;
  bundle_index: string;
}

export const DEFENSE_EXCLUSION_NOTE =
  'Acknowledgment records are excluded from this IRS-facing bundle by default. They remain in the platform ledger with the full history, and they can be legally compelled (for example under an IRS §7602 summons) — they are excluded, not hidden.';

export interface TranscriptReconciliation {
  status: string; // capped at partial before IRMF settlement — never "Reconciled"
  lag_caveat: string;
  matches: { label: string; state: 'matched' | 'missing' | 'extra' }[];
}

/** Cap-24 mock reconciliation, rebuilt from stored structures (facts + transcript source). */
export function buildReconciliation(
  facts: TaxFact[],
  sources: SourceDoc[],
  asOf: string,
): TranscriptReconciliation {
  const transcript = sources.find((s) => s.type === 'IRS_WI_TRANSCRIPT');
  const raw = transcript?.fields['records'];
  const matches: TranscriptReconciliation['matches'] = [];
  if (raw !== undefined) {
    const records = JSON.parse(raw) as { form: string; payer: string; concept: string; amount: string }[];
    const confirmed = facts.filter((f) => f.derivation === undefined && f.status === 'confirmed');
    for (const rec of records) {
      const hit = confirmed.some((f) => f.concept === rec.concept && f.value.eq(Money.fromString(rec.amount)));
      matches.push({ label: `${rec.form} · ${rec.payer} · $${rec.amount}`, state: hit ? 'matched' : 'missing' });
    }
    for (const f of confirmed.filter((x) => x.concept.startsWith('income.'))) {
      const on = records.some((rec) => rec.concept === f.concept && f.value.eq(Money.fromString(rec.amount)));
      if (!on) matches.push({ label: `${f.concept} · $${f.value.toString()}`, state: 'extra' });
    }
  }
  return {
    status: transcript ? `Partially verified (transcript incomplete as of ${asOf})` : 'No transcript connected',
    lag_caveat:
      'The IRS Wage & Income transcript fills in over the year; an item absent from the transcript is not evidence that no document exists. Completeness is additionally checked against the prior-year document profile.',
    matches,
  };
}

export interface DefenseBuildInput {
  manifest: PackageManifest;
  artifacts: readonly PackageArtifact[];
  reconciliation: TranscriptReconciliation;
  /** Position memos (comp memo fixture now; Cap 25 attestation memos as they land). */
  memos: CompMemo[];
  /** Substantiation-COMPLETE capture heads only (CaptureStore.defenseEligible()). */
  capture_records: CaptureRecord[];
  gate_runs: readonly GateRun[];
}

function neutralGateLog(runs: readonly GateRun[]): string {
  const lines = runs.map(
    (r) => `${r.timestamp}  gate ${r.gate}  ${r.jurisdiction}  ${r.result}  rule ${r.rule_version}`,
  );
  return `${['NEUTRAL GATE LOG — factual run record (pass/fail/timestamps only)', ...lines].join('\n')}\n`;
}

function substantiationIndex(artifacts: readonly PackageArtifact[]): string {
  const workpapers = artifacts.find((a) => a.target === 'workpapers');
  return workpapers?.content ?? '{"lines":[]}\n';
}

export function buildDefenseFile(input: DefenseBuildInput, clock: { nowIso(): string }): DefenseFile {
  if (input.capture_records.some((r) => r.substantiation !== 'complete')) {
    throw new Error(
      'defense file: a substantiation-incomplete capture record was offered — generic-purpose records stay out until corrected (§274(d))',
    );
  }
  const sections: DefenseSection[] = [
    {
      section_id: 'returns',
      title: 'Return copies (paper rendering + XML)',
      source_ref: `PackageManifest ${input.manifest.package_id} v${input.manifest.version}`,
      files: input.artifacts
        .filter((a) => a.target === 'paper' || a.target === 'mef_xml')
        .map((a) => ({ name: a.artifact_id, content: a.content })),
    },
    {
      section_id: 'substantiation-index',
      title: 'Per-line substantiation index',
      source_ref: 'D form-line lineage (workpapers artifact)',
      files: [{ name: 'substantiation-index.json', content: substantiationIndex(input.artifacts) }],
    },
    {
      section_id: 'reconciliation',
      title: 'Third-party reconciliation report',
      source_ref: 'Cap 24 transcript match results',
      files: [
        {
          name: 'reconciliation.json',
          content: `${JSON.stringify(input.reconciliation, null, 2)}\n`,
        },
      ],
    },
    {
      section_id: 'position-memos',
      title: 'Position memos',
      source_ref: 'Cap 25 attestations + §5.5 memo engine (fixture slice)',
      files: input.memos.map((m) => ({ name: `${m.memo_id}.json`, content: `${JSON.stringify(m, null, 2)}\n` })),
    },
    {
      section_id: 'contemporaneous',
      title: 'Contemporaneous attachments (substantiation-complete only)',
      source_ref: 'G.5 capture store',
      files: input.capture_records.map((r) => ({
        name: `${r.record_id}.json`,
        content: `${JSON.stringify(r, null, 2)}\n`,
      })),
    },
    {
      section_id: 'basis-carryforward',
      title: 'Basis & carryforward schedules',
      source_ref: 'Cap 22 (no records exist in the step-1 slice; section present by design)',
      files: [{ name: 'README.txt', content: 'No basis or carryforward records exist for this filing context (step-1 scope).\n' }],
    },
    {
      section_id: 'gate-log',
      title: 'Neutral gate log',
      source_ref: 'GateRuns (complete immutable history retained in-platform, A.4)',
      files: [{ name: 'gate-log.txt', content: neutralGateLog(input.gate_runs) }],
    },
  ];

  const index = [
    `%TAXOS-PDF-PLACEHOLDER v1 — Defense File bundle index`,
    `package ${input.manifest.package_id} v${input.manifest.version} · rules FED ${input.manifest.rule_versions.FED} / IL ${input.manifest.rule_versions.IL} · kernel ${input.manifest.kernel_version}`,
    `note: ${DEFENSE_EXCLUSION_NOTE}`,
    ...sections.flatMap((s) => [`SECTION ${s.section_id}: ${s.title} [${s.source_ref}]`, ...s.files.map((f) => `  - ${f.name}`)]),
  ].join('\n');

  return {
    defense_file_id: `defense-${input.manifest.package_id}-v${input.manifest.version}`,
    package_id: input.manifest.package_id,
    package_version: input.manifest.version,
    generated_at: clock.nowIso(),
    sections,
    exclusion_note: DEFENSE_EXCLUSION_NOTE,
    bundle_index: `${index}\n`,
  };
}
