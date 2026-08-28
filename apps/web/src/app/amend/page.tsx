import Link from 'next/link';
import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import {
  buildAmendment,
  finalizeAmendment,
  getAmendView,
  makeIlCompanion,
  openAmendment,
  type AmendRowDto,
} from '@/server/amend';
import { PageHelp } from '@/components/pagehelp';
import { SubmitButton } from '@/components/submit-button';

const back = (msg: string): never => redirect(`/amend?msg=${encodeURIComponent(msg)}`);

async function openAmendmentAction(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  back(await openAmendment(userId, ws.workspace_id, String(formData.get('reason') ?? ''), String(formData.get('concept') ?? '')));
}

async function buildAmendmentAction(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  back(await buildAmendment(userId, ws.workspace_id, String(formData.get('amend_id') ?? ''),
    String(formData.get('concept_summary') ?? '').trim(), String(formData.get('reference') ?? '').trim()));
}

async function finalizeAmendmentAction(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  back(await finalizeAmendment(userId, ws.workspace_id, String(formData.get('amend_id') ?? '')));
}

async function generateIlCompanionAction(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  back(await makeIlCompanion(userId, ws.workspace_id, String(formData.get('amend_id') ?? '')));
}

const REASON_LABELS: Record<string, string> = {
  user_correction: 'I am correcting something I reported',
  late_doc: 'A document arrived after filing',
  rule_patch: 'The applicable rule set was corrected',
  notice_outcome: 'Reflecting the resolution of an IRS notice',
};

function ColumnsTable({ rows, testid }: { rows: AmendRowDto[]; testid: string }) {
  return (
    <table className="mt-2 w-full text-xs" data-testid={testid}>
      <thead>
        <tr className="text-left text-slate-500">
          <th className="py-1">Line</th>
          <th className="text-right">A · As filed</th>
          <th className="text-right">B · Change</th>
          <th className="text-right">C · Corrected</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.concept} className="border-t border-slate-100" data-testid={`amendrow-${r.concept}`}>
            <td className="py-1">{r.label}</td>
            <td className="text-right font-mono" data-testid={`amendrow-${r.concept}-a`}>{r.col_a}</td>
            <td className="text-right font-mono" data-testid={`amendrow-${r.concept}-b`}>{r.col_b}</td>
            <td className="text-right font-mono" data-testid={`amendrow-${r.concept}-c`}>{r.col_c}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function Amend({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const { msg } = await searchParams;
  const dto = await getAmendView(userId, ws.workspace_id);
  return (
    <main className="max-w-3xl space-y-4">
      <h1 className="text-xl font-black">Amend</h1>
      {msg ? <p className="rounded border border-sky-300 bg-sky-50 p-2 text-sm" role="status" data-testid="amend-msg">{msg}</p> : null}
      <PageHelp
        what={'Corrections AFTER filing. The filed record never changes; a correction opens a case, and the 1040-X columns (as filed / change / corrected) are computed and verified line by line.'}
        doThis={[
          'Open a case naming the value the correction touches.',
          'Make the fix on Review (only the case\'s values unlock), then build the 1040-X columns here.',
          'Finalize federal — the Illinois conformity clock starts — and generate the IL-1040-X companion.',
        ]}
      />
      <p className="text-sm text-slate-600">
        The filed record never changes. A correction opens a case here; column A comes from the return as filed,
        column C from the corrected calculation, and B = C − A is re-verified line by line before anything renders.
        You file the 1040-X yourself — TaxFS does not transmit.
      </p>

      {!dto.filed ? (
        <p className="rounded border border-slate-300 bg-slate-50 p-3 text-sm" data-testid="amend-not-filed">
          Nothing to amend yet: amendments start from a return marked Filed on the{' '}
          <Link className="underline" href="/file-it">File It</Link> page.
        </p>
      ) : (
        <>
          <p className="rounded border border-indigo-300 bg-indigo-50 p-3 text-xs" data-testid="amend-filed-ref">
            Amending {dto.filed.filing_id} (package v{dto.filed.package_version}, filed {dto.filed.filed_date} via{' '}
            {dto.filed.channel === 'paper' ? 'print and mail' : 'e-file channel'}).
          </p>

          <section className="rounded border border-slate-200 bg-white p-3 text-sm">
            <h2 className="font-bold">Open an amendment case</h2>
            <form action={openAmendmentAction} className="mt-2 flex flex-wrap items-end gap-2 text-xs">
              <label className="block">
                <span className="font-semibold">Reason</span>
                <select name="reason" className="mt-1 block rounded border p-1" defaultValue="user_correction" data-testid="amend-reason">
                  {Object.entries(REASON_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="font-semibold">Value the correction touches</span>
                <select name="concept" className="mt-1 block rounded border p-1" data-testid="amend-concept">
                  {dto.source_concepts.map((c) => (
                    <option key={c.concept} value={c.concept}>{c.label}</option>
                  ))}
                </select>
              </label>
              <SubmitButton className="rounded bg-slate-900 px-3 py-1 text-white" data-testid="amend-open">
                Open case
              </SubmitButton>
            </form>
            <p className="mt-2 text-[11px] text-slate-500">
              After opening a case, make the correction on the <Link className="underline" href="/review">Review</Link>{' '}
              page — edits to the case&apos;s value are allowed and recorded on the case.
            </p>
          </section>

          {dto.cases.map((c) => (
            <section key={c.amend_id} className="rounded border border-slate-200 bg-white p-3 text-sm" data-testid={`amend-case-${c.amend_id}`}>
              <h2 className="font-bold">
                Case {c.amend_id} <span className="font-normal text-slate-500">— {REASON_LABELS[c.reason] ?? c.reason} · {c.status}</span>
              </h2>
              <p className="mt-1 text-xs text-slate-600">Covers: {c.concepts.join(', ')}</p>

              {c.delta_facts.length === 0 ? (
                <p className="mt-2 rounded bg-slate-50 p-2 text-xs" data-testid="amend-no-deltas">
                  No correction recorded yet — edit the covered value on the Review page first.
                </p>
              ) : (
                <ul className="mt-2 space-y-1 text-xs" data-testid="amend-deltas">
                  {c.delta_facts.map((d, i) => (
                    <li key={i} className="font-mono">
                      {d.concept}: {d.old_value} → {d.new_value}
                    </li>
                  ))}
                </ul>
              )}

              {c.status === 'draft' ? (
                <form action={buildAmendmentAction} className="mt-3 flex flex-wrap items-end gap-2 rounded bg-slate-50 p-2 text-xs">
                  <input type="hidden" name="amend_id" value={c.amend_id} />
                  <label className="block">
                    <span className="font-semibold">What was corrected</span>
                    <input name="concept_summary" className="mt-1 block w-48 rounded border p-1" placeholder="e.g. interest income" data-testid="amend-summary" />
                  </label>
                  <label className="block">
                    <span className="font-semibold">Reference{c.needs_reference ? '' : ' (optional)'}</span>
                    <input name="reference" className="mt-1 block w-56 rounded border p-1" placeholder="e.g. a corrected 1099-INT" data-testid="amend-reference" />
                  </label>
                  <SubmitButton className="rounded bg-slate-900 px-3 py-1 text-white" data-testid="amend-build">
                    Build 1040-X columns
                  </SubmitButton>
                </form>
              ) : null}

              {c.built ? (
                <>
                  <h3 className="mt-3 text-xs font-bold">Form 1040-X — columns A / B / C</h3>
                  <ColumnsTable rows={c.built.fed_rows} testid="amend-fed-rows" />
                  <p className="mt-2 rounded bg-slate-50 p-2 text-xs" data-testid="amend-statement">
                    <span className="font-semibold">Explanation of changes (pre-approved template): </span>
                    {c.built.explanation}
                  </p>
                  {c.status === 'draft' ? (
                    <form action={finalizeAmendmentAction} className="mt-2">
                      <input type="hidden" name="amend_id" value={c.amend_id} />
                      <SubmitButton className="rounded bg-indigo-700 px-3 py-1 text-xs text-white" data-testid="amend-finalize">
                        Finalize federal amendment
                      </SubmitButton>
                    </form>
                  ) : null}
                </>
              ) : null}

              {c.il_companion ? (
                <div className="mt-3">
                  <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs" data-testid="il-companion-alert">
                    {c.il_companion.alert}
                  </p>
                  {!c.il_companion.generated ? (
                    <form action={generateIlCompanionAction} className="mt-2">
                      <input type="hidden" name="amend_id" value={c.amend_id} />
                      <SubmitButton className="rounded bg-slate-900 px-3 py-1 text-xs text-white" data-testid="il-generate">
                        Generate IL-1040-X companion
                      </SubmitButton>
                    </form>
                  ) : null}
                  {c.il_rows ? (
                    <>
                      <h3 className="mt-3 text-xs font-bold">IL-1040-X — columns A / B / C</h3>
                      <ColumnsTable rows={c.il_rows} testid="amend-il-rows" />
                    </>
                  ) : null}
                </div>
              ) : null}
            </section>
          ))}
        </>
      )}
    </main>
  );
}
