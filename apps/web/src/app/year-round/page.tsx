import { redirect } from 'next/navigation';
import { executeYearClose } from '@taxfs/spine';
import { Money } from '@taxfs/shared';
import { appConfigured, requireContext } from '@/server/context';
import { withSpine, withUserClient } from '@/server/db';
import { readSetting, writeSetting } from '@/server/filing';
import { withPostFiling } from '@/server/postfiling';
import {
  addEstPayment as saveEstPayment,
  getYearRound,
  setPriorYearTax as savePriorYearTax,
  withCaptureStore,
  type CaptureDto,
} from '@/server/yearround';
import { TAX_YEAR } from '@/server/env';
import { PageHelp } from '@/components/pagehelp';
import { SubmitButton } from '@/components/submit-button';

const back = (msg: string): never => redirect(`/year-round?msg=${encodeURIComponent(msg)}`);

async function addMileage(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  try {
    await withCaptureStore(userId, ws.workspace_id, (store) =>
      store.addMileage({
        trip_date: String(formData.get('trip_date') ?? ''),
        purpose: String(formData.get('purpose') ?? ''),
        miles: String(formData.get('miles') ?? '').trim(),
      }));
  } catch (e) {
    back(e instanceof Error ? e.message : String(e));
  }
  redirect('/year-round');
}

async function amendCapture(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  try {
    await withCaptureStore(userId, ws.workspace_id, (store) =>
      store.amend(String(formData.get('record_id')), {
        purpose: String(formData.get('purpose') ?? '').trim() || undefined,
      }));
  } catch (e) {
    back(e instanceof Error ? e.message : String(e));
  }
  redirect('/year-round');
}

async function addReceipt(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  try {
    await withCaptureStore(userId, ws.workspace_id, (store) =>
      store.addReceipt({
        receipt_date: String(formData.get('receipt_date') ?? ''),
        payee: String(formData.get('payee') ?? ''),
        amount: String(formData.get('amount') ?? '').trim(),
        purpose: String(formData.get('purpose') ?? ''),
        photo_ref: `photo://${Date.now()}`,
      }));
  } catch (e) {
    back(e instanceof Error ? e.message : String(e));
  }
  redirect('/year-round');
}

async function addIncomeEntry(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  try {
    await withCaptureStore(userId, ws.workspace_id, (store) =>
      store.addIncome({
        income_date: String(formData.get('income_date') ?? ''),
        source: String(formData.get('source') ?? ''),
        amount: String(formData.get('amount') ?? '').trim(),
      }));
  } catch (e) {
    back(e instanceof Error ? e.message : String(e));
  }
  redirect('/year-round');
}

async function addEstPayment(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const err = await saveEstPayment(userId, ws.workspace_id,
    String(formData.get('date') ?? ''), String(formData.get('amount') ?? '').trim());
  if (err) back(err);
  redirect('/year-round');
}

async function setPriorYearTax(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const err = await savePriorYearTax(userId, ws.workspace_id, String(formData.get('amount') ?? '').trim());
  if (err) back(err);
  redirect('/year-round');
}

async function addTranscriptLine(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const concept = String(formData.get('concept') ?? '');
  const value = String(formData.get('transcript_value') ?? '').trim();
  try {
    Money.fromString(value);
  } catch {
    back(`"${value}" is not a valid transcript amount.`);
  }
  await withUserClient(userId, async (client) => {
    const lines = ((await readSetting(client, ws.workspace_id, 'transcript.lines')) as
      { concept: string; label: string; transcript_value: string }[] | undefined) ?? [];
    const next = [...lines.filter((l) => l.concept !== concept), { concept, label: concept, transcript_value: value }];
    await writeSetting(client, ws.workspace_id, 'transcript.lines', next);
  });
  redirect('/year-round?msg=Transcript%20line%20recorded.');
}

async function clearTranscriptLines() {
  'use server';
  const { userId, ws } = await requireContext();
  await withUserClient(userId, (client) => writeSetting(client, ws.workspace_id, 'transcript.lines', []));
  redirect('/year-round');
}

async function closeYearAction() {
  'use server';
  const { userId, ws } = await requireContext();
  const filing = await withPostFiling(userId, ws.workspace_id, (store) => store.latestFiling(ws.workspace_id, TAX_YEAR));
  if (!filing) {
    back('Year close requires a FILED return — lock the package and mark it filed on File It first.');
  }
  // Message computed INSIDE try, redirect OUTSIDE: redirect() works by
  // throwing, so a catch around it would swallow the success redirect and
  // re-redirect with the literal message "NEXT_REDIRECT".
  let msg: string;
  try {
    const closed = await withSpine({ userId, workspaceId: ws.workspace_id }, async (spine) => {
      const facts = await spine.getFacts({ taxpayer_id: ws.workspace_id, tax_year: TAX_YEAR });
      return executeYearClose(spine, ws.workspace_id, TAX_YEAR, filing!.package_id, facts);
    });
    msg = closed.length === 0
      ? 'Year closed — no carryforwards this year.'
      : `Year closed: ${closed.length} register${closed.length === 1 ? '' : 's'} rolled into ${TAX_YEAR + 1} openings.`;
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  back(msg);
}

async function getCarryforwards(userId: string, ws: string): Promise<{ concept: string; value: string }[]> {
  return withSpine({ userId, workspaceId: ws }, async (spine) => {
    const facts = await spine.getFacts({ taxpayer_id: ws, tax_year: TAX_YEAR });
    return facts
      .filter((f) => f.derivation !== undefined && f.concept.endsWith('.out'))
      .map((f) => ({ concept: f.concept, value: f.value.toString() }))
      .sort((a, b) => a.concept.localeCompare(b.concept));
  });
}

function CaptureList({ items, testid }: { items: CaptureDto[]; testid: string }) {
  return (
    <ul className="mt-2 space-y-2" data-testid={testid}>
      {items.map((r) => (
        <li key={r.record_id} className="rounded border border-slate-200 p-2 text-xs" data-testid={`capture-${r.record_id}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{r.date}</span>
            <span>{r.detail}</span>
            <span
              data-testid="substantiation-badge"
              className={
                r.substantiation === 'complete'
                  ? 'rounded bg-emerald-100 px-1.5 font-semibold text-emerald-800'
                  : 'rounded bg-amber-100 px-1.5 font-semibold text-amber-800'
              }
            >
              {r.substantiation}
            </span>
            <span className="text-slate-400">
              v{r.version} · recorded {r.created_at.slice(0, 19).replace('T', ' ')} (immutable)
            </span>
            {r.history_count > 1 ? (
              <span className="text-slate-500" data-testid="history-note">
                {r.history_count} versions retained — history is never rewritten
              </span>
            ) : null}
          </div>
          <p className="mt-1">Purpose: {r.purpose}</p>
          {r.completeness_prompt ? (
            <p className="mt-1 rounded bg-amber-50 p-1.5" data-testid="completeness-prompt">
              {r.completeness_prompt}
            </p>
          ) : null}
          <form action={amendCapture} className="mt-1 flex gap-1">
            <input type="hidden" name="record_id" value={r.record_id} />
            <input
              name="purpose"
              placeholder="corrected purpose (creates a new version)"
              className="w-72 rounded border p-1"
              autoComplete="off"
              data-testid={`amend-purpose-${r.record_id}`}
            />
            <SubmitButton className="rounded border border-slate-400 px-2" data-testid={`amend-save-${r.record_id}`}>
              Amend
            </SubmitButton>
          </form>
        </li>
      ))}
    </ul>
  );
}

export default async function YearRound({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const { msg } = await searchParams;
  const dto = await getYearRound(userId, ws.workspace_id);
  const carryforwards = await getCarryforwards(userId, ws.workspace_id);
  const nextRegisters = await withSpine({ userId, workspaceId: ws.workspace_id }, (spine) =>
    spine.getRegisters(ws.workspace_id, TAX_YEAR + 1));
  return (
    <main className="max-w-3xl space-y-6">
      <h1 className="text-xl font-black">Year-Round</h1>
      {msg ? <p className="rounded border border-sky-300 bg-sky-50 p-2 text-sm" role="status" data-testid="yr-msg">{msg}</p> : null}
      <PageHelp
        what={'Between-filings home: estimated-tax tracking, deduction capture, carryforwards, the year-close roll into next year, and the post-filing IRS transcript check (Gate 13).'}
        doThis={[
          'Record estimated payments and deductible items as they happen during the year.',
          'After the IRS processes your filed return, type your transcript lines here — TaxFS verifies them against what you filed.',
          'Run Year close after filing to roll carryforwards into next year\'s opening balances.',
        ]}
      />
      <p className="text-sm text-slate-600">
        Contemporaneous capture is the product: a record’s evidentiary value is <em>when</em> it was made. Entries are
        append-only — edits create new versions and the original is always retained.
      </p>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-bold">Mileage log</h2>
        <form action={addMileage} className="mt-2 flex flex-wrap items-end gap-2 text-xs">
          <label className="block">
            <span className="font-semibold">Date</span>
            <input name="trip_date" type="date" className="mt-1 block rounded border p-1" defaultValue="2025-03-10" />
          </label>
          <label className="block">
            <span className="font-semibold">Miles</span>
            <input name="miles" className="mt-1 block w-20 rounded border p-1 font-mono" autoComplete="off" data-testid="mileage-miles" />
          </label>
          <label className="block grow">
            <span className="font-semibold">Purpose (who/what/why — specifics make it evidence)</span>
            <input name="purpose" className="mt-1 block w-full rounded border p-1" autoComplete="off" data-testid="mileage-purpose" />
          </label>
          <SubmitButton className="rounded bg-slate-900 px-3 py-1 text-white" data-testid="mileage-add">
            Log trip
          </SubmitButton>
        </form>
        <CaptureList items={dto.mileage} testid="mileage-list" />
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-bold">Receipt vault</h2>
        <form action={addReceipt} className="mt-2 flex flex-wrap items-end gap-2 text-xs">
          <label className="block">
            <span className="font-semibold">Date</span>
            <input name="receipt_date" type="date" className="mt-1 block rounded border p-1" defaultValue="2025-03-10" />
          </label>
          <label className="block">
            <span className="font-semibold">Payee</span>
            <input name="payee" className="mt-1 block rounded border p-1" autoComplete="off" />
          </label>
          <label className="block">
            <span className="font-semibold">Amount</span>
            <input name="amount" className="mt-1 block w-24 rounded border p-1 font-mono" autoComplete="off" />
          </label>
          <label className="block grow">
            <span className="font-semibold">Purpose</span>
            <input name="purpose" className="mt-1 block w-full rounded border p-1" autoComplete="off" />
          </label>
          <SubmitButton className="rounded bg-slate-900 px-3 py-1 text-white">
            Capture receipt
          </SubmitButton>
        </form>
        <CaptureList items={dto.receipts} testid="receipt-list" />
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-bold">Income ledger</h2>
        <p className="mt-1 text-xs text-slate-500">
          A running income record independent of 1099s — no form ≠ no income. It also powers the annualized
          estimated-tax method below.
        </p>
        <form action={addIncomeEntry} className="mt-2 flex flex-wrap items-end gap-2 text-xs">
          <label className="block">
            <span className="font-semibold">Date</span>
            <input name="income_date" type="date" className="mt-1 block rounded border p-1" defaultValue="2025-03-01" data-testid="income-date" />
          </label>
          <label className="block grow">
            <span className="font-semibold">Source</span>
            <input name="source" className="mt-1 block w-full rounded border p-1" autoComplete="off" data-testid="income-source" />
          </label>
          <label className="block">
            <span className="font-semibold">Amount</span>
            <input name="amount" className="mt-1 block w-24 rounded border p-1 font-mono" autoComplete="off" data-testid="income-amount" />
          </label>
          <SubmitButton className="rounded bg-slate-900 px-3 py-1 text-white" data-testid="income-add">
            Record income
          </SubmitButton>
        </form>
        <ul className="mt-2 space-y-1 text-xs" data-testid="income-list">
          {dto.income.map((e) => (
            <li key={e.record_id} className="font-mono">
              {e.income_date} · ${e.amount} · {e.source}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-bold">Estimated tax — both methods, side by side</h2>
        <p className="mt-1 text-xs text-slate-500">{dto.esttax.methods_note}</p>
        <div className="mt-2 flex flex-wrap gap-3 text-xs">
          <form action={setPriorYearTax} className="flex items-end gap-1">
            <label className="block">
              <span className="font-semibold">Prior-year tax (anchor)</span>
              <input name="amount" defaultValue={dto.prior_year_tax} className="mt-1 block w-28 rounded border p-1 font-mono" data-testid="prior-year-tax" />
            </label>
            <SubmitButton className="rounded border border-slate-400 px-2 py-1" data-testid="prior-year-save">
              Save
            </SubmitButton>
          </form>
          <form action={addEstPayment} className="flex items-end gap-1">
            <label className="block">
              <span className="font-semibold">Payment date</span>
              <input name="date" type="date" className="mt-1 block rounded border p-1" defaultValue="2025-04-10" data-testid="payment-date" />
            </label>
            <label className="block">
              <span className="font-semibold">Amount</span>
              <input name="amount" className="mt-1 block w-24 rounded border p-1 font-mono" data-testid="payment-amount" />
            </label>
            <SubmitButton className="rounded border border-slate-400 px-2 py-1" data-testid="payment-add">
              Record payment
            </SubmitButton>
          </form>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          This tracker checks your quarterly safe harbor only — it does not flow onto the return. When you prepare
          the return, enter the year&apos;s total once on Documents → Manual entry → &quot;Federal estimated tax
          payments&quot;.
        </p>
        {dto.esttax.missed_quarters.length > 0 ? (
          <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-800" data-testid="missed-quarter-warning">
            Missed installment{dto.esttax.missed_quarters.length > 1 ? 's' : ''} (Q
            {dto.esttax.missed_quarters.join(', Q')}): an underpayment locked in on a due date cannot be unwound at
            filing time — it only stops growing.
          </p>
        ) : null}
        <table className="mt-2 w-full text-xs" data-testid="esttax-table">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1">Quarter</th>
              <th>Due</th>
              <th>Safe harbor (cum.)</th>
              <th>Annualized (cum.)</th>
              <th>Difference</th>
              <th>Paid (cum.)</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {dto.esttax.quarters.map((q) => (
              <tr key={q.quarter} className="border-t border-slate-100 align-top" data-testid={`esttax-q${q.quarter}`}>
                <td className="py-1">Q{q.quarter}</td>
                <td>{q.due_date}</td>
                <td className="font-mono">${q.safe_harbor_required_cumulative}</td>
                <td className="font-mono">${q.annualized_required_cumulative}</td>
                <td className="font-mono">${q.method_difference}</td>
                <td className="font-mono">${q.paid_cumulative}</td>
                <td>
                  <span
                    className={
                      q.status === 'met'
                        ? 'rounded bg-emerald-100 px-1.5 font-semibold text-emerald-800'
                        : q.status === 'underpaid'
                          ? 'rounded bg-red-100 px-1.5 font-semibold text-red-800'
                          : q.status === 'nudge'
                            ? 'rounded bg-amber-100 px-1.5 font-semibold text-amber-800'
                            : 'rounded bg-slate-100 px-1.5'
                    }
                  >
                    {q.status}
                  </span>
                  <p className="mt-0.5 text-slate-500">{q.note}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm" data-testid="carryforwards">
        <h2 className="font-bold">Carryforwards to next year</h2>
        <p className="mt-1 text-xs text-slate-500">
          Every suspended or carried amount the kernel emitted this year (year-close writes these into the
          registers — wiring is a recorded gap; the amounts themselves are already computed and auditable).
        </p>
        {carryforwards.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">None so far.</p>
        ) : (
          <ul className="mt-2 space-y-0.5 font-mono text-xs">
            {carryforwards.map((c) => (
              <li key={c.concept}>
                {c.concept} = {c.value}
              </li>
            ))}
          </ul>
        )}
        <form action={closeYearAction} className="mt-3">
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-xs text-white" data-testid="close-year">
            Close year (roll registers)
          </SubmitButton>
          <span className="ml-2 text-xs text-slate-500">Requires a FILED return; closed registers are immutable.</span>
        </form>
        {nextRegisters.length > 0 ? (
          <div className="mt-3 border-t border-slate-100 pt-2" data-testid="next-registers">
            <h3 className="text-xs font-bold">Next-year register openings</h3>
            <ul className="mt-1 space-y-0.5 font-mono text-xs">
              {nextRegisters.map((r) => (
                <li key={r.register_id}>
                  {r.kind} · {r.scope_ref} → {Object.entries(r.opening).map(([k, v]) => `${k}=${v}`).join(', ') || '(empty)'}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm" data-testid="transcript-entry">
        <h2 className="font-bold">Post-filing verification (Gate 13)</h2>
        <p className="mt-1 text-xs text-slate-500">
          After the IRS processes your filed return, type the transcript values here. They compare against
          the FILED baseline (nothing filed yet → the gate stays pending; entered lines wait).
        </p>
        <form action={addTranscriptLine} className="mt-2 flex flex-wrap items-end gap-2 text-xs">
          <label className="block">
            Line
            <select name="concept" className="mt-1 block rounded border p-1" data-testid="tr-concept">
              <option value="fed.agi">Adjusted gross income</option>
              <option value="fed.taxable_income">Taxable income</option>
              <option value="fed.tax.liability.total">Total tax</option>
              <option value="fed.withholding.total">Federal withholding</option>
              <option value="fed.refund_or_due">Refund / amount owed</option>
            </select>
          </label>
          <label className="block">
            IRS transcript value
            <input name="transcript_value" inputMode="decimal" className="mt-1 block w-32 rounded border p-1" data-testid="tr-value" />
          </label>
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="tr-add">
            Record line
          </SubmitButton>
          <SubmitButton formAction={clearTranscriptLines} className="rounded border px-3 py-1.5" data-testid="tr-clear">
            Clear all
          </SubmitButton>
        </form>
        <p className="mt-2 text-xs text-slate-500">The Gates Board shows the per-line match result once a filed baseline exists.</p>
      </section>
    </main>
  );
}
