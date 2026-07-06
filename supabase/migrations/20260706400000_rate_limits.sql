-- Rate limiting (launch roadmap Gate 4: "Rate limiting and abuse protection
-- are live"). Fixed-window counters in Postgres — atomic via a single upsert,
-- correct across serverless instances, no extra infrastructure. Swap for
-- Upstash/Redis if per-request latency ever matters at scale.

create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  count integer not null default 0
);

alter table public.rate_limits enable row level security;

-- Bump the counter for `p_key`; returns whether the request is allowed.
-- The window resets lazily when the previous one has expired.
create or replace function public.bump_rate(
  p_key text,
  p_window_secs integer,
  p_max integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.rate_limits as rl (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update set
    count = case
      when rl.window_start < now() - make_interval(secs => p_window_secs)
        then 1
      else rl.count + 1
    end,
    window_start = case
      when rl.window_start < now() - make_interval(secs => p_window_secs)
        then now()
      else rl.window_start
    end
  returning rl.count into v_count;

  return v_count <= p_max;
end;
$$;

revoke execute on function public.bump_rate(text, integer, integer)
  from public, anon, authenticated;
