-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Also enable Authentication -> Providers -> "Allow anonymous sign-ins".

create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  grp         text not null,
  book        text not null,
  chapter     int  not null,
  verse       int  not null,
  author      text not null check (char_length(author) <= 30),
  body        text not null check (char_length(body) <= 2000),
  owner       uuid not null default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists notes_lookup on public.notes (grp, book, chapter);

alter table public.notes enable row level security;

-- Anyone signed in (anonymously) can read notes; the group code is the filter.
create policy "read notes"   on public.notes for select to authenticated using (true);
create policy "add notes"    on public.notes for insert to authenticated with check (owner = auth.uid());
create policy "edit own"     on public.notes for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "delete own"   on public.notes for delete to authenticated using (owner = auth.uid());

alter publication supabase_realtime add table public.notes;
