import { withUserClient } from '@/server/db';

interface Membership { workspace_id: string; display_name: string; role: string }

export async function MembersList({
  memberships,
  userId,
  openAction,
}: {
  memberships: Membership[];
  userId: string;
  openAction: (formData: FormData) => Promise<void>;
}) {
  const owned = memberships.filter((m) => m.role === 'owner');
  if (owned.length === 0) return null;
  const rows = await withUserClient(userId, async (client) => {
    const r = await client.query(
      `select workspace_id, user_id, role from workspace_members
        where workspace_id = any($1) order by workspace_id, role, user_id`,
      [owned.map((m) => m.workspace_id)],
    );
    return r.rows as { workspace_id: string; user_id: string; role: string }[];
  });
  const nameOf = new Map(memberships.map((m) => [m.workspace_id, m.display_name]));
  return (
    <ul className="mt-2 space-y-1 text-sm" data-testid="member-list">
      {rows.map((r) => (
        <li key={`${r.workspace_id}:${r.user_id}`} className="flex items-center justify-between rounded border border-slate-100 px-2 py-1">
          <span>
            <span className="font-semibold">{nameOf.get(r.workspace_id)}</span>
            <span className="ml-2 font-mono text-xs">{r.user_id}</span>
            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs">{r.role}</span>
            {r.user_id === userId ? <span className="ml-1 text-xs text-slate-400">(you)</span> : null}
          </span>
          {r.user_id !== userId ? (
            <form action={openAction}>
              <input type="hidden" name="workspace_id" value={r.workspace_id} />
              <input type="hidden" name="user_id" value={r.user_id} />
              <button className="text-xs text-red-700 underline">Remove</button>
            </form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
