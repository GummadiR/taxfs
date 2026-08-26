-- TaxFS schema v2 (Blueprint §4). Every table: composite workspace-scoped PK
-- (G1 — the P91 class is unrepresentable), RLS ENABLED + FORCED (G2),
-- created_at, and audit coverage. Approved deviations from the Blueprint DDL
-- (operator-acknowledged, see PLAN_OF_RECORD.md):
--   * filing_contexts: entity_id NOT NULL DEFAULT '-' with a plain composite
--     PK — Postgres does not allow coalesce() inside a PK constraint.
--   * workspaces.created_by: closes a bootstrap hole — without it, a
--     membership-insert policy would have to probe workspace_members with an
--     RLS-filtered NOT EXISTS, which would let any user claim ownership of a
--     workspace they cannot see. Creator-only bootstrap instead.
--   * my_workspaces() is SECURITY DEFINER owned by taxfs_definer, a NOLOGIN
--     BYPASSRLS role. With FORCE RLS on every table, a definer helper owned
--     by the table owner would re-enter the very policies that call it and
--     Postgres would raise "infinite recursion detected in policy" (and an
--     UPDATE's WHERE clause applies SELECT policies to its target rows, so
--     owners could never manage members they cannot see). The bypass surface
--     is exactly one fixed, auth.uid()-filtered function — the app role and
--     the table owner still cannot bypass anything; the isolation suite
--     asserts no other role carries BYPASSRLS.
--   * nav_status is security_invoker so RLS applies to the querying user —
--     a plain view would run with owner rights and leak across workspaces.

-- ---------------------------------------------------------------- tables

create table workspaces (
  workspace_id text primary key default 'ws_' || replace(gen_random_uuid()::text, '-', ''),
  display_name text not null,
  created_by   uuid not null default auth.uid(),   -- bootstrap wall (see header)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table workspace_members (
  workspace_id text not null references workspaces,
  user_id      uuid not null,                      -- auth.users
  role         text not null check (role in ('owner','editor','reviewer')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table settings (
  workspace_id text not null references workspaces,
  tax_year     int  not null,
  key          text not null,
  value        jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, tax_year, key)
);

create table sources (
  workspace_id   text not null references workspaces,
  source_id      text not null,
  tax_year       int  not null,
  type           text not null,
  fields         jsonb not null,
  ocr_confidence numeric(5,4) not null,
  raw_ref        text not null,
  review_status  text not null default 'pending'
                 check (review_status in ('pending','confirmed')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, source_id)
);
create index sources_by_year on sources (workspace_id, tax_year);

create table tax_facts (
  workspace_id   text not null references workspaces,
  fact_id        text not null,
  concept        text not null,
  tax_year       int  not null,
  jurisdictions  text[] not null,
  taxpayer_scope text not null,
  value          numeric(16,2) not null,
  unit           text not null default 'USD',
  status         text not null check (status in ('unconfirmed','confirmed','stale')),
  confidence     numeric(5,4) not null,
  derivation_calc_id text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, fact_id)
);
create index tax_facts_lookup on tax_facts (workspace_id, tax_year, concept);

create table fact_provenance (
  workspace_id text not null,
  fact_id      text not null,
  source_id    text not null,
  source_field text not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, fact_id, source_id, source_field),
  foreign key (workspace_id, fact_id)   references tax_facts,
  foreign key (workspace_id, source_id) references sources
);

create table calculations (
  workspace_id   text not null references workspaces,
  calc_id        text not null,
  concept        text not null,
  output_fact_id text not null,
  rule_version   text not null,
  formula_ref    text not null,
  steps          text[] not null,
  value          numeric(16,2) not null,
  created_at     timestamptz not null default now(),
  primary key (workspace_id, calc_id),
  foreign key (workspace_id, output_fact_id) references tax_facts
);
create index calculations_by_output on calculations (workspace_id, output_fact_id);

create table fact_dependencies (
  workspace_id   text not null,
  calc_id        text not null,
  input_fact_id  text not null,
  output_fact_id text not null,
  created_at     timestamptz not null default now(),
  primary key (workspace_id, calc_id, input_fact_id),
  foreign key (workspace_id, calc_id)       references calculations,
  foreign key (workspace_id, input_fact_id) references tax_facts
);
create index fact_deps_input on fact_dependencies (workspace_id, input_fact_id);

create table filing_contexts (
  workspace_id  text not null references workspaces,
  tax_year      int  not null,
  jurisdiction  text not null check (jurisdiction in ('FED','IL')),
  entity_id     text not null default '-',   -- '-' = the personal return
  filing_status text not null check (filing_status in
                  ('single','mfj','mfs','hoh','qss')),
  rule_version  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, tax_year, jurisdiction, entity_id)
);
create index filing_contexts_by_year on filing_contexts (workspace_id, tax_year);

create table gate_runs (
  workspace_id text not null references workspaces,
  run_id       text not null,
  tax_year     int  not null,
  gate         int  not null,
  jurisdiction text not null,
  result       text not null,
  ts           timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, run_id)
);
create index gate_runs_latest on gate_runs (workspace_id, gate, jurisdiction, ts desc);

create table findings (
  workspace_id text not null references workspaces,
  finding_id   text not null,
  gate_run_id  text not null,
  critic_id    text not null,
  severity     text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, finding_id),
  foreign key (workspace_id, gate_run_id) references gate_runs
);
create index findings_by_run on findings (workspace_id, gate_run_id);

create table packages (
  workspace_id   text not null references workspaces,
  package_id     text not null,
  tax_year       int  not null,
  version        int  not null,
  status         text not null check (status in ('draft','locked','filed')),
  manifest       jsonb not null,
  supersedes     text,
  unlock_history jsonb not null default '[]',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, package_id),
  unique (workspace_id, tax_year, version)
);

create table registers (
  workspace_id text not null references workspaces,
  register_id  text not null,
  kind         text not null,
  tax_year     int  not null,
  amount       numeric(16,2) not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, register_id)
);

create table history_lines (
  workspace_id text not null references workspaces,
  tax_year     int  not null,
  line         text not null,
  value        numeric(16,2) not null,
  source_id    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, tax_year, line)
);

create table agent_traces (
  workspace_id text not null references workspaces,
  trace_id     text not null,
  agent        text not null,
  model        text not null,
  input_hash   text not null,
  output       jsonb not null,
  validation   text not null check (validation in ('accepted','rejected','retried')),
  ts           timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, trace_id)
);

create table audit_log (
  workspace_id text not null,
  seq          bigserial,
  actor        text not null,
  action       text not null,
  detail       jsonb not null,
  ts           timestamptz not null default now(),
  primary key (workspace_id, seq)
);
create index audit_by_ws on audit_log (workspace_id, seq desc);

-- ---------------------------------------------------------------- helpers

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'taxfs_definer') then
    create role taxfs_definer nologin bypassrls;
  end if;
end $$;
grant usage on schema auth to taxfs_definer;
grant execute on function auth.uid() to taxfs_definer;

create or replace function my_workspaces(min_role text default 'reviewer')
returns setof text language sql stable security definer
set search_path = public as $$
  select workspace_id from workspace_members
  where user_id = auth.uid()
    and case min_role when 'owner'  then role = 'owner'
                      when 'editor' then role in ('owner','editor')
                      else true end
$$;
alter function my_workspaces(text) owner to taxfs_definer;
grant select on workspace_members to taxfs_definer;   -- BYPASSRLS skips policies, not grants

create or replace function touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end $$;

create or replace function log_audit() returns trigger
language plpgsql set search_path = public as $$
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

-- ------------------------------------------------------------ RLS + policies

alter table workspaces enable row level security;
alter table workspaces force  row level security;
create policy workspaces_read on workspaces for select
  using (created_by = auth.uid()
         or workspace_id in (select my_workspaces('reviewer')));
create policy workspaces_insert on workspaces for insert
  with check (created_by = auth.uid());
create policy workspaces_update on workspaces for update
  using (workspace_id in (select my_workspaces('owner')));
create policy workspaces_delete on workspaces for delete
  using (workspace_id in (select my_workspaces('owner')));

alter table workspace_members enable row level security;
alter table workspace_members force  row level security;
create policy members_read on workspace_members for select
  using (user_id = auth.uid()
         or workspace_id in (select my_workspaces('owner')));
-- Creator-only bootstrap: you may make yourself owner ONLY of a workspace you
-- created. An RLS-filtered NOT EXISTS probe would let user B "claim" a
-- workspace it cannot see — created_by is the wall (negative-tested).
create policy members_bootstrap on workspace_members for insert
  with check (
    user_id = auth.uid() and role = 'owner'
    and exists (select 1 from workspaces w
                where w.workspace_id = workspace_members.workspace_id
                  and w.created_by = auth.uid())
  );
create policy members_manage_insert on workspace_members for insert
  with check (workspace_id in (select my_workspaces('owner')));
create policy members_manage_update on workspace_members for update
  using (workspace_id in (select my_workspaces('owner')));
create policy members_manage_delete on workspace_members for delete
  using (workspace_id in (select my_workspaces('owner')));

-- Data tables: members read, editors write. One block per table.
do $plpgsql$
declare
  t text;
begin
  foreach t in array array[
    'settings','sources','tax_facts','fact_provenance','calculations',
    'fact_dependencies','filing_contexts','gate_runs','findings','packages',
    'registers','history_lines','agent_traces'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format(
      'create policy %I on %I for select using (workspace_id in (select my_workspaces(''reviewer'')))',
      t || '_read', t);
    execute format(
      'create policy %I on %I for insert with check (workspace_id in (select my_workspaces(''editor'')))',
      t || '_insert', t);
    execute format(
      'create policy %I on %I for update using (workspace_id in (select my_workspaces(''editor'')))',
      t || '_update', t);
    execute format(
      'create policy %I on %I for delete using (workspace_id in (select my_workspaces(''editor'')))',
      t || '_delete', t);
  end loop;
end $plpgsql$;

-- audit_log: readable by members, appendable by members (the audit triggers
-- run with invoker rights), never updatable or deletable — no such policy
-- exists, FORCE RLS denies even the owner, and grants below revoke the verbs.
alter table audit_log enable row level security;
alter table audit_log force  row level security;
create policy audit_read on audit_log for select
  using (workspace_id in (select my_workspaces('reviewer')));
create policy audit_append on audit_log for insert
  with check (workspace_id in (select my_workspaces('reviewer')));

-- ------------------------------------------------------------- triggers

do $plpgsql$
declare
  t text;
begin
  foreach t in array array[
    'workspaces','workspace_members','settings','sources','tax_facts',
    'filing_contexts','packages','registers','history_lines'
  ] loop
    execute format(
      'create trigger %I before update on %I for each row execute function touch_updated_at()',
      t || '_touch', t);
  end loop;
  foreach t in array array[
    'workspace_members','settings','sources','tax_facts','fact_provenance',
    'calculations','fact_dependencies','filing_contexts','gate_runs',
    'findings','packages','registers','history_lines','agent_traces'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on %I for each row execute function log_audit()',
      t || '_audit', t);
  end loop;
end $plpgsql$;

-- ---------------------------------------------------------------- view

create view nav_status with (security_invoker = true) as
  select w.workspace_id,
         exists(select 1 from settings s where s.workspace_id = w.workspace_id
                and s.key = 'filing_status')               as started,
         (select count(*) from sources src where src.workspace_id = w.workspace_id
                and src.review_status = 'pending')         as docs_pending,
         (select max(ts) from gate_runs g where g.workspace_id = w.workspace_id) as last_gates,
         (select max(version) from packages p where p.workspace_id = w.workspace_id
                and p.status <> 'draft')                   as package_version
  from workspaces w;

-- ---------------------------------------------------------------- grants
-- The app connects as the AUTHENTICATED USER (JWT), never as table owner.
-- RLS scopes rows; these grants scope verbs. anon gets nothing.

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant select on nav_status to authenticated;
revoke update, delete on audit_log from authenticated;   -- append-only
