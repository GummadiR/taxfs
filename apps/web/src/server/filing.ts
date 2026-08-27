/**
 * Filing context + settings. Settings are a REAL table keyed
 * (workspace_id, tax_year, key) — the §4 fix for the P91 magic-source-row
 * class — and the filing context row is what Get Started writes.
 */
import type pg from 'pg';
import type { FilingContext, FilingStatus } from '@taxfs/shared';
import { TAX_YEAR } from './env';
import { releases } from './rules';

const STATUSES: readonly FilingStatus[] = ['single', 'mfj', 'mfs', 'hoh', 'qss'];

export function parseFilingStatus(raw: string): FilingStatus {
  if ((STATUSES as readonly string[]).includes(raw)) return raw as FilingStatus;
  throw new Error(`unknown filing status ${raw}`);
}

export async function readSetting(client: pg.Client, ws: string, key: string): Promise<unknown> {
  const r = await client.query(
    `select value from settings where workspace_id = $1 and tax_year = $2 and key = $3`,
    [ws, TAX_YEAR, key],
  );
  return r.rows[0]?.value;
}

export async function writeSetting(client: pg.Client, ws: string, key: string, value: unknown): Promise<void> {
  await client.query(
    `insert into settings (workspace_id, tax_year, key, value) values ($1, $2, $3, $4::jsonb)
     on conflict (workspace_id, tax_year, key) do update set value = excluded.value`,
    [ws, TAX_YEAR, key, JSON.stringify(value)],
  );
}

export async function saveFilingChoices(
  client: pg.Client,
  ws: string,
  input: { filing_status: FilingStatus; il_exemption_count: number; addl_std_boxes: number },
): Promise<void> {
  await writeSetting(client, ws, 'filing_status', input.filing_status);
  await writeSetting(client, ws, 'il_exemption_count', input.il_exemption_count);
  await writeSetting(client, ws, 'addl_std_boxes', input.addl_std_boxes);
  for (const jurisdiction of ['FED', 'IL'] as const) {
    await client.query(
      `insert into filing_contexts (workspace_id, tax_year, jurisdiction, filing_status, rule_version)
       values ($1, $2, $3, $4, $5)
       on conflict (workspace_id, tax_year, jurisdiction, entity_id)
         do update set filing_status = excluded.filing_status, rule_version = excluded.rule_version`,
      [ws, TAX_YEAR, jurisdiction,
       input.filing_status,
       jurisdiction === 'FED' ? releases().fedRules.rule_version : releases().ilRules.rule_version],
    );
  }
}

/** null until Get Started has been completed for the year. */
export async function filingContext(client: pg.Client, ws: string): Promise<FilingContext | null> {
  const status = (await readSetting(client, ws, 'filing_status')) as string | undefined;
  if (!status) return null;
  const ilCount = (await readSetting(client, ws, 'il_exemption_count')) as number | undefined;
  const boxes = (await readSetting(client, ws, 'addl_std_boxes')) as number | undefined;
  return {
    taxpayer_id: ws,
    tax_year: TAX_YEAR,
    filing_status: parseFilingStatus(status),
    il_exemption_count: ilCount ?? 1,
    addl_std_boxes: boxes ?? 0,
    rule_versions: { FED: releases().fedRules.rule_version, IL: releases().ilRules.rule_version },
  };
}
