/**
 * Per-page explainer (TaxOS P12.2, ported verbatim): a native <details> box
 * under each page title saying what the page is and what the user does on
 * it. No client JS.
 */
export function PageHelp({ what, doThis }: { what: string; doThis: string[] }) {
  return (
    <details className="rounded border border-sky-200 bg-sky-50 p-3 text-sm" data-testid="page-help">
      <summary className="cursor-pointer font-semibold text-sky-900">What is this page? What do I do here?</summary>
      <p className="mt-2 text-xs text-slate-700">{what}</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-slate-700">
        {doThis.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </details>
  );
}
