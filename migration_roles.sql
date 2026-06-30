-- ================================================================
-- MIGRATION: Upgrade to Super Admin / Admin / L1 / L2 / L3 role system
-- Run this ONCE in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- This does NOT delete your existing users or tasks -- it only adds
-- a new column and updates the role values.
-- ================================================================

-- STEP 1: remove the old role restriction (admin/manager/user only)
alter table users drop constraint if exists users_role_check;

-- STEP 2: add the "reports_to" column -- this stores WHO a person
-- reports to, which is how the system knows who is on whose team.
-- Example: an L3 user reports to an L2 manager; an L2 manager reports
-- to an L1 HOD. Super Admin / Admin / L1 usually have this empty (null).
alter table users add column if not exists reports_to text references users(id);

-- STEP 3: convert your existing demo accounts to the new role names.
-- admin@company.com (was role "admin") becomes the one and only Super Admin.
update users set role = 'superadmin' where email = 'admin@company.com';

-- manager@company.com (was role "manager") becomes an L1 (HOD).
update users set role = 'l1' where email = 'manager@company.com';

-- Any other existing "manager" role accounts become L2.
update users set role = 'l2' where role = 'manager';

-- Any existing "user" role accounts become L3.
update users set role = 'l3' where role = 'user';

-- STEP 4: re-link your demo team so the hierarchy makes sense:
-- Rahul Gupta (L2 manager) now reports to Priya Mehta (L1 HOD).
update users set role = 'l2', reports_to = 'EMP002' where id = 'EMP003';
-- Sneha Patel and Vikram Singh (L3 users) report to Rahul Gupta (L2).
update users set role = 'l3', reports_to = 'EMP003' where id in ('EMP004','EMP005');

-- STEP 5: add the new check constraint with the 5 allowed roles.
alter table users add constraint users_role_check
  check (role in ('superadmin','admin','l1','l2','l3'));

-- ================================================================
-- That's it. After running this, your accounts will be:
--   admin@company.com   -> superadmin  (full control, assigns L1/L2/L3 levels)
--   manager@company.com -> l1          (HOD -- sees & updates whole team)
--   rahul@company.com   -> l2          (manager -- reports to manager@company.com)
--   sneha@company.com   -> l3          (user -- reports to rahul@company.com)
--   vikram@company.com  -> l3          (user -- reports to rahul@company.com)
--
-- You can verify by running:  select id, name, role, reports_to from users;
-- ================================================================
