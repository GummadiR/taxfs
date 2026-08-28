'use client';
/**
 * Reset and Delete, for owners only.
 *
 * Three things this component is responsible for, none of which is the
 * security wall — that lives in the database (migration 0005), and this UI
 * would be useless as a guard because anyone can post to a server action:
 *
 *  1. Make the destructive path deliberate. The operator picks the action,
 *     then types the workspace name. A mis-click cannot reach it.
 *  2. Clear the BROWSER's identity vault. Identity never reaches the server
 *     (G9), so the server physically cannot clear it — only this code can,
 *     and a "wipe" that left the SSNs in IndexedDB would be a lie.
 *  3. Report what actually happened, per table. A destructive action that
 *     says only "done" gives the operator nothing to check.
 */
import { useState, useTransition } from 'react';
import { deleteIdentity } from '@/lib/identity/vault';

export interface WorkspaceOption {
  workspace_id: string;
  display_name: string;
}

export interface LifecycleReport {
  action: 'reset' | 'delete';
  display_name: string;
  rows: number;
  by_table: { table: string; rows: number }[];
  documents: number;
  orphaned_documents: string[];
  error?: string;
  /** Set client-side after the server action returns: did the browser vault
   *  actually clear? Never claimed true on a swallowed failure. */
  vault_cleared?: boolean;
}

type Runner = (workspaceId: string, action: 'reset' | 'delete', confirmName: string) => Promise<LifecycleReport>;

export function DangerZone({ owned, run }: { owned: WorkspaceOption[]; run: Runner }) {
  const [workspaceId, setWorkspaceId] = useState(owned[0]?.workspace_id ?? '');
  const [action, setAction] = useState<'reset' | 'delete'>('reset');
  const [typed, setTyped] = useState('');
  const [report, setReport] = useState<LifecycleReport | null>(null);
  const [pending, startTransition] = useTransition();

  if (owned.length === 0) return null;
  const selected = owned.find((w) => w.workspace_id === workspaceId) ?? owned[0]!;
  const armed = typed.trim() === selected.display_name && !pending;

  function onRun() {
    startTransition(async () => {
      const result = await run(selected.workspace_id, action, typed);
      // The vault is per-workspace and lives only here. Clear it on BOTH
      // actions: a reset that left last year's SSN behind would silently
      // repopulate the next return. Whether it ACTUALLY cleared is tracked
      // and reported honestly — a failure (DB corruption, storage eviction)
      // must never be announced as "cleared" while the ciphertext remains.
      let vault_cleared = false;
      if (!result.error) {
        try {
          await deleteIdentity(selected.workspace_id);
          vault_cleared = true;
        } catch {
          vault_cleared = false;
        }
      }
      setReport({ ...result, vault_cleared });
      setTyped('');
    });
  }

  return (
    <section className="mt-8 rounded border border-red-200 bg-red-50/40 p-4" data-testid="danger-zone">
      <h2 className="font-bold text-red-900">Reset or delete a workspace</h2>
      <p className="mt-1 text-xs text-red-900/80">
        Owner-only, and the database enforces it — a reviewer or editor is refused by Postgres,
        not by this page. Both actions also clear the identity stored in this browser.
        The audit log is kept on purpose: the record that a wipe happened survives the wipe.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <select
          className="rounded border border-red-300 bg-white p-2"
          value={selected.workspace_id}
          onChange={(e) => { setWorkspaceId(e.target.value); setTyped(''); setReport(null); }}
          data-testid="danger-workspace"
        >
          {owned.map((w) => (
            <option key={w.workspace_id} value={w.workspace_id}>{w.display_name}</option>
          ))}
        </select>
        <select
          className="rounded border border-red-300 bg-white p-2"
          value={action}
          onChange={(e) => { setAction(e.target.value as 'reset' | 'delete'); setReport(null); }}
          data-testid="danger-action"
        >
          <option value="reset">Reset — empty it, keep the workspace and its members</option>
          <option value="delete">Delete — remove the workspace entirely</option>
        </select>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <label className="text-red-900" htmlFor="danger-confirm">
          Type <span className="font-semibold">{selected.display_name}</span> to confirm:
        </label>
        <input
          id="danger-confirm"
          className="rounded border border-red-300 bg-white p-2"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={selected.display_name}
          autoComplete="off"
          data-testid="danger-confirm"
        />
        <button
          type="button"
          onClick={onRun}
          disabled={!armed}
          className="rounded bg-red-700 px-3 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:bg-red-300"
          data-testid="danger-run"
        >
          {pending ? 'Working…' : action === 'reset' ? 'Reset workspace' : 'Delete workspace'}
        </button>
      </div>

      {report ? (
        report.error ? (
          <p className="mt-3 text-sm font-semibold text-red-800" role="alert" data-testid="danger-error">
            {report.error}
          </p>
        ) : (
          <div className="mt-3 rounded border border-red-200 bg-white p-3 text-sm" role="status" data-testid="danger-report">
            <p className="font-semibold text-red-900">
              {report.action === 'reset' ? 'Reset' : 'Deleted'} “{report.display_name}” — {report.rows}{' '}
              {report.rows === 1 ? 'row' : 'rows'} removed
              {report.documents > 0 ? `, ${report.documents} document${report.documents === 1 ? '' : 's'}` : ''}.
            </p>
            {report.by_table.length > 0 ? (
              <ul className="mt-2 grid grid-cols-2 gap-x-6 font-mono text-xs text-slate-700 sm:grid-cols-3">
                {report.by_table.map((t) => (
                  <li key={t.table} className="flex justify-between tabular-nums">
                    <span>{t.table}</span><span>{t.rows}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-slate-600">It was already empty.</p>
            )}
            {report.vault_cleared ? (
              <p className="mt-2 text-xs text-slate-600">
                The identity stored in this browser for this workspace was cleared.
              </p>
            ) : (
              <p className="mt-2 text-xs font-semibold text-red-800" data-testid="danger-vault-failed">
                The identity stored in this browser could NOT be cleared automatically.
                Clear it manually: browser settings → site data for this site → delete.
              </p>
            )}
            {report.orphaned_documents.length > 0 ? (
              <p className="mt-2 text-xs font-semibold text-red-800" data-testid="danger-orphans">
                {report.orphaned_documents.length} stored document(s) could NOT be removed and are still in the
                bucket: {report.orphaned_documents.join(', ')}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-slate-500">
              Reload the page to see the updated workspace list.
            </p>
          </div>
        )
      ) : null}
    </section>
  );
}
