-- ════════════════════════════════════════════════════════════════
-- KẾ HOẠCH CÔNG VIỆC – HỆ THỐNG HOÀNG TUẤN · Supabase
-- BƯỚC 1: tạo bảng, phân quyền, kho tài liệu, cập nhật tức thời.
-- Dán toàn bộ vào Supabase › SQL Editor › New query › Run. Chạy lại được nhiều lần.
-- ════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ───────── Bảng ─────────
create table if not exists public.depts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  lead_name   text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.members (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  login       text not null unique,                       -- tên đăng nhập, VD: huong.lvl
  name        text not null,
  title       text not null default '',
  role        text not null check (role in ('admin','lead','staff')),
  dept_id     uuid references public.depts(id),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  check (role = 'admin' or dept_id is not null)
);

create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  dept_id      uuid not null references public.depts(id),
  owner_id     uuid not null references public.members(user_id),
  horizon      text not null check (horizon in ('D','W','M','Q')),   -- Ngày / Tuần / Tháng / Quý
  period       text not null,                                       -- VD: M:2026-10, W:2026-W42
  title        text not null,
  kind         text not null default 'Định kỳ',
  prio         text not null default 'mid' check (prio in ('hi','mid','lo')),
  due          date not null,
  output       text not null default '',
  metric       text not null default '',
  target       text not null default '',
  actual       text not null default '',
  unit         text not null default '',
  progress     int  not null default 0 check (progress between 0 and 100),
  status       text not null default 'todo' check (status in ('todo','doing','done','blocked','moved','cancel')),
  self_note    text not null default '',
  issue        text not null default '',
  quality      int  not null default 0 check (quality between 0 and 5),
  review       text not null default '',
  accepted     boolean not null default false,
  done_at      date,
  from_id      uuid,
  deleted      boolean not null default false,
  created_at   timestamptz not null default now(),
  created_by   text,
  updated_at   timestamptz not null default now(),
  updated_by   text,
  last_act     text,
  last_changes jsonb
);
create index if not exists tasks_dept_period on public.tasks (dept_id, period);

create table if not exists public.files (
  id          uuid primary key default gen_random_uuid(),
  dept_id     uuid not null references public.depts(id),
  task_id     uuid references public.tasks(id),
  name        text not null,
  size        bigint not null default 0,
  mime        text not null default '',
  path        text not null unique,                       -- <dept_id>/<uuid>-<tên tệp> trong kho 'tai-lieu'
  owner_id    uuid default auth.uid() references public.members(user_id),
  by_name     text,
  created_at  timestamptz not null default now(),
  deleted     boolean not null default false,
  del_by      text,
  del_at      timestamptz
);
create index if not exists files_dept on public.files (dept_id);

create table if not exists public.logs (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  by_user   uuid default auth.uid(),
  by_name   text,
  dept_id   uuid,
  task_id   uuid,
  act       text not null,
  title     text,
  detail    text,
  changes   jsonb
);
create index if not exists logs_dept_at on public.logs (dept_id, at desc);
create index if not exists logs_task on public.logs (task_id);

-- ───────── Hàm hỏi "tôi là ai" ─────────
create or replace function public.my_role() returns text language sql stable security definer set search_path = public as
$$ select role from members where user_id = auth.uid() and active $$;

create or replace function public.my_dept() returns uuid language sql stable security definer set search_path = public as
$$ select dept_id from members where user_id = auth.uid() and active $$;

create or replace function public.in_scope(d uuid) returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select role = 'admin' or dept_id = d from members where user_id = auth.uid() and active), false) $$;

create or replace function public.my_label() returns text language sql stable security definer set search_path = public as
$$ select case m.role when 'admin' then m.name || ' (Quản trị)'
                      when 'lead'  then m.name || ' (TP ' || coalesce(d.name, '') || ')'
                      else m.name end
     from members m left join depts d on d.id = m.dept_id where m.user_id = auth.uid() $$;

-- ───────── Bật phân quyền theo dòng ─────────
alter table public.depts   enable row level security;
alter table public.members enable row level security;
alter table public.tasks   enable row level security;
alter table public.files   enable row level security;
alter table public.logs    enable row level security;

drop policy if exists depts_read on public.depts;
drop policy if exists depts_ins  on public.depts;
drop policy if exists depts_upd  on public.depts;
create policy depts_read on public.depts for select to authenticated using (public.my_role() is not null);
create policy depts_ins  on public.depts for insert to authenticated with check (public.my_role() = 'admin');
create policy depts_upd  on public.depts for update to authenticated
  using (public.my_role() = 'admin' or (public.my_role() = 'lead' and id = public.my_dept()))
  with check (public.my_role() = 'admin' or (public.my_role() = 'lead' and id = public.my_dept()));

drop policy if exists members_read on public.members;
drop policy if exists members_ins  on public.members;
drop policy if exists members_upd  on public.members;
create policy members_read on public.members for select to authenticated
  using (public.my_role() = 'admin' or dept_id = public.my_dept() or user_id = auth.uid());
create policy members_ins on public.members for insert to authenticated
  with check (public.my_role() = 'admin' or (public.my_role() = 'lead' and role = 'staff' and dept_id = public.my_dept()));
create policy members_upd on public.members for update to authenticated
  using (public.my_role() = 'admin' or (public.my_role() = 'lead' and role = 'staff' and dept_id = public.my_dept()))
  with check (public.my_role() = 'admin' or (public.my_role() = 'lead' and role = 'staff' and dept_id = public.my_dept()));

drop policy if exists tasks_read on public.tasks;
drop policy if exists tasks_ins  on public.tasks;
drop policy if exists tasks_upd  on public.tasks;
create policy tasks_read on public.tasks for select to authenticated using (public.in_scope(dept_id));
create policy tasks_ins on public.tasks for insert to authenticated
  with check (public.in_scope(dept_id) and (public.my_role() <> 'staff' or owner_id = auth.uid()));
create policy tasks_upd on public.tasks for update to authenticated
  using (public.in_scope(dept_id) and (public.my_role() <> 'staff' or (owner_id = auth.uid() and not accepted)))
  with check (public.in_scope(dept_id) and (public.my_role() <> 'staff' or owner_id = auth.uid()));

drop policy if exists files_read on public.files;
drop policy if exists files_ins  on public.files;
drop policy if exists files_upd  on public.files;
create policy files_read on public.files for select to authenticated using (public.in_scope(dept_id));
create policy files_ins on public.files for insert to authenticated
  with check (public.in_scope(dept_id) and owner_id = auth.uid());
create policy files_upd on public.files for update to authenticated
  using (public.my_role() = 'admin' or (public.my_role() = 'lead' and dept_id = public.my_dept()) or owner_id = auth.uid())
  with check (public.in_scope(dept_id));

drop policy if exists logs_read on public.logs;
create policy logs_read on public.logs for select to authenticated
  using (public.my_role() = 'admin' or dept_id = public.my_dept());
-- Không có quyền ghi trực tiếp vào logs: chỉ các trigger bên dưới được ghi.

-- ───────── Trigger: khóa phần chấm điểm, đóng dấu người sửa, ghi lịch sử ─────────
create or replace function public.tasks_before() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() = 'staff' then
    if tg_op = 'INSERT' then new.quality := 0; new.review := ''; new.accepted := false;
    else new.quality := old.quality; new.review := old.review; new.accepted := old.accepted; end if;
  end if;
  new.updated_at := now();
  new.updated_by := public.my_label();
  if tg_op = 'INSERT' then new.created_at := now(); new.created_by := public.my_label(); end if;
  return new;
end $$;
drop trigger if exists tasks_before on public.tasks;
create trigger tasks_before before insert or update on public.tasks for each row execute function public.tasks_before();

create or replace function public.tasks_after() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into logs (by_name, dept_id, task_id, act, title, changes)
  values (public.my_label(), new.dept_id, new.id,
          coalesce(nullif(new.last_act, ''), case when tg_op = 'INSERT' then 'Tạo việc' else 'Sửa' end),
          new.title, new.last_changes);
  return null;
end $$;
drop trigger if exists tasks_after on public.tasks;
create trigger tasks_after after insert or update on public.tasks for each row execute function public.tasks_after();

create or replace function public.files_before() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.by_name := public.my_label(); new.created_at := now(); new.deleted := false; end if;
  if tg_op = 'UPDATE' and new.deleted and not old.deleted then new.del_by := public.my_label(); new.del_at := now(); end if;
  return new;
end $$;
drop trigger if exists files_before on public.files;
create trigger files_before before insert or update on public.files for each row execute function public.files_before();

create or replace function public.files_after() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into logs (by_name, dept_id, task_id, act, detail) values (public.my_label(), new.dept_id, new.task_id, 'Tải lên tài liệu', new.name);
  elsif new.deleted and not old.deleted then
    insert into logs (by_name, dept_id, task_id, act, detail) values (public.my_label(), new.dept_id, new.task_id, 'Xóa tài liệu', new.name);
  end if;
  return null;
end $$;
drop trigger if exists files_after on public.files;
create trigger files_after after insert or update on public.files for each row execute function public.files_after();

create or replace function public.org_after() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'members' then
    insert into logs (by_name, dept_id, act, detail)
    values (coalesce(public.my_label(), 'Hệ thống'), new.dept_id,
            case when tg_op = 'INSERT' then 'Thêm nhân sự' when not new.active and old.active then 'Khóa tài khoản' else 'Sửa thông tin nhân sự' end,
            new.name || ' · ' || new.login);
  else
    insert into logs (by_name, dept_id, act, detail)
    values (coalesce(public.my_label(), 'Hệ thống'), new.id, case when tg_op = 'INSERT' then 'Thêm phòng' else 'Sửa thông tin phòng' end, new.name);
  end if;
  return null;
end $$;
drop trigger if exists members_after on public.members;
create trigger members_after after insert or update on public.members for each row execute function public.org_after();
drop trigger if exists depts_after on public.depts;
create trigger depts_after after insert or update on public.depts for each row execute function public.org_after();

-- ───────── Đặt lại mật khẩu cho người khác (quản trị: mọi người; trưởng phòng: nhân viên phòng mình) ─────────
create or replace function public.set_member_password(target uuid, new_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare r text; d uuid; tr text; td uuid; tn text;
begin
  select role, dept_id into r, d from members where user_id = auth.uid() and active;
  select role, dept_id, name into tr, td, tn from members where user_id = target;
  if tn is null then raise exception 'not_found'; end if;
  if not (r = 'admin' or (r = 'lead' and tr = 'staff' and td = d)) then raise exception 'forbidden'; end if;
  if length(coalesce(new_password, '')) < 6 then raise exception 'weak_pw'; end if;
  update auth.users set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')), updated_at = now() where id = target;
  insert into logs (by_name, dept_id, act, detail) values (public.my_label(), td, 'Đặt lại mật khẩu', tn);
end $$;
revoke all on function public.set_member_password(uuid, text) from public, anon;
grant execute on function public.set_member_password(uuid, text) to authenticated;

-- Ghi lịch sử khi một người tự đổi mật khẩu của mình (trang gọi sau khi đổi xong)
create or replace function public.log_self_password() returns void language sql security definer set search_path = public as
$$ insert into logs (by_name, dept_id, act) select public.my_label(), public.my_dept(), 'Tự đổi mật khẩu' where public.my_role() is not null $$;
grant execute on function public.log_self_password() to authenticated;

-- ───────── Kho tài liệu (riêng tư, tối đa 20 MB/tệp) ─────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('tai-lieu', 'tai-lieu', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

drop policy if exists tai_lieu_read on storage.objects;
drop policy if exists tai_lieu_ins  on storage.objects;
drop policy if exists tai_lieu_del  on storage.objects;
create policy tai_lieu_read on storage.objects for select to authenticated
  using (bucket_id = 'tai-lieu' and public.in_scope(((storage.foldername(name))[1])::uuid));
create policy tai_lieu_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'tai-lieu' and public.in_scope(((storage.foldername(name))[1])::uuid));
create policy tai_lieu_del on storage.objects for delete to authenticated
  using (bucket_id = 'tai-lieu' and exists (
    select 1 from public.files f where f.path = storage.objects.name
      and (public.my_role() = 'admin' or (public.my_role() = 'lead' and f.dept_id = public.my_dept()) or f.owner_id = auth.uid())));

-- ───────── Cập nhật tức thời cho mọi người đang mở trang ─────────
do $$
declare t text;
begin
  foreach t in array array['tasks','files','logs','members','depts'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

select 'Đã tạo xong bảng và phân quyền' as ket_qua;
