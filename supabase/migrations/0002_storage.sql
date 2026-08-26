-- Storage buckets + policies AS MIGRATIONS (Blueprint §4 improvement (f):
-- TaxOS's bucket rules lived untracked in the dashboard and every request
-- path used the service-role key). Objects are named
--   {workspace_id}/{tax_year}/...
-- so (storage.foldername(name))[1] is the workspace, and the same membership
-- helper that guards every table guards every object. The server acts as the
-- authenticated user; the service-role key never appears on request paths.

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false), ('packages', 'packages', false)
on conflict (id) do nothing;

create policy taxfs_objects_read on storage.objects for select
  using (bucket_id in ('documents','packages')
         and (storage.foldername(name))[1] in (select my_workspaces('reviewer')));
create policy taxfs_objects_insert on storage.objects for insert
  with check (bucket_id in ('documents','packages')
              and (storage.foldername(name))[1] in (select my_workspaces('editor')));
create policy taxfs_objects_update on storage.objects for update
  using (bucket_id in ('documents','packages')
         and (storage.foldername(name))[1] in (select my_workspaces('editor')));
create policy taxfs_objects_delete on storage.objects for delete
  using (bucket_id in ('documents','packages')
         and (storage.foldername(name))[1] in (select my_workspaces('editor')));
