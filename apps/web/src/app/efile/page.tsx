import Link from 'next/link';
import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { getEfileSheet } from '@/server/views';
import { PageHelp } from '@/components/pagehelp';

/**
 * E-file companion (TaxOS P11.2, ported). Individuals cannot upload a
 * return file to the IRS (MeF transmission is limited to IRS-authorized
 * providers), so the free e-file path at any income level is the IRS's own
 * Free File Fillable Forms: type these exact values in, reconcile,
 * transmit. Illinois files directly at MyTax Illinois. TaxFS stays the
 * system of record.
 */
export default async function Efile() {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const dto = await getEfileSheet(userId, ws.workspace_id);
  return (
    <main className="max-w-3xl space-y-4">
      <h1 className="text-xl font-black">E-file Sheet</h1>
      <PageHelp
        what={'The e-file companion: individuals cannot upload a return file to the IRS, so this page gives you the exact values to type into the IRS\'s Free File Fillable Forms (federal) and MyTax Illinois (state).'}
        doThis={[
          'Open Free File Fillable Forms (irs.gov) and add the forms listed here; type each value exactly.',
          'STOP before transmitting: their computed refund/owed must match the reconciliation box to the dollar.',
          'File Illinois at mytax.illinois.gov the same way; then lock the package on File It.',
        ]}
      />
      <p className="text-sm text-slate-600">
        The IRS does not accept a return-file upload from individuals — e-filing goes through IRS-authorized
        transmitters. The free path at any income level is the IRS&apos;s own{' '}
        <span className="font-semibold">Free File Fillable Forms</span> (federal) and{' '}
        <span className="font-semibold">MyTax Illinois</span> (state): enter the values below, reconcile the totals,
        and transmit there. TaxFS remains the system of record.
      </p>

      <section className="rounded border border-slate-200 bg-white p-3 text-sm">
        <h2 className="font-bold">Workflow</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
          <li>Create/sign in to Free File Fillable Forms (irs.gov → &quot;Free File Fillable Forms&quot;; opens late January).</li>
          <li>Add each federal form listed below and type the line values exactly as shown.</li>
          <li>Identity fields (names, SSNs, address, bank details) come from your own records — TaxFS never stores them on any server.</li>
          <li className="font-semibold">
            Before transmitting: FFFF computes its own math. Its refund / amount-owed MUST equal the reconciliation
            box below. If it differs by even a dollar, STOP and investigate — do not transmit a number TaxFS
            didn&apos;t compute.
          </li>
          <li>File Illinois separately at MyTax Illinois with the IL values below (same reconciliation rule).</li>
          <li>
            After IRS/IL acceptance, lock the package on <Link className="underline" href="/file-it">File It</Link>.
          </li>
        </ol>
      </section>

      {!dto.has_lines ? (
        <p className="rounded border border-slate-300 bg-slate-50 p-3 text-sm" data-testid="efile-empty">
          No computed lines yet — add documents and run the gates first. The sheet fills itself from the calculated
          return.
        </p>
      ) : (
        <>
          {dto.empty_run ? (
            <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm font-semibold" data-testid="efile-empty-run">
              These numbers come from a run with NO income data — they are all zeros, a leftover snapshot, not
              your return. Add and confirm your documents first; this sheet refreshes from the new computation.
            </p>
          ) : null}
          {dto.reconcile.length > 0 ? (
            <section className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm" data-testid="efile-recon">
              <h2 className="font-bold">Reconciliation targets — must match before you transmit</h2>
              <table className="mt-2 text-xs">
                <tbody>
                  {dto.reconcile.map((r) => (
                    <tr key={r.label}>
                      <td className="pr-4">{r.label}</td>
                      <td className="text-right font-mono font-bold">{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          <section className="rounded border border-slate-200 bg-white p-3 text-sm">
            <h2 className="font-bold">Federal — Free File Fillable Forms</h2>
            {dto.fed_forms.map((f) => (
              <div key={f.form_id} className="mt-3" data-testid={`efile-form-${f.form_id}`}>
                <h3 className="text-xs font-bold">{f.form_id}</h3>
                <table className="mt-1 w-full text-xs">
                  <tbody>
                    {f.lines.map((l) => (
                      <tr key={l.line_id} className="border-t border-slate-100">
                        <td className="py-0.5 font-mono">{l.line_id}</td>
                        <td>{l.label}</td>
                        <td className="text-right font-mono">{l.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>

          <section className="rounded border border-slate-200 bg-white p-3 text-sm" data-testid="efile-il">
            <h2 className="font-bold">Illinois — MyTax Illinois (mytax.illinois.gov)</h2>
            <p className="mt-1 text-xs text-slate-500">
              Illinois lets individuals file the IL-1040 directly online for free.
            </p>
            <table className="mt-2 w-full text-xs">
              <tbody>
                {dto.il_lines.map((l) => (
                  <tr key={l.line_id} className="border-t border-slate-100">
                    <td className="py-0.5 font-mono">{l.line_id}</td>
                    <td>{l.label}</td>
                    <td className="text-right font-mono">{l.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
