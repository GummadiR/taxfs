import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { withSpine, withUserClient } from '@/server/db';
import { filingContext } from '@/server/filing';
import { boardFromRuns, buildOrchestrator } from '@/server/gates';

const GATE_TITLES: Record<number, string> = {
  0: 'Intake integrity', 1: 'Source confirmation', 2: 'Profile consistency',
  3: 'Rule-data validity', 4: 'Computation & tie-outs', 5: 'Advisory review', 6: 'Package readiness',
};

async function runGates() {
  'use server';
  const { userId, ws } = await requireContext();
  const filing = await withUserClient(userId, (client) => filingContext(client, ws.workspace_id));
  if (!filing) redirect('/get-started');
  await withSpine({ userId, workspaceId: ws.workspace_id }, async (spine) => {
    await buildOrchestrator(spine, filing).runAll();
  });
  redirect('/gates');
}

export default async function GatesBoard() {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const { gateRuns } = await withSpine({ userId, workspaceId: ws.workspace_id }, (spine) =>
    spine.inspect(ws.workspace_id));
  const board = boardFromRuns(gateRuns);
  return (
    <main>
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-black">Gates Board</h1>
        <form action={runGates}>
          <button className="rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white" data-testid="run-gates">
            Run gates
          </button>
        </form>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        Gates 0–4 and 6 block on any error; gate 5 warns and never blocks a lawful return.
      </p>
      {board.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500" data-testid="gates-empty">Gates have not run yet.</p>
      ) : (
        <table className="mt-4 w-full text-sm" data-testid="gates-board">
          <thead><tr className="text-left text-xs text-slate-500"><th>Gate</th><th>Jurisdiction</th><th>Result</th><th>Findings</th></tr></thead>
          <tbody>
            {board.map((cell) => (
              <tr key={`${cell.gate}-${cell.jurisdiction}`} className="border-t border-slate-100 align-top">
                <td className="py-1">{cell.gate} — {GATE_TITLES[cell.gate] ?? ''}</td>
                <td>{cell.jurisdiction}</td>
                <td>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${
                    cell.result === 'pass' ? 'bg-green-100 text-green-800'
                    : cell.result === 'warn' ? 'bg-amber-100 text-amber-900'
                    : 'bg-red-100 text-red-800'}`} data-testid={`gate-${cell.gate}-${cell.jurisdiction}`}>
                    {cell.result}
                  </span>
                </td>
                <td className="text-xs">
                  {cell.errors.map((m, i) => <p key={`e${i}`} className="text-red-800">{m}</p>)}
                  {cell.warnings.map((m, i) => <p key={`w${i}`} className="text-amber-900">{m}</p>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
