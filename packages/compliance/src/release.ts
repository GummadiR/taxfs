/**
 * J.4 — Compliance-review gate (the human release gate).
 * No rule-set release tag exists without a POPULATED release record: a
 * named signer, the exact scope statement, suite results, and benchmark
 * results. The scope statement is fixed wording — the signer certifies
 * rule-data parameters and logic paths, never individual returns.
 * Records are retained with the tag (Rev. Proc. 97-22 posture).
 */
import type { Clock } from '@taxfs/shared';
import type { BenchmarkReport } from './benchmark';

export const RELEASE_SCOPE_STATEMENT =
  'This sign-off certifies the rule-data parameters and logic paths of the identified rule-set release. It does not certify any individual taxpayer return.';

export interface ReleaseRecord {
  release_tag: string;
  rule_versions: Record<string, string>;
  signer: { name: string; credential: string };
  scope_statement: typeof RELEASE_SCOPE_STATEMENT;
  signed_date: string;
  suite_results: { suites: string[]; total_tests: number; failed: number };
  benchmark_results: { benchmark_id: string; lines_compared: number; deltas: number };
}

export function createReleaseRecord(input: {
  release_tag: string;
  rule_versions: Record<string, string>;
  signer: { name: string; credential: string };
  clock: Clock;
  suite_results: { suites: string[]; total_tests: number; failed: number };
  benchmark: BenchmarkReport;
}): ReleaseRecord {
  if (input.signer.name.trim().length === 0 || input.signer.credential.trim().length === 0) {
    throw new Error('release record requires a NAMED signer with credential — sign-off is a human, not a build step (B.2)');
  }
  if (input.suite_results.failed > 0) {
    throw new Error(`release record refused: ${input.suite_results.failed} suite failure(s) — golden suites must be green`);
  }
  if (!input.benchmark.clean) {
    throw new Error(
      `release record refused: accuracy benchmark has ${input.benchmark.deltas.length} unexplained delta(s) vs the professional anchor`,
    );
  }
  return {
    release_tag: input.release_tag,
    rule_versions: { ...input.rule_versions },
    signer: { ...input.signer },
    scope_statement: RELEASE_SCOPE_STATEMENT,
    signed_date: input.clock.nowIso().slice(0, 10),
    suite_results: { ...input.suite_results, suites: [...input.suite_results.suites] },
    benchmark_results: {
      benchmark_id: input.benchmark.benchmark_id,
      lines_compared: input.benchmark.lines_compared,
      deltas: input.benchmark.deltas.length,
    },
  };
}

/** The CI gate: tagging requires the populated record — no record, no tag. */
export class ReleaseRegistry {
  private readonly tags = new Map<string, ReleaseRecord>();

  tagRelease(tag: string, record: ReleaseRecord | undefined | null): ReleaseRecord {
    if (!record) {
      throw new Error(`release tag "${tag}" refused: no release record — the compliance gate is not optional (J.4)`);
    }
    if (record.release_tag !== tag) {
      throw new Error(`release tag "${tag}" does not match the record's tag "${record.release_tag}"`);
    }
    if (record.scope_statement !== RELEASE_SCOPE_STATEMENT) {
      throw new Error('release record scope statement does not match the required wording');
    }
    if (this.tags.has(tag)) throw new Error(`release tag "${tag}" already exists (releases are immutable)`);
    this.tags.set(tag, Object.freeze(record));
    return record;
  }

  get(tag: string): ReleaseRecord | undefined {
    return this.tags.get(tag);
  }
}
