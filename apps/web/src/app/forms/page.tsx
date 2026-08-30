/**
 * Printable return view (TaxOS P7.2, ported): every resolved form with its
 * populated lines — a DRAFT rendering of the current confirmed facts. The
 * locked package on File It stays the artifact of record. Print with the
 * browser (Cmd/Ctrl+P) — the page is print-styled.
 */
import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { getFormsView } from '@/server/views';
import { PageHelp } from '@/components/pagehelp';

export default async function FormsView() {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const dto = await getFormsView(userId, ws.workspace_id);
  return (
    <main className="max-w-3xl space-y-6 print:max-w-none">
      <div className="print:hidden">
        <h1 className="text-xl font-black">Forms (draft)</h1>
        <p className="mb-2 text-sm text-slate-600">
          The return as form lines — every amount is a kernel-emitted total with lineage; the mapping layer does
          no math. Use your browser&apos;s Print for a paper copy; the locked package on File It remains the filing
          artifact of record.
        </p>
        <PageHelp
          what={'The draft return rendered as form lines (1040, schedules, IL-1040) — a preview of what will print. Every value is calculation-backed; the mapping layer does no math.'}
          doThis={[
            'Click a form header to expand or collapse it; the headline number shows while collapsed.',
            'Use “Preview official PDF” to see the draft on the REAL government form (mapped forms only).',
            'Anything missing or off, fix at the source (Documents / Review), not here — the locked package on File It stays the official artifact.',
          ]}
        />
      </div>

      {dto.defects.length > 0 ? (
        <section className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800" data-testid="forms-defects">
          <h2 className="font-bold">Mapping defects (fix upstream — never patched here)</h2>
          <ul className="mt-1 list-disc pl-4">
            {dto.defects.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {dto.forms.length === 0 ? (
        <p className="text-sm text-slate-500" data-testid="forms-empty">
          Nothing to render yet — add data and confirm it first.
        </p>
      ) : (
        dto.forms.map((f, i) => (
          <details
            key={`${f.jurisdiction}:${f.form_id}`}
            className="break-inside-avoid rounded border border-slate-300 bg-white p-4 text-sm"
            data-testid={`form-${f.form_id}`}
            open={i === 0 || f.form_id === 'IL1040'}
          >
            <summary className="flex cursor-pointer list-none items-baseline justify-between border-b border-slate-300 pb-1">
              <span>
                <span className="font-black">{f.form_id}</span>
                <span className="ml-2 text-xs text-slate-500">{f.headline}</span>
              </span>
              <span className="flex items-center gap-2 text-xs text-slate-500">
                {f.jurisdiction} · {f.revision}
                {f.pdf_available ? (
                  <a
                    className="rounded border border-slate-400 px-2 py-0.5 underline"
                    href={`/api/formpdf?form_id=${encodeURIComponent(f.form_id)}`}
                    target="_blank"
                    rel="noreferrer"
                    data-testid={`formpdf-${f.form_id}`}
                  >
                    Preview official PDF ↗
                  </a>
                ) : (
                  <span
                    className="rounded bg-amber-100 px-1.5 text-amber-800"
                    title="The official template for this form has not been dropped in yet — the line view below is the draft."
                  >
                    official PDF pending
                  </span>
                )}
              </span>
            </summary>
            <table className="mt-2 w-full text-xs">
              <tbody>
                {f.lines.map((l) => (
                  <tr key={l.line_id} className="border-b border-dotted border-slate-200">
                    <td className="py-1 pr-2 font-mono text-slate-500">{l.line_id}</td>
                    <td className="py-1 pr-2">{l.label}</td>
                    <td className="py-1 text-right font-mono">{l.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))
      )}
    </main>
  );
}
