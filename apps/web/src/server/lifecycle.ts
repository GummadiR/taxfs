/**
 * Reset and Delete a workspace.
 *
 * The wall is in the database (migration 0005): both operations are refused
 * for anyone who is not an owner, and RLS independently confines them to the
 * caller's own workspaces. Nothing here re-implements that check as the
 * primary guard — this layer exists to (a) name the workspace the operator
 * actually confirmed, so a stale form cannot wipe a different one, and (b)
 * clear the storage bucket, which lives outside Postgres and so cannot be
 * covered by the same transaction.
 *
 * Storage is cleared AFTER the rows are gone. If it fails, the caller is
 * told which objects were left rather than being shown a clean success —
 * a silently orphaned document is exactly the kind of "looked fine" defect
 * the Blueprint's loud-failure rule exists to prevent.
 */
import { resetWorkspace, deleteWorkspace, listWorkspaces } from '@taxfs/spine';
import { requireDbUrl } from './db';
import { supabaseServer } from '@/lib/supabase/server';

export type LifecycleAction = 'reset' | 'delete';

export interface LifecycleOutcome {
  action: LifecycleAction;
  workspace_id: string;
  display_name: string;
  /** Total rows removed across every table. */
  rows: number;
  /** Per-table counts, highest first — shown to the operator verbatim. */
  by_table: { table: string; rows: number }[];
  documents: number;
  /** Storage objects that could NOT be removed. Empty is the success case. */
  orphaned_documents: string[];
}

/** The caller's membership row for this workspace, or null if there is none. */
async function membership(userId: string, workspaceId: string) {
  const all = await listWorkspaces({ connectionString: requireDbUrl() }, userId);
  return all.find((w) => w.workspace_id === workspaceId) ?? null;
}

/**
 * Run a lifecycle action. `confirmName` must equal the workspace's display
 * name: the operator has to type it, so the destructive path cannot be
 * reached by a mis-click or a resubmitted form.
 */
export async function runLifecycle(
  userId: string,
  workspaceId: string,
  action: LifecycleAction,
  confirmName: string,
): Promise<LifecycleOutcome> {
  const member = await membership(userId, workspaceId);
  if (!member) throw new Error('That workspace is not yours.');
  if (member.role !== 'owner') {
    throw new Error(`Only a workspace owner can ${action} a workspace. You are a ${member.role} here.`);
  }
  if (confirmName.trim() !== member.display_name) {
    throw new Error(`Type the workspace name exactly (“${member.display_name}”) to confirm.`);
  }

  const config = { connectionString: requireDbUrl() };
  const result =
    action === 'reset'
      ? await resetWorkspace(config, userId, workspaceId)
      : await deleteWorkspace(config, userId, workspaceId);

  const by_table = Object.entries(result.deleted)
    .map(([table, rows]) => ({ table, rows }))
    .filter((r) => r.rows > 0)
    .sort((a, b) => b.rows - a.rows);

  return {
    action,
    workspace_id: workspaceId,
    display_name: member.display_name,
    rows: by_table.reduce((sum, r) => sum + r.rows, 0),
    by_table,
    documents: result.raw_refs.length,
    orphaned_documents: await clearDocuments(result.raw_refs),
  };
}

/**
 * Remove the workspace's stored documents. Local-operator mode stores no
 * objects (there is no bucket), so this is a no-op there and the refs list
 * is empty; hosted mode removes them as the authenticated user, which the
 * bucket policies allow only for a member of that workspace.
 */
async function clearDocuments(refs: string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const supabase = await supabaseServer();
  if (!supabase) return refs; // no bucket reachable — report, never pretend
  const { data, error } = await supabase.storage.from('documents').remove(refs);
  if (error) return refs;
  const removed = new Set((data ?? []).map((o) => o.name));
  return refs.filter((r) => !removed.has(r));
}
