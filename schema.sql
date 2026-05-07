-- ============================================================
-- Bench — Supabase Schema
-- Run this entire script in Supabase SQL Editor once.
-- ============================================================

-- ── EXTENSIONS ──────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ── PROFILES ────────────────────────────────────────────────
-- One row per auth.users entry. Created automatically via trigger.
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text        not null,
  role       text        not null default 'staff' check (role in ('admin','staff')),
  created_at timestamptz not null default now()
);

-- Auto-create a profile row when a new auth user is confirmed
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'role', 'staff')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── LISTS ───────────────────────────────────────────────────
-- Single-row config table for all dropdown lists.
create table public.lists (
  id              int  primary key default 1 check (id = 1), -- singleton
  statuses        text[] not null default '{"To be quoted","In workshop","Awaiting parts","With setter","Ready for collection","Collected"}',
  closed_statuses text[] not null default '{"Collected"}',
  locations       text[] not null default '{"Store — City","Store — Suburb","Main workshop","External setter","Offshore"}',
  types           text[] not null default '{"Repair","Manufacture","Resize","Restring","Valuation","Parcel"}',
  staff           text[] not null default '{"Jane Smith","Tom Reid","Sarah Jones","Mike Chen"}',
  updated_at      timestamptz not null default now()
);

-- Seed the singleton row
insert into public.lists (id) values (1) on conflict do nothing;

-- ── JOBS ────────────────────────────────────────────────────
create table public.jobs (
  id             uuid        primary key default uuid_generate_v4(),
  num            text        not null unique,           -- e.g. B-0001
  created_at     timestamptz not null default now(),
  created_by     uuid        references public.profiles(id) on delete set null,
  client_name    text        not null,
  client_contact text,
  reference      text,                                  -- external ref e.g. Lightspeed invoice
  type           text        not null,
  status         text        not null,
  location       text        not null,
  staff          text,
  due            date,
  description    text        not null,
  updated_at     timestamptz not null default now(),
  updated_by     uuid        references public.profiles(id) on delete set null
  -- updated_by is set by the app on every edit; updated_at is set automatically
  -- by the trigger below. Together they form a lightweight audit trail.
);

-- Auto-increment job number (B-0001, B-0002, …)
create sequence if not exists public.job_num_seq start 1;

create or replace function public.set_job_num()
returns trigger language plpgsql as $$
begin
  -- On INSERT: assign the next job number if one wasn't supplied
  if TG_OP = 'INSERT' and (new.num is null or new.num = '') then
    new.num := 'B-' || lpad(nextval('public.job_num_seq')::text, 4, '0');
  end if;
  -- Always stamp updated_at
  new.updated_at := now();
  return new;
end;
$$;

-- Single trigger handles both INSERT (numbering) and UPDATE (timestamp).
-- Replaces the previous two separate triggers; no touch_updated_at needed.
create trigger before_job_write
  before insert or update on public.jobs
  for each row execute procedure public.set_job_num();

-- ── JOB PHOTOS ──────────────────────────────────────────────
-- Photos stored in Supabase Storage (PRIVATE bucket).
-- Only storage_path is persisted — signed URLs are generated on demand.
-- No public URL is ever stored in the database.
create table public.job_photos (
  id           uuid        primary key default uuid_generate_v4(),
  job_id       uuid        not null references public.jobs(id) on delete cascade,
  storage_path text        not null,  -- path inside the 'job-photos' bucket
  uploaded_by  uuid        references public.profiles(id) on delete set null,
  uploaded_at  timestamptz not null default now()
);

-- ── COMMENTS ────────────────────────────────────────────────
create table public.comments (
  id         uuid        primary key default uuid_generate_v4(),
  job_id     uuid        not null references public.jobs(id) on delete cascade,
  author_id  uuid        not null references public.profiles(id) on delete cascade,
  body       text        not null,
  created_at timestamptz not null default now()
);

-- ── COMMENT PHOTOS ──────────────────────────────────────────
-- Same private-bucket approach as job_photos — no URL stored.
create table public.comment_photos (
  id           uuid        primary key default uuid_generate_v4(),
  comment_id   uuid        not null references public.comments(id) on delete cascade,
  storage_path text        not null,
  uploaded_at  timestamptz not null default now()
);

-- ── SAVED VIEWS (per-user filter presets) ───────────────────
create table public.saved_views (
  id          uuid        primary key default uuid_generate_v4(),
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  name        text        not null,
  filters     jsonb       not null default '{}',
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

-- ── API TOKENS ──────────────────────────────────────────────
create table public.api_tokens (
  id          uuid        primary key default uuid_generate_v4(),
  label       text        not null,
  token_hash  text        not null unique,  -- sha256 of the actual token
  created_by  uuid        references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  last_used_at timestamptz
);

-- ── APPEARANCE (per-user) ────────────────────────────────────
create table public.appearance (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  settings   jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────

alter table public.profiles      enable row level security;
alter table public.lists         enable row level security;
alter table public.jobs          enable row level security;
alter table public.job_photos    enable row level security;
alter table public.comments      enable row level security;
alter table public.comment_photos enable row level security;
alter table public.saved_views   enable row level security;
alter table public.api_tokens    enable row level security;
alter table public.appearance    enable row level security;

-- Helper: is the calling user an admin?
create or replace function public.is_admin()
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- PROFILES
create policy "Users can read all profiles"
  on public.profiles for select using (auth.uid() is not null);
create policy "Users can update own profile"
  on public.profiles for update using (id = auth.uid());
create policy "Admins can update any profile"
  on public.profiles for update using (public.is_admin());

-- LISTS (everyone reads, only admins write)
create policy "All authenticated users can read lists"
  on public.lists for select using (auth.uid() is not null);
create policy "Admins can update lists"
  on public.lists for update using (public.is_admin());

-- JOBS (all staff read/write, only admins delete)
create policy "All staff can read jobs"
  on public.jobs for select using (auth.uid() is not null);
create policy "All staff can create jobs"
  on public.jobs for insert with check (auth.uid() is not null);
create policy "All staff can update jobs"
  on public.jobs for update using (auth.uid() is not null);
create policy "Only admins can delete jobs"
  on public.jobs for delete using (public.is_admin());

-- JOB PHOTOS
create policy "All staff can read job photos"
  on public.job_photos for select using (auth.uid() is not null);
create policy "All staff can upload job photos"
  on public.job_photos for insert with check (auth.uid() is not null);
create policy "Only admins can delete job photos"
  on public.job_photos for delete using (public.is_admin());

-- COMMENTS
create policy "All staff can read comments"
  on public.comments for select using (auth.uid() is not null);
create policy "All staff can create comments"
  on public.comments for insert with check (auth.uid() = author_id);
create policy "Authors and admins can delete comments"
  on public.comments for delete using (author_id = auth.uid() or public.is_admin());

-- COMMENT PHOTOS
create policy "All staff can read comment photos"
  on public.comment_photos for select using (auth.uid() is not null);
create policy "All staff can upload comment photos"
  on public.comment_photos for insert with check (auth.uid() is not null);

-- SAVED VIEWS (strictly per-user)
create policy "Users can manage own saved views"
  on public.saved_views for all using (user_id = auth.uid());

-- API TOKENS (admins only)
create policy "Admins can manage API tokens"
  on public.api_tokens for all using (public.is_admin());

-- APPEARANCE (own row only)
create policy "Users manage own appearance"
  on public.appearance for all using (user_id = auth.uid());

-- ── STORAGE BUCKET ───────────────────────────────────────────
-- Create this in Supabase Dashboard → Storage → New Bucket
-- Name:   job-photos
-- Public: FALSE  ← this is the critical setting
--
-- Or via SQL:
insert into storage.buckets (id, name, public)
  values ('job-photos', 'job-photos', false)
  on conflict (id) do update set public = false;

-- Storage RLS policies (run after creating the bucket)
-- ─────────────────────────────────────────────────────
-- Only authenticated users can upload
create policy "Authenticated users can upload photos"
  on storage.objects for insert
  with check (bucket_id = 'job-photos' and auth.uid() is not null);

-- Only authenticated users can read (required for signed URL generation)
-- Unauthenticated requests — even with a direct storage path — are rejected.
create policy "Authenticated users can read photos"
  on storage.objects for select
  using (bucket_id = 'job-photos' and auth.uid() is not null);

-- Only admins can permanently delete files from storage
create policy "Admins can delete photos"
  on storage.objects for delete
  using (bucket_id = 'job-photos' and public.is_admin());

-- ── INDEXES ──────────────────────────────────────────────────
create index jobs_status_idx      on public.jobs(status);
create index jobs_location_idx    on public.jobs(location);
create index jobs_staff_idx       on public.jobs(staff);
create index jobs_due_idx         on public.jobs(due);
create index jobs_created_at_idx  on public.jobs(created_at desc);
create index comments_job_id_idx  on public.comments(job_id);
create index job_photos_job_idx   on public.job_photos(job_id);

-- ── MIGRATION (for existing deployments already running the original schema) ──
-- If you have already run the initial schema.sql, run ONLY these statements:
--
-- alter table public.jobs
--   add column if not exists updated_by uuid references public.profiles(id) on delete set null;
--
-- drop trigger if exists before_job_insert  on public.jobs;
-- drop trigger if exists before_job_update  on public.jobs;
-- drop trigger if exists jobs_updated_at    on public.jobs;
-- drop function if exists public.touch_updated_at;
--
-- create or replace function public.set_job_num() ... (see full definition above)
--
-- create trigger before_job_write
--   before insert or update on public.jobs
--   for each row execute procedure public.set_job_num();
