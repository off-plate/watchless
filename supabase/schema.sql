-- Watchless: transcript cache and a spend counter.
-- Run once in the shared Supabase project (SQL editor, paste, run).
-- Table prefix keeps it clear of the other apps sharing this project.

-- A video read once never costs a credit again.
create table if not exists watchless_transcripts (
  video_id   text primary key,
  title      text,
  payload    jsonb not null,
  fetched_at timestamptz not null default now()
);

create index if not exists watchless_transcripts_fetched_at
  on watchless_transcripts (fetched_at desc);

-- Counts only the calls that spend a provider credit, one row per month.
create table if not exists watchless_usage (
  month text primary key,          -- 'YYYY-MM'
  count integer not null default 0
);

-- Atomic increment, so two people pasting at once cannot both slip past the cap.
create or replace function watchless_spend(m text)
returns integer
language sql
as $$
  insert into watchless_usage (month, count) values (m, 1)
  on conflict (month) do update set count = watchless_usage.count + 1
  returning count;
$$;

-- Only the Netlify function touches these, using the service key.
-- No anon policies exist, so a browser can read nothing here.
alter table watchless_transcripts enable row level security;
alter table watchless_usage enable row level security;
