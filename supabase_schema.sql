-- Supabase schema for the Telegram finance AI bot.
create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  full_name text,
  current_salary numeric default 0,
  daily_limit integer not null default 15 check (daily_limit > 0),
  daily_voice_limit integer not null default 2 check (daily_voice_limit > 0),
  daily_usage_count integer not null default 0 check (daily_usage_count >= 0),
  daily_usage_date date,
  daily_voice_usage_count integer not null default 0 check (daily_voice_usage_count >= 0),
  daily_voice_usage_date date,
  is_premium boolean not null default false,
  awaiting_payment boolean not null default false,
  premium_expires_at timestamp with time zone,
  current_month text,
  created_at timestamp with time zone default now()
);

-- Migration for existing projects that already created public.users earlier.
alter table public.users add column if not exists daily_limit integer default 15;
alter table public.users add column if not exists daily_voice_limit integer default 2;
alter table public.users add column if not exists daily_usage_count integer default 0;
alter table public.users add column if not exists daily_usage_date date;
alter table public.users add column if not exists daily_voice_usage_count integer default 0;
alter table public.users add column if not exists daily_voice_usage_date date;
alter table public.users add column if not exists is_premium boolean default false;
alter table public.users add column if not exists awaiting_payment boolean default false;
alter table public.users add column if not exists premium_expires_at timestamp with time zone;
update public.users set is_premium = false where is_premium is null;
update public.users set awaiting_payment = false where awaiting_payment is null;
update public.users set daily_limit = 15 where daily_limit is null;
update public.users set daily_limit = 15 where is_premium = false and daily_limit = 10;
update public.users set daily_voice_limit = case when is_premium = true then 10 else 2 end where daily_voice_limit is null;
update public.users set daily_voice_limit = 10 where is_premium = true and daily_voice_limit = 2;
update public.users set daily_usage_count = 0 where daily_usage_count is null;
update public.users set daily_voice_usage_count = 0 where daily_voice_usage_count is null;
update public.users set premium_expires_at = now() + interval '30 days' where is_premium = true and premium_expires_at is null;
alter table public.users alter column daily_limit set default 15;
alter table public.users alter column daily_limit set not null;
alter table public.users alter column daily_voice_limit set default 2;
alter table public.users alter column daily_voice_limit set not null;
alter table public.users alter column daily_usage_count set default 0;
alter table public.users alter column daily_usage_count set not null;
alter table public.users alter column daily_voice_usage_count set default 0;
alter table public.users alter column daily_voice_usage_count set not null;
alter table public.users alter column is_premium set default false;
alter table public.users alter column is_premium set not null;
alter table public.users alter column awaiting_payment set default false;
alter table public.users alter column awaiting_payment set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_daily_limit_positive'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_daily_limit_positive check (daily_limit > 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_daily_voice_limit_positive'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_daily_voice_limit_positive check (daily_voice_limit > 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_daily_usage_count_nonnegative'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_daily_usage_count_nonnegative check (daily_usage_count >= 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_daily_voice_usage_count_nonnegative'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_daily_voice_usage_count_nonnegative check (daily_voice_usage_count >= 0);
  end if;
end $$;

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  amount numeric not null check (amount > 0),
  category text not null check (
    category in (
      'Oziq-ovqat',
      'Transport',
      'Kommunal',
      'Uy-joy',
      'Sog''liq',
      'Ta''lim',
      'Texnika',
      'Kiyim-kechak',
      'Bo''lib to''lash',
      'Oilaviy yordam',
      'Ko''ngilochar',
      'Kirim',
      'Boshqa'
    )
  ),
  type text not null default 'expense' check (type in ('expense', 'income')),
  note text,
  month text,
  input_type text not null default 'text' check (input_type in ('text', 'voice')),
  created_at timestamp with time zone default now()
);

alter table public.expenses add column if not exists type text default 'expense';
update public.expenses set type = 'expense' where type is null;
alter table public.expenses alter column type set default 'expense';
alter table public.expenses alter column type set not null;

alter table public.expenses add column if not exists input_type text default 'text';
update public.expenses set input_type = 'text' where input_type is null;
alter table public.expenses alter column input_type set default 'text';
alter table public.expenses alter column input_type set not null;

alter table public.expenses drop constraint if exists expenses_category_check;
alter table public.expenses drop constraint if exists expenses_category_valid;
alter table public.expenses
  add constraint expenses_category_valid
  check (
    category in (
      'Oziq-ovqat',
      'Transport',
      'Kommunal',
      'Uy-joy',
      'Sog''liq',
      'Ta''lim',
      'Texnika',
      'Kiyim-kechak',
      'Bo''lib to''lash',
      'Oilaviy yordam',
      'Ko''ngilochar',
      'Kirim',
      'Boshqa'
    )
  ) not valid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'expenses_type_valid'
      and conrelid = 'public.expenses'::regclass
  ) then
    alter table public.expenses
      add constraint expenses_type_valid check (type in ('expense', 'income'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'expenses_input_type_valid'
      and conrelid = 'public.expenses'::regclass
  ) then
    alter table public.expenses
      add constraint expenses_input_type_valid check (input_type in ('text', 'voice'));
  end if;
end $$;

create table if not exists public.monthly_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  month text,
  salary numeric,
  total_spent numeric,
  savings numeric,
  created_at timestamp with time zone default now(),
  unique (user_id, month)
);

create table if not exists public.api_usage_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now()
);

create index if not exists expenses_user_month_idx on public.expenses(user_id, month);
create index if not exists expenses_created_at_idx on public.expenses(created_at desc);
create index if not exists expenses_user_input_type_created_at_idx on public.expenses(user_id, input_type, created_at desc);
create index if not exists monthly_history_user_month_idx on public.monthly_history(user_id, month);
create index if not exists api_usage_log_created_at_idx on public.api_usage_log(created_at desc);

alter table public.users enable row level security;
alter table public.expenses enable row level security;
alter table public.monthly_history enable row level security;
alter table public.api_usage_log enable row level security;

revoke all on table public.users from anon, authenticated;
revoke all on table public.expenses from anon, authenticated;
revoke all on table public.monthly_history from anon, authenticated;
revoke all on table public.api_usage_log from anon, authenticated;

grant all on table public.users to service_role;
grant all on table public.expenses to service_role;
grant all on table public.monthly_history to service_role;
grant all on table public.api_usage_log to service_role;

drop policy if exists "service_role_users_all" on public.users;
create policy "service_role_users_all"
on public.users
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_expenses_all" on public.expenses;
create policy "service_role_expenses_all"
on public.expenses
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_monthly_history_all" on public.monthly_history;
create policy "service_role_monthly_history_all"
on public.monthly_history
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_api_usage_log_all" on public.api_usage_log;
create policy "service_role_api_usage_log_all"
on public.api_usage_log
for all
to service_role
using (true)
with check (true);
