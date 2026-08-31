/**
 * Year-round capture + estimated tax (TaxOS G.5, ported and made durable).
 *
 * TaxOS kept the capture store, estimated payments and prior-year tax in
 * the server session — records whose entire evidentiary value is their
 * contemporaneity were LOST ON RESTART. Here the append-only snapshot
 * persists as settings rows (workspace- and year-scoped, RLS-walled, every
 * write audited), and the store reconstructs verbatim per request.
 */
import {
  CaptureStore,
  estimatedTaxReport,
  loadCaptureRules,
  loadEstTaxRules,
  type CaptureRecord,
  type CaptureSnapshot,
  type EstTaxReport,
} from '@taxfs/defense';
import type { Clock } from '@taxfs/shared';
import { Money } from '@taxfs/shared';
import { withUserClient } from './db';
import { readSetting, writeSetting } from './filing';
import { readFixture } from './rules';
import { TAX_YEAR } from './env';

class RealClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}

const CAPTURE_KEY = 'capture.state';
const PAYMENTS_KEY = 'esttax.payments';
const PRIOR_TAX_KEY = 'esttax.prior_year_tax';

function captureRules() {
  return loadCaptureRules(readFixture(`rules/fixtures/${TAX_YEAR}.CAPTURE-RULES.json`));
}
export function estTaxRules() {
  return loadEstTaxRules(readFixture(`rules/fixtures/${TAX_YEAR}.ESTTAX.json`));
}

/** Hydrate → mutate → persist, one transaction-shaped round trip. */
export async function withCaptureStore<T>(
  userId: string,
  ws: string,
  fn: (store: CaptureStore) => T,
): Promise<T> {
  return withUserClient(userId, async (client) => {
    const snap = ((await readSetting(client, ws, CAPTURE_KEY)) as CaptureSnapshot | undefined) ?? null;
    const store = CaptureStore.fromSnapshot(new RealClock(), captureRules(), snap);
    const result = fn(store);
    await writeSetting(client, ws, CAPTURE_KEY, store.toSnapshot());
    return result;
  });
}

export interface CaptureDto {
  record_id: string;
  chain_id: string;
  version: number;
  created_at: string;
  kind: string;
  date: string;
  purpose: string;
  detail: string;
  substantiation: string;
  completeness_prompt?: string;
  history_count: number;
}

export interface YearRoundDto {
  mileage: CaptureDto[];
  receipts: CaptureDto[];
  income: { record_id: string; income_date: string; source: string; amount: string; created_at: string }[];
  prior_year_tax: string;
  payments: { date: string; amount: string }[];
  esttax: EstTaxReport;
}

function captureDto(r: CaptureRecord, historyCount: number): CaptureDto {
  return {
    record_id: r.record_id,
    chain_id: r.chain_id,
    version: r.version,
    created_at: r.created_at,
    kind: r.kind,
    date: r.kind === 'mileage' ? r.trip_date : r.receipt_date,
    purpose: r.purpose,
    detail: r.kind === 'mileage' ? `${r.miles} miles` : `$${r.amount} · ${r.payee}`,
    substantiation: r.substantiation,
    ...(r.completeness_prompt ? { completeness_prompt: r.completeness_prompt } : {}),
    history_count: historyCount,
  };
}

export async function getYearRound(userId: string, ws: string): Promise<YearRoundDto> {
  return withUserClient(userId, async (client) => {
    const snap = ((await readSetting(client, ws, CAPTURE_KEY)) as CaptureSnapshot | undefined) ?? null;
    const store = CaptureStore.fromSnapshot(new RealClock(), captureRules(), snap);
    const payments = ((await readSetting(client, ws, PAYMENTS_KEY)) as { date: string; amount: string }[] | undefined) ?? [];
    const priorYearTax = ((await readSetting(client, ws, PRIOR_TAX_KEY)) as string | undefined) ?? '0';
    const current = store.current();
    const dto = (r: CaptureRecord) => captureDto(r, store.history(r.chain_id).length);
    return {
      mileage: current.filter((r) => r.kind === 'mileage').map(dto),
      receipts: current.filter((r) => r.kind === 'receipt').map(dto),
      income: store.incomeLedger().map((e) => ({
        record_id: e.record_id,
        income_date: e.income_date,
        source: e.source,
        amount: e.amount,
        created_at: e.created_at,
      })),
      prior_year_tax: priorYearTax,
      payments,
      esttax: estimatedTaxReport({
        rules: estTaxRules(),
        clock: new RealClock(),
        prior_year_tax: priorYearTax,
        payments,
        income_ledger: store.incomeLedger(),
      }),
    };
  });
}

export async function addEstPayment(userId: string, ws: string, date: string, amount: string): Promise<string | null> {
  try {
    Money.fromString(amount);
  } catch {
    return `"${amount}" is not a valid amount.`;
  }
  await withUserClient(userId, async (client) => {
    const payments = ((await readSetting(client, ws, PAYMENTS_KEY)) as { date: string; amount: string }[] | undefined) ?? [];
    payments.push({ date, amount });
    await writeSetting(client, ws, PAYMENTS_KEY, payments);
  });
  return null;
}

export async function setPriorYearTax(userId: string, ws: string, amount: string): Promise<string | null> {
  try {
    Money.fromString(amount);
  } catch {
    return `"${amount}" is not a valid amount.`;
  }
  await withUserClient(userId, (client) => writeSetting(client, ws, PRIOR_TAX_KEY, amount));
  return null;
}
