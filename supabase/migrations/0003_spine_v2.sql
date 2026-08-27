-- Spine v2 support (Phase 4). Three reconciliations between the Blueprint §4
-- DDL (abridged) and the ported spine contract, each recorded in
-- PLAN_OF_RECORD:
--   1. registers: the Blueprint's thin (kind, tax_year, amount) row cannot
--      carry ARCHITECTURE §3.2 / Gate-3 continuity (opening/activity/closing
--      balances, closed-immutability, the year-close roll). Rebuilt with the
--      TaxOS-proven shape, workspace-scoped PK, FORCE RLS, closed rows
--      immutable by trigger.
--   2. gate_runs: + rule_version, started, consumed_fact_ids — A.2's
--      dependency-scoped staleness re-opens exactly the gates whose latest
--      run consumed an affected fact; without the column the cascade cannot
--      exist. + a sequence so run ids order deterministically within a tie.
--   3. calculations: + terms/clamp_zero (the §3.2 graph-derived tie-out
--      decomposition) so persisted lineage carries what the kernel emitted.
-- Also: audit triggers now record the row's natural id (TG_ARGV id column),
-- so the audit trail names WHAT changed, not just the table.

-- ---------------------------------------------------------------- registers
drop table registers;

create table registers (
  workspace_id          text not null references workspaces,
  register_id           text not null,
  scope_ref             text not null,
  kind                  text not null check (kind in (
    'capital_loss', 'nol', 'passive_loss', 'qbi_loss', 'basis_stock',
    'basis_debt', 'basis_outside', 'depreciation_asset', 'home_office_carryover'
  )),
  tax_year              int  not null,
  opening               jsonb not null default '{}'::jsonb,
  activity              jsonb not null default '{}'::jsonb,
  closing               jsonb,
  status                text not null default 'open' check (status in ('open', 'closed')),
  closed_by_package_id  text,
  opening_source_ref    text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (workspace_id, register_id),
  check ((status = 'closed') = (closing is not null))
);
create index registers_by_year on registers (workspace_id, tax_year, kind);

alter table registers enable row level security;
alter table registers force  row level security;
create policy registers_read on registers for select
  using (workspace_id in (select my_workspaces('reviewer')));
create policy registers_insert on registers for insert
  with check (workspace_id in (select my_workspaces('editor')));
create policy registers_update on registers for update
  using (workspace_id in (select my_workspaces('editor')));
create policy registers_delete on registers for delete
  using (workspace_id in (select my_workspaces('editor')));
grant select, insert, update, delete on registers to authenticated;

create or replace function registers_forbid_closed_mutation() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.status = 'closed' then
    raise exception 'register % is closed — closed registers are immutable', old.register_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger registers_closed_immutable
  before update or delete on registers
  for each row execute function registers_forbid_closed_mutation();
create trigger registers_touch before update on registers
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- gate_runs
alter table gate_runs
  add column rule_version      text not null default '',
  add column started           timestamptz,
  add column consumed_fact_ids text[] not null default '{}';
create sequence if not exists gate_run_seq;
grant usage on sequence gate_run_seq to authenticated;

-- -------------------------------------------------------------- calculations
alter table calculations
  add column terms      jsonb,
  add column clamp_zero boolean not null default false;

-- ------------------------------------------------- audit triggers, with ids
create or replace function log_audit() returns trigger
language plpgsql set search_path = public as $$
declare
  ws text;
  row_id text;
begin
  ws := coalesce(new.workspace_id, old.workspace_id);
  if tg_nargs > 0 then
    row_id := to_jsonb(coalesce(new, old)) ->> tg_argv[0];
  end if;
  insert into audit_log (workspace_id, actor, action, detail)
  values (ws, coalesce(auth.uid()::text, 'system'),
          lower(tg_op) || ' ' || tg_table_name,
          jsonb_build_object('op', tg_op, 'table', tg_table_name, 'id', row_id));
  return coalesce(new, old);
end $$;

do $plpgsql$
declare
  t record;
begin
  for t in select * from (values
    ('workspace_members', 'user_id'),
    ('settings',          'key'),
    ('sources',           'source_id'),
    ('tax_facts',         'fact_id'),
    ('fact_provenance',   'fact_id'),
    ('calculations',      'calc_id'),
    ('fact_dependencies', 'calc_id'),
    ('filing_contexts',   'jurisdiction'),
    ('gate_runs',         'run_id'),
    ('findings',          'finding_id'),
    ('packages',          'package_id'),
    ('registers',         'register_id'),
    ('history_lines',     'line'),
    ('agent_traces',      'trace_id')
  ) as v(tbl, idcol) loop
    execute format('drop trigger if exists %I on %I', t.tbl || '_audit', t.tbl);
    execute format(
      'create trigger %I after insert or update or delete on %I for each row execute function log_audit(%L)',
      t.tbl || '_audit', t.tbl, t.idcol);
  end loop;
end $plpgsql$;
