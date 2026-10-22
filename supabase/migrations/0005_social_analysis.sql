-- RnR Os · Website analysis and brand profiles built from it. Run after 0004. Safe to re-run.

-- One run of the website analyser. Pages fetched, skipped and the per-field outcome are kept for review.
create table if not exists website_scans (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  website_id     uuid not null,
  brand_id       uuid,
  status         text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  requested_by   text not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  pages_fetched  int not null default 0 check (pages_fetched >= 0),
  pages_skipped  int not null default 0 check (pages_skipped >= 0),
  error          text check (length(error) <= 1000),
  -- {pages: [{url, status, title, reason}], fields: {field: "found" | "missing" | "conflict"}, ai: "used" | "skipped: …"}
  report         jsonb not null default '{}',
  unique (id, workspace_id),
  foreign key (website_id, workspace_id) references workspace_websites (id, workspace_id) on delete cascade,
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete set null (brand_id),
  check ((status = 'running') = (finished_at is null))
);
create index if not exists website_scans_website on website_scans (website_id, started_at desc);
-- At most one scan running per website at a time.
create unique index if not exists website_scans_one_running on website_scans (website_id) where status = 'running';

-- Facts gain where they came from, how sure the extractor was and which website/scan saw them last.
alter table brand_facts add column if not exists website_id uuid;
alter table brand_facts add column if not exists scan_id uuid;
alter table brand_facts add column if not exists origin text not null default 'user';
alter table brand_facts add column if not exists confidence real;
alter table brand_facts add column if not exists label text;
alter table brand_facts add column if not exists last_seen_at timestamptz;
alter table brand_facts add column if not exists value_key text generated always as (lower(btrim(value))) stored;

alter table brand_facts drop constraint if exists brand_facts_kind_check;
do $$ begin
  alter table brand_facts add constraint brand_facts_kind_check check (kind in (
    'name', 'website_url', 'canonical_domain', 'industry', 'niche', 'city', 'region', 'phone', 'email', 'address',
    'hours', 'description', 'usp', 'tone', 'logo', 'image', 'service', 'service_area', 'service_page', 'article',
    'social_link', 'claim', 'certification', 'offer', 'other'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table brand_facts add constraint brand_facts_origin_check check (origin in ('website', 'structured_data', 'ai_suggestion', 'user'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table brand_facts add constraint brand_facts_confidence_check check (confidence is null or confidence between 0 and 1);
exception when duplicate_object then null; end $$;
-- Anything read from the website must say which page it came from.
do $$ begin
  alter table brand_facts add constraint brand_facts_website_source_check
    check (origin not in ('website', 'structured_data') or source_url is not null);
exception when duplicate_object then null; end $$;
-- AI may only suggest descriptive fields. Contact details, credentials and claims must come from the site or the user.
do $$ begin
  alter table brand_facts add constraint brand_facts_ai_scope_check
    check (origin <> 'ai_suggestion' or (kind in ('industry', 'niche', 'tone', 'usp', 'description') and status <> 'verified'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table brand_facts add constraint brand_facts_website_fk foreign key (website_id, workspace_id)
    references workspace_websites (id, workspace_id) on delete set null (website_id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table brand_facts add constraint brand_facts_scan_fk foreign key (scan_id, workspace_id)
    references website_scans (id, workspace_id) on delete set null (scan_id);
exception when duplicate_object then null; end $$;
-- A rescan updates the same fact instead of adding a copy, so user decisions on it are kept.
create unique index if not exists brand_facts_unique_value on brand_facts (brand_id, kind, value_key);

-- The brand profile is what the user approved. Fields listed in confirmed_fields are never changed by a rescan.
alter table brand_profiles add column if not exists website_url text check (website_url ~ '^https?://');
alter table brand_profiles add column if not exists canonical_domain text check (canonical_domain = lower(canonical_domain));
alter table brand_profiles add column if not exists industry text check (length(industry) <= 120);
alter table brand_profiles add column if not exists niche text check (length(niche) <= 120);
alter table brand_profiles add column if not exists city text check (length(city) <= 120);
alter table brand_profiles add column if not exists region text check (length(region) <= 120);
alter table brand_profiles add column if not exists hours text check (length(hours) <= 500);
alter table brand_profiles add column if not exists value_proposition text check (length(value_proposition) <= 500);
alter table brand_profiles add column if not exists logo_url text check (logo_url ~ '^https://');
alter table brand_profiles add column if not exists source_website_id uuid;
alter table brand_profiles add column if not exists confirmed_fields text[] not null default '{}';
alter table brand_profiles add column if not exists status text not null default 'draft';
alter table brand_profiles add column if not exists approved_at timestamptz;
alter table brand_profiles add column if not exists approved_by text;
do $$ begin
  alter table brand_profiles add constraint brand_profiles_status_check check (status in ('draft', 'approved'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table brand_profiles add constraint brand_profiles_approval_check check ((status = 'approved') = (approved_at is not null and approved_by is not null));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table brand_profiles add constraint brand_profiles_source_website_fk foreign key (source_website_id, workspace_id)
    references workspace_websites (id, workspace_id) on delete set null (source_website_id);
exception when duplicate_object then null; end $$;

alter table website_scans enable row level security;
