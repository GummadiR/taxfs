/**
 * P6.2 — Structured data entry: K-1s, brokerage lots, 1095-A. Every form
 * feeds registered concepts only (free-form ids are rejected by the
 * action); each submit becomes ONE manual source, deletable as a unit from
 * Documents → Manual entries.
 *
 * P14.3 — upload-driven: what the uploaded documents already answered shows
 * as DETECTED cards that ask only for the recipient-side facts no document
 * carries (completion families — nothing double-counts).
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { getAddData } from '@/server/add-data';
import {
  computeCarryoversFrom2024 as runWorksheet,
  lookupFxRate as runFxLookup,
  structuredEntry as saveStructured,
} from '@/server/structured';
import { PageHelp } from '@/components/pagehelp';
import { SubmitButton } from '@/components/submit-button';

// Stateless action wrappers: run as the authenticated user, surface the
// outcome via ?msg= (the workspaces-page idiom; no flash cookie).
async function structuredEntry(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const msg = await saveStructured(userId, ws.workspace_id, formData);
  redirect(`/data?msg=${encodeURIComponent(msg)}`);
}

async function computeCarryoversFrom2024(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const msg = await runWorksheet(userId, ws.workspace_id, formData);
  redirect(`/data?msg=${encodeURIComponent(msg)}`);
}

async function lookupFxRate() {
  'use server';
  const { userId, ws } = await requireContext();
  const msg = await runFxLookup(userId, ws.workspace_id);
  redirect(`/data?msg=${encodeURIComponent(msg)}`);
}

/** Hover the label (or the ⓘ) to see where the number comes from. */
function Hint({ hint }: { hint?: string }) {
  if (!hint) return null;
  return (
    <span className="ml-0.5 cursor-help text-slate-400" title={hint} aria-label={hint}>
      ⓘ
    </span>
  );
}

function Amount({ name, label, required = false, hint, defaultValue }: { name: string; label: string; required?: boolean; hint?: string; defaultValue?: string }) {
  return (
    <label className="block text-xs" title={hint}>
      {label}
      {required ? ' *' : ''}
      <Hint hint={hint} />
      <input
        name={name}
        inputMode="decimal"
        defaultValue={defaultValue}
        className="mt-1 block w-36 rounded border p-1"
        data-testid={`field-${name}`}
      />
    </label>
  );
}

function ZeroOne({ name, label, defaultValue, hint }: { name: string; label: string; defaultValue: string; hint?: string }) {
  return (
    <label className="block text-xs" title={hint}>
      {label}
      <Hint hint={hint} />
      <select name={name} defaultValue={defaultValue} className="mt-1 block rounded border p-1" data-testid={`field-${name}`}>
        <option value="1">yes</option>
        <option value="0">no</option>
      </select>
    </label>
  );
}

export default async function DataEntry({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const { msg } = await searchParams;
  const detected = await getAddData(userId, ws.workspace_id);
  return (
    <main className="space-y-6">
      <h1 className="text-xl font-black">Add data</h1>
      {msg ? <p className="rounded border border-sky-300 bg-sky-50 p-2 text-sm" role="status" data-testid="data-msg">{msg}</p> : null}
      <PageHelp
        what={'Structured entry for personal-return items that need more than one number: K-1s from your S-corps/partnerships, brokerage sale lots, and marketplace insurance (1095-A). UPLOAD FIRST on Documents — anything a document answers fills in here automatically, and this page only asks for what no document carries.'}
        doThis={[
          'Upload K-1s / brokerage statements / 1095-A on Documents and confirm the extracted values.',
          'Answer the follow-up questions in the “Detected from your documents” cards (basis, participation — YOUR facts, not the paper\'s).',
          'Use the blank cards only for items with no scannable document.',
        ]}
      />
      <p className="text-sm text-slate-600">
        Upload first — enter manually only what has no document. Each saved card shows up under Documents →
        Manual entries and can be deleted there as one unit. Your businesses (S-corps / partnerships) file
        separately on Business Filing — what belongs HERE is the K-1 each one sends you.
      </p>

      {detected.k1s.length > 0 || detected.brokerage.length > 0 || detected.ptc.detected ? (
        <section className="rounded border border-emerald-300 bg-emerald-50 p-4 text-sm" data-testid="detected-panel">
          <h2 className="font-bold">Detected from your documents</h2>
          <p className="mt-1 text-xs text-slate-600">
            Everything your uploads carry is already counted — nothing here needs re-typing. The few questions
            below exist because they are facts <strong>only you know</strong>, which no tax document anywhere
            carries: what you originally paid for something (your basis), whether you actively worked in a
            business, your household size, or which exchange rate to convert at. Answer them once and every
            form computes from there.
          </p>

          {detected.k1s.map((k) => (
            <div key={k.k1_id} className="mt-3 rounded border border-emerald-200 bg-white p-3" data-testid={`detected-k1-${k.k1_id}`}>
              <h3 className="text-xs font-bold">
                K-1 “{k.k1_id}”
                {k.source_title ? <span className="ml-1 font-normal text-slate-500">— from {k.source_title}</span> : null}
              </h3>
              <p className="mt-1 text-xs text-slate-600">
                Already read from the document:{' '}
                {[
                  k.box1 !== null ? `box 1 income ${k.box1}` : null,
                  k.is_scorp !== null ? (k.is_scorp === '1' ? 'S-corp (1120-S)' : 'partnership (1065)') : null,
                  k.capital_gain !== null ? `capital gain ${k.capital_gain}` : null,
                  k.guaranteed_payment !== null ? `partner payment for services (1065 box 4) ${k.guaranteed_payment}` : null,
                ].filter(Boolean).join(' · ') || 'nothing yet'}
              </p>
              <form action={structuredEntry} className="mt-2 flex flex-wrap items-end gap-2">
                <input type="hidden" name="family" value="k1_completion" />
                <input type="hidden" name="k1_id" value={k.k1_id} />
                <Amount
                  name="basis_opening"
                  label="Basis opening"
                  required
                  hint="Your ownership basis at the START of the year: prior-year Form 7203 line 15 (S-corp) or your partnership outside-basis worksheet. First year: what you paid or contributed. The K-1 paper does not carry this — it is YOUR record."
                />
                <ZeroOne
                  name="material_participation"
                  label="Materially participate?"
                  defaultValue="0"
                  hint="Did you work in this business regularly and substantially (e.g. 500+ hours this year)? Passive investors answer no — losses then fall under the passive-activity limits (Form 8582)."
                />
                <Amount name="debt_basis_opening" label="Debt basis (S-corp)" hint="Prior-year Form 7203 Part II — loans YOU personally made to the S-corp. Blank if none." />
                <Amount name="passive_carryover" label="Prior unallowed passive" hint="Prior-year Form 8582 unallowed loss for THIS activity, as a positive number. Blank if none." />
                <Amount name="disposed_entire_interest" label="Entire interest disposed of" hint="Enter 1 if you disposed of your ENTIRE interest in this activity this year in a fully taxable transaction to an unrelated party. §469(g) then frees every suspended loss. Blank otherwise." />
                <ZeroOne name="qbi_eligible" label="Reports §199A items?" defaultValue="1" hint="Does the K-1 include a §199A / QBI statement (1065 box 20 code Z; 1120-S box 17 code V)?" />
                <SubmitButton className="rounded bg-emerald-700 px-3 py-1.5 text-white" data-testid={`complete-k1-${k.k1_id}`}>
                  Save answers
                </SubmitButton>
              </form>
            </div>
          ))}

          {detected.brokerage.map((b) => (
            <div key={b.source_title} className="mt-3 rounded border border-emerald-200 bg-white p-3" data-testid="detected-brokerage">
              <h3 className="text-xs font-bold">Brokerage income — from {b.source_title}</h3>
              <p className="mt-1 text-xs text-slate-600">
                Already counted: {b.concepts.map((c) => `${c.concept} = ${c.value}`).join(' · ')}. Nothing to
                re-enter. Per-lot entry below is only needed when you want lot-level Form 8949 detail.
              </p>
            </div>
          ))}

          {detected.foreign.detected ? (
            <div className="mt-3 rounded border border-emerald-200 bg-white p-3" data-testid="detected-foreign">
              <h3 className="text-xs font-bold">
                Foreign income &amp; tax (Form 1116)
                {detected.foreign.source_title ? <span className="ml-1 font-normal text-slate-500">— from {detected.foreign.source_title}</span> : null}
              </h3>
              <p className="mt-1 text-xs text-slate-600">
                Already read from your certificate:{' '}
                {[
                  detected.foreign.tax_foreign ? `foreign tax withheld ${detected.foreign.tax_foreign}` : null,
                  detected.foreign.has_income ? 'the taxable gain' : null,
                ].filter(Boolean).join(' · ')}{' '}
                (in the document&apos;s own currency — do NOT re-enter anything already listed). The fields
                below are ONLY what is still missing. TaxFS then converts the gain, reports it as US income
                (Schedule D), and computes the Form 1116 credit — Review shows the division and both lines.
                One caution: a prior-year Form 1116 from your CPA is a different year and already in dollars —
                never copy its numbers here.
              </p>
              {detected.foreign.doc_date ? (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600" data-testid="foreign-doc-date">
                  <span>
                    Sale/remittance date read from the certificate:{' '}
                    <strong>{detected.foreign.doc_date}</strong>
                    {detected.foreign.currency ? <> · currency <strong>{detected.foreign.currency}</strong></> : null}
                  </span>
                  <form action={lookupFxRate}>
                    <SubmitButton
                      className="rounded border border-slate-400 px-2 py-0.5 font-semibold hover:bg-slate-50"
                      data-testid="lookup-fx-rate"
                      title="The rate for this date was applied automatically when the certificate was uploaded. Press this only to fetch it again. Sends ONLY the date and the currency code to a public reference-rate service (ECB rates) — never your amounts. To use a different rate, type it into the exchange-rate field instead."
                    >
                      Re-fetch the rate for this date
                    </SubmitButton>
                  </form>
                </div>
              ) : null}
              {detected.foreign.needs_completion || !detected.foreign.has_ltcg ? (
                <form action={structuredEntry} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="family" value="foreign" />
                  {!detected.foreign.has_income ? (
                    <Amount
                      name="income_foreign"
                      label="Taxable gain (foreign currency)"
                      hint="Sale price minus what the property cost you, in the document's currency (e.g. rupees), no commas. NOT the remittance amount — that is the money moved, not the gain; the certificate cannot know what you originally paid."
                    />
                  ) : null}
                  {!detected.foreign.has_ltcg ? (
                    <Amount
                      name="ltcg_foreign"
                      label="Long-term portion"
                      hint="Owned it more than one year? Enter the SAME number as the gain (usual for real estate — including the gain read from your certificate). Owned it a year or less? Leave blank. The long-term part gets the lower US tax rate, which also adjusts the credit limit."
                    />
                  ) : null}
                  {!detected.foreign.has_rate ? (
                    <Amount
                      name="fx_rate"
                      label="Exchange rate (units per USD)"
                      hint="Foreign units per 1 US dollar (for rupees this is a number like 85, not 0.012). The automatic lookup uses the date PRINTED ON THE CERTIFICATE, which for a 15CA/15CB is when the money was REMITTED — often weeks or months after the sale. §1001 wants the rate on the SALE date, so if they differ, type the sale-date rate here and it replaces the looked-up one. The IRS yearly average for the year of sale is equally acceptable. Year-end rates are only for FBAR account balances, not income."
                    />
                  ) : null}
                  <SubmitButton className="rounded bg-emerald-700 px-3 py-1.5 text-white" data-testid="complete-foreign">
                    Save answers
                  </SubmitButton>
                </form>
              ) : (
                <p className="mt-1 text-xs text-slate-600">
                  Gain and exchange rate are in — TaxFS converts the gain, reports it as US income (Schedule
                  D), and computes the Form 1116 credit against it. Both lines show on Review with the
                  division in their lineage.
                </p>
              )}
            </div>
          ) : null}

          {detected.ptc.detected ? (
            <div className="mt-3 rounded border border-emerald-200 bg-white p-3" data-testid="detected-ptc">
              <h3 className="text-xs font-bold">
                Marketplace insurance (1095-A)
                {detected.ptc.source_title ? <span className="ml-1 font-normal text-slate-500">— from {detected.ptc.source_title}</span> : null}
              </h3>
              {detected.ptc.needs_household_size ? (
                <form action={structuredEntry} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="family" value="ptc_household" />
                  <Amount
                    name="household_size"
                    label="Household size"
                    required
                    hint="Your tax family size: you + spouse + dependents claimed on this return. The 1095-A does not carry this."
                  />
                  <SubmitButton className="rounded bg-emerald-700 px-3 py-1.5 text-white" data-testid="complete-ptc">
                    Save answer
                  </SubmitButton>
                </form>
              ) : (
                <p className="mt-1 text-xs text-slate-600">Annual totals and household size are complete — Form 8962 computes from these.</p>
              )}
            </div>
          ) : null}
        </section>
      ) : (
        <p className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600" data-testid="detected-empty">
          Nothing detected from uploads yet. Upload K-1s, brokerage statements, or a 1095-A on{' '}
          <Link className="underline" href="/documents">Documents</Link> and confirm the values — the cards here
          then fill themselves and only ask the follow-up questions no document carries.
        </p>
      )}

      <section className="rounded border border-slate-200 bg-white p-4 text-sm" data-testid="form-k1">
        <h2 className="font-bold">Schedule K-1 (received)</h2>
        <p className="mt-1 text-xs text-slate-500">
          Box 1 ordinary income/loss (use a minus sign for losses). Basis comes from your prior-year 7203 /
          basis worksheet. Capital gain = box 8a/9a/10 pass-through gains.
        </p>
        <form action={structuredEntry} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="family" value="k1" />
          <label className="block text-xs">
            K-1 id *
            <input name="k1_id" placeholder="asap-llc" className="mt-1 block w-32 rounded border p-1" data-testid="field-k1_id" />
          </label>
          <Amount name="box1" label="Box 1 income/(loss)" required hint="K-1 box 1 (ordinary business income or loss). Use a minus sign for a loss, e.g. -2431." />
          <ZeroOne name="is_scorp" label="S-corp?" defaultValue="1" hint="Which K-1 did you get? Form 1120-S K-1 = yes; Form 1065 (partnership/LLC) K-1 = no." />
          <ZeroOne name="material_participation" label="Materially participate?" defaultValue="0" hint="Did you work in this business regularly and substantially (e.g. 500+ hours in the year)? Passive investors answer no — losses then fall under the passive-activity limits (Form 8582)." />
          <Amount name="basis_opening" label="Basis opening" required hint="Your ownership basis at the START of the year: prior-year Form 7203 line 15 (S-corp stock basis) or your partnership outside-basis worksheet. First year: what you paid/contributed. Losses are only allowed up to basis." />
          <Amount name="debt_basis_opening" label="Debt basis (S-corp)" hint="Prior-year Form 7203 Part II (loans YOU personally made to the S-corp — not bank loans). Blank if none." />
          <Amount name="capital_gain" label="Capital gain" hint="K-1 boxes 8a/9a (1065) or 7/8a (1120-S): net long-term capital gain passed through. Flows to Schedule D." />
          <Amount name="passive_carryover" label="Prior unallowed passive" hint="Prior-year Form 8582 Worksheet 5/6 unallowed loss for THIS activity, entered as a positive number. Blank if none." />
                <Amount name="disposed_entire_interest" label="Entire interest disposed of" hint="Enter 1 if you disposed of your ENTIRE interest in this activity this year in a fully taxable transaction to an unrelated party. §469(g) then frees every suspended loss. Blank otherwise." />
          <ZeroOne name="rental_active" label="Rental real estate you actively manage?" defaultValue="0" hint="Yes if this K-1 is a RENTAL REAL ESTATE activity where you make the management decisions (approve tenants, set rents, approve repairs) and own 10%+ — a lower bar than material participation. Unlocks the §469(i) special allowance: up to $25,000 of rental loss deducts against other income, phasing out between $100k and $150k of income." />
          <Amount name="f4797" label="Form 4797 ordinary gain/(loss)" hint="K-1 statement line for §1231/ordinary gain or loss from property sales (1065 box 10; 1120-S box 9). Loss as negative. Reports on Schedule 1 line 4, sharing this activity's basis and passive limits." />
          <Amount name="guaranteed_payment" label="Partner payment for services (1065 box 4)" hint="1065 K-1 box 4a/4b. Ordinary income outside the basis/passive limits; never QBI." />
          <ZeroOne name="qbi_eligible" label="Reports §199A items?" defaultValue="1" hint="Does the K-1 include a §199A / QBI statement (1065 box 20 code Z; 1120-S box 17 code V)? If yes, box 1 feeds the QBI deduction." />
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="save-k1">
            Save K-1
          </SubmitButton>
        </form>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm" data-testid="form-lot">
        <h2 className="font-bold">Brokerage lot (1099-B)</h2>
        <form action={structuredEntry} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="family" value="lot" />
          <label className="block text-xs">
            Lot id *
            <input name="lot_id" placeholder="vti-lot1" className="mt-1 block w-32 rounded border p-1" data-testid="field-lot_id" />
          </label>
          <Amount name="proceeds" label="Proceeds" required hint="1099-B proceeds for this lot (box 1d)." />
          <Amount name="basis" label="Cost basis" required hint="1099-B cost basis for this lot (box 1e)." />
          <label className="block text-xs">
            Term *
            <select name="term" defaultValue="1" className="mt-1 block rounded border p-1" data-testid="field-term">
              <option value="0">short-term</option>
              <option value="1">long-term</option>
            </select>
          </label>
          <Amount name="wash_disallowed" label="Wash-sale disallowed" hint="1099-B box 1g (wash-sale loss disallowed). Blank if none." />
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="save-lot">
            Save lot
          </SubmitButton>
        </form>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm" data-testid="form-ptc">
        <h2 className="font-bold">Marketplace insurance (1095-A)</h2>
        <p className="mt-1 text-xs text-slate-500">
          <span className="font-semibold">What this is:</span> Form 1095-A comes ONLY if you bought health
          insurance through the government Marketplace (healthcare.gov / “Obamacare”) — the Marketplace mails it
          and posts it in your healthcare.gov account each January. It reconciles the premium subsidy on Form
          8962. <span className="font-semibold">If your insurance is through an employer, you never get a 1095-A
          — skip this card entirely.</span> Prefer uploading it on Documents; enter here only if you cannot scan
          it. Annual totals: line 33 columns A / B / C, plus your tax-family size.
        </p>
        <form action={structuredEntry} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="family" value="ptc" />
          <Amount name="annual_premium" label="Premiums (col A)" required hint="1095-A line 33 column A (annual total premiums)." />
          <Amount name="annual_slcsp" label="SLCSP (col B)" required hint="1095-A line 33 column B (annual second-lowest-cost Silver plan premium)." />
          <Amount name="annual_aptc" label="Advance credit (col C)" required hint="1095-A line 33 column C (advance premium tax credit paid to your insurer)." />
          <Amount name="household_size" label="Household size" required hint="Your tax family size: you + spouse + dependents claimed on this return." />
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="save-ptc">
            Save 1095-A
          </SubmitButton>
        </form>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm" data-testid="form-foreign">
        <h2 className="font-bold">Foreign income &amp; foreign tax (Form 1116)</h2>
        <p className="mt-1 text-xs text-slate-500">
          <span className="font-semibold">What this is:</span> income from outside the US that a foreign country
          already taxed — like selling property in India, where the buyer deducts TDS and the transfer is
          documented on Forms 15CA/15CB. The US taxes your worldwide income but credits the foreign tax
          against your US tax on that same income (Form 1116) — you don&apos;t pay twice, up to a limit. Prefer
          uploading the 15CA/15CB (or the foreign tax certificate) on Documents; enter everything in the
          FOREIGN currency plus one exchange rate — TaxFS converts and shows the arithmetic.
        </p>
        <form action={structuredEntry} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="family" value="foreign" />
          <Amount name="income_foreign" label="Taxable gain / income (foreign currency)" required hint="Sale price minus your cost basis (for a property sale), or the gross foreign income — in the FOREIGN currency, e.g. rupees." />
          <Amount name="ltcg_foreign" label="Long-term portion" hint="The part that is long-term capital gain (property held over one year) — usually the whole gain for real estate." />
          <Amount name="tax_foreign" label="Foreign tax paid (foreign currency)" hint="Tax withheld or paid abroad — e.g. Indian TDS u/s 195 from Form 15CB. Same currency as the income." />
          <Amount name="fx_rate" label="Exchange rate (units per USD)" required hint="Foreign units per 1 US dollar. WHICH DATE: use the spot rate on the DATE OF THE SALE (the day the income arose), or the IRS yearly-average rate for the SALE YEAR — either is accepted if used consistently. NEVER the date you file in the US or abroad, and year-end rates are only for FBAR balances. Find both on IRS.gov (search 'yearly average currency exchange rates')." />
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="save-foreign">
            Save foreign income
          </SubmitButton>
        </form>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm" data-testid="form-caploss-carryover">
        <h2 className="font-bold">Capital-loss carryover coming INTO 2025 (from your 2024 return)</h2>
        <p className="mt-1 text-xs text-slate-500">
          <span className="font-semibold">What this is:</span> if your 2024 return had capital losses bigger
          than the IRS let you deduct that year, the unused part carries into 2025 — losses first offset your
          2025 gains without limit; any NET loss left after that deducts against other income only up to
          $3,000 per year ($1,500 married filing separately), and the rest keeps rolling forward year after
          year with <em>no expiration</em> until used. TaxFS applies all of that automatically once you enter
          the two numbers — and computes what carries to 2026 for you.
        </p>
        <ul className="mt-1 list-disc pl-5 text-xs text-slate-500">
          <li>
            <span className="font-semibold">Where to find the numbers:</span> on your 2024 federal return,
            look for the <em>&quot;Capital Loss Carryover Worksheet&quot;</em> (CPA-prepared returns include
            it, often titled &quot;Carryovers to 2025&quot;) — use its
            <span className="font-semibold"> &quot;carryover TO 2025&quot;</span> short-term and long-term
            lines. The amounts you enter here land on your 2025 Schedule D lines 6 and 14.
          </li>
          <li className="font-semibold text-amber-700" data-testid="carryover-trap-warning">
            Do NOT copy lines 6 or 14 from the 2024 Schedule D itself — those are the carryovers that came
            INTO 2024 from 2023, and 2024&apos;s return already used part of them. Entering them here
            double-counts a year. If you only have the 2024 Schedule D (no worksheet), the long-term
            carryover to 2025 is: 2024 line 15 loss − 2024 line 7 gain (if line 7 is a gain) − the loss
            deducted on the 2024 return (up to $3,000); short-term works the same way from line 7.
          </li>
          <li>
            <span className="font-semibold">Short-term vs long-term:</span> short-term = losses from assets
            held one year or less; long-term = held more than a year. Each keeps its character when it
            carries — enter them separately, never combined.
          </li>
          <li>Enter both as <span className="font-semibold">positive numbers</span> — TaxFS knows they are losses.</li>
        </ul>
        {/* P86 — the two routes to the SAME two numbers used to stack
            vertically with no framing, so the helper read as step 1 and the
            entry boxes as a mandatory step 2. They are alternatives: say so,
            and show what is already saved so "done" is visible. */}
        {detected.caploss.st_entries > 1 || detected.caploss.lt_entries > 1 ? (
          /* The kernel SUMS every confirmed fact for a concept, so a
             carryover saved by the worksheet and typed again on Documents is
             subtracted twice. This card used to show only the first entry,
             under a green "nothing further is needed" — which is how a
             doubled carryover stayed invisible while it moved thousands. */
          <p
            className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-900"
            data-testid="caploss-duplicate"
          >
            <span className="font-semibold">Entered more than once — your return is subtracting it twice.</span>{' '}
            {detected.caploss.st_entries > 1 ? `Short-term has ${detected.caploss.st_entries} entries. ` : ''}
            {detected.caploss.lt_entries > 1 ? `Long-term has ${detected.caploss.lt_entries} entries. ` : ''}
            A carryover is ONE figure from the Carryover Worksheet, so a second entry is the same loss counted
            again, not a second source. Open <a className="font-semibold underline" href="/documents">Documents</a>{' '}
            and remove all but one. The gates block filing until you do.
          </p>
        ) : detected.caploss.st !== null || detected.caploss.lt !== null ? (
          <p
            className="mt-2 rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900"
            data-testid="caploss-saved"
          >
            <span className="font-semibold">Already on your return:</span>{' '}
            short-term {detected.caploss.st ?? '0'}, long-term {detected.caploss.lt ?? '0'}
            {detected.caploss.from_worksheet ? ' — computed from your 2024 figures and saved automatically.' : '.'}{' '}
            Nothing further is needed. The boxes below show these values; change one only if it is wrong.
          </p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            Two ways to do this — <span className="font-semibold">either one is enough</span>.
          </p>
        )}

        <p className="mt-2 text-xs font-semibold text-slate-600">
          Option A — you have the &quot;Capital Loss Carryover Worksheet&quot; page: type the two figures below.
        </p>
        <form action={structuredEntry} className="mt-1 flex flex-wrap items-end gap-2">
          <input type="hidden" name="family" value="capital_loss_carryover" />
          <Amount name="st_carryover" defaultValue={detected.caploss.st ?? undefined} label="Short-term carryover (positive)" hint="From the 2024 Capital Loss Carryover Worksheet, the 'short-term capital loss carryover TO 2025' line — NOT line 6 of the 2024 Schedule D (that was 2023's carryover into 2024). If 2024's line 7 was a GAIN, this is zero. Lands on the 2025 Schedule D line 6." />
          <Amount name="lt_carryover" defaultValue={detected.caploss.lt ?? undefined} label="Long-term carryover (positive)" hint="From the same worksheet, the 'long-term capital loss carryover TO 2025' line — NOT line 14 of the 2024 Schedule D (that was 2023's carryover into 2024; entering it double-counts a year). Lands on the 2025 Schedule D line 14." />
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="save-caploss-carryover">
            Save carryovers
          </SubmitButton>
        </form>
        <details className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs" data-testid="carryover-helper">
          <summary className="cursor-pointer font-semibold" data-testid="wk-toggle">
            Option B — you only have the 2024 Schedule D: TaxFS computes both figures for you (no math on your side)
          </summary>
          <p className="mt-1 text-slate-500">
            Type these four numbers exactly as printed on the 2024 return (losses as negative, e.g. -48842).
            TaxFS runs the official IRS worksheet, <span className="font-semibold">saves both carryovers onto
            your return</span>, and keeps these four figures with them as the derivation — so the trail shows
            where the carryover came from. You do not need to retype the result.
          </p>
          <form action={computeCarryoversFrom2024} className="mt-2 flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="block text-slate-500">2024 Form 1040 line 15 (taxable income)</span>
              <input name="wk_taxable_income" className="mt-0.5 w-36 rounded border border-slate-300 p-1 font-mono" autoComplete="off" data-testid="wk-taxable-income" />
            </label>
            <label className="block">
              <span className="block text-slate-500">2024 Sch D line 7 (short-term)</span>
              <input name="wk_line7" className="mt-0.5 w-32 rounded border border-slate-300 p-1 font-mono" autoComplete="off" data-testid="wk-line7" />
            </label>
            <label className="block">
              <span className="block text-slate-500">2024 Sch D line 15 (long-term)</span>
              <input name="wk_line15" className="mt-0.5 w-32 rounded border border-slate-300 p-1 font-mono" autoComplete="off" data-testid="wk-line15" />
            </label>
            <label className="block">
              <span className="block text-slate-500">2024 Sch D line 21 (allowed loss)</span>
              <input name="wk_line21" className="mt-0.5 w-32 rounded border border-slate-300 p-1 font-mono" autoComplete="off" data-testid="wk-line21" />
            </label>
            <SubmitButton className="rounded bg-slate-700 px-3 py-1 text-white" data-testid="wk-compute">
              Compute my carryovers
            </SubmitButton>
          </form>
        </details>
      </section>

    </main>
  );
}
