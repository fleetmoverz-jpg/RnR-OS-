-- RnR Os · Social Media Automation foundation.
-- Run after 0001 and 0002. Safe to re-run.
--
-- Tenant isolation: every row carries workspace_id, and every link between rows is a
-- composite foreign key on (id, workspace_id). The database itself refuses to attach a
-- brand, website, account or post from one workspace to anything in another.
-- RLS is on with no policies, as in 0001: only the server (service role) can read or write.

create table if not exists workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 80),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         text not null check (email = lower(email) and email like '%_@_%'),
  role          text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, email)
);
create index if not exists workspace_members_email on workspace_members (email);

-- Websites the workspace manages. A website can come from Search Console (gsc_site_id) or be
-- added by hand; verification_status records how ownership was established.
create table if not exists workspace_websites (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  brand_id             uuid,
  gsc_site_id          uuid references sites(id) on delete set null,
  url                  text not null check (url ~ '^https?://[^/\s]+'),
  domain               text not null check (domain = lower(domain) and domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  verification_status  text not null default 'unverified'
                       check (verification_status in ('unverified', 'pending', 'verified', 'failed')),
  verification_method  text check (verification_method in ('search_console', 'manual')),
  verified_at          timestamptz,
  last_checked_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, domain),
  unique (workspace_id, gsc_site_id),
  check ((verification_status = 'verified') = (verified_at is not null and verification_method is not null))
);

create table if not exists brands (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  name                text not null check (length(btrim(name)) between 1 and 80),
  slug                text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 60),
  niche               text check (length(niche) <= 120),
  timezone            text not null default 'UTC' check (length(timezone) between 1 and 64),
  primary_website_id  uuid,
  autopilot           boolean not null default false,
  status              text not null default 'active' check (status in ('active', 'archived')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, slug),
  foreign key (primary_website_id, workspace_id) references workspace_websites (id, workspace_id) on delete set null (primary_website_id)
);
create index if not exists brands_workspace on brands (workspace_id, status);

do $$ begin
  alter table workspace_websites
    add constraint workspace_websites_brand_fk foreign key (brand_id, workspace_id)
    references brands (id, workspace_id) on delete set null (brand_id);
exception when duplicate_object then null; end $$;
create index if not exists workspace_websites_brand on workspace_websites (brand_id);

-- Business details. Only facts a person confirmed may be used in posts (later phases).
create table if not exists brand_profiles (
  brand_id        uuid primary key,
  workspace_id    uuid not null,
  business_name   text check (length(business_name) <= 120),
  phone           text check (length(phone) <= 40),
  email           text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address         text check (length(address) <= 300),
  services        text[] not null default '{}',
  service_areas   text[] not null default '{}',
  tone            text check (length(tone) <= 200),
  description     text check (length(description) <= 2000),
  updated_at      timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade
);

create table if not exists brand_facts (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  brand_id      uuid not null,
  kind          text not null check (kind in ('name', 'phone', 'email', 'address', 'service', 'service_area', 'hours', 'usp', 'other')),
  value         text not null check (length(value) between 1 and 500),
  source_url    text check (source_url ~ '^https?://'),
  source_quote  text,
  status        text not null default 'extracted' check (status in ('extracted', 'verified', 'confirmed', 'rejected')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade,
  -- A fact can only be "verified" against the page it was found on.
  check (status <> 'verified' or (source_url is not null and source_quote is not null))
);
create index if not exists brand_facts_brand on brand_facts (brand_id, kind);

-- Social accounts. Rows are created only by a completed OAuth connection (later phase).
create table if not exists social_accounts (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  brand_id             uuid not null,
  platform             text not null check (platform in ('facebook_page', 'instagram', 'linkedin_profile', 'linkedin_page', 'google_business', 'x', 'pinterest', 'threads')),
  external_account_id  text not null check (length(external_account_id) between 1 and 200),
  display_name         text not null check (length(display_name) between 1 and 200),
  avatar_url           text check (avatar_url ~ '^https://'),
  status               text not null default 'connected' check (status in ('connected', 'needs_reconnect', 'revoked', 'error')),
  scopes               text[] not null default '{}',
  token_expires_at     timestamptz,
  last_error           text,
  connected_at         timestamptz not null default now(),
  last_checked_at      timestamptz,
  updated_at           timestamptz not null default now(),
  unique (id, workspace_id),
  unique (id, platform, workspace_id),
  unique (workspace_id, platform, external_account_id),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade
);
create index if not exists social_accounts_brand on social_accounts (brand_id, platform);

-- Tokens live apart from account metadata and only as AES-256-GCM ciphertext ("v1:iv:tag:data").
create table if not exists social_account_credentials (
  social_account_id   uuid primary key,
  workspace_id        uuid not null,
  access_token_enc    text not null check (access_token_enc ~ '^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'),
  refresh_token_enc   text check (refresh_token_enc ~ '^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'),
  updated_at          timestamptz not null default now(),
  foreign key (social_account_id, workspace_id) references social_accounts (id, workspace_id) on delete cascade
);

create table if not exists website_social_accounts (
  workspace_id       uuid not null,
  website_id         uuid not null,
  social_account_id  uuid not null,
  created_at         timestamptz not null default now(),
  primary key (website_id, social_account_id),
  foreign key (website_id, workspace_id) references workspace_websites (id, workspace_id) on delete cascade,
  foreign key (social_account_id, workspace_id) references social_accounts (id, workspace_id) on delete cascade
);
create index if not exists website_social_accounts_account on website_social_accounts (social_account_id);

create table if not exists research_runs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  brand_id      uuid not null,
  kind          text not null check (kind in ('website_crawl', 'niche_research')),
  status        text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  summary       jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  unique (id, workspace_id),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade,
  check (finished_at is null or started_at is not null)
);
create index if not exists research_runs_brand on research_runs (brand_id, created_at desc);

create table if not exists content_topics (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  brand_id         uuid not null,
  research_run_id  uuid,
  title            text not null check (length(btrim(title)) between 1 and 200),
  angle            text check (length(angle) <= 1000),
  service          text,
  location         text,
  source_urls      text[] not null default '{}',
  status           text not null default 'new' check (status in ('new', 'used', 'dismissed')),
  created_at       timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade,
  foreign key (research_run_id, workspace_id) references research_runs (id, workspace_id) on delete set null (research_run_id)
);
create unique index if not exists content_topics_unique_title on content_topics (brand_id, lower(title));

-- A post is the idea; a variant is its text for one social account.
create table if not exists posts (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  brand_id      uuid not null,
  topic_id      uuid,
  title         text not null check (length(btrim(title)) between 1 and 200),
  body          text not null default '' check (length(body) <= 5000),
  status        text not null default 'draft'
                check (status in ('draft', 'in_review', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  origin        text not null default 'manual' check (origin in ('manual', 'ai')),
  created_by    text not null,
  approved_by   text,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade,
  foreign key (topic_id, workspace_id) references content_topics (id, workspace_id) on delete set null (topic_id),
  check ((approved_at is null) = (approved_by is null))
);
create index if not exists posts_brand_status on posts (brand_id, status, created_at desc);
create index if not exists posts_workspace_status on posts (workspace_id, status);

create table if not exists post_variants (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  post_id            uuid not null,
  social_account_id  uuid not null,
  platform           text not null,
  body               text not null check (length(body) between 1 and 5000),
  link_url           text check (link_url ~ '^https?://'),
  hashtags           text[] not null default '{}',
  status             text not null default 'draft'
                     check (status in ('draft', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  external_post_id   text,
  external_url       text,
  published_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, workspace_id),
  unique (post_id, social_account_id),
  foreign key (post_id, workspace_id) references posts (id, workspace_id) on delete cascade,
  -- The variant's platform must be the account's platform.
  foreign key (social_account_id, platform, workspace_id) references social_accounts (id, platform, workspace_id) on delete cascade,
  check ((status = 'published') = (published_at is not null and external_post_id is not null))
);
create index if not exists post_variants_account on post_variants (social_account_id, status);

create table if not exists media_assets (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  brand_id      uuid not null,
  kind          text not null check (kind in ('image', 'video')),
  source        text not null check (source in ('ai_generated', 'uploaded')),
  storage_path  text not null unique check (length(storage_path) between 1 and 500),
  public_url    text check (public_url ~ '^https://'),
  mime_type     text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4')),
  width         integer check (width > 0),
  height        integer check (height > 0),
  bytes         bigint check (bytes > 0),
  alt_text      text check (length(alt_text) <= 1000),
  created_at    timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade
);
create index if not exists media_assets_brand on media_assets (brand_id, created_at desc);

create table if not exists post_variant_media (
  workspace_id  uuid not null,
  variant_id    uuid not null,
  media_id      uuid not null,
  position      smallint not null default 0 check (position between 0 and 19),
  primary key (variant_id, media_id),
  unique (variant_id, position),
  foreign key (variant_id, workspace_id) references post_variants (id, workspace_id) on delete cascade,
  foreign key (media_id, workspace_id) references media_assets (id, workspace_id) on delete restrict
);

-- Recurring posting slots, e.g. Mon/Wed/Fri at 09:00 in the brand's time zone.
create table if not exists publish_schedules (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  brand_id           uuid not null,
  social_account_id  uuid,
  name               text not null check (length(btrim(name)) between 1 and 80),
  days_of_week       smallint[] not null check (cardinality(days_of_week) between 1 and 7 and days_of_week <@ array[0,1,2,3,4,5,6]::smallint[]),
  times              text[] not null check (cardinality(times) between 1 and 12),
  timezone           text not null default 'UTC',
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade,
  foreign key (social_account_id, workspace_id) references social_accounts (id, workspace_id) on delete cascade
);
create index if not exists publish_schedules_brand on publish_schedules (brand_id) where active;

-- One job per variant publication. idempotency_key stops a retry from posting twice.
create table if not exists scheduled_jobs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  variant_id       uuid not null,
  run_at           timestamptz not null,
  status           text not null default 'pending' check (status in ('pending', 'claimed', 'succeeded', 'failed', 'cancelled')),
  attempts         smallint not null default 0 check (attempts >= 0),
  max_attempts     smallint not null default 3 check (max_attempts between 1 and 10),
  idempotency_key  text not null unique,
  locked_at        timestamptz,
  locked_by        text,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (variant_id, workspace_id) references post_variants (id, workspace_id) on delete cascade,
  check (attempts <= max_attempts),
  check ((status = 'claimed') = (locked_at is not null))
);
create index if not exists scheduled_jobs_due on scheduled_jobs (run_at) where status = 'pending';
create index if not exists scheduled_jobs_workspace on scheduled_jobs (workspace_id, run_at);

create table if not exists publish_attempts (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  job_id         uuid not null,
  attempt_no     smallint not null check (attempt_no >= 1),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  outcome        text check (outcome in ('success', 'error')),
  http_status    smallint,
  response       jsonb,   -- platform response with any token-like values removed before saving
  error_code     text,
  error_message  text,
  unique (job_id, attempt_no),
  foreign key (job_id, workspace_id) references scheduled_jobs (id, workspace_id) on delete cascade,
  check ((outcome is null) = (finished_at is null))
);
create index if not exists publish_attempts_workspace on publish_attempts (workspace_id, started_at desc);

create table if not exists audit_events (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  actor_email   text not null,
  action        text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type   text not null,
  entity_id     uuid,
  details       jsonb not null default '{}',
  created_at    timestamptz not null default now()
);
create index if not exists audit_events_workspace on audit_events (workspace_id, created_at desc);

-- Keep updated_at honest.
create or replace function social_touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['workspaces', 'workspace_websites', 'brands', 'brand_profiles', 'brand_facts', 'social_accounts',
                           'social_account_credentials', 'posts', 'post_variants', 'publish_schedules', 'scheduled_jobs']
  loop
    execute format('drop trigger if exists %I_touch on %I', t, t);
    execute format('create trigger %I_touch before update on %I for each row execute function social_touch_updated_at()', t, t);
  end loop;
end $$;

alter table workspaces                 enable row level security;
alter table workspace_members          enable row level security;
alter table workspace_websites         enable row level security;
alter table brands                     enable row level security;
alter table brand_profiles             enable row level security;
alter table brand_facts                enable row level security;
alter table social_accounts            enable row level security;
alter table social_account_credentials enable row level security;
alter table website_social_accounts    enable row level security;
alter table research_runs              enable row level security;
alter table content_topics             enable row level security;
alter table posts                      enable row level security;
alter table post_variants              enable row level security;
alter table media_assets               enable row level security;
alter table post_variant_media         enable row level security;
alter table publish_schedules          enable row level security;
alter table scheduled_jobs             enable row level security;
alter table publish_attempts           enable row level security;
alter table audit_events               enable row level security;
