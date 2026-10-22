-- RnR Os: country and device breakdowns for the SEO Overview.
-- Run in the Supabase SQL Editor after 0001_gsc.sql.

create table if not exists gsc_country_daily (
  site_id      uuid not null references sites(id) on delete cascade,
  date         date not null,
  country      text not null,       -- ISO 3166-1 alpha-3, lowercase (as Search Console returns it)
  clicks       integer not null,
  impressions  integer not null,
  ctr          double precision not null,
  position     double precision not null,
  primary key (site_id, date, country)
);

create table if not exists gsc_device_daily (
  site_id      uuid not null references sites(id) on delete cascade,
  date         date not null,
  device       text not null,       -- DESKTOP / MOBILE / TABLET
  clicks       integer not null,
  impressions  integer not null,
  ctr          double precision not null,
  position     double precision not null,
  primary key (site_id, date, device)
);

alter table gsc_country_daily enable row level security;
alter table gsc_device_daily  enable row level security;

-- Same shape as gsc_query_compare, keyed by country or device.
create or replace function gsc_dimension_compare(
  p_dimension text, p_site uuid, cur_start date, cur_end date, prev_start date, prev_end date
) returns table (
  key text,
  clicks integer, impressions integer, ctr double precision, "position" double precision,
  prev_clicks integer, prev_impressions integer, prev_ctr double precision, prev_position double precision
) language plpgsql stable as $$
begin
  if p_dimension not in ('country', 'device') then
    raise exception 'unsupported dimension %', p_dimension;
  end if;
  return query execute format($q$
    with cur as (
      select %1$I k, sum(clicks)::int c, sum(impressions)::int i,
             sum(position * impressions) / nullif(sum(impressions), 0) p
      from %2$I where site_id = $1 and date between $2 and $3 group by 1
    ), prev as (
      select %1$I k, sum(clicks)::int c, sum(impressions)::int i,
             sum(position * impressions) / nullif(sum(impressions), 0) p
      from %2$I where site_id = $1 and date between $4 and $5 group by 1
    )
    select coalesce(cur.k, prev.k),
           coalesce(cur.c, 0), coalesce(cur.i, 0),
           case when coalesce(cur.i, 0) > 0 then cur.c::float / cur.i else 0 end, cur.p,
           coalesce(prev.c, 0), coalesce(prev.i, 0),
           case when coalesce(prev.i, 0) > 0 then prev.c::float / prev.i else 0 end, prev.p
    from cur full outer join prev on cur.k = prev.k
    order by 1
  $q$, p_dimension, 'gsc_' || p_dimension || '_daily')
  using p_site, cur_start, cur_end, prev_start, prev_end;
end
$$;
