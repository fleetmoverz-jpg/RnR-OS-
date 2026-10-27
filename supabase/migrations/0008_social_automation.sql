-- RnR Os · Scheduling and automation. Run after 0007. Safe to re-run.
--
-- Scheduled posts are rows in scheduled_jobs with a future run_at (UTC) plus the IANA time zone
-- they were planned in. A worker (/api/cron/social) claims due jobs with FOR UPDATE SKIP LOCKED,
-- so two workers never take the same job, and a job is only ever published through its
-- idempotency key. Nothing here publishes on its own: automation is off until switched on per brand.

-- Workspace-wide switches and limits for automated publishing.
create table if not exists automation_settings (
  workspace_id             uuid primary key references workspaces(id) on delete cascade,
  paused                   boolean not null default false,
  paused_by                text,
  paused_at                timestamptz,
  daily_post_limit         integer not null default 10 check (daily_post_limit between 0 and 500),
  monthly_post_limit       integer not null default 150 check (monthly_post_limit between 0 and 10000),
  daily_ai_cost_limit_usd  numeric(10, 2) not null default 2 check (daily_ai_cost_limit_usd >= 0),
  updated_by               text,
  updated_at               timestamptz not null default now(),
  check (paused = (paused_at is not null))
);

-- Per-brand automation: when to post, how often, and how much the app may do on its own.
--   draft_only             generate drafts ahead of the schedule; never queue or publish them
--   approval_required      generate drafts; once a person approves one, it is queued into the next slot
--   auto_publish_approved  generate nothing; queue posts people approved into the next slots
--   fully_automatic        generate, approve drafts that pass every check, queue and publish
create table if not exists brand_automation (
  brand_id                uuid primary key,
  workspace_id            uuid not null,
  enabled                 boolean not null default false,
  paused                  boolean not null default false,
  mode                    text not null default 'draft_only'
                          check (mode in ('draft_only', 'approval_required', 'auto_publish_approved', 'fully_automatic')),
  days_of_week            smallint[] not null default '{1,3,5}'
                          check (cardinality(days_of_week) between 1 and 7 and days_of_week <@ array[0,1,2,3,4,5,6]::smallint[]),
  times                   text[] not null default '{10:00}'
                          check (cardinality(times) between 1 and 6
                                 and array_to_string(times, ',') ~ '^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])*$'),
  posts_per_week          smallint not null default 3 check (posts_per_week between 1 and 21),
  categories              text[] not null default '{}'
                          check (categories <@ array['educational', 'faq', 'maintenance_tips', 'seasonal', 'industry_update', 'service_explainer', 'local_relevance']::text[]),
  full_auto_confirmed_by  text,
  full_auto_confirmed_at  timestamptz,
  last_generated_at       timestamptz,
  updated_by              text,
  updated_at              timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade,
  -- Fully automatic publishing needs a recorded, explicit opt-in.
  check (mode <> 'fully_automatic' or (full_auto_confirmed_by is not null and full_auto_confirmed_at is not null))
);

-- Per-account switch: a paused account is never planned into or published to by the queue.
alter table social_accounts add column if not exists automation_paused boolean not null default false;

-- The queue.
alter table scheduled_jobs drop constraint if exists scheduled_jobs_status_check;
do $$ begin
  alter table scheduled_jobs add constraint scheduled_jobs_status_check
    check (status in ('pending', 'claimed', 'succeeded', 'failed', 'needs_check', 'cancelled', 'paused', 'skipped', 'dead'));
exception when duplicate_object then null; end $$;
alter table scheduled_jobs drop constraint if exists scheduled_jobs_max_attempts_check;
do $$ begin
  alter table scheduled_jobs add constraint scheduled_jobs_max_attempts_check check (max_attempts between 1 and 100);
exception when duplicate_object then null; end $$;
alter table scheduled_jobs add column if not exists source text not null default 'manual';
alter table scheduled_jobs add column if not exists timezone text not null default 'UTC';
alter table scheduled_jobs add column if not exists local_time text;
alter table scheduled_jobs add column if not exists brand_id uuid;
do $$ begin
  alter table scheduled_jobs add constraint scheduled_jobs_source_check check (source in ('manual', 'schedule', 'automation'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table scheduled_jobs add constraint scheduled_jobs_brand_fk foreign key (brand_id, workspace_id)
    references brands (id, workspace_id) on delete cascade;
exception when duplicate_object then null; end $$;
do $$ begin
  -- A job that gave up says why.
  alter table scheduled_jobs add constraint scheduled_jobs_dead_reason check (status <> 'dead' or last_error is not null);
exception when duplicate_object then null; end $$;
update scheduled_jobs j set brand_id = p.brand_id
  from post_variants v join posts p on p.id = v.post_id
  where j.brand_id is null and v.id = j.variant_id;
-- One queued post per account per minute, so the planner can't double-fill a slot.
create unique index if not exists scheduled_jobs_account_slot on scheduled_jobs (social_account_id, run_at)
  where status in ('pending', 'claimed', 'paused');
create index if not exists scheduled_jobs_brand on scheduled_jobs (brand_id, run_at);
create index if not exists scheduled_jobs_status on scheduled_jobs (status, run_at);

-- Rejects time zones Postgres doesn't know (e.g. "Mars/Base"), so stored times are always convertible.
create or replace function social_check_timezone() returns trigger language plpgsql as $$
begin
  perform now() at time zone new.timezone;
  return new;
exception when others then
  raise exception 'unknown time zone: %', new.timezone using errcode = '22023';
end $$;
drop trigger if exists scheduled_jobs_timezone on scheduled_jobs;
create trigger scheduled_jobs_timezone before insert or update of timezone on scheduled_jobs
  for each row execute function social_check_timezone();

-- In-app alerts: disconnected accounts, failed or unclear posts, limits reached, drafts needing review.
create table if not exists notifications (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  brand_id      uuid,
  kind          text not null check (kind ~ '^[a-z_]+$' and length(kind) <= 60),
  severity      text not null check (severity in ('info', 'warning', 'error')),
  title         text not null check (length(title) between 1 and 200),
  body          text check (length(body) <= 1000),
  entity_type   text,
  entity_id     uuid,
  dedupe_key    text check (length(dedupe_key) <= 200),
  created_at    timestamptz not null default now(),
  read_at       timestamptz,
  read_by       text,
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade,
  check ((read_at is null) = (read_by is null))
);
-- The same unread alert is never raised twice.
create unique index if not exists notifications_unread_dedupe on notifications (workspace_id, dedupe_key) where read_at is null;
create index if not exists notifications_workspace on notifications (workspace_id, created_at desc);

-- One row per worker run, for monitoring ("last run 3 minutes ago, 2 posts published").
create table if not exists worker_runs (
  id           bigint generated always as identity primary key,
  worker       text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  stats        jsonb not null default '{}',
  error        text check (length(error) <= 2000)
);
create index if not exists worker_runs_started on worker_runs (started_at desc);

-- Claims due jobs for one worker. SKIP LOCKED means concurrent workers split the work instead of
-- sharing it. Paused workspaces, brands and accounts, and workspaces listed in p_skip (at a limit), are left alone.
-- p_only limits the run to some workspaces (null: all).
create or replace function social_claim_due_jobs(p_worker text, p_limit integer, p_now timestamptz, p_skip uuid[] default '{}', p_only uuid[] default null)
returns setof scheduled_jobs language plpgsql as $$
begin
  return query
  with due as (
    select j.id
    from scheduled_jobs j
    left join automation_settings s on s.workspace_id = j.workspace_id
    left join brand_automation b on b.brand_id = j.brand_id
    left join social_accounts a on a.id = j.social_account_id
    where j.status = 'pending'
      and j.run_at <= p_now
      and j.attempts < j.max_attempts
      and not (j.workspace_id = any (p_skip))
      and (p_only is null or j.workspace_id = any (p_only))
      and not coalesce(s.paused, false)
      and not coalesce(b.paused, false)
      and not coalesce(a.automation_paused, false)
    order by j.run_at
    limit p_limit
    for update of j skip locked
  )
  update scheduled_jobs j
     set status = 'claimed', attempts = j.attempts + 1, locked_at = p_now, locked_by = p_worker, last_error = null
    from due
   where j.id = due.id
  returning j.*;
end $$;

-- A claimed job whose worker died. If an attempt was started, the post may have gone out, so the
-- job needs checking and is never put back as pending. If no attempt started, nothing was sent.
create or replace function social_recover_stale_jobs(p_stale_seconds integer, p_now timestamptz, p_only uuid[] default null)
returns table (job_id uuid, workspace_id uuid, outcome text) language plpgsql as $$
begin
  return query
  with stale as (
    select j.id, j.workspace_id, j.attempts,
           exists (select 1 from publish_attempts pa where pa.job_id = j.id and pa.attempt_no = j.attempts) as started
    from scheduled_jobs j
    where j.status = 'claimed' and j.locked_at < p_now - make_interval(secs => p_stale_seconds)
      and (p_only is null or j.workspace_id = any (p_only))
    for update of j skip locked
  ), closed as (
    update publish_attempts pa
       set finished_at = p_now, outcome = 'ambiguous', error_kind = 'ambiguous',
           error_message = 'The worker stopped before it recorded the platform''s answer.'
      from stale
     where stale.started and pa.job_id = stale.id and pa.attempt_no = stale.attempts and pa.finished_at is null
  ), moved as (
    update scheduled_jobs j
       set status = case when stale.started then 'needs_check' else 'pending' end,
           attempts = case when stale.started then j.attempts else j.attempts - 1 end,
           locked_at = null, locked_by = null,
           last_error = case when stale.started then 'The worker stopped mid-publish. Check whether it posted before trying again.' else null end
      from stale
     where j.id = stale.id
    returning j.id, j.workspace_id, j.status
  )
  select moved.id, moved.workspace_id, moved.status from moved;
end $$;

drop trigger if exists automation_settings_touch on automation_settings;
create trigger automation_settings_touch before update on automation_settings for each row execute function social_touch_updated_at();
drop trigger if exists brand_automation_touch on brand_automation;
create trigger brand_automation_touch before update on brand_automation for each row execute function social_touch_updated_at();

alter table automation_settings enable row level security;
alter table brand_automation    enable row level security;
alter table notifications       enable row level security;
alter table worker_runs         enable row level security;

-- Only the server calls these. Supabase's anon and authenticated roles get no access.
revoke all on function social_claim_due_jobs(text, integer, timestamptz, uuid[], uuid[]) from public;
revoke all on function social_recover_stale_jobs(integer, timestamptz, uuid[]) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function social_claim_due_jobs(text, integer, timestamptz, uuid[], uuid[]) from %I', r);
      execute format('revoke all on function social_recover_stale_jobs(integer, timestamptz, uuid[]) from %I', r);
    end if;
  end loop;
end $$;
