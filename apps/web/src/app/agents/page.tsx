import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { withUserClient } from '@/server/db';
import { listTraces, groupTraces } from '@/server/agent-log';

export const dynamic = 'force-dynamic';

/**
 * What the AI read.
 *
 * This screen used to be "Agent traces": one row per model call, keyed on an
 * input hash, which is the shape the LOG has and not a shape anyone can act
 * on. A hash repeated down the page is the single most informative thing
 * here and it read as noise.
 *
 * Repeats are not noise. A re-scan reuses the document's own id and stored
 * file, so its prompt is byte-identical to the first read and lands on the
 * same input hash. That makes the hash a natural grouping key: one group is
 * ONE DOCUMENT, and the group's size is how many times it has been read.
 *
 * The question worth answering then is whether those reads AGREED. The sink
 * already stores an output hash next to every call (a hash, never the text —
 * the S2 privacy discipline is unchanged), so equal output hashes across a
 * group mean the model returned exactly the same answer and the re-scan
 * changed nothing. Different ones mean the same document read two ways, and
 * the operator should look at its values before confirming them.
 *
 * PRIVACY: this reads only what the sink stores — hashes, lengths, model ids
 * and validation verdicts. No prompt text, no document content, and no way
 * to join back to a document name, which is why a group is identified by
 * what it is (a document read N times) rather than by which document.
 */

/** Operator-facing names. The log stores the harness's own agent ids. */
const AGENT_LABELS: Record<string, { title: string; what: string }> = {
  extraction: { title: 'Read a document', what: 'Classified an uploaded document and pulled its boxes out' },
  extraction_simple: { title: 'Read a document', what: 'Classified an uploaded document and pulled its boxes out' },
  notice_extraction: { title: 'Read an IRS notice', what: 'Classified a notice letter and pulled out what it asks for' },
  interview: { title: 'Asked an interview question', what: 'Chose the next question to put to you' },
  discovery: { title: 'Looked for missing documents', what: 'Compared this year against what it expected to see' },
  explanation: { title: 'Explained a line', what: 'Wrote the plain-English note behind a computed line' },
};

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export default async function AiActivity() {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const traces = await withUserClient(userId, (client) => listTraces(client, ws.workspace_id));
  const groups = groupTraces(traces);
  const reread = groups.filter((g) => g.calls > 1);
  const disagreed = groups.filter((g) => g.answers > 1);
  const failed = groups.filter((g) => g.rejected > 0);

  return (
    <main>
      <h1 className="text-xl font-black">AI activity</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Every model call this workspace has made, grouped by what was read. A document re-scanned three
        times is one row that says <span className="font-semibold">read 3×</span>, not three rows. Nothing
        here becomes a number on your return: a read only ever produces a proposal you confirm in Documents.
      </p>
      <p className="mt-1 max-w-3xl text-xs text-slate-500">
        Hashes and verdicts only — the prompt text and the model&rsquo;s answer are never stored, so this page
        can say that two reads of a document disagreed but not what either of them said. Empty until live
        extraction runs; the offline paths spend no calls.
      </p>

      {groups.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500" data-testid="traces-empty">
          No AI calls recorded. Nothing has been read by a model in this workspace.
        </p>
      ) : (
        <>
          <dl className="mt-4 flex flex-wrap gap-6 rounded border border-slate-200 bg-slate-50 p-3" data-testid="ai-activity-summary">
            <div>
              <dt className="text-xs text-slate-500">Model calls</dt>
              <dd className="text-lg font-black tabular-nums">{traces.length}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Distinct things read</dt>
              <dd className="text-lg font-black tabular-nums">{groups.length}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Read more than once</dt>
              <dd className="text-lg font-black tabular-nums">{reread.length}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Re-reads that disagreed</dt>
              <dd className={`text-lg font-black tabular-nums ${disagreed.length > 0 ? 'text-amber-700' : ''}`}>
                {disagreed.length}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Rejected by validation</dt>
              <dd className={`text-lg font-black tabular-nums ${failed.length > 0 ? 'text-amber-700' : ''}`}>
                {failed.length}
              </dd>
            </div>
          </dl>

          {disagreed.length > 0 ? (
            <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="ai-activity-disagreement">
              {disagreed.length === 1 ? 'One document was' : `${disagreed.length} documents were`} read more than
              once and the reads did not agree. Check those values against the paper before you confirm them in
              Documents — a re-scan that changes an answer means the document was hard to read, not that the
              newer answer is right.
            </p>
          ) : null}

          <table className="mt-4 w-full text-sm" data-testid="traces-table">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="py-1">What the AI did</th>
                <th>Reads</th>
                <th>Agreement</th>
                <th>Outcome</th>
                <th>Last read</th>
                <th>Model</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const label = AGENT_LABELS[g.agent] ?? { title: g.agent, what: 'Model call' };
                return (
                  <tr key={g.key} className="border-t border-slate-100 align-top">
                    <td className="py-1.5">
                      <div className="font-semibold">{label.title}</div>
                      <div className="text-xs text-slate-500">{label.what}</div>
                      <div className="font-mono text-[10px] text-slate-400" title="Identifies the input without revealing it">
                        {g.input_hash}
                      </div>
                    </td>
                    <td className="tabular-nums">
                      {g.calls}×
                      {g.calls > 1 ? <div className="text-xs text-slate-500">first {when(g.first)}</div> : null}
                    </td>
                    <td>
                      {g.calls === 1 ? (
                        <span className="text-xs text-slate-400">read once</span>
                      ) : g.answers > 1 ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                          {g.answers} different answers
                        </span>
                      ) : (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                          every read agreed
                        </span>
                      )}
                    </td>
                    <td>
                      {g.rejected > 0 ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                          rejected — the answer was never used
                        </span>
                      ) : g.retried > 0 ? (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                          accepted after {g.retried} retry
                        </span>
                      ) : (
                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800">accepted</span>
                      )}
                      {g.issues.length > 0 ? (
                        <ul className="mt-1 list-disc pl-4 text-xs text-slate-600">
                          {g.issues.map((m) => <li key={m}>{m}</li>)}
                        </ul>
                      ) : null}
                    </td>
                    <td className="text-xs">{when(g.last)}</td>
                    <td className="text-xs text-slate-500">{g.model}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
