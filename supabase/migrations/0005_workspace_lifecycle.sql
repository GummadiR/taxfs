-- Workspace lifecycle: Reset (empty it, keep it) and Delete (remove it).
--
-- Operator need: a workspace handed to a tester must be returnable to a known
-- clean state, and a test workspace must be removable entirely — without
-- anyone opening pgAdmin. Both are destructive, so both are OWNER-ONLY and
-- the wall lives in the database, not in the UI.
--
-- Design notes:
--
--  * SECURITY INVOKER, not definer. The functions run as the CALLING user, so
--    row-level security applies to every statement inside them exactly as it
--    would to hand-written SQL. The owner check is therefore defence in
--    depth, not the only wall: even if the check were wrong, RLS still
--    confines every delete to workspaces the caller belongs to. A definer
--    function would have been the opposite trade — one bug away from
--    cross-tenant deletion — so it is deliberately not used here.
--
--  * The role ladder these enforce, and what each is worth:
--      reviewer  refused twice — by the owner check AND by RLS (a reviewer
--                has no delete policy anywhere, so every statement inside
--                would touch 0 rows). This is the tester case, and it is a
--                hard database wall.
--      editor    refused by the owner check. An editor can already delete
--                data rows one at a time (the spine's supersede path needs
--                it), so this is a guard against the one-click wipe, not a
--                new capability wall. Stated plainly rather than overclaimed.
--      owner     allowed.
--
--  * audit_log SURVIVES both operations. It has no foreign key to workspaces
--    precisely so the record that a wipe happened outlives the thing wiped.
--    Each function writes an explicit summary row in the same transaction as
--    its deletes — the row commits with a completed wipe (all-or-nothing),
--    it is not a durable record of failed attempts.
--
--  * log_audit() becomes SECURITY DEFINER (see below) — required, because
--    delete_workspace removes the caller's own membership row, and the audit
--    trigger for that delete fires after the statement, by which time the
--    caller is no longer a member and the append policy would refuse the
--    insert, failing the whole delete. An audit trail the actor can cause to
--    fail is a defect in its own right; this fixes that too.

-- ------------------------------------------------------- audit, unblockable

-- Trigger functions cannot be called directly ("trigger functions can only be
-- called as triggers"), so owning this by the bypassrls role adds no callable
-- bypass surface: it only guarantees the trail is written for rows the caller
-- was already permitted to change.
grant insert on audit_log to taxfs_definer;
grant usage, select on sequence audit_log_seq_seq to taxfs_definer;

create or replace function log_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ws text;
begin
  ws := coalesce(new.workspace_id, old.workspace_id);
  insert into audit_log (workspace_id, actor, action, detail)
  values (ws, coalesce(auth.uid()::text, 'system'),
          lower(tg_op) || ' ' || tg_table_name,
          jsonb_build_object('op', tg_op, 'table', tg_table_name));
  return coalesce(new, old);
end $$;
alter function log_audit() owner to taxfs_definer;

-- ------------------------------------------------- request_budgets, by owner
-- budgets_rw scopes every verb to `user_id = auth.uid()`, which is right for
-- normal use but leaves an owner unable to clear OTHER members' budget rows —
-- so deleting a shared workspace failed on the foreign key from
-- request_budgets. Found by the e2e suite, not by the SQL tests, which had no
-- budget rows to trip over.
--
-- BOTH policies below are required, and the read one is the non-obvious half:
-- a DELETE whose WHERE clause references a column also applies the table's
-- SELECT policies to its target rows (the same trap the 0001 header records
-- for UPDATE). With only a delete policy, the owner's statement still saw
-- just their own row and removed exactly one — no error, one row short. The
-- widened read is a workspace OWNER seeing per-user request counts in their
-- own workspace: strictly less than the tax data they already read, and it
-- carries no identity. Writes stay scoped to the acting user, so the budget
-- still cannot become a write side channel.
create policy budgets_owner_read on request_budgets for select
  using (workspace_id in (select my_workspaces('owner')));
create policy budgets_owner_delete on request_budgets for delete
  using (workspace_id in (select my_workspaces('owner')));

-- ----------------------------------------------------------- the owner check

create or replace function assert_workspace_owner(p_workspace_id text)
returns void language plpgsql stable set search_path = public as $$
begin
  if not exists (
    select 1 from workspace_members
    where workspace_id = p_workspace_id
      and user_id = auth.uid()
      and role = 'owner'
  ) then
    raise exception 'only a workspace owner may do this (workspace %)', p_workspace_id
      using errcode = 'insufficient_privilege';
  end if;
end $$;

-- ------------------------------------------------- the tables a reset clears

-- Deletion ORDER is real knowledge (foreign keys), so the list is explicit
-- rather than derived from the catalog at run time. Its COMPLETENESS is not
-- left to memory: supabase/test/lifecycle.test.ts compares this against
-- every table in the schema carrying a workspace_id.
create or replace function lifecycle_tables() returns text[]
language sql immutable set search_path = public as $$
  select array[
    'findings', 'gate_runs', 'fact_dependencies', 'fact_provenance',
    'calculations', 'tax_facts', 'sources', 'registers', 'filing_contexts',
    'packages', 'history_lines', 'agent_traces', 'request_budgets', 'settings'
  ]
$$;

-- --------------------------------------------------------------------- reset

-- Empties the workspace: every fact, source, calculation, gate run, finding,
-- package, register, history line, agent trace and setting. KEEPS the
-- workspace, its members, and the audit log. Returns the storage refs of any
-- stored documents so the caller can clear the bucket in the same operation.
create or replace function reset_workspace(p_workspace_id text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  refs   text[];
  t      text;
  n      bigint;
  counts jsonb := '{}'::jsonb;
begin
  perform assert_workspace_owner(p_workspace_id);

  select coalesce(array_agg(raw_ref), '{}') into refs
    from sources where workspace_id = p_workspace_id;

  -- Written before the deletes for reading order, but it lives in the SAME
  -- transaction as them (plpgsql has no autonomous transactions): a failed
  -- reset rolls this row back along with every delete. All-or-nothing is
  -- the guarantee here — there is deliberately NO record-of-failed-attempt
  -- claim, because Postgres cannot make one from inside this function.
  insert into audit_log (workspace_id, actor, action, detail)
  values (p_workspace_id, coalesce(auth.uid()::text, 'system'), 'reset workspace',
          jsonb_build_object('documents', coalesce(array_length(refs, 1), 0)));

  -- Ordered children-before-parents; workspace_members is untouched by a
  -- reset and handled separately by a delete. The list lives in
  -- lifecycle_tables() so a catalog test can prove it covers every
  -- workspace-scoped table — a later migration that adds one and forgets
  -- this list fails that test instead of surfacing as a foreign-key error
  -- in front of the operator, which is how request_budgets was found.
  foreach t in array lifecycle_tables() loop
    execute format('delete from %I where workspace_id = $1', t)
      using p_workspace_id;
    get diagnostics n = row_count;
    counts := counts || jsonb_build_object(t, n);
  end loop;

  return jsonb_build_object('raw_refs', to_jsonb(refs), 'deleted', counts);
end $$;

-- -------------------------------------------------------------------- delete

-- Removes the workspace entirely, members included. The audit log survives.
create or replace function delete_workspace(p_workspace_id text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  result jsonb;
begin
  perform assert_workspace_owner(p_workspace_id);
  result := reset_workspace(p_workspace_id);

  insert into audit_log (workspace_id, actor, action, detail)
  values (p_workspace_id, coalesce(auth.uid()::text, 'system'), 'delete workspace', '{}'::jsonb);

  -- ONE statement, deliberately. Deleting the members first would strip the
  -- caller's own membership, and the very next statement's RLS check
  -- (workspaces_delete -> my_workspaces('owner')) would then match nothing,
  -- leaving an orphaned workspace row behind with no error. As a single
  -- statement, both deletes see the snapshot taken before either ran, so the
  -- owner is still an owner; the foreign key from workspace_members is NO
  -- ACTION, whose check fires at end of statement, by which time the children
  -- are gone. Verified by the lifecycle suite, which asserts zero rows remain.
  with cleared_members as (
    delete from workspace_members where workspace_id = p_workspace_id returning 1
  )
  delete from workspaces where workspace_id = p_workspace_id;

  return result;
end $$;

grant execute on function lifecycle_tables()           to authenticated;
grant execute on function assert_workspace_owner(text) to authenticated;
grant execute on function reset_workspace(text)        to authenticated;
grant execute on function delete_workspace(text)       to authenticated;
