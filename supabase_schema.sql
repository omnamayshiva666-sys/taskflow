-- ================================================================
-- Task Management System — Supabase Schema
-- Run this ONCE in: Supabase Dashboard → SQL Editor → New query → Run
-- This replaces the old "Users" / "Tasks" / "ActivityLog" Google Sheets.
-- ================================================================

create table if not exists users (
  id          text primary key,          -- employee code, e.g. EMP001
  department  text,
  name        text not null,
  email       text unique not null,
  password    text not null,             -- plain text, same as the old sheet (see README security note)
  role        text not null default 'user' check (role in ('admin','manager','user')),
  created_at  timestamptz default now()
);

create table if not exists tasks (
  id                  text primary key,           -- e.g. T1719999999999
  title               text not null,
  description         text default '',
  frequency           text not null check (frequency in ('daily','weekly','monthly','yearly','ott')),
  department          text,
  assignee_id         text,
  assignee_name       text,
  assigned_by_id      text,
  assigned_by_name    text,
  priority            text default 'medium' check (priority in ('high','medium','low')),
  start_date          date,
  due_date            date,
  status              text default 'pending' check (status in ('pending','in-progress','done','not-done','hold')),
  remarks             text default '',
  created_at          timestamptz default now(),
  completed_at        timestamptz,
  recurring_group_id  text,
  active              boolean default true
);
-- NOTE: assignee_id / assigned_by_id are NOT foreign keys on purpose.
-- The app keeps a removed employee's old tasks around (deactivated, not deleted),
-- exactly like the original Google Sheet did.

create table if not exists notices (
  id          text primary key,
  by_id       text,
  by_name     text,
  by_role     text,
  msg         text,
  meet_link   text default '',
  created_at  timestamptz default now()
);

create table if not exists activity_log (
  id          bigserial primary key,
  created_at  timestamptz default now(),
  emp_code    text,
  name        text,
  action      text,
  task_id     text,
  title       text,
  detail      text
);

-- Helpful indexes
create index if not exists idx_tasks_assignee   on tasks(assignee_id);
create index if not exists idx_tasks_department on tasks(department);
create index if not exists idx_tasks_active     on tasks(active);
create index if not exists idx_tasks_group      on tasks(recurring_group_id);
create index if not exists idx_notices_created  on notices(created_at);

-- ----------------------------------------------------------------
-- Security: lock every table down completely.
-- The frontend NEVER talks to Supabase directly — it only talks to
-- our own Vercel API, which uses the secret service_role key (server
-- side only) to read/write. That key bypasses RLS, so with RLS turned
-- on and zero policies, the public anon key (if it ever leaked) can
-- do nothing at all.
-- ----------------------------------------------------------------
alter table users         enable row level security;
alter table tasks         enable row level security;
alter table notices       enable row level security;
alter table activity_log  enable row level security;

-- ----------------------------------------------------------------
-- Seed data — same default accounts as the original Apps Script setup.
-- ⚠️ Change these passwords after your first login in production!
-- ----------------------------------------------------------------
insert into users (id, department, name, email, password, role) values
  ('EMP001','Administration','Arjun Sharma','admin@company.com','admin123','admin'),
  ('EMP002','Sales','Priya Mehta','manager@company.com','mgr123','manager'),
  ('EMP003','Sales','Rahul Gupta','rahul@company.com','user123','user'),
  ('EMP004','IT','Sneha Patel','sneha@company.com','user123','user'),
  ('EMP005','IT','Vikram Singh','vikram@company.com','user123','user')
on conflict (id) do nothing;
