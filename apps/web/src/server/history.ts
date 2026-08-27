/**
 * Tax History (Blueprint §7.6, P101/P102 as design): prior-year headline
 * lines live in §4's history_lines; the CURRENT year's column reads the
 * kernel's own derived facts; a projection column exists ONLY when a cited
 * next-year rule release exists on disk — no release, no projection, with
 * the reason shown (the honesty rule, never a guessed number).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { C, type TaxFact } from '@taxfs/shared';
import { TAX_YEAR } from './env';

export interface HeadlineLine {
  line: string;
  label: string;
  /** The kernel concept whose derived fact IS this line for the active year. */
  concept: string;
}

export const HEADLINE_LINES: HeadlineLine[] = [
  { line: 'total_income', label: 'Total income (1040 line 9)', concept: C.FED_TOTAL_INCOME },
  { line: 'agi', label: 'AGI (line 11)', concept: C.FED_AGI },
  { line: 'taxable_income', label: 'Taxable income (line 15)', concept: C.FED_TAXABLE },
  { line: 'total_tax', label: 'Total tax (line 24)', concept: C.FED_TOTAL_TAX_LIABILITY },
  { line: 'payments', label: 'Payments (line 33)', concept: C.FED_PAYMENTS },
  { line: 'refund_or_due', label: 'Refund (+) / owed (−)', concept: C.FED_REFUND_OR_DUE },
];

export async function upsertHistoryLine(
  client: pg.Client,
  ws: string,
  tax_year: number,
  line: string,
  value: string,
  source_id: string | null,
): Promise<void> {
  if (!HEADLINE_LINES.some((h) => h.line === line)) throw new Error(`unknown history line ${line}`);
  if (!Number.isInteger(tax_year) || tax_year >= TAX_YEAR || tax_year < 2015) {
    throw new Error(`history year must be a prior year (2015–${TAX_YEAR - 1})`);
  }
  await client.query(
    `insert into history_lines (workspace_id, tax_year, line, value, source_id)
     values ($1, $2, $3, $4::numeric, $5)
     on conflict (workspace_id, tax_year, line) do update
       set value = excluded.value, source_id = excluded.source_id`,
    [ws, tax_year, line, value, source_id],
  );
}

export interface HistoryTable {
  years: number[]; // ascending, current year last
  /** line -> year -> decimal string ('' = no value). */
  cells: Record<string, Record<number, string>>;
}

export async function historyTable(client: pg.Client, ws: string, currentFacts: TaxFact[]): Promise<HistoryTable> {
  const r = await client.query(
    `select tax_year, line, value::text as value from history_lines
      where workspace_id = $1 order by tax_year, line`,
    [ws],
  );
  const years = [...new Set<number>(r.rows.map((x) => x.tax_year as number))].sort((a, b) => a - b);
  const cells: Record<string, Record<number, string>> = {};
  for (const h of HEADLINE_LINES) cells[h.line] = {};
  for (const row of r.rows) {
    if (cells[row.line]) cells[row.line]![row.tax_year as number] = row.value as string;
  }
  const byConcept = new Map(currentFacts.map((f) => [f.concept, f]));
  let hasCurrent = false;
  for (const h of HEADLINE_LINES) {
    const fact = byConcept.get(h.concept);
    if (fact) {
      cells[h.line]![TAX_YEAR] = fact.value.toString();
      hasCurrent = true;
    }
  }
  if (hasCurrent || years.length > 0) {
    if (!years.includes(TAX_YEAR) && hasCurrent) years.push(TAX_YEAR);
  }
  return { years, cells };
}

/** A projection column may exist ONLY when the next season's cited release
 *  is on disk (the P99/§7.6 rule). Returns the reason when it may not. */
export function projectionStatus(repoRoot: string): { available: boolean; reason: string } {
  const next = TAX_YEAR + 1;
  const path = join(repoRoot, `rules/fixtures/${next}.FED.1.0.json`);
  if (existsSync(path)) return { available: true, reason: '' };
  return {
    available: false,
    reason: `No ${next} projection: the cited ${next} federal rule release (${next}.FED.1.0.json) does not exist yet. TaxFS never projects on guessed figures.`,
  };
}

/** Deterministic demo prior-year import (same posture as demo documents —
 *  live extraction of a real prior-year PDF arrives with the agent phase). */
export const DEMO_PRIOR_YEAR: { tax_year: number; lines: Record<string, string> } = {
  tax_year: 2024,
  lines: {
    total_income: '48000',
    agi: '48000',
    taxable_income: '33400',
    total_tax: '3760',
    payments: '4100',
    refund_or_due: '340',
  },
};
