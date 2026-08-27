import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { withSpine, withUserClient } from '@/server/db';
import { TAX_YEAR } from '@/server/env';
import {
  DEMO_PRIOR_YEAR,
  HEADLINE_LINES,
  historyTable,
  projectionStatus,
  upsertHistoryLine,
} from '@/server/history';
import { YearBars } from './chart';

async function addLine(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const year = Number(formData.get('year'));
  const line = String(formData.get('line'));
  const value = String(formData.get('value') ?? '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) throw new Error('value must be a plain dollar figure');
  await withUserClient(userId, (client) => upsertHistoryLine(client, ws.workspace_id, year, line, value, null));
  redirect('/history');
}

async function importDemo() {
  'use server';
  const { userId, ws } = await requireContext();
  await withUserClient(userId, async (client) => {
    for (const [line, value] of Object.entries(DEMO_PRIOR_YEAR.lines)) {
      await upsertHistoryLine(client, ws.workspace_id, DEMO_PRIOR_YEAR.tax_year, line, value, null);
    }
  });
  redirect('/history');
}

export default async function History() {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const facts = await withSpine({ userId, workspaceId: ws.workspace_id }, (spine) =>
    spine.getFacts({ taxpayer_id: ws.workspace_id, tax_year: TAX_YEAR }));
  const table = await withUserClient(userId, (client) => historyTable(client, ws.workspace_id, facts));
  const projection = projectionStatus(process.cwd().endsWith('apps/web') ? `${process.cwd()}/../..` : process.cwd());
  const priorYears = Array.from({ length: 6 }, (_, i) => TAX_YEAR - 1 - i);
  return (
    <main>
      <h1 className="text-xl font-black">Tax History</h1>
      <p className="mt-1 text-sm text-slate-600">
        Prior-year headline lines side by side with this year&apos;s computed return. Prior years are typed from
        your filed returns for now — importing a prior-year PDF arrives with the extraction phase.
      </p>
      {table.years.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500" data-testid="history-empty">No history yet — add a prior year below.</p>
      ) : (
        <>
          <table className="mt-4 w-full text-sm" data-testid="history-table">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th>Line</th>
                {table.years.map((y) => (
                  <th key={y} className="text-right">{y}{y === TAX_YEAR ? ' (this return)' : ''}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {HEADLINE_LINES.map((h) => (
                <tr key={h.line} className="border-t border-slate-100">
                  <td className="py-1">{h.label}</td>
                  {table.years.map((y) => (
                    <td key={y} className="text-right font-mono text-xs">
                      {table.cells[h.line]?.[y] ? Intl.NumberFormat('en-US').format(Number(table.cells[h.line]![y])) : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-500" data-testid="projection-note">{projection.available ? '' : projection.reason}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-3" data-testid="history-charts">
            {HEADLINE_LINES.filter((h) => table.years.some((y) => table.cells[h.line]?.[y])).map((h) => (
              <YearBars
                key={h.line}
                label={h.label}
                points={table.years
                  .filter((y) => table.cells[h.line]?.[y] !== undefined)
                  .map((y) => ({ year: y, value: table.cells[h.line]![y]! }))}
              />
            ))}
          </div>
        </>
      )}
      <section className="mt-6">
        <h2 className="font-bold">Add a prior-year line</h2>
        <form action={addLine} className="mt-2 flex flex-wrap gap-2 text-sm">
          <select name="year" className="rounded border border-slate-300 p-2" data-testid="history-year">
            {priorYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select name="line" className="rounded border border-slate-300 p-2" data-testid="history-line">
            {HEADLINE_LINES.map((h) => <option key={h.line} value={h.line}>{h.label}</option>)}
          </select>
          <input name="value" required placeholder="Amount" inputMode="decimal"
            className="w-32 rounded border border-slate-300 p-2" data-testid="history-value" />
          <button className="rounded bg-slate-900 px-3 py-2 font-semibold text-white">Add</button>
        </form>
        <form action={importDemo} className="mt-2">
          <button className="rounded border border-slate-300 px-3 py-2 text-sm" data-testid="history-demo">
            Import demo {DEMO_PRIOR_YEAR.tax_year} return (synthetic figures)
          </button>
        </form>
      </section>
    </main>
  );
}
