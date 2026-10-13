-- ════════════════════════════════════════════════════════════════
-- BƯỚC 2: gắn tài khoản quản trị và tạo 3 phòng.
-- Làm TRƯỚC: Authentication › Users › Add user › Create new user
--   Email:    admin@kehoach.drhoangtuan.vn
--   Password: (mật khẩu quản trị chị chọn, tối thiểu 6 ký tự)
--   Tick "Auto Confirm User" › Create user
-- Sau đó dán file này vào SQL Editor › Run.
-- ════════════════════════════════════════════════════════════════

insert into public.members (user_id, login, name, role)
select id, 'admin', 'BGĐ / CFO', 'admin'
from auth.users where email = 'admin@kehoach.drhoangtuan.vn'
on conflict (user_id) do update set role = 'admin', active = true;

insert into public.depts (name)
select n from (values
  ('Phòng Tài chính - Kế toán'),
  ('Phòng Nhân sự'),
  ('Phòng Vật tư - Mua hàng (gồm Thiết bị y tế)')
) v(n)
where not exists (select 1 from public.depts d where d.name = v.n);

select
  (select count(*) from public.members where role = 'admin') as so_quan_tri,
  (select count(*) from public.depts) as so_phong;
-- Kết quả đúng: so_quan_tri = 1, so_phong = 3. Nếu so_quan_tri = 0: email ở bước tạo user chưa khớp.
