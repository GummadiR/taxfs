/**
 * Language discipline (E.5, §5.6).
 * Checked twice: as a semantic validator inside the Audit-Summary agent
 * (violating output is rejected) and as a CI lint over agent sources and
 * fixtures (banned-vocab.test.ts).
 *
 * Personal-use pivot: the UPL advice-verb bans ("you should claim…",
 * "we recommend…") are removed — this is a private single-user tool, not a
 * consumer product. The remaining bans stay because they protect the OWNER:
 * no immunity promises (they're false), no numeric risk scores (itemized,
 * explainable profile only), no outcome guarantees.
 */
export interface VocabViolation {
  pattern: string;
  reason: string;
  excerpt: string;
}

interface BannedPattern {
  re: RegExp;
  reason: string;
}

export const BANNED_PATTERNS: BannedPattern[] = [
  {
    re: /audit[\s-]?proof/i,
    reason: 'never promise audit immunity — risk is reduced, never eliminated (§1.7)',
  },
  {
    re: /\b(?:risk|audit)\s*score\b/i,
    reason: 'no numeric/black-box scores — itemized, explainable profile only (§5.2)',
  },
  {
    re: /\bscore(?:d|s)?\s*(?:of\s*)?\d/i,
    reason: 'no numeric scoring language',
  },
  {
    re: /\bguarantee(?:d|s)?\b/i,
    reason: 'no acceptance/outcome guarantees (§11/S3)',
  },
];

export function checkBannedVocabulary(text: string): VocabViolation[] {
  const violations: VocabViolation[] = [];
  for (const { re, reason } of BANNED_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const at = m.index;
      violations.push({
        pattern: re.source,
        reason,
        excerpt: text.slice(Math.max(0, at - 20), at + m[0].length + 20),
      });
    }
  }
  return violations;
}
