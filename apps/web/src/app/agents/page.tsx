import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { withUserClient } from '@/server/db';
import { listTraces } from '@/server/agent-log';

export default async function AgentTraces() {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const traces = await withUserClient(userId, (client) => listTraces(client, ws.workspace_id));
  return (
    <main>
      <h1 className="text-xl font-black">Agent traces</h1>
      <p className="mt-1 text-sm text-slate-600">
        Every model call this workspace has ever made — model, input hash, verdict. Hashes only: prompt and
        output text are never stored. Empty until live extraction runs (the stub paths spend no calls).
      </p>
      {traces.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500" data-testid="traces-empty">No agent calls recorded.</p>
      ) : (
        <table className="mt-4 w-full text-sm" data-testid="traces-table">
          <thead><tr className="text-left text-xs text-slate-500"><th>When</th><th>Agent</th><th>Model</th><th>Input hash</th><th>Verdict</th></tr></thead>
          <tbody>
            {traces.map((t) => (
              <tr key={t.trace_id} className="border-t border-slate-100">
                <td className="py-1 text-xs">{t.ts}</td>
                <td>{t.agent}</td>
                <td className="text-xs">{t.model}</td>
                <td className="font-mono text-xs">{t.input_hash}</td>
                <td>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${t.validation === 'accepted' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-900'}`}>
                    {t.validation}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
