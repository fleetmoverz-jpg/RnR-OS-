-- RnR Os, Phase 1: Google Search Console.
-- The app talks to Postgres with the service role key from the server only,
-- so every table has RLS enabled with no policies (the anon key sees nothing).

create table if not exists google_accounts (
  email          text primary key,
  refresh_token  text not null,
  access_token   text,
  expires_at     timestamptz,
  scope          text,
  updated_at     timestamptz not null default now()
);

create table if not exists sites (
  id                 uuid primary key default gen_random_uuid(),
  site_url           text not null unique,          -- e.g. "sc-domain:example.com" or "https://example.com/"
  permission_level   text,
  enabled            boolean not null default true,
  last_synced_at     timestamptz,
  last_sync_error    text,
  created_at         timestamptz not null default now()
);

-- Site totals per day (dimension: date). Exact totals, unlike sums of query rows.
create table if not exists gsc_site_daily (
  site_id      uuid not null references sites(id) on delete cascade,
  date         date not null,
  clicks       integer not null,
  impressions  integer not null,
  ctr          double precision not null,
  position     double precision not null,
  primary key (site_id, date)
);

create table if not exists gsc_query_daily (
  site_id      uuid not null references sites(id) on delete cascade,
  date         date not null,
  query        text not null,
  clicks       integer not null,
  impressions  integer not null,
  ctr          double precision not null,
  position     double precision not null,
  primary key (site_id, date, query)
);

create table if not exists gsc_page_daily (
  site_id      uuid not null references sites(id) on delete cascade,
  date         date not null,
  page         text not null,
  clicks       integer not null,
  impressions  integer not null,
  ctr          double precision not null,
  position     double precision not null,
  primary key (site_id, date, page)
);

-- Query x page over the latest 28-day window, replaced on every sync.
-- Used for cannibalization (one query served by several pages).
create table if not exists gsc_query_page_window (
  site_id      uuid not null references sites(id) on delete cascade,
  query        text not null,
  page         text not null,
  clicks       integer not null,
  impressions  integer not null,
  position     double precision not null,
  window_start date not null,
  window_end   date not null,
  primary key (site_id, query, page)
);

create table if not exists url_inspections (
  site_id          uuid not null references sites(id) on delete cascade,
  page             text not null,
  verdict          text,          -- PASS / PARTIAL / FAIL / NEUTRAL
  coverage_state   text,          -- e.g. "Submitted and indexed", "Crawled - currently not indexed"
  indexing_state   text,
  robots_state     text,
  fetch_state      text,
  google_canonical text,
  user_canonical   text,
  last_crawl_time  timestamptz,
  raw              jsonb,
  inspected_at     timestamptz not null default now(),
  primary key (site_id, page)
);

create table if not exists ai_reports (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  model       text not null,
  summary     text not null,
  recommendations jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists ai_reports_site_created on ai_reports (site_id, created_at desc);

create table if not exists sync_runs (
  id          bigserial primary key,
  site_id     uuid references sites(id) on delete cascade,
  trigger     text not null,           -- cron / manual
  status      text not null,           -- running / ok / error
  detail      text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists gsc_query_daily_site_date on gsc_query_daily (site_id, date);
create index if not exists gsc_page_daily_site_date on gsc_page_daily (site_id, date);

alter table google_accounts       enable row level security;
alter table sites                 enable row level security;
alter table gsc_site_daily        enable row level security;
alter table gsc_query_daily       enable row level security;
alter table gsc_page_daily        enable row level security;
alter table gsc_query_page_window enable row level security;
alter table url_inspections       enable row level security;
alter table ai_reports            enable row level security;
alter table sync_runs             enable row level security;

-- Period-over-period comparison per query. Position is impression-weighted.
create or replace function gsc_query_compare(
  p_site uuid, cur_start date, cur_end date, prev_start date, prev_end date
) returns table (
  query text,
  clicks integer, impressions integer, ctr double precision, "position" double precision,
  prev_clicks integer, prev_impressions integer, prev_ctr double precision, prev_position double precision
) language sql stable as $$
  with cur as (
    select q.query, sum(clicks)::int c, sum(impressions)::int i,
           sum(position * impressions) / nullif(sum(impressions), 0) p
    from gsc_query_daily q
    where q.site_id = p_site and q.date between cur_start and cur_end
    group by q.query
  ), prev as (
    select q.query, sum(clicks)::int c, sum(impressions)::int i,
           sum(position * impressions) / nullif(sum(impressions), 0) p
    from gsc_query_daily q
    where q.site_id = p_site and q.date between prev_start and prev_end
    group by q.query
  )
  select coalesce(cur.query, prev.query),
         coalesce(cur.c, 0), coalesce(cur.i, 0),
         case when coalesce(cur.i, 0) > 0 then cur.c::float / cur.i else 0 end, cur.p,
         coalesce(prev.c, 0), coalesce(prev.i, 0),
         case when coalesce(prev.i, 0) > 0 then prev.c::float / prev.i else 0 end, prev.p
  from cur full outer join prev on cur.query = prev.query
  order by 1
$$;

create or replace function gsc_page_compare(
  p_site uuid, cur_start date, cur_end date, prev_start date, prev_end date
) returns table (
  page text,
  clicks integer, impressions integer, ctr double precision, "position" double precision,
  prev_clicks integer, prev_impressions integer, prev_ctr double precision, prev_position double precision
) language sql stable as $$
  with cur as (
    select g.page, sum(clicks)::int c, sum(impressions)::int i,
           sum(position * impressions) / nullif(sum(impressions), 0) p
    from gsc_page_daily g
    where g.site_id = p_site and g.date between cur_start and cur_end
    group by g.page
  ), prev as (
    select g.page, sum(clicks)::int c, sum(impressions)::int i,
           sum(position * impressions) / nullif(sum(impressions), 0) p
    from gsc_page_daily g
    where g.site_id = p_site and g.date between prev_start and prev_end
    group by g.page
  )
  select coalesce(cur.page, prev.page),
         coalesce(cur.c, 0), coalesce(cur.i, 0),
         case when coalesce(cur.i, 0) > 0 then cur.c::float / cur.i else 0 end, cur.p,
         coalesce(prev.c, 0), coalesce(prev.i, 0),
         case when coalesce(prev.i, 0) > 0 then prev.c::float / prev.i else 0 end, prev.p
  from cur full outer join prev on cur.page = prev.page
  order by 1
$$;
