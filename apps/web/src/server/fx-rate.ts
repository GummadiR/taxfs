/**
 * Exchange-rate resolution for foreign-currency certificates (15CA/15CB).
 *
 * P75 — this runs AUTOMATICALLY when such a certificate is uploaded. The
 * certificate states its own date and currency; the rate for that date is a
 * published fact, not a judgement. Asking the filer to press a button
 * contributed no information — the system already had the date, already knew
 * it needed a rate, and already had a deterministic lookup for exactly that
 * date. The button remains only as a re-fetch.
 *
 * REMITTANCE DATE IS NOT ALWAYS THE SALE DATE. A 15CA/15CB certifies money
 * LEAVING India, which routinely happens weeks or months after the sale it
 * arose from — the CA has to certify first. §1001 translates the amount
 * realized at the rate on the date of the SALE. This code (and its own
 * comments, which used to read "remittance / sale date" as though they were
 * one thing) can only see the date the certificate prints, so it uses that
 * and now SAYS which date it used. When the sale was earlier, the filer
 * overrides the rate on Add Data and their figure replaces this one.
 *
 * PRIVACY: only the date and the ISO currency code leave this machine. Never
 * an amount, never identity.
 */
import { C, Money } from '@taxfs/shared';
import type { SourceDoc } from '@taxfs/shared';
import type { SpineBackend } from '@taxfs/spine';

export interface FxLookupResult {
  status: 'saved' | 'no_date' | 'failed';
  message: string;
}

/** Marker prefix so a looked-up rate is distinguishable from a typed one. */
export const FX_LOOKUP_REF = 'fxlookup://';

/**
 * Look up the ECB reference rate for the certificate's own date and SAVE it.
 * Returns a description of what happened; the caller decides whether to
 * surface it. Never throws — a rate service outage must not fail an upload.
 */
export async function resolveFxRateFromCertificate(
  spine: SpineBackend,
  tenant: string,
  taxYear: number,
  sources: readonly SourceDoc[],
): Promise<FxLookupResult> {
  const remit = sources.find((x) => x.type === 'FOREIGN-REMITTANCE');
  const date = remit?.fields['remittance_date'];
  const currency = (remit?.fields['currency_code'] ?? 'INR').toUpperCase();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return {
      status: 'no_date',
      message:
        'No date was read from the certificate, so the exchange rate could not be looked up — enter it on Add Data (the rate on the date of SALE, or the IRS published yearly-average rate for the year of sale).',
    };
  }
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/${date}?base=USD&symbols=${currency}`);
    if (!res.ok) throw new Error(`rate service replied ${res.status}`);
    const data = (await res.json()) as { date: string; rates: Record<string, number> };
    const rate = data.rates[currency];
    if (rate === undefined) throw new Error(`no ${currency} rate published`);

    // The kernel requires EXACTLY one rate: replace any earlier lookup rather
    // than adding a second one, which would refuse the whole return.
    for (const prior of sources.filter((x) => x.raw_ref.startsWith(FX_LOOKUP_REF))) {
      await spine.deleteSource(prior.source_id, { cascade: true });
    }
    const sourceId = `fxlookup-${crypto.randomUUID()}`;
    await spine.registerSource({
      source_id: sourceId,
      taxpayer_id: tenant,
      type: 'USER_ENTRY',
      tax_year: taxYear,
      fields: {
        source: 'European Central Bank reference rate via frankfurter.dev',
        rate_date: data.date,
        certificate_date: date,
        currency_code: currency,
        rate: String(rate),
      },
      ocr_confidence: 1,
      raw_ref: `${FX_LOOKUP_REF}${sourceId}`,
    });
    await spine.confirmSource(sourceId);
    await spine.putSourceFact({
      fact_id: `f:${sourceId}:${C.FOREIGN_FX_RATE}`,
      taxpayer_id: tenant,
      concept: C.FOREIGN_FX_RATE,
      tax_year: taxYear,
      jurisdiction: ['FED'],
      taxpayer_scope: 'primary',
      value: Money.fromString(String(rate)),
      confidence: 1,
      provenance: [{ source_id: sourceId, source_field: 'rate' }],
      confirmed: true,
    });
    const nearest = data.date !== date ? ` (nearest business day to the certificate's ${date})` : '';
    return {
      status: 'saved',
      message:
        `Exchange rate applied automatically: 1 USD = ${rate} ${currency}, the European Central Bank reference rate for ${data.date}${nearest}. ` +
        `CHECK THIS DATE: ${date} is the date printed on the certificate, which for a 15CA/15CB is when the money was REMITTED. ` +
        'If the sale happened earlier, the rate on the SALE date is the one §1001 wants — type it into the exchange-rate field on Add Data and yours replaces this one. ' +
        'The IRS equally accepts its published yearly-average rate for the year of sale. ' +
        'Only the date and the currency code were sent to the rate service — never your amounts.',
    };
  } catch (e) {
    return {
      status: 'failed',
      message:
        `The exchange-rate lookup did not succeed (${e instanceof Error ? e.message : String(e)}). Enter the rate on Add Data — search "IRS yearly average currency exchange rates" and use the ${currency} row for the sale year.`,
    };
  }
}
