-- Phase 8 (hardening for testers): DB-backed rate limiting. Serverless
-- lambdas have no shared memory, so a token bucket must live where the data
-- lives. One row per (workspace, user, action) in a rolling window; the
-- guard reads-increments-refuses in one statement. Named request_budgets
-- (not rate_limits) so future cohabitation with an existing project's
-- tables cannot collide.

create table request_budgets (
  workspace_id text not null references workspaces,
  user_id      uuid not null,
  action       text not null,
  window_start timestamptz not null default now(),
  count        int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id, action)
);

alter table request_budgets enable row level security;
alter table request_budgets force  row level security;
-- A user manages only their own budget rows, and only in workspaces they
-- can at least review — the budget must never become a write side channel.
create policy budgets_rw on request_budgets for all
  using (user_id = auth.uid() and workspace_id in (select my_workspaces('reviewer')))
  with check (user_id = auth.uid() and workspace_id in (select my_workspaces('reviewer')));
grant select, insert, update, delete on request_budgets to authenticated;
create trigger request_budgets_touch before update on request_budgets
  for each row execute function touch_updated_at();
