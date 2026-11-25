-- Bookmark — Supabase schema
-- Run this once in your project: Dashboard → SQL Editor → New query → paste → Run.

create table if not exists public.books (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  ol_key        text,                                   -- Open Library work key, e.g. /works/OL27482W
  title         text not null check (char_length(title) between 1 and 500),
  authors       text[] not null default '{}',
  cover_id      bigint,
  year          integer,
  total_pages   integer check (total_pages > 0),
  current_page  integer not null default 0 check (current_page >= 0),
  status        text not null default 'reading' check (status in ('reading', 'want', 'finished')),
  added_at      timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists books_user_updated_idx on public.books (user_id, updated_at desc);

-- Row Level Security: every user can only see and change their own books.
-- This is what makes it safe to publish the anon/publishable key on GitHub Pages.
alter table public.books enable row level security;

drop policy if exists "Users read own books"   on public.books;
drop policy if exists "Users insert own books" on public.books;
drop policy if exists "Users update own books" on public.books;
drop policy if exists "Users delete own books" on public.books;

create policy "Users read own books" on public.books
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users insert own books" on public.books
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users update own books" on public.books
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users delete own books" on public.books
  for delete to authenticated
  using ((select auth.uid()) = user_id);
