-- RnR Os · Analytics, link tracking and request limits. Run after 0008. Safe to re-run.

-- Optional UTM tagging of the link a post carries, per brand. Off by default.
-- {platform} in a value is replaced by the platform (facebook_page, instagram, ...).
create table if not exists brand_link_tracking (
  brand_id      uuid primary key,
  workspace_id  uuid not null,
  enabled       boolean not null default false,
  utm_source    text not null default '{platform}' check (utm_source ~ '^[A-Za-z0-9_{}.-]{1,60}$'),
  utm_medium    text not null default 'social' check (utm_medium ~ '^[A-Za-z0-9_{}.-]{1,60}$'),
  utm_campaign  text not null default 'rnr-os' check (utm_campaign ~ '^[A-Za-z0-9_{}.-]{1,60}$'),
  updated_by    text,
  updated_at    timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade
);
drop trigger if exists brand_link_tracking_touch on brand_link_tracking;
create trigger brand_link_tracking_touch before update on brand_link_tracking for each row execute function social_touch_updated_at();

-- The exact link sent with a published post (after any UTM tagging).
alter table post_variants add column if not exists sent_link_url text;
do $$ begin
  alter table post_variants add constraint post_variants_sent_link_check check (sent_link_url is null or sent_link_url ~ '^https?://');
exception when duplicate_object then null; end $$;

-- Fixed-window request limits for expensive or sensitive actions (AI calls, publishing, sign-ins).
create table if not exists request_limits (
  key           text not null check (length(key) between 1 and 200),
  window_start  timestamptz not null,
  hits          integer not null default 0,
  primary key (key, window_start)
);
create index if not exists request_limits_window on request_limits (window_start);

-- Counts one hit and says whether it is within the limit. Atomic, so parallel requests can't slip through.
create or replace function social_rate_limit(p_key text, p_limit integer, p_window_seconds integer, p_now timestamptz default now())
returns boolean language plpgsql as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds);
  n integer;
begin
  insert into request_limits (key, window_start, hits) values (p_key, w, 1)
  on conflict (key, window_start) do update set hits = request_limits.hits + 1
  returning hits into n;
  -- Old windows are cleared now and then.
  if random() < 0.01 then delete from request_limits where window_start < p_now - interval '1 day'; end if;
  return n <= p_limit;
end $$;

-- Analytics read these by time.
create index if not exists publish_attempts_finished on publish_attempts (workspace_id, finished_at desc);
create index if not exists post_variants_published on post_variants (workspace_id, published_at desc) where published_at is not null;
create index if not exists audit_events_action on audit_events (workspace_id, action, created_at desc);

alter table brand_link_tracking enable row level security;
alter table request_limits      enable row level security;

revoke all on function social_rate_limit(text, integer, integer, timestamptz) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function social_rate_limit(text, integer, integer, timestamptz) from %I', r);
    end if;
  end loop;
end $$;
