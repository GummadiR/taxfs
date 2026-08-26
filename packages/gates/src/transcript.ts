/**
 * P5.3 — Gate 13 (Post-Filing Verification): transcript matching.
 * Compares the LOCKED package's filed lines against the values the IRS
 * actually has (Wage & Income / Record of Account transcript, typed in by
 * the user — transcript retrieval is manual, never automated). Every
 * compared line yields an explicit row; any mismatch blocks Gate 13 and
 * names the line, the filed value, and the IRS value. A transcript that
 * matches line-for-line is the engagement's closing evidence.
 */
import { Money } from '@taxfs/shared';

export interface TranscriptLine {
  /** The package concept this transcript entry corresponds to (e.g. fed.agi). */
  concept: string;
  /** Transcript label as shown on the IRS document (for the audit trail). */
  label: string;
  /** The value the IRS transcript shows (decimal string). */
  transcript_value: string;
}

export interface TranscriptRow {
  concept: string;
  label: string;
  package_value: string; // '<missing>' when the locked package has no such line
  transcript_value: string;
  delta: string; // package − transcript ('n/a' when the package line is missing)
  match: boolean;
}

export interface TranscriptMatchReport {
  rows: TranscriptRow[];
  matched: number;
  mismatched: number;
}

/**
 * Pure comparison of filed (locked) lines vs typed transcript lines.
 * `filedLines` is the same concept→value snapshot the amendment engine
 * pins at markFiled — Gate 13 and 1040-X column A share one baseline.
 */
export function matchTranscript(
  filedLines: Record<string, string>,
  lines: readonly TranscriptLine[],
): TranscriptMatchReport {
  const rows = lines.map((line): TranscriptRow => {
    const filed = filedLines[line.concept];
    if (filed === undefined) {
      return {
        concept: line.concept, label: line.label,
        package_value: '<missing>', transcript_value: line.transcript_value,
        delta: 'n/a', match: false,
      };
    }
    const delta = Money.fromString(filed).sub(Money.fromString(line.transcript_value));
    return {
      concept: line.concept, label: line.label,
      package_value: filed, transcript_value: line.transcript_value,
      delta: delta.toString(), match: delta.isZero(),
    };
  });
  const mismatched = rows.filter((r) => !r.match).length;
  return { rows, matched: rows.length - mismatched, mismatched };
}
